// Replaying a fixed past task through the real coordinator: a scratch instance (its own event log, a file backlog,
// its own state and slots) on a scratch clone whose default branch is the task's base commit, pushed to a local bare
// remote, so nothing reaches GitHub. The agents are the real ones (the runner given), within the run's budget. A
// scratch clone is deleted when its replay ends. The engine is the one running the replay (the harness under test);
// the task's project config is its own at the base, except the harness config taken from the harness under test
// (HARNESS_CONFIG_PATHS), so a change to that config is what the replay measures.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from '../brand.js';
import { FileBacklog } from '../backlog/file.js';
import { loadConfig } from '../config/load.js';
import { Coordinator } from '../coordinator.js';
import type { CoordinatorDeps } from '../coordinator/shared.js';
import { EventLog } from '../events/log.js';
import type { EventPayload, EventType } from '../events/types.js';
import { DEFAULT_COMMIT_IDENTITY, type AgentRunner, type RunRequest, type RunResult } from '../runner.js';
import { makeSlotDir, slotFile, writeSlotFile } from '../slot-file.js';
import { slotDirAt } from '../os/index.js';
import { round, scoreReplay, totals, type TaskScore } from './score.js';
import { issueBody, type LoadedTask } from './tasks.js';

/**
 * The run's budget over every agent run in it: each run is capped at what is left, and once it is spent no run
 * starts (it ends as budget_exhausted, as a real budget stop does), so the replay in flight stops and no other starts.
 */
export class BudgetRunner implements AgentRunner {
  spent = 0;
  /** Every run's reported turns. */
  turns = 0;
  hit = false;
  constructor(
    private inner: AgentRunner,
    readonly budgetUsd: number,
  ) {}
  get left(): number {
    return Math.max(0, this.budgetUsd - this.spent);
  }
  /** Under a cent left counts as spent: no run can do anything with it. */
  get exhausted(): boolean {
    return this.hit || this.left < 0.01;
  }
  async run(req: RunRequest): Promise<RunResult> {
    if (this.exhausted) {
      this.hit = true;
      return { reason: 'budget_exhausted', detail: `the harness eval budget ($${this.budgetUsd}) is spent`, costUsd: 0, turns: 0, model: req.model };
    }
    const cap = Math.min(req.maxBudgetUsd, this.left);
    const r = await this.inner.run({ ...req, maxBudgetUsd: cap });
    this.spent = round(this.spent + r.costUsd);
    this.turns += r.turns;
    if (r.reason === 'budget_exhausted' && cap < req.maxBudgetUsd) this.hit = true;
    if (this.left < 0.01) this.hit = true;
    return r;
  }
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 }).trim();

