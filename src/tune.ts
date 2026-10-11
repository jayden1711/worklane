// `tune`: profile a project's test suite once, on this machine, and propose the settings as a reviewed PR.
// It sets up a fresh worktree on main the way a task would (the project's own setup, as the agent user),
// runs the suite at 1, 2, 4 and all cores' worth of workers, records each run's time and its largest test
// worker's peak memory, and writes the recommendation into the project's tests.yaml: `cores.max`, and a
// fixed worker count turned into `{cores}` so the core budget sets it from then on. The PR goes through the
// same push limits and backlog as every other harness PR; nothing changes until it is reviewed and merged.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { Backlog } from './backlog/types.js';
import { BRAND } from './brand.js';
import type { TestsConfig } from './config/schema.js';
import { CORES_PLACEHOLDER, envWithCores, withCores } from './cores.js';
import { cpuCount, peakMemoryMb, projectCommand, withPeakMemory, writeGroupOnly } from './os/index.js';
import { machineStats } from './os/stats.js';
import { checkedPush, type PushLimits } from './push-check.js';
import { recommendWorkers, WORKER_VAR, type ProfileRun, type TuneProfile } from './tuning.js';
import { createWorktree, removeWorktree, type WorktreeOptions } from './worktrees.js';

export type WorkerSetting = { kind: 'template' } | { kind: 'var'; name: string; value: number };

/** How the project's test worker count is set: already `{cores}`, a fixed number in a worker variable, or not at all. */
export function workerSetting(tests: Pick<TestsConfig, 'env' | 'runner'>): WorkerSetting | null {
  const strings = [...Object.values(tests.env), tests.runner.changed, tests.runner.full];
  if (strings.some((s) => s.includes(CORES_PLACEHOLDER))) return { kind: 'template' };
  for (const [name, value] of Object.entries(tests.env)) if (WORKER_VAR.test(name) && /^\d+$/.test(value)) return { kind: 'var', name, value: Number(value) };
  return null;
}

/** The worker counts to try: 1, 2, 4 and every core, as far as the machine has them. */
export function profileCounts(cores: number): number[] {
  return [...new Set([1, 2, 4, Math.max(1, Math.floor(cores))])].filter((n) => n <= Math.max(1, cores)).sort((a, b) => a - b);
}

/** One run's settings: the worker count in the env and in the command. */
export function settingsFor(setting: WorkerSetting, env: Record<string, string>, command: string, workers: number): { env: Record<string, string>; command: string } {
  if (setting.kind === 'var') return { env: { ...env, [setting.name]: String(workers) }, command };
  return { env: envWithCores(env, workers), command: withCores(command, workers) };
}

export type SuiteRunner = (command: string, env: Record<string, string>, cwd: string) => { seconds: number; ok: boolean; peakWorkerMb: number | null };

/** The suite as a task would run it: through the project's command path, as the agent user, timed. */
export function suiteRunner(runAs?: { user: string; home: string }, timeoutMs = 3_600_000): SuiteRunner {
  return (command, env, cwd) => {
    const out = join(cwd, `.${BRAND.cli}-tune-peak`);
    rmSync(out, { force: true });
    const { file, args, env: e } = projectCommand(withPeakMemory(command, out), runAs, env);
    const t = Date.now();
    const r = spawnSync(file, args, { cwd, env: e, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'ignore', 'ignore'] });
    const seconds = (Date.now() - t) / 1000;
    const peak = peakMemoryMb(out);
    rmSync(out, { force: true });
    return { seconds, ok: r.status === 0, peakWorkerMb: peak };
  };
}

export function runProfile(o: { command: string; cwd: string; env: Record<string, string>; setting: WorkerSetting; counts: number[]; run: SuiteRunner }): ProfileRun[] {
  return o.counts.map((workers) => {
    const s = settingsFor(o.setting, o.env, o.command, workers);
    return { workers, ...o.run(s.command, s.env, o.cwd) };
  });
}

/** tests.yaml with the recommendation applied, comments and layout kept: `cores.max`, and a fixed count made `{cores}`. */
export function applyTuning(testsYaml: string, workers: number, setting: WorkerSetting): string {
  const doc = parseDocument(testsYaml);
  doc.setIn(['cores', 'max'], workers);
  if (setting.kind === 'var') doc.setIn(['env', setting.name], CORES_PLACEHOLDER);
  return String(doc);
}

const memAvailableMb = () => {
  const m = machineStats().memory;
  return (m ? m.availableBytes : freemem()) / 1024 / 1024;
};

export interface TuneOptions {
  wt: WorktreeOptions;
  tests: TestsConfig;
  /** main's tip to profile and to base the PR on. */
  base: string;
  /** The default branch the PR targets. */
  mainBranch: string;
  /** The full suite instead of the fast tier (slower, more representative). */
  full?: boolean;
  /** Profile and write the change locally; no push, no PR. */
  dryRun?: boolean;
  remote?: string;
  limits: PushLimits;
  backlog?: Backlog;
  identity: { name: string; email: string };
  stateDir: string;
  cores?: number;
  /** Memory available for test workers, in MB (default: what the machine reports now). */
  memAvailableMb?: number;
  run?: SuiteRunner;
}

export interface TuneResult {
  profile: TuneProfile;
  recommendation: { workers: number; why: string } | null;
  changed: boolean;
  pr?: { url: string; number: number };
  refused?: string[];
}

export async function tune(o: TuneOptions): Promise<TuneResult> {
  const setting = workerSetting(o.tests);
  if (!setting) throw new Error(`no test worker setting to tune: put ${CORES_PLACEHOLDER} where the test command takes a worker count (a tests.yaml env value or a runner command), or a numeric *_WORKERS variable`);
  const name = `tune-${Date.now().toString(36)}`;
  const branch = `${BRAND.cli}/${name}`;
  const { path, setupErrors } = createWorktree(o.wt, name, branch, o.base);
  try {
    if (setupErrors.length) throw new Error(`worktree setup failed: ${setupErrors.join('; ')}`);
    const cores = o.cores ?? cpuCount();
    const command = o.full ? o.tests.runner.full : o.tests.runner.changed;
    const runs = runProfile({ command, cwd: path, env: o.tests.env, setting, counts: profileCounts(cores), run: o.run ?? suiteRunner(o.wt.runAs) });
    const profile: TuneProfile = { at: new Date().toISOString(), command, cores, memAvailableMb: o.memAvailableMb ?? memAvailableMb(), runs };
    writeGroupOnly(join(o.stateDir, 'tune-profile.json'), JSON.stringify(profile, null, 2));
    const rec = recommendWorkers(runs, profile.memAvailableMb);
    if (!rec) return { profile, recommendation: null, changed: false };
    const file = join(path, BRAND.configDir, 'tests.yaml');
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const after = applyTuning(before, rec.workers, setting);
    if (after === before) return { profile, recommendation: rec, changed: false };
    writeFileSync(file, after);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('add', '--', `${BRAND.configDir}/tests.yaml`);
    git('-c', `user.name=${o.identity.name}`, '-c', `user.email=${o.identity.email}`, 'commit', '-q', '-m', `Test workers: at most ${rec.workers}, from a profile on this machine`, '-m', rec.why);
    const head = git('rev-parse', 'HEAD');
    if (o.dryRun || !o.backlog) return { profile, recommendation: rec, changed: true };
    const push = checkedPush({ cwd: path, remote: o.remote ?? 'origin', base: o.base, head, ref: `refs/heads/${branch}`, limits: o.limits });
    if (!push.ok) return { profile, recommendation: rec, changed: true, ...('refused' in push && push.refused ? { refused: push.refused } : {}) };
    const body = [
      `Profiled on this machine (${cores} cores${profile.memAvailableMb ? `, ${Math.round(profile.memAvailableMb)} MB available` : ''}): \`${command}\``,
      '',
      '| workers | time | peak per worker |',
      '|---|---|---|',
      ...runs.map((r) => `| ${r.workers} | ${r.ok ? `${r.seconds.toFixed(0)} s` : 'failed'} | ${r.peakWorkerMb ? `${r.peakWorkerMb.toFixed(0)} MB` : 'not measured'} |`),
      '',
      `**Recommended:** ${rec.why}.`,
      setting.kind === 'var' ? `\`${setting.name}\` becomes \`${CORES_PLACEHOLDER}\`, so each task gets its share of the machine's cores, capped at ${rec.workers}.` : `\`cores.max: ${rec.workers}\` caps each task's share.`,
    ].join('\n');
    const pr = await o.backlog.openPr(branch, o.mainBranch, `Test workers: at most ${rec.workers}, from a profile on this machine`, body);
    return { profile, recommendation: rec, changed: true, pr: { url: pr.url, number: pr.number } };
  } finally {
    try {
      removeWorktree(o.wt, name);
    } catch {
      // already gone
    }
  }
}
