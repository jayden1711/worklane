// WHY: an MCP server's credentials never enter an agent's environment or reach. The instance's broker runs as its own
// user (wl-<name>-mcp, a root-installed system unit); it alone reads the servers' secrets, starts each approved server
// in its own sandbox for one agent session, and stands between the two:
//   - an agent's claude reaches it only through the connector (`<cli> mcp-connect`) on a socket only the instance's
//     agent user may open, with a ticket the coordinator registered for that one run (its role, its expiry);
//   - the agent sees the APPROVED snapshot (instructions, tools, schemas), never the live list; the live list is
//     compared with it at every start and on every list_changed, and any difference blocks the server (a rug pull);
//   - a tool call must name an approved tool and fit its approved schema; nothing else from the agent reaches the
//     server, and the server's own requests (sampling, elicitation, roots) are refused. No token is passed through:
//     the agent has none, and the server's own secrets are in its own environment only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../plugins/approval.js';
import { LineChannel } from './jsonrpc.js';
import { argumentsProblem } from './schema.js';
import { diffSnapshots, snapshotHash } from './snapshot.js';
import { connectUpstream } from './upstream.js';
/** Protocol revisions the broker answers an agent's claude with (it serves only tools). */
const CLIENT_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
/** The most a tool result may be before it is refused, not passed on. */
export const MAX_RESULT_BYTES = 1024 * 1024;
export const TICKET = /^[0-9a-f]{64}$/;
const HELLO_MS = 5_000;
const CALL_MS = 120_000;
const MAX_TICKET_MS = 12 * 3_600_000;
export class Broker {
    d;
    tickets = new Map();
    sessions = 0;
    constructor(d) {
        this.d = d;
    }
    now = () => (this.d.now ?? Date.now)();
    blockedFile = () => join(this.d.stateDir, 'blocked.json');
    log = (line) => this.d.log?.(line);
    /** Servers blocked by a rug-pull check, by id: until a new approval changes the approved snapshot. */
    blocked() {
        try {
            return JSON.parse(readFileSync(this.blockedFile(), 'utf8'));
        }
        catch {
            return {};
        }
    }
    block(r, live) {
        const all = this.blocked();
        all[r.id] = { at: new Date(this.now()).toISOString(), approved: r.snapshotHash, live: snapshotHash(live), diff: diffSnapshots(r.snapshot, live) };
        mkdirSync(this.d.stateDir, { recursive: true });
        const tmp = `${this.blockedFile()}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o640 });
        renameSync(tmp, this.blockedFile());
        this.log(`blocked ${r.id}: its tools changed after approval (approved ${r.snapshotHash}, live ${snapshotHash(live)})`);
    }
    isBlocked(r) {
        const b = this.blocked()[r.id];
        return !!b && b.approved === r.snapshotHash;
    }
    callLog(e) {
        try {
            mkdirSync(this.d.stateDir, { recursive: true });
            appendFileSync(join(this.d.stateDir, 'calls.jsonl'), `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...e })}\n`, { mode: 0o640 });
        }
        catch {
            // the log never changes a decision
        }
    }
    // ---------- the coordinator's control socket: register and end a run's ticket ----------
    control(line) {
        let m;
        try {
            m = JSON.parse(line);
        }
        catch {
            return JSON.stringify({ ok: false, error: 'not JSON' });
        }
        // For the Plugins page: which servers the rug-pull check blocked, with what changed. Never a secret or a ticket.
        if (m.op === 'status')
            return JSON.stringify({ ok: true, blocked: this.blocked() });
        if (typeof m.ticket !== 'string' || !TICKET.test(m.ticket))
            return JSON.stringify({ ok: false, error: 'a ticket is 64 hex characters' });
        if (m.op === 'add') {
            if (typeof m.role !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(m.role))
                return JSON.stringify({ ok: false, error: 'role must be a role name' });
            const ttl = typeof m.ttlMs === 'number' && m.ttlMs > 0 ? Math.min(m.ttlMs, MAX_TICKET_MS) : 3_600_000;
            this.tickets.set(m.ticket, { role: m.role, expires: this.now() + ttl });
            const servers = this.d.servers().filter((r) => r.roles.includes(m.role) && r.snapshot && !this.isBlocked(r));
            return JSON.stringify({ ok: true, servers: servers.map((r) => ({ id: r.id, tools: r.snapshot.tools.map((t) => t.name) })) });
        }
        if (m.op === 'remove') {
            this.tickets.delete(m.ticket);
            return JSON.stringify({ ok: true });
        }
        return JSON.stringify({ ok: false, error: 'op must be add or remove' });
    }
    serveControl(sock) {
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString();
            if (buf.length > 64 * 1024)
                return sock.destroy();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                let op;
                try {
                    op = JSON.parse(line).op;
                }
                catch {
                    op = null;
                }
                if (op === 'snapshot') {
                    void this.snapshotFor(line).then((r) => sock.write(`${r}\n`));
                    continue;
                }
                sock.write(`${this.control(line)}\n`);
            }
        });
        sock.on('error', () => { });
    }
    /**
     * The second snapshot of an APPROVED server (Q3), for root: started as for a session (its secrets, its network, its
     * sandbox), listed, stopped; never compared or blocked here (the owner reviews it as an update). Unapproved code
     * never reaches this: its snapshot is a throwaway user's (src/mcp/throwaway.ts).
     */
    async snapshotFor(line) {
        const id = JSON.parse(line).id;
        const r = this.d.servers().find((x) => x.id === id);
        if (!r)
            return JSON.stringify({ ok: false, error: `no approved MCP server ${String(id)}` });
        try {
            const up = await this.start(r, `snapshot-${this.now()}`, false);
            const snapshot = up.snapshot;
            up.stop();
            return JSON.stringify({ ok: true, snapshot });
        }
        catch (e) {
            return JSON.stringify({ ok: false, error: e.message });
        }
    }
    // ---------- an agent's session (through the connector) ----------
    serveClient(sock) {
        const channel = new LineChannel(sock, sock);
        const sessionId = `${this.now()}-${++this.sessions}`;
        let up = null;
        let record = null;
        let role = '';
        let ready = null;
        const fail = (why) => {
            this.log(`session ${sessionId}: ${why}`);
            channel.send({ method: 'notifications/message', params: { level: 'error', data: why } });
            sock.end();
            up?.stop();
        };
        const helloTimer = setTimeout(() => fail('no hello'), HELLO_MS);
        channel.onClose = () => {
            clearTimeout(helloTimer);
            up?.stop();
        };
        channel.onMessage = (m) => {
            // The first line is the connector's hello: the run's ticket and the server it wants. Nothing before it counts.
            if (!ready) {
                clearTimeout(helloTimer);
                const hello = m.hello;
                const t = typeof hello?.ticket === 'string' ? this.tickets.get(hello.ticket) : undefined;
                if (!t || t.expires < this.now())
                    return fail('no live ticket for this run');
                const r = this.d.servers().find((x) => x.id === hello.server);
                if (!r)
                    return fail(`no approved MCP server ${String(hello.server)}`);
                if (!r.roles.includes(t.role))
                    return fail(`${r.id} is not approved for role ${t.role}`);
                if (!r.snapshot || !r.snapshotHash)
                    return fail(`${r.id} has no approved snapshot yet`);
                if (this.isBlocked(r))
                    return fail(`${r.id} is blocked: its tools changed after approval`);
                record = r;
                role = t.role;
                ready = this.start(r, sessionId).then((u) => {
                    up = u;
                    u.onListChanged = () => {
                        void u.list().then((live) => {
                            if (snapshotHash(live) !== r.snapshotHash) {
                                this.block(r, live);
                                fail(`${r.id} changed its tools during the session: blocked`);
                            }
                        }, (e) => fail(`${r.id}: re-listing its tools failed: ${e.message}`));
                    };
                }, (e) => fail(e.message));
                return;
            }
            void ready.then(() => {
                if (!up || channel.isClosed)
                    return;
                this.answer(channel, m, record, up, role, sessionId);
            });
        };
    }
    /** Start the server for one session and check it against its approved snapshot. */
    async start(r, sessionId, compare = true) {
        const secrets = {};
        for (const n of r.secrets) {
            const v = this.d.secret(r.id, n);
            if (v === null)
                throw new Error(`${r.id}: secret ${n} is not installed (mcp-broker.sh <instance> secret ${r.id} ${n})`);
            secrets[n] = v;
        }
        const child = this.d.launch(r, secrets, sessionId);
        // The server's stderr, for the broker's own log (the journal) only, with its secrets taken out: never the agent's.
        let stderr = '';
        child.stderr?.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)));
        let up;
        try {
            up = await connectUpstream(child, { clientName: 'broker', timeoutMs: 30_000 });
        }
        catch (e) {
            child.kill('SIGKILL');
            let tail = stderr.trim().split('\n').slice(-8).join(' | ');
            for (const v of Object.values(secrets))
                if (v.length >= 4)
                    tail = tail.split(v).join('[redacted]');
            this.log(`${r.id} (session ${sessionId}) didn't start: ${e.message}${tail ? `; its stderr: ${tail}` : ''}`);
            throw new Error(`${r.id} didn't start as an MCP server: ${e.message}`);
        }
        if (compare && snapshotHash(up.snapshot) !== r.snapshotHash) {
            this.block(r, up.snapshot);
            up.stop();
            throw new Error(`${r.id} is blocked: its tools changed after approval`);
        }
        return up;
    }
    answer(channel, m, r, up, role, sessionId) {
        const id = m.id;
        const reply = (result) => id !== undefined && id !== null && channel.send({ id, result });
        const error = (code, message) => id !== undefined && id !== null && channel.send({ id, error: { code, message } });
        const s = r.snapshot;
        switch (m.method) {
            case 'initialize': {
                const asked = m.params?.protocolVersion;
                return void reply({
                    protocolVersion: typeof asked === 'string' && CLIENT_PROTOCOLS.includes(asked) ? asked : CLIENT_PROTOCOLS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: r.id, version: 'approved' },
                    ...(s.instructions ? { instructions: s.instructions } : {}),
                });
            }
            case 'ping':
                return void reply({});
            case 'tools/list':
                return void reply({ tools: s.tools });
            case 'tools/call': {
                const p = (m.params ?? {});
                const tool = s.tools.find((t) => t.name === p.name);
                const refuse = (why) => {
                    this.callLog({ session: sessionId, role, server: r.id, tool: String(p.name), ok: false, why });
                    reply({ isError: true, content: [{ type: 'text', text: `refused by the broker: ${why}` }] });
                };
                if (!tool)
                    return refuse(`${String(p.name)} is not an approved tool of ${r.id}`);
                const bad = argumentsProblem(tool.inputSchema, p.arguments);
                if (bad)
                    return refuse(bad);
                // Only the name and the arguments go on: no _meta, no token, nothing else from the agent's side.
                void up.call(tool.name, p.arguments ?? {}, CALL_MS).then((result) => {
                    const size = Buffer.byteLength(canonicalJson(result ?? null));
                    if (size > MAX_RESULT_BYTES)
                        return refuse(`the result was ${size} bytes, over the ${MAX_RESULT_BYTES} limit`);
                    this.callLog({ session: sessionId, role, server: r.id, tool: tool.name, ok: true, bytes: size });
                    reply(result);
                }, (e) => refuse(`the server failed: ${e.message}`));
                return;
            }
            case 'resources/list':
                return void reply({ resources: [] });
            case 'resources/templates/list':
                return void reply({ resourceTemplates: [] });
            case 'prompts/list':
                return void reply({ prompts: [] });
            default:
                if (m.method?.startsWith('notifications/'))
                    return;
                return void error(-32601, `${String(m.method)} is not available through this broker`);
        }
    }
    /** Listen on the client and control sockets (each opened 0660 to its own group by the unit). */
    listen(clientPath, controlPath) {
        for (const p of [clientPath, controlPath]) {
            mkdirSync(dirname(p), { recursive: true });
            if (existsSync(p)) {
                try {
                    rmSync(p);
                }
                catch {
                    // a stale socket from an earlier run; listen below reports anything real
                }
            }
        }
        const client = createServer((s) => this.serveClient(s)).listen(clientPath);
        const control = createServer((s) => this.serveControl(s)).listen(controlPath);
        return { client, control };
    }
}
//# sourceMappingURL=broker.js.map