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
// An owner may override from Discord (`deploy <sha>`, src/coordinator/deploy-commands.ts): a commit on the default
// branch's first-parent line, moved by the same fast-forward-only path, recorded with the gate's state at the time.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '../events/log.js';
import type { EventPayload, EventType } from '../events/types.js';
import { writeGroupOnly } from '../os/index.js';
import type { IncidentSink } from '../usage-limit.js';
import type { TestRunRequest, TestRunResult } from '../testrun/index.js';
import { DEPLOY_GATE_INCIDENT, type DeployGateConfig } from './config.js';

/** What the gate reads with git, in the coordinator's clone. */
export interface GateGit {
  /** Fetch the default branch and the deploy branch; their tips (deploy null when the branch doesn't exist). */
  fetch(): { main: string; deploy: string | null };
  /** Whether `a` is `b` or an ancestor of it. */
  isAncestor(a: string, b: string): boolean;
  /** Whether `sha` is on `tip`'s first-parent line (`tip` itself included). */
  onFirstParent(sha: string, tip: string): boolean;
  /** The full sha of a commit in the clone, or null. */
  resolve(ref: string): string | null;
  /** The files `to` changes since `from` (from null: since its first parent). */
  changed(from: string | null, to: string): string[];
}

export type RefResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * The deploy branch's one write: a fast-forward to `sha` (PATCH git/refs, force false), or the branch's creation
 * when it doesn't exist yet. There is no way to force it: refUpdateBody is the only body either sends.
 */
export interface DeployRefs {
  fastForward(sha: string): Promise<RefResult>;
  create(sha: string): Promise<RefResult>;
}

/** The body of the ref update: never a force. */
export function refUpdateBody(sha: string): { sha: string; force: false } {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`a ref update needs the full commit, not ${sha}`);
  return { sha, force: false };
}

export interface GateDeps {
  config: DeployGateConfig;
  /** The default branch (the gate refuses to be configured on it). */
  defaultBranch: string;
  git: GateGit;
  refs: DeployRefs;
  log: EventLog;
  actor: string;
  stateDir: string;
  /** A run of the gate's tiers on a commit (startTestRun with `tiers`). */
  start: (req: TestRunRequest, o: { signal: AbortSignal }) => Promise<TestRunResult>;
  /** Post the run's checks on the commit: its tiers' own and the `deploy-gate` one. */
  post: (sha: string, result: TestRunResult) => Promise<void>;
  /** The coordinator's clone (the run's repo). */
  repo: string;
  incidents?: IncidentSink;
  /** How often the branches are fetched (default 90 s). */
  pollMs?: number;
  now?: () => number;
}

interface GateFile {
  /** The last default-branch commit a verdict (or a failed run) was recorded for: never run again. */
  lastRun: string | null;
  /** Where the gate last saw or put the deploy branch. */
  deployed: string | null;
  /** Recent verdicts, newest last: the gate's state for an override. */
  verdicts: { sha: string; ok: boolean; reason: string }[];
}

const VERDICTS_KEPT = 50;

/** The gate's state for one commit, as an override records it. */
export type GateState = 'green' | 'red' | 'running' | 'unchecked';

export class DeployGate {
  private lastPoll = -Infinity;
  private running: { sha: string; controller: AbortController; done: Promise<void> } | null = null;
  private readonly stopped = new AbortController();

  constructor(private d: GateDeps) {
    if (d.config.branch === d.defaultBranch) throw new Error(`deploy_gate.branch can't be the default branch (${d.defaultBranch})`);
  }

  private get file() {
    return join(this.d.stateDir, 'deploy-gate.json');
  }

  private read(): GateFile {
    if (!existsSync(this.file)) return { lastRun: null, deployed: null, verdicts: [] };
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<GateFile>;
      return { lastRun: j.lastRun ?? null, deployed: j.deployed ?? null, verdicts: Array.isArray(j.verdicts) ? j.verdicts : [] };
    } catch {
      return { lastRun: null, deployed: null, verdicts: [] };
    }
  }

  private write(f: GateFile) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeGroupOnly(tmp, JSON.stringify({ ...f, verdicts: f.verdicts.slice(-VERDICTS_KEPT) }, null, 2));
    renameSync(tmp, this.file);
  }

  private emit<T extends EventType>(type: T, payload: EventPayload<T>) {
    this.d.log.append(type, payload, this.d.actor);
  }

  get branch() {
    return this.d.config.branch;
  }

  /** The gate's state for `sha`: its verdict, running now, or none. */
  stateOf(sha: string): GateState {
    if (this.running?.sha === sha) return 'running';
    const v = this.read().verdicts.filter((x) => x.sha === sha).at(-1);
    return v ? (v.ok ? 'green' : 'red') : 'unchecked';
  }

  /**
   * One pass, at most every pollMs: fetch both branches, check the deploy branch is where the gate left it, and start
   * a run on the default branch's tip when it is new and no run is going. The run is not waited for.
   */
  async step(): Promise<void> {
    if (this.stopped.signal.aborted || this.running) return;
    const now = (this.d.now ?? Date.now)();
    if (now - this.lastPoll < (this.d.pollMs ?? 90_000)) return;
    this.lastPoll = now;
    const tips = this.d.git.fetch();
    this.watchDeploy(tips);
    const f = this.read();
    if (f.lastRun === tips.main || tips.deploy === tips.main) return;
    const sha = tips.main;
    const controller = new AbortController();
    const entry = { sha, controller, done: Promise.resolve() };
    entry.done = this.runOn(sha, tips.deploy, controller).finally(() => {
      if (this.running === entry) this.running = null;
    });
    this.running = entry;
  }

  /**
   * The deploy branch moved outside the gate: an incident (once per position), and a refusal record when it is off
   * the default branch's line. Back where the gate put it (or the gate moves it on): resolved.
   */
  private watchDeploy(tips: { main: string; deploy: string | null }) {
    const f = this.read();
    if (tips.deploy === null) return;
    if (f.deployed === null) {
      // First sight of the branch: where it is now is the starting point, if it is on the default branch's line.
      if (this.d.git.isAncestor(tips.deploy, tips.main)) return this.write({ ...f, deployed: tips.deploy });
    }
    if (tips.deploy === f.deployed) return this.d.incidents?.resolveIncident(DEPLOY_GATE_INCIDENT, this.branch);
    const off = !this.d.git.isAncestor(tips.deploy, tips.main);
    const reason = off
      ? `${this.branch} is at ${tips.deploy.slice(0, 8)}, which is not on the default branch's line (someone pushed to it); the gate moves nothing until it is put back`
      : `${this.branch} is at ${tips.deploy.slice(0, 8)}, not where the gate put it (${f.deployed?.slice(0, 8) ?? 'nowhere yet'}): someone pushed a commit the gate didn't pass`;
    this.raise(tips.deploy, tips.main, null, reason, off);
  }

  private raise(deploy: string | null, main: string, target: string | null, reason: string, off: boolean) {
    const seen = this.d.log.read(0, ['deploy_gate.refused']).some((e) => {
      const p = e.payload as EventPayload<'deploy_gate.refused'>;
      return p.deploy === deploy && p.reason === reason;
    });
    if (!seen) this.emit('deploy_gate.refused', { branch: this.branch, deploy, main, target, reason });
    this.d.incidents?.raiseIncident(
      DEPLOY_GATE_INCIDENT,
      this.branch,
      reason,
      off
        ? `Put ${this.branch} back on a commit the gate passed (git push origin <sha>:refs/heads/${this.branch} --force-with-lease, by a person), then check what the host deployed meanwhile.`
        : `Check what the host deployed from ${this.branch}; the gate moves it on at the next green commit of the default branch.`,
    );
  }

  private async runOn(sha: string, deploy: string | null, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, this.stopped.signal]);
    let changedFiles: string[] = [];
    try {
      changedFiles = this.d.git.changed(deploy && this.d.git.isAncestor(deploy, sha) ? deploy : null, sha);
    } catch {
      changedFiles = [];
    }
    let result: TestRunResult;
    try {
      result = await this.d.start({ repo: this.d.repo, sha, kind: 'full', prs: [], changedFiles, tiers: this.d.config.tiers }, { signal });
    } catch (e) {
      return this.verdict(sha, deploy, null, false, [...this.d.config.tiers], `the run couldn't start: ${(e as Error).message.slice(0, 500)}`);
    }
    // The coordinator stopping: no verdict; the same commit runs again after the restart.
    if (signal.aborted || result.outcome === 'cancelled') return;
    const failed = this.d.config.tiers.filter((t) => !result.tiers.some((r) => r.tier === t && r.ok));
    const ok = result.outcome === 'done' && failed.length === 0;
    const reason = ok ? 'every gate tier passed' : result.outcome !== 'done' ? `the run couldn't go ahead (${result.outcome})` : `failed: ${failed.join(', ')}`;
    try {
      await this.d.post(sha, result);
    } catch (e) {
      this.emit('coordinator.error', { instance: this.d.actor, where: `deploy gate checks on ${sha.slice(0, 8)}`, kind: 'error', message: (e as Error).message.slice(0, 500) });
    }
    await this.verdict(sha, deploy, result.id, ok, failed, reason);
  }

  private async verdict(sha: string, deploy: string | null, run: string | null, ok: boolean, failed: string[], reason: string) {
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
  async advance(target: string, meta: { by: string; override: boolean; gate: string }): Promise<{ ok: true; from: string | null } | { ok: false; reason: string }> {
    const tips = this.d.git.fetch();
    const f = this.read();
    const deploy = tips.deploy;
    if (!this.d.git.isAncestor(target, tips.main)) return { ok: false, reason: `${target.slice(0, 8)} is not on the default branch` };
    if (deploy === target) {
      if (f.deployed !== target) this.write({ ...f, deployed: target });
      return { ok: false, reason: `${this.branch} is at ${target.slice(0, 8)} already` };
    }
    if (deploy !== null && !this.d.git.isAncestor(deploy, tips.main)) {
      const reason = `${this.branch} is at ${deploy.slice(0, 8)}, which is not on the default branch's line (someone pushed to it); not moved to ${target.slice(0, 8)}`;
      this.raise(deploy, tips.main, target, reason, true);
      return { ok: false, reason };
    }
    if (deploy !== null && !this.d.git.isAncestor(deploy, target)) return { ok: false, reason: `${this.branch} is at ${deploy.slice(0, 8)}, past ${target.slice(0, 8)}: never moved back` };
    const r = deploy === null ? await this.d.refs.create(target) : await this.d.refs.fastForward(target);
    if (!r.ok) {
      // 422: not a fast-forward any more (the branch moved between the fetch and the update), or it exists already.
      const reason = `GitHub refused moving ${this.branch} to ${target.slice(0, 8)} (${r.status}): ${r.message.slice(0, 300)}`;
      if (r.status === 422) this.raise(deploy, tips.main, target, reason, false);
      else this.emit('coordinator.error', { instance: this.d.actor, where: 'deploy gate', kind: 'error', message: reason });
      return { ok: false, reason };
    }
    this.write({ ...this.read(), deployed: target });
    this.emit('deploy_gate.moved', { branch: this.branch, from: deploy, to: target, by: meta.by, override: meta.override, gate: meta.gate });
    this.d.incidents?.resolveIncident(DEPLOY_GATE_INCIDENT, this.branch);
    return { ok: true, from: deploy };
  }

  /**
   * Whether an owner may deploy `ref` now: a commit on the default branch's first-parent line. Its full sha and the
   * gate's state for it, or why not. Moves nothing.
   */
  checkOverride(ref: string): { ok: true; sha: string; gate: GateState } | { ok: false; reason: string } {
    if (!/^[0-9a-f]{7,40}$/.test(ref)) return { ok: false, reason: `${ref.slice(0, 50)} is not a commit sha` };
    const tips = this.d.git.fetch();
    const sha = this.d.git.resolve(ref);
    if (!sha || !sha.startsWith(ref)) return { ok: false, reason: `${ref} is not a commit here` };
    if (!this.d.git.onFirstParent(sha, tips.main)) return { ok: false, reason: `${sha.slice(0, 8)} is not on the default branch's first-parent line` };
    return { ok: true, sha, gate: this.stateOf(sha) };
  }

  /** An owner's confirmed override: checked again, then the same fast-forward-only move. */
  async override(ref: string, by: string): Promise<{ ok: true; sha: string; gate: GateState; from: string | null } | { ok: false; reason: string; gate: GateState | null }> {
    const c = this.checkOverride(ref);
    if (!c.ok) return { ok: false, reason: c.reason, gate: null };
    const label = c.gate === 'green' ? 'override while green' : `override while ${c.gate}`;
    const r = await this.advance(c.sha, { by, override: true, gate: label });
    return r.ok ? { ok: true, sha: c.sha, gate: c.gate, from: r.from } : { ok: false, reason: r.reason, gate: c.gate };
  }

  /** Wait for the run in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  stop(): void {
    this.stopped.abort();
    this.running?.controller.abort();
  }
}

/** The gate for the dashboard: where the branch is, the last held commit and why, and a refusal in force. */
export function deployGateView(stateDir: string, events: readonly { type: string; ts: string; payload: unknown }[], repo: string, branch: string) {
  const last = <T extends EventType>(t: T) => {
    const e = events.filter((x) => x.type === t).at(-1);
    return e ? { at: e.ts, p: e.payload as EventPayload<T> } : null;
  };
  let deployed: string | null = null;
  try {
    deployed = (JSON.parse(readFileSync(join(stateDir, 'deploy-gate.json'), 'utf8')) as { deployed?: string | null }).deployed ?? null;
  } catch {
    deployed = null;
  }
  const moved = last('deploy_gate.moved');
  const held = last('deploy_gate.held');
  const refused = last('deploy_gate.refused');
  const url = (sha: string) => `https://github.com/${repo}/commit/${sha}`;
  return {
    branch,
    deployed: deployed ? { sha: deployed, url: url(deployed), at: moved && moved.p.to === deployed ? moved.at : null, by: moved && moved.p.to === deployed ? moved.p.by : null, override: !!(moved && moved.p.to === deployed && moved.p.override) } : null,
    // The last held commit, while the branch hasn't moved past it since.
    held: held && (!moved || held.at >= moved.at) ? { sha: held.p.sha, url: url(held.p.sha), at: held.at, reason: held.p.reason } : null,
    refused: refused && (!moved || refused.at >= moved.at) ? { at: refused.at, reason: refused.p.reason } : null,
  };
}
