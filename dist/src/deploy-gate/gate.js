// The pre-deploy gate (docs/deploy-gate.md). A project's host deploys production from a branch (tests.yaml
// deploy_gate.branch) that only this gate moves, and only forward:
//
//   1. For each new tip of the default branch, it runs the configured test_run tiers on that exact commit (a post-merge
//      run, through the same test-run service as PRs) and posts a `deploy-gate` check on it.
//   2. Every tier green on that commit: the deploy branch is fast-forwarded to it with a plain ref update (force false;
//      GitHub refuses anything but a fast-forward), and only when the commit descends from where the branch is now.
//      Commits merged while a run was going are skipped: the next run is on the newest tip.
//   3. Any tier red, or the run couldn't go ahead: the branch stays where it is (held), and that is recorded.
//   4. The branch not where the gate last put it (someone pushed it): if it is off the default branch's line, nothing
//      moves until a person puts it back; either way a watchdog incident is raised. GitHub Free can't stop the push.
//
// 5. After each move, the post-deploy check (post-deploy.ts, deploy_gate.post_deploy) waits for the host's deploy of
//    the commit and smoke-tests production; a commit that failed it is never moved to again (by the gate or an override).
//
// An owner may override from Discord (`deploy <sha>`, src/coordinator/deploy-commands.ts): a commit on the default
// branch's first-parent line, moved by the same fast-forward-only path, recorded with the gate's state at the time.
import { TestRunHeld } from '../testrun/gate.js';
import { GPU_NO_REPEAT, gpuRunsNotToRepeat } from '../testrun/gpu.js';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { writeGroupOnly } from '../os/index.js';
import { DEPLOY_GATE_INCIDENT, DEPLOY_GATE_OFF } from './config.js';
/** The body of the ref update: never a force. */
export function refUpdateBody(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`a ref update needs the full commit, not ${sha}`);
    return { sha, force: false };
}
const VERDICTS_KEPT = 50;
export class DeployGate {
    d;
    lastPoll = -Infinity;
    running = null;
    stopped = new AbortController();
    constructor(d) {
        this.d = d;
        if (d.config.branch === d.defaultBranch)
            throw new Error(`deploy_gate.branch can't be the default branch (${d.defaultBranch})`);
    }
    get file() {
        return join(this.d.stateDir, 'deploy-gate.json');
    }
    read() {
        if (!existsSync(this.file))
            return { lastRun: null, deployed: null, verdicts: [], failed: [] };
        try {
            const j = JSON.parse(readFileSync(this.file, 'utf8'));
            return { lastRun: j.lastRun ?? null, deployed: j.deployed ?? null, verdicts: Array.isArray(j.verdicts) ? j.verdicts : [], failed: Array.isArray(j.failed) ? j.failed : [] };
        }
        catch {
            return { lastRun: null, deployed: null, verdicts: [], failed: [] };
        }
    }
    write(f) {
        const tmp = `${this.file}.${process.pid}.tmp`;
        writeGroupOnly(tmp, JSON.stringify({ ...f, verdicts: f.verdicts.slice(-VERDICTS_KEPT), failed: f.failed.slice(-VERDICTS_KEPT) }, null, 2));
        renameSync(tmp, this.file);
    }
    emit(type, payload) {
        this.d.log.append(type, payload, this.d.actor);
    }
    get branch() {
        return this.d.config.branch;
    }
    /** A commit that failed the post-deploy check in production: the branch is never moved to it again. */
    markFailed(sha, reason) {
        const f = this.read();
        this.write({ ...f, failed: [...f.failed.filter((x) => x.sha !== sha), { sha, reason: reason.slice(0, 500) }] });
    }
    /** Whether `sha` failed the post-deploy check. */
    failedPostDeploy(sha) {
        return this.read().failed.some((x) => x.sha === sha);
    }
    /** The gate's state for `sha`: its verdict, running now, or none. */
    stateOf(sha) {
        if (this.running?.sha === sha)
            return 'running';
        const v = this.read().verdicts.filter((x) => x.sha === sha).at(-1);
        return v ? (v.ok ? 'green' : 'red') : 'unchecked';
    }
    /**
     * One pass, at most every pollMs: fetch both branches, check the deploy branch is where the gate left it, and start
     * a run on the default branch's tip when it is new and no run is going. The run is not waited for.
     */
    async step() {
        // Off (deploy_gate.enabled not true): no run, no move, no post-deploy check.
        if (this.stopped.signal.aborted || !this.d.config.enabled)
            return;
        this.d.postDeploy?.step();
        if (this.running)
            return;
        const now = (this.d.now ?? Date.now)();
        if (now - this.lastPoll < (this.d.pollMs ?? 90_000))
            return;
        this.lastPoll = now;
        const tips = this.d.git.fetch();
        this.watchDeploy(tips);
        const f = this.read();
        if (f.lastRun === tips.main || tips.deploy === tips.main)
            return;
        const sha = tips.main;
        const controller = new AbortController();
        const entry = { sha, controller, done: Promise.resolve() };
        entry.done = this.runOn(sha, tips.deploy, controller).finally(() => {
            if (this.running === entry)
                this.running = null;
        });
        this.running = entry;
    }
    /**
     * The deploy branch moved outside the gate: an incident (once per position), and a refusal record when it is off
     * the default branch's line. Back where the gate put it (or the gate moves it on): resolved.
     */
    watchDeploy(tips) {
        const f = this.read();
        if (tips.deploy === null)
            return;
        if (f.deployed === null) {
            // First sight of the branch: where it is now is the starting point, if it is on the default branch's line.
            if (this.d.git.isAncestor(tips.deploy, tips.main))
                return this.write({ ...f, deployed: tips.deploy });
        }
        if (tips.deploy === f.deployed)
            return this.d.incidents?.resolveIncident(DEPLOY_GATE_INCIDENT, this.branch);
        const off = !this.d.git.isAncestor(tips.deploy, tips.main);
        const reason = off
            ? `${this.branch} is at ${tips.deploy.slice(0, 8)}, which is not on the default branch's line (someone pushed to it); the gate moves nothing until it is put back`
            : `${this.branch} is at ${tips.deploy.slice(0, 8)}, not where the gate put it (${f.deployed?.slice(0, 8) ?? 'nowhere yet'}): someone pushed a commit the gate didn't pass`;
        this.raise(tips.deploy, tips.main, null, reason, off);
    }
    raise(deploy, main, target, reason, off) {
        const seen = this.d.log.read(0, ['deploy_gate.refused']).some((e) => {
            const p = e.payload;
            return p.deploy === deploy && p.reason === reason;
        });
        if (!seen)
            this.emit('deploy_gate.refused', { branch: this.branch, deploy, main, target, reason });
        this.d.incidents?.raiseIncident(DEPLOY_GATE_INCIDENT, this.branch, reason, off
            ? `Put ${this.branch} back on a commit the gate passed (git push origin <sha>:refs/heads/${this.branch} --force-with-lease, by a person), then check what the host deployed meanwhile.`
            : `Check what the host deployed from ${this.branch}; the gate moves it on at the next green commit of the default branch.`);
    }
    async runOn(sha, deploy, controller) {
        const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
        let changedFiles = [];
        try {
            changedFiles = this.d.git.changed(deploy && this.d.git.isAncestor(deploy, sha) ? deploy : null, sha);
        }
        catch {
            changedFiles = [];
        }
        // A GPU run of this commit cut off by a stop of the coordinator or the machine is never run again by itself
        // (src/testrun/gpu.ts): it gets a red verdict instead, and the branch stays where it is.
        const cutOff = gpuRunsNotToRepeat(this.d.log.read(0, ['testrun.queued', 'testrun.started', 'testrun.finished']), sha).at(-1);
        if (cutOff)
            return this.verdict(sha, deploy, cutOff, false, [...this.d.config.tiers], `its GPU run ${cutOff} was cut off: ${GPU_NO_REPEAT}`);
        let result;
        try {
            result = await this.d.start({ repo: this.d.repo, sha, kind: 'full', prs: [], changedFiles, tiers: this.d.config.tiers }, { signal });
        }
        catch (e) {
            // WHY: held at the gate (src/testrun/gate.ts) is no verdict: the branch stays, and a later pass runs this commit.
            if (e instanceof TestRunHeld)
                return;
            return this.verdict(sha, deploy, null, false, [...this.d.config.tiers], `the run couldn't start: ${e.message.slice(0, 500)}`);
        }
        // The coordinator stopping: no verdict; the same commit runs again after the restart.
        if (signal.aborted || result.outcome === 'cancelled')
            return;
        const failed = this.d.config.tiers.filter((t) => !result.tiers.some((r) => r.tier === t && r.ok));
        const ok = result.outcome === 'done' && failed.length === 0;
        const reason = ok ? 'every gate tier passed' : result.outcome !== 'done' ? `the run couldn't go ahead (${result.outcome})` : `failed: ${failed.join(', ')}`;
        try {
            await this.d.post(sha, result);
        }
        catch (e) {
            this.emit('coordinator.error', { instance: this.d.actor, where: `deploy gate checks on ${sha.slice(0, 8)}`, kind: 'error', message: e.message.slice(0, 500) });
        }
        await this.verdict(sha, deploy, result.id, ok, failed, reason);
    }
    async verdict(sha, deploy, run, ok, failed, reason) {
        const f = this.read();
        this.write({ ...f, lastRun: sha, verdicts: [...f.verdicts, { sha, ok, reason }] });
        this.emit('deploy_gate.verdict', { sha, ok, failed, reason, run });
        if (!ok) {
            this.emit('deploy_gate.held', { branch: this.branch, sha, deployed: this.read().deployed ?? deploy, reason });
            return;
        }
        await this.advance(sha, { by: 'gate', override: false, gate: 'green' });
    }
    /**
     * Fast-forward the deploy branch to `target`: only when `target` is on the default branch's line and descends from
     * where the branch is now, and the branch is where the gate left it or on the default branch's line. Never forced.
     */
    async advance(target, meta) {
        if (!this.d.config.enabled)
            return { ok: false, reason: DEPLOY_GATE_OFF };
        const tips = this.d.git.fetch();
        const f = this.read();
        const deploy = tips.deploy;
        if (!this.d.git.isAncestor(target, tips.main))
            return { ok: false, reason: `${target.slice(0, 8)} is not on the default branch` };
        if (f.failed.some((x) => x.sha === target))
            return { ok: false, reason: `${target.slice(0, 8)} failed its post-deploy check in production: ${this.branch} is never moved to it again` };
        if (deploy === target) {
            if (f.deployed !== target)
                this.write({ ...f, deployed: target });
            return { ok: false, reason: `${this.branch} is at ${target.slice(0, 8)} already` };
        }
        if (deploy !== null && !this.d.git.isAncestor(deploy, tips.main)) {
            const reason = `${this.branch} is at ${deploy.slice(0, 8)}, which is not on the default branch's line (someone pushed to it); not moved to ${target.slice(0, 8)}`;
            this.raise(deploy, tips.main, target, reason, true);
            return { ok: false, reason };
        }
        if (deploy !== null && !this.d.git.isAncestor(deploy, target))
            return { ok: false, reason: `${this.branch} is at ${deploy.slice(0, 8)}, past ${target.slice(0, 8)}: never moved back` };
        const r = deploy === null ? await this.d.refs.create(target) : await this.d.refs.fastForward(target);
        if (!r.ok) {
            // 422: not a fast-forward any more (the branch moved between the fetch and the update), or it exists already.
            const reason = `GitHub refused moving ${this.branch} to ${target.slice(0, 8)} (${r.status}): ${r.message.slice(0, 300)}`;
            if (r.status === 422)
                this.raise(deploy, tips.main, target, reason, false);
            else
                this.emit('coordinator.error', { instance: this.d.actor, where: 'deploy gate', kind: 'error', message: reason });
            return { ok: false, reason };
        }
        this.write({ ...this.read(), deployed: target });
        this.emit('deploy_gate.moved', { branch: this.branch, from: deploy, to: target, by: meta.by, override: meta.override, gate: meta.gate });
        this.d.postDeploy?.start(target, deploy);
        this.d.incidents?.resolveIncident(DEPLOY_GATE_INCIDENT, this.branch);
        return { ok: true, from: deploy };
    }
    /**
     * Whether an owner may deploy `ref` now: a commit on the default branch's first-parent line. Its full sha and the
     * gate's state for it, or why not. Moves nothing.
     */
    checkOverride(ref) {
        if (!this.d.config.enabled)
            return { ok: false, reason: DEPLOY_GATE_OFF };
        if (!/^[0-9a-f]{7,40}$/.test(ref))
            return { ok: false, reason: `${ref.slice(0, 50)} is not a commit sha` };
        const tips = this.d.git.fetch();
        const sha = this.d.git.resolve(ref);
        if (!sha || !sha.startsWith(ref))
            return { ok: false, reason: `${ref} is not a commit here` };
        if (!this.d.git.onFirstParent(sha, tips.main))
            return { ok: false, reason: `${sha.slice(0, 8)} is not on the default branch's first-parent line` };
        if (this.failedPostDeploy(sha))
            return { ok: false, reason: `${sha.slice(0, 8)} failed its post-deploy check in production; it is never deployed again` };
        return { ok: true, sha, gate: this.stateOf(sha) };
    }
    /** An owner's confirmed override: checked again, then the same fast-forward-only move. */
    async override(ref, by) {
        const c = this.checkOverride(ref);
        if (!c.ok)
            return { ok: false, reason: c.reason, gate: null };
        const label = c.gate === 'green' ? 'override while green' : `override while ${c.gate}`;
        const r = await this.advance(c.sha, { by, override: true, gate: label });
        return r.ok ? { ok: true, sha: c.sha, gate: c.gate, from: r.from } : { ok: false, reason: r.reason, gate: c.gate };
    }
    /** Wait for the run in flight (tests and shutdown). */
    async idle() {
        while (this.running)
            await this.running.done;
        await this.d.postDeploy?.idle();
    }
    stop() {
        this.stopped.abort();
        this.d.postDeploy?.stop();
        this.running?.controller.abort();
    }
}
/** The gate for the dashboard: where the branch is, the last held commit and why, and a refusal in force. */
export function deployGateView(stateDir, events, repo, branch) {
    const last = (t) => {
        const e = events.filter((x) => x.type === t).at(-1);
        return e ? { at: e.ts, p: e.payload } : null;
    };
    let deployed = null;
    try {
        deployed = JSON.parse(readFileSync(join(stateDir, 'deploy-gate.json'), 'utf8')).deployed ?? null;
    }
    catch {
        deployed = null;
    }
    const moved = last('deploy_gate.moved');
    const held = last('deploy_gate.held');
    const refused = last('deploy_gate.refused');
    const url = (sha) => `https://github.com/${repo}/commit/${sha}`;
    return {
        branch,
        deployed: deployed ? { sha: deployed, url: url(deployed), at: moved && moved.p.to === deployed ? moved.at : null, by: moved && moved.p.to === deployed ? moved.p.by : null, override: !!(moved && moved.p.to === deployed && moved.p.override) } : null,
        // The last held commit, while the branch hasn't moved past it since.
        held: held && (!moved || held.at >= moved.at) ? { sha: held.p.sha, url: url(held.p.sha), at: held.at, reason: held.p.reason } : null,
        refused: refused && (!moved || refused.at >= moved.at) ? { at: refused.at, reason: refused.p.reason } : null,
    };
}
//# sourceMappingURL=gate.js.map