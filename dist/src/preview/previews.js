// docs/previews.md, "How it works": each pass deletes closed, expired and failed previews, then creates new ones.
import { startRefusal } from '../testrun/gate.js';
import { mkdirSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { judgeFlow } from '../browser/check.js';
import { redactString } from '../events/redact.js';
import { writeGroupOnly } from '../os/index.js';
import { PREVIEW_ENV_PREFIX, previewPr } from './config.js';
export const PREVIEW_COMMENT_MARKER = '<!-- pr-preview -->';
const DEAD = new Set(['FAILED', 'CRASHED', 'SKIPPED', 'REMOVED']);
const short = (sha) => sha.slice(0, 8);
const plain = (s, max = 300) => redactString(s.split('\n')[0].replace(/`/g, "'")).slice(0, max);
export class Previews {
    d;
    lastPass = -Infinity;
    running = null;
    inFlight = new Map();
    stopped = new AbortController();
    tokenSaid = false;
    constructor(d) {
        this.d = d;
    }
    get file() {
        return join(this.d.stateDir, 'previews.json');
    }
    read() {
        if (!existsSync(this.file))
            return {};
        try {
            const j = JSON.parse(readFileSync(this.file, 'utf8'));
            return j && typeof j === 'object' ? j : {};
        }
        catch {
            return {};
        }
    }
    update(pr, f) {
        const all = this.read();
        const next = f(all[pr]);
        if (next)
            all[pr] = next;
        else
            delete all[pr];
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeGroupOnly(tmp, JSON.stringify(all, null, 2));
        renameSync(tmp, this.file);
    }
    now() {
        return (this.d.now ?? Date.now)();
    }
    emit(type, payload) {
        this.d.log.append(type, payload, this.d.actor);
    }
    step() {
        if (this.stopped.signal.aborted || this.running || this.now() - this.lastPass < (this.d.passMs ?? 60_000))
            return;
        this.lastPass = this.now();
        this.running = this.pass()
            .catch((e) => this.emit('preview.error', { detail: plain(e.message, 1000) }))
            .finally(() => (this.running = null));
    }
    async idle() {
        while (this.running || this.inFlight.size)
            await Promise.all([this.running, ...this.inFlight.values()]);
    }
    stop() {
        this.stopped.abort();
    }
    async pass() {
        if (!this.d.hasToken()) {
            if (!this.tokenSaid)
                this.emit('preview.error', { detail: `no host token is stored, so no previews are created or deleted (docs/previews.md)` });
            this.tokenSaid = true;
            return;
        }
        this.tokenSaid = false;
        const prs = await this.d.github.openPrs();
        if (!prs)
            return this.emit('preview.error', { detail: "GitHub didn't list the open PRs; nothing was created or deleted" });
        const open = new Map(prs.map((p) => [p.number, p]));
        const ours = (await this.d.host.environments()).flatMap((e) => {
            const pr = previewPr(e.name);
            // INVARIANT: only environments named pr-preview-<n> are ever ours, and never the template.
            return pr !== null && e.id !== this.d.config.template_environment ? [{ ...e, pr }] : [];
        });
        const state = this.read();
        const live = new Set();
        for (const e of ours) {
            if (this.inFlight.has(e.pr)) {
                live.add(e.pr);
                continue;
            }
            const s = state[e.pr];
            const age = this.now() - Date.parse(e.createdAt);
            const reason = !open.has(e.pr) ? 'closed' : age > this.d.config.ttl_hours * 3_600_000 ? 'expired' : s?.outcome === 'failed' ? 'failed' : null;
            if (!reason) {
                live.add(e.pr);
                continue;
            }
            await this.remove(e.pr, e.id, reason);
            if (reason === 'expired')
                this.update(e.pr, (x) => (x ? { ...x, env: null, outcome: 'expired' } : { head: open.get(e.pr).head, env: null, outcome: 'expired', comment: null }));
        }
        for (const n of Object.keys(state).map(Number)) {
            if (open.has(n) || this.inFlight.has(n))
                continue;
            await this.d.github.detach(`pr-${n}-`).catch(() => { });
            this.update(n, () => undefined);
        }
        const max = this.d.config.max_concurrent;
        for (const pr of [...open.values()].sort((a, b) => a.number - b.number)) {
            if (this.stopped.signal.aborted)
                return;
            // INVARIANT: a fork's head never reaches the host (it would run with the template's variables).
            if (!pr.sameRepo || this.inFlight.has(pr.number))
                continue;
            const s = this.read()[pr.number];
            // WHY: a `running` record with nothing in flight was cut short by a restart, so it runs again.
            if (s && s.head === pr.head && !s.waited && s.outcome !== 'running')
                continue;
            const env = ours.find((e) => e.pr === pr.number && live.has(e.pr))?.id ?? null;
            const active = new Set([...live, ...this.inFlight.keys()]).size;
            if (!env && active >= max) {
                if (!(s?.head === pr.head && s.waited)) {
                    this.emit('preview.waiting', { pr: pr.number, head: pr.head, active, max });
                    this.update(pr.number, (x) => ({ head: pr.head, env: null, outcome: x?.outcome ?? 'running', comment: x?.comment ?? null, waited: true }));
                }
                continue;
            }
            // INVARIANT: a preview launches only through the start gate (src/testrun/gate.ts); held, it launches at a later pass.
            if (startRefusal())
                continue;
            this.launch(pr, env);
            live.add(pr.number);
        }
    }
    async remove(pr, env, reason) {
        // INVARIANT: the template is never deleted, whatever its name.
        if (env === this.d.config.template_environment)
            return;
        let ok = false;
        try {
            ok = await this.d.host.remove(env);
        }
        catch {
            ok = false;
        }
        this.emit('preview.removed', { pr, environment: env, reason, ok });
        await this.d.github.detach(`pr-${pr}-`).catch(() => { });
    }
    launch(pr, env) {
        const p = this.run(pr, env).finally(() => this.inFlight.delete(pr.number));
        this.inFlight.set(pr.number, p);
    }
    sleep(ms) {
        return new Promise((r) => {
            const t = setTimeout(r, ms);
            this.stopped.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
    }
    async run(pr, existing) {
        const c = this.d.config;
        const prev = this.read()[pr.number];
        let comment = prev?.comment ?? null;
        let env = existing;
        this.update(pr.number, () => ({ head: pr.head, env, outcome: 'running', comment }));
        const post = async (body) => {
            try {
                comment = await this.d.github.comment(pr.number, comment, `${PREVIEW_COMMENT_MARKER}\n${body}`);
            }
            catch (e) {
                this.emit('preview.error', { detail: `PR #${pr.number}: the preview comment wasn't posted: ${plain(e.message)}` });
            }
        };
        const fail = async (outcome, detail) => {
            this.emit('preview.failed', { pr: pr.number, head: pr.head, outcome, detail: plain(detail, 1000) });
            if (env)
                await this.remove(pr.number, env, 'failed');
            await post(`### Preview\nNo preview of \`${short(pr.head)}\`: ${plain(detail)}. It is tried again when the PR's head moves.`);
            this.update(pr.number, () => ({ head: pr.head, env: null, outcome: 'failed', comment }));
        };
        try {
            if (!env) {
                env = await this.d.host.create(`${PREVIEW_ENV_PREFIX}${pr.number}`);
                this.emit('preview.created', { pr: pr.number, head: pr.head, environment: env });
                this.update(pr.number, (x) => ({ ...x, env }));
            }
            const services = c.services;
            const deployments = new Map();
            for (const s of services)
                deployments.set(s.name, await this.d.host.deploy(env, s.id, pr.head));
            const deadline = this.now() + c.timeout_s * 1000;
            let domain = null;
            for (;;) {
                if (this.stopped.signal.aborted)
                    return;
                const st = await Promise.all([...deployments].map(async ([name, id]) => ({ name, ...(await this.d.host.deployment(id)) })));
                const dead = st.find((x) => DEAD.has(x.status));
                if (dead)
                    return await fail('deploy_failed', `the host's deploy of ${dead.name} ended ${dead.status}`);
                if (st.every((x) => x.status === 'SUCCESS')) {
                    domain = st.find((x) => x.name === c.url_service)?.domain ?? null;
                    break;
                }
                if (this.now() >= deadline)
                    return await fail('timed_out', `the host didn't finish deploying within ${c.timeout_s} s`);
                await this.sleep(this.d.pollMs ?? 10_000);
            }
            domain ??= await this.d.host.domain(env, services.find((s) => s.name === c.url_service).id);
            const url = `https://${domain}`;
            const flows = await this.flows(pr, url);
            const lines = [`### Preview`, `- URL: ${url}`, `- Head: \`${short(pr.head)}\``, ...flows.lines];
            await post(lines.join('\n'));
            this.emit('preview.ready', { pr: pr.number, head: pr.head, url, flows: flows.results });
            this.update(pr.number, () => ({ head: pr.head, env, outcome: 'ready', comment }));
        }
        catch (e) {
            await fail('error', e.message);
        }
    }
    async flows(pr, origin) {
        const results = [];
        const lines = [];
        const app = this.d.app;
        if (!app)
            return { results, lines: ['- Flows: none (no app.yaml)'] };
        const names = this.d.config.flows ?? Object.keys(app.flows);
        const outDir = join(this.d.stateDir, 'previews', `pr-${pr.number}`, short(pr.head));
        mkdirSync(outDir, { recursive: true });
        await this.d.github.detach(`pr-${pr.number}-`).catch(() => { });
        for (const flow of names) {
            let run;
            try {
                run = await this.d.runFlow({ app, flow, origin, outDir });
            }
            catch (e) {
                results.push({ flow, status: 'fail', detail: plain(e.message, 500) });
                lines.push(`- \`${flow}\`: fail: ${plain(e.message)}`);
                continue;
            }
            if ('skipped' in run) {
                results.push({ flow, status: 'unavailable', detail: plain(run.skipped, 500) });
                lines.push(`- \`${flow}\`: unavailable: ${plain(run.skipped)}`);
                continue;
            }
            const v = judgeFlow(run, app.thresholds);
            const detail = v.pass ? 'passed' : v.reasons.join('; ');
            results.push({ flow, status: v.pass ? 'pass' : 'fail', detail: plain(detail, 500) });
            lines.push(`- \`${flow}\`: ${v.pass ? 'pass' : `fail: ${plain(detail)}`}`);
            if (run.screenshot && existsSync(run.screenshot)) {
                try {
                    const at = await this.d.github.attach(`pr-${pr.number}-${short(pr.head)}-${basename(run.screenshot)}`, readFileSync(run.screenshot));
                    lines.push(`  ![${flow}](${at})`);
                }
                catch (e) {
                    lines.push(`  - screenshot not attached: ${plain(e.message)}`);
                }
            }
        }
        return { results, lines };
    }
}
//# sourceMappingURL=previews.js.map