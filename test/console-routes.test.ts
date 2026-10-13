import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asks } from '../src/console/asks.js';
import { secretsDir } from '../src/console/secrets.js';
import type { Role } from '../src/console/asks.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { exampleProject, machineOwnersFile } from './helpers.js';

const posix = process.platform !== 'win32';
// Not secret-shaped (the log's pattern redaction wouldn't catch it): only never writing it keeps it out.
const SECRET = 'plain-Value-9f3k2LmQx7Zr-not-a-known-pattern';

async function site(roles: Record<string, Role> = { olive: 'owner', wendy: 'writer', vic: 'viewer' }) {
  const dir = mkdtempSync(join(tmpdir(), 'console-routes-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const { dir: root } = exampleProject();
  const calls: string[][] = [];
  const exec = (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return 'slot cap now 4';
  };
  const home = join(dir, 'home');
  const owners = machineOwnersFile('olive');
  const d = await startDashboard({
    root,
    cfg: loadConfig(root),
    eventsDb: db,
    stateDir: join(dir, 'state'),
    user: 'olive',
    instance: 'demo',
    webDir: join(dir, 'web'),
    slotsDir: join(dir, 'slots'),
    secretsHome: home,
    machine: {},
    machineOwnersFile: owners,
    // A person signed in just now, from an allowed console device (a machine change needs both).
    session: (req) => {
      const login = String(req.headers['x-login'] ?? '');
      return login ? { login, role: roles[login] ?? null, authenticatedAt: Date.now(), csrfOk: true, deviceOk: true } : null;
    },
  });
  const base = d.url.split('/?')[0]!;
  const bodies: string[] = [];
  const call = async (path: string, login: string, body?: string, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${d.token}`, 'x-login': login, 'content-type': 'application/json' }, ...(body !== undefined ? { body } : {}) });
    const text = await r.text();
    bodies.push(text);
    return { status: r.status, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { d, db, dir, log, home, calls, exec, call, bodies, owners, a: asks(log) };
}

/** Everything written to stdout and stderr while `fn` runs. */
async function captured(fn: () => Promise<void>): Promise<string> {
  let out = '';
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

test('a pasted secret lands in the credential store, 0400 and this user only, and appears nowhere else', async () => {
  const s = await site();
  try {
    const ask = s.a.create({ instance: 'demo', kind: 'paste_secret', title: 'The chat bot token', detail: 'For intake.', credential: 'intake-discord', where: 'credentials.yaml intake.discord_token' });
    const output = await captured(async () => {
      // A writer and a viewer may not paste it; neither attempt stores anything.
      assert.equal((await s.call(`/api/asks/${ask.id}/secret`, 'wendy', JSON.stringify({ value: SECRET }))).status, 403);
      assert.equal((await s.call(`/api/asks/${ask.id}/secret`, 'vic', JSON.stringify({ value: SECRET }))).status, 403);
      assert.equal(existsSync(join(secretsDir('demo', s.home), 'intake-discord')), false);
      // A malformed body that holds the secret: refused, without quoting it (JSON.parse's message would).
      for (const body of [SECRET, `{"value": "${SECRET}"`, JSON.stringify({ value: 5 })]) {
        const bad = await s.call(`/api/asks/${ask.id}/secret`, 'olive', body);
        assert.equal(bad.status, 400);
      }
      const ok = await s.call(`/api/asks/${ask.id}/secret`, 'olive', JSON.stringify({ value: SECRET }));
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal((ok.json.ask as { status: string }).status, 'answered');
      // Answered once: a second paste is refused and the file keeps the first value.
      assert.equal((await s.call(`/api/asks/${ask.id}/secret`, 'olive', JSON.stringify({ value: 'other' }))).status, 409);
      await s.call('/api/asks', 'olive');
      await s.call('/api/state', 'olive');
      await s.call('/api/events', 'olive');
    });
    const dir = secretsDir('demo', s.home);
    const file = join(dir, 'intake-discord');
    assert.equal(readFileSync(file, 'utf8'), SECRET);
    if (posix) {
      assert.equal(statSync(file).mode & 0o777, 0o400);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(file).uid, process.getuid!());
    }
    assert.deepEqual(readdirSync(dir), ['intake-discord'], 'no temp file left behind');
    const answered = s.a.get(ask.id)!;
    assert.equal(answered.answer!.by, 'olive');
    assert.equal(answered.answer!.role, 'owner');
    assert.equal(answered.answer!.answer, 'stored');
    // Nowhere else: no event, no file under the dashboard's state or log (the WAL included), no response, no output.
    assert.ok(!JSON.stringify(s.log.read(0)).includes(SECRET), 'not in any event');
    s.log.close();
    for (const f of filesUnder(s.dir).filter((f) => f !== file)) assert.ok(!readFileSync(f).includes(SECRET), `not in ${f}`);
    // Not even a prefix of it (a JSON parse error quotes the start of its input).
    for (const b of s.bodies) assert.ok(!b.includes(SECRET.slice(0, 8)), `not in a response: ${b.slice(0, 200)}`);
    assert.ok(!output.includes(SECRET), 'not in the console output');
  } finally {
    await s.d.close();
  }
});

test("a root step off the helper's allowlist is refused and never reaches sudo; an allowed one is run by the coordinator, exactly the helper, once", async () => {
  const s = await site();
  try {
    const bad = s.a.create({ instance: 'demo', kind: 'root_step', title: 'Install a package', detail: 'x', command: 'apt-get', args: ['install', 'x'] });
    const r = await s.call(`/api/asks/${bad.id}/run`, 'olive', '{}');
    assert.equal(r.status, 403);
    assert.match(String(r.json.error), /needs the helper extended/);
    const tooMany = s.a.create({ instance: 'demo', kind: 'root_step', title: 'Too many slots', detail: 'x', command: 'set-slots', args: ['99'] });
    assert.equal((await s.call(`/api/asks/${tooMany.id}/run`, 'olive', '{}')).status, 403);
    assert.deepEqual(s.calls, [], 'sudo never ran');
    assert.equal(s.a.get(bad.id)!.status, 'open');

    const ok = s.a.create({ instance: 'demo', kind: 'root_step', title: 'Four slots', detail: 'x', command: 'set-slots', args: ['4'] });
    assert.equal((await s.call(`/api/asks/${ok.id}/run`, 'wendy', '{}')).status, 403, 'a writer may not run it');
    assert.deepEqual(s.calls, []);
    // The dashboard only records the request; the coordinator runs it (src/machine-requests.ts).
    const ran = await s.call(`/api/asks/${ok.id}/run`, 'olive', '{}');
    assert.equal(ran.status, 200, JSON.stringify(ran.json));
    assert.deepEqual(s.calls, [], 'the dashboard never runs sudo');
    assert.equal(s.a.get(ok.id)!.status, 'open', 'open until the coordinator has run it');
    assert.equal((await s.call(`/api/asks/${ok.id}/run`, 'olive', '{}')).status, 409, 'one request at a time');
    const listed = (await s.call('/api/asks', 'olive')).json.asks as { id: string; request: { status: string } | null }[];
    assert.equal(listed.find((x) => x.id === ok.id)!.request!.status, 'pending');
    runMachineRequests({ log: s.log, instance: 'demo', exec: s.exec, ownersFile: s.owners });
    assert.deepEqual(s.calls, [['sudo', '-n', MACHINE_HELPER, 'set-slots', '4']]);
    assert.equal(s.a.get(ok.id)!.answer!.answer, 'ran');
    assert.equal(s.a.get(ok.id)!.answer!.by, 'olive');
    assert.equal((await s.call(`/api/asks/${ok.id}/run`, 'olive', '{}')).status, 409, 'once');
    runMachineRequests({ log: s.log, instance: 'demo', exec: s.exec, ownersFile: s.owners });
    assert.equal(s.calls.length, 1);
  } finally {
    s.log.close();
    await s.d.close();
  }
});

test("writers and viewers can't answer owner asks; a writer may answer a question that allows writers", async () => {
  const s = await site();
  try {
    const owners = s.a.create({ instance: 'demo', kind: 'question', title: 'Owner only', detail: 'x', options: ['yes', 'no'] });
    const link = s.a.create({ instance: 'demo', kind: 'approve_link', title: 'Install the App', detail: 'x', url: 'https://github.com/apps/x/installations/new' });
    const open = s.a.create({ instance: 'demo', kind: 'question', title: 'Writers too', detail: 'x', options: ['yes', 'no'], writersMayAnswer: true });
    for (const who of ['wendy', 'vic']) {
      assert.equal((await s.call(`/api/asks/${owners.id}/answer`, who, JSON.stringify({ answer: 'yes' }))).status, 403, who);
      assert.equal((await s.call(`/api/asks/${link.id}/answer`, who, JSON.stringify({ answer: 'approved' }))).status, 403, who);
    }
    assert.equal((await s.call(`/api/asks/${open.id}/answer`, 'vic', JSON.stringify({ answer: 'yes' }))).status, 403, 'a viewer never answers');
    assert.equal((await s.call(`/api/asks/${owners.id}/answer`, 'nobody', JSON.stringify({ answer: 'yes' }))).status, 403, 'no role');
    assert.equal((await s.call('/api/asks', 'nobody')).status, 403);
    assert.equal(s.log.read(0, ['ask.answered']).length, 0);

    const listed = (await s.call('/api/asks', 'wendy')).json.asks as { id: string; canAnswer: boolean }[];
    assert.deepEqual(Object.fromEntries(listed.map((a) => [a.id, a.canAnswer])), { [owners.id]: false, [link.id]: false, [open.id]: true });
    assert.equal((await s.call(`/api/asks/${open.id}/answer`, 'wendy', JSON.stringify({ answer: 'no' }))).status, 200);
    assert.equal((await s.call(`/api/asks/${link.id}/answer`, 'olive', JSON.stringify({ answer: 'approved' }))).status, 200);
    const answered = s.log.read(0, ['ask.answered']).map((e) => e.payload as { by: string; role: string });
    assert.deepEqual(answered.map((p) => [p.by, p.role]), [['wendy', 'writer'], ['olive', 'owner']]);
  } finally {
    s.log.close();
    await s.d.close();
  }
});