/** The engine's own identity on the scratch config commit, as an agent session commits. */
function commit(cwd: string, msg: string) {
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/**
 * The scratch instance's config, committed on top of the base: a file backlog, direct landing into the local remote,
 * and nothing scheduled, paid or networked beyond the agents (no nightly runs, test runs, deploy gate, PR previews,
 * gardener, optimization pass, checks from feedback, or harness evals of its own). Intake is never wired into it. The daily
 * budget is at most the run's.
 */
export function scratchConfig(root: string, budgetUsd: number): void {
  const dir = join(root, BRAND.configDir);
  const edit = (file: string, fn: (d: ReturnType<typeof parseDocument>) => void) => {
    const f = join(dir, file);
    if (!existsSync(f)) return;
    const d = parseDocument(readFileSync(f, 'utf8'));
    fn(d);
    writeFileSync(f, d.toString());
  };
  edit('config.yaml', (d) => {
    d.set('backlog', 'file');
    d.set('land_mode', 'direct');
    d.deleteIn(['gardener']);
    d.setIn(['gardener', 'enabled'], false);
    d.deleteIn(['harness_evals']);
    d.deleteIn(['optimize']);
    d.deleteIn(['checks_from_feedback']);
  });
  edit('tests.yaml', (d) => {
    for (const k of ['nightly_at', 'test_run', 'deploy_gate', 'preview']) d.delete(k);
  });
  edit('agents.yaml', (d) => {
    const cur = Number(d.get('daily_budget_usd') ?? budgetUsd);
    d.set('daily_budget_usd', Math.min(Number.isFinite(cur) ? cur : budgetUsd, budgetUsd));
  });
}

/**
 * The config folder's paths a replay takes from the harness under test instead of the task's base: the base predates
 * the harness config being measured, so without this a replay never sees it. Only rules for agents, never project
 * history: lessons, checks, runbooks and skills are left out, since they record what the project learned later,
 * possibly from the task's own fix (its future).
 */
export const HARNESS_CONFIG_PATHS = ['principles'] as const;

/** A snapshot of the harness under test's harness config: each file under HARNESS_CONFIG_PATHS, relative to the config folder. */
export interface HarnessConfig {
  from: string;
  files: { path: string; content: Buffer }[];
}

/**
 * Read the harness config of a checkout (the harness under test), once per run, so every replay sees the same
 * snapshot however the checkout changes meanwhile. Fails closed: a checkout without a config folder, or anything in
 * those paths but plain files and folders (a link could bring in what lies outside them), refuses the run.
 */
export function readHarnessConfig(from: string): HarnessConfig {
  const dir = join(from, BRAND.configDir);
  const stat = (f: string) => {
    try {
      return lstatSync(f);
    } catch {
      return null;
    }
  };
  if (!stat(dir)?.isDirectory()) throw new Error(`${from} has no ${BRAND.configDir} folder: not a project checkout to take the harness config under test from`);
  const files: HarnessConfig['files'] = [];
  const walk = (f: string) => {
    const st = stat(f);
    if (!st) return;
    if (st.isDirectory()) for (const e of readdirSync(f).sort()) walk(join(f, e));
    else if (st.isFile()) files.push({ path: relative(dir, f), content: readFileSync(f) });
    else throw new Error(`${BRAND.configDir}/${relative(dir, f)} in the harness under test is not a regular file or folder (a link?): refused, so nothing outside its harness config reaches a replay`);
  };
  for (const p of HARNESS_CONFIG_PATHS) walk(join(dir, p));
  return { from, files };
}

/**
 * Replace the task's own harness config with the snapshot's: the replay sees exactly the harness under test's (none if
 * it has none). Every file must land inside one of HARNESS_CONFIG_PATHS: a path that resolves anywhere else (`../x`,
 * `lessons/x`) refuses the whole overlay before anything is removed or written, whoever built the snapshot.
 */
export function overlayHarnessConfig(root: string, h: HarnessConfig): void {
  const dir = resolve(root, BRAND.configDir);
  const inside = (to: string) => HARNESS_CONFIG_PATHS.some((p) => to.startsWith(join(dir, p) + sep));
  const targets = h.files.map((f) => {
    const to = resolve(dir, f.path);
    if (isAbsolute(f.path) || !inside(to)) throw new Error(`harness config file ${JSON.stringify(f.path)} is not inside ${HARNESS_CONFIG_PATHS.map((p) => `${BRAND.configDir}/${p}/`).join(', ')}: refused`);
    return { to, content: f.content };
  });
  for (const p of HARNESS_CONFIG_PATHS) rmSync(join(dir, p), { recursive: true, force: true });
  for (const f of targets) {
    mkdirSync(dirname(f.to), { recursive: true });
    writeFileSync(f.to, f.content);
  }
}

/**
 * The scratch commit holds exactly the snapshot under HARNESS_CONFIG_PATHS: a task repo's .gitignore (or anything
 * else) must not silently drop a principle the agents would then never see.
 */
function checkCommittedHarnessConfig(root: string, h: HarnessConfig): void {
  const committed = git(root, 'ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...HARNESS_CONFIG_PATHS.map((p) => `${BRAND.configDir}/${p}`)).split('\0').filter(Boolean).sort();
  const want = h.files.map((f) => `${BRAND.configDir}/${f.path.split(sep).join('/')}`).sort();
  if (committed.join('\n') !== want.join('\n')) throw new Error(`the scratch commit's harness config differs from the harness under test's (committed: ${committed.join(', ') || 'none'}; expected: ${want.join(', ') || 'none'})`);
}

export interface ReplayOptions {
  runner: BudgetRunner;
  /** The harness under test's harness config, in place of the task's own (readHarnessConfig); none: the task's own. */
  harness?: HarnessConfig;
  /** Where scratch clones go (each in its own new directory, deleted after). */
  workDir: string;
  /** Where to fetch the task's base from: a local clone that has it, or the repository's URL. */
  source: (t: LoadedTask) => string;
  sample: number;
  /** Ticks before a replay that hasn't finished is given up (unfinished). */
  maxTicks?: number;
  /** Wall-clock cap per replay. */
  timeoutMs?: number;
  /** Keep the scratch clone (debugging). */
  keep?: boolean;
  signal?: AbortSignal;
  /** Instance wiring passed through to the scratch coordinator (agents as their own user). */
  deps?: Pick<CoordinatorDeps, 'commandsAs' | 'agentTasks' | 'depCacheRoot' | 'commitIdentity'>;
  /** Readings for the scratch coordinator's machine gates (tests); default: never held by load or disk. */
  machine?: CoordinatorDeps['machine'];
  say?: (line: string) => void;
}

export interface ReplayResult extends TaskScore {
  wallMs: number;
}

/** Events that end a replay: the change is queued to land, the owner is asked, or the task is blocked. */
const ENDS: EventType[] = ['land.queued', 'decision.asked', 'issue.blocked'];

export async function replayTask(t: LoadedTask, o: ReplayOptions): Promise<ReplayResult> {
  const dir = join(o.workDir, `${t.id}-${o.sample}-${randomBytes(3).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  let log: EventLog | null = null;
  try {
    const remote = join(dir, 'remote.git');
    const root = join(dir, 'repo');
    git(dir, 'init', '-q', '--bare', remote);
    git(remote, 'fetch', '-q', '--depth', '1', o.source(t), t.base);
    const cfgText = (() => {
      try {
        return git(remote, 'show', `${t.base}:${BRAND.configDir}/config.yaml`);
      } catch {
        throw new Error(`${t.repo} at ${t.base.slice(0, 8)} has no ${BRAND.configDir}/config.yaml`);
      }
    })();
    const branch = String((parseDocument(cfgText).getIn(['project', 'default_branch']) as string | undefined) ?? 'main');
    git(remote, 'update-ref', `refs/heads/${branch}`, t.base);
    git(remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    git(dir, 'clone', '-q', remote, root);
    for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0']] as const) git(root, 'config', k, v);
    scratchConfig(root, o.runner.budgetUsd);
    if (o.harness) overlayHarnessConfig(root, o.harness);
    git(root, 'add', '-A', '--', BRAND.configDir);
    // Forced: the overlay replaced these folders whole, so nothing in them is the task's to ignore.
    if (o.harness?.files.length) git(root, 'add', '-f', '--', ...o.harness.files.map((f) => `${BRAND.configDir}/${f.path.split(sep).join('/')}`));
    commit(root, `${BRAND.cli} harness eval: scratch instance config`);
    if (o.harness) checkCommittedHarnessConfig(root, o.harness);
    // The remote takes it by fetching from the clone: the engine pushes only through checkedPush (push-check.ts).
    git(remote, 'fetch', '-q', root, `+refs/heads/${branch}:refs/heads/${branch}`);
    git(root, 'fetch', '-q', 'origin');

    const cfg = loadConfig(root);
    const state = join(dir, 'state');
    const slots = slotDirAt(join(state, 'slots'));
    makeSlotDir(slots);
    writeSlotFile(slotFile(slots, 'config.json'), JSON.stringify({ max_agents: 1 }));
    log = new EventLog(join(state, 'events.db'));
    const backlog = new FileBacklog(join(state, 'backlog.json'));
    const owner = cfg.project.owners.default;
    const n = backlog.open({ title: t.title, body: issueBody(t), author: owner, labels: ['ready', ...t.labels] });
    const instance = `harness-eval@${t.id}`;
    const c = new Coordinator({ cfg, log, backlog, runner: o.runner, repo: root, instance, stateDir: state, slotsDir: slots, harnessEvals: { replay: true }, machine: o.machine ?? { load: () => 0, disk: () => ({ freePct: 80, totalGb: 500 }) }, ...(o.deps ?? {}) });
    const stop = () => c.stop();
    o.signal?.addEventListener('abort', stop, { once: true });
    const started = Date.now();
    const ended = () => log!.read(0, ENDS).some((e) => (e.payload as { issue: number | null }).issue === n);
    try {
      log.append('coordinator.started', { instance, pid: process.pid, version: 'harness-eval' }, instance);
      const maxTicks = o.maxTicks ?? 6;
      for (let i = 0; i < maxTicks; i++) {
        await c.tick();
        await c.idle();
        if (ended() || o.runner.exhausted || o.signal?.aborted) break;
        if (Date.now() - started > (o.timeoutMs ?? 3 * 3600_000)) break;
      }
    } finally {
      o.signal?.removeEventListener('abort', stop);
      c.stop();
      await c.idle();
    }
    const wallMs = Date.now() - started;
    return { ...scoreReplay(log.read(), n, { budgetHit: o.runner.hit && !ended() }), wallMs };
  } finally {
    log?.close();
    if (!o.keep) rmSync(dir, { recursive: true, force: true });
  }
}

export interface SuiteOptions extends Omit<ReplayOptions, 'sample' | 'runner' | 'harness'> {
  tasks: LoadedTask[];
  /** A checkout of the harness under test: every replay runs with its harness config (HARNESS_CONFIG_PATHS), read once at the start. */
  harnessConfig?: string;
  samples: number;
  budgetUsd: number;
  /** The agents (the instance's runner, or a CLI runner); wrapped in the run's budget. */
  runner: AgentRunner;
  trigger: EventPayload<'harness_eval.run'>['trigger'];
  engine: string | null;
  pr: number | null;
  /** Records each event in the instance's own log. */
  emit: <T extends EventType>(type: T, payload: EventPayload<T>) => void;
  /** Replays a task (tests inject this); default: replayTask. */
  replay?: (t: LoadedTask, o: ReplayOptions) => Promise<ReplayResult>;
}

/**
 * Run the suite: every task, `samples` times, in order, within the budget. Each replay is recorded as it ends
 * (harness_eval.task, and its spend as a run.cost so the instance's daily budget counts it); then the run
 * (harness_eval.run). Once the budget is spent, nothing more starts and the run says it stopped there.
 */
export async function runSuite(o: SuiteOptions): Promise<EventPayload<'harness_eval.run'>> {
  const id = `he-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const runner = new BudgetRunner(o.runner, o.budgetUsd);
  const replay = o.replay ?? replayTask;
  const done: EventPayload<'harness_eval.task'>[] = [];
  let error: string | undefined;
  let harness: HarnessConfig | undefined;
  try {
    if (o.harnessConfig) {
      harness = readHarnessConfig(o.harnessConfig);
      o.say?.(`harness config under test: ${harness.files.length} file(s) under ${HARNESS_CONFIG_PATHS.map((p) => `${BRAND.configDir}/${p}`).join(', ')} from ${o.harnessConfig}`);
    }
  } catch (e) {
    error = (e as Error).message.slice(0, 500);
  }
  outer: for (const t of error ? [] : o.tasks) {
    for (let s = 1; s <= o.samples; s++) {
      if (runner.exhausted || o.signal?.aborted) break outer;
      o.say?.(`replaying ${t.id} (sample ${s} of ${o.samples}; $${runner.left.toFixed(2)} of $${o.budgetUsd} left)`);
      const before = { spent: runner.spent, turns: runner.turns };
      let r: ReplayResult;
      try {
        r = await replay(t, { ...o, runner, sample: s, ...(harness ? { harness } : {}) });
      } catch (e) {
        const spent = round(runner.spent - before.spent);
        r = { success: false, doneWhen: null, verdict: null, outcome: 'error', costUsd: spent, turns: runner.turns - before.turns, interventions: 0, detail: (e as Error).message.slice(0, 500), wallMs: 0 };
      }
      const p: EventPayload<'harness_eval.task'> = { run: id, task: t.id, held_out: t.heldOut, sample: s, success: r.success, done_when: r.doneWhen, verdict: r.verdict, outcome: r.outcome, cost_usd: r.costUsd, wall_ms: r.wallMs, interventions: r.interventions, turns: r.turns, detail: r.detail };
      o.emit('harness_eval.task', p);
      if (r.costUsd > 0) o.emit('run.cost', { issue: null, role: 'harness-eval', model: 'mixed', usd: r.costUsd, turns: r.turns });
      done.push(p);
      o.say?.(`  ${t.id}: ${r.success ? 'pass' : 'FAIL'} (${r.outcome}) $${r.costUsd.toFixed(2)}, ${(r.wallMs / 60_000).toFixed(1)} min, ${r.turns} turn(s), ${r.interventions} intervention(s)${r.detail ? `: ${r.detail.slice(0, 200)}` : ''}`);
    }
  }
  if (!error && !o.tasks.length) error = 'no tasks';
  const tot = totals(done);
  const run: EventPayload<'harness_eval.run'> = {
    id,
    trigger: o.trigger,
    engine: o.engine,
    pr: o.pr,
    tasks: new Set(done.map((d) => d.task)).size,
    samples: o.samples,
    runs: tot.runs,
    passed: tot.passed,
    cost_usd: tot.costUsd,
    wall_ms: tot.wallMs,
    interventions: tot.interventions,
    turns: tot.turns,
    budget_usd: o.budgetUsd,
    stopped: runner.exhausted && done.length < o.tasks.length * o.samples ? 'budget' : runner.hit ? 'budget' : null,
    ...(error ? { error } : {}),
  };
  o.emit('harness_eval.run', run);
  return run;
}
