// Shared fixtures for the state-graph repro tests: copied from test/coordinator.test.ts (whose helpers are
// not exported), so each repro file builds a Coordinator over a real git remote, a file backlog and a log.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../../src/backlog/file.js';
import { BRAND } from '../../src/brand.js';
import { loadConfig } from '../../src/config/load.js';
import { Coordinator } from '../../src/coordinator.js';
import { EventLog } from '../../src/events/log.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../../src/runner.js';
import { which } from '../../src/os/index.js';
import { repoRoot } from '../helpers.js';

export const skip = !which('gitleaks') && 'gitleaks not installed (the coordinator refuses unscanned changes)';
export const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A "GitHub" remote, the coordinator's clone of the example project, a file backlog and a log. */
export function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'coord-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'coordinator-clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  const log = new EventLog(join(base, 'events.db'));
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const machine = { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) };
  return { base, remote, repo, cfg, backlog, log, slotsDir, stateDir: join(base, 'state'), machine };
}
export type Fixture = ReturnType<typeof fixture>;

export const BUG = 'Orders with a zero or negative quantity are counted in totals.\n\n```done_when\n- test: test/price.test.js\n- repro: true\n```\n';
export const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('ignores non-positive quantities', () => { assert.equal(totalCents([{ cents: 100, qty: -2 }, { cents: 5, qty: 1 }]), 5); });\n`;

export function commitAll(cwd: string, msg: string) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}

/** What a diligent evaluator reports: every file changed since the base named in its prompt. */
export function readAll(req: RunRequest): string[] {
  const base = /Base commit: ([0-9a-f]{40})/.exec(req.prompt)?.[1];
  return base ? git(req.cwd, 'diff', '--name-only', `${base}..HEAD`).split('\n').filter(Boolean) : [];
}

/** The evaluator's repro: a failing test, committed. */
export function writeRepro(req: RunRequest) {
  writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), REPRO);
  commitAll(req.cwd, 'repro');
  return { test_path: 'test/repro-qty.test.js', explanation: 'negative qty subtracts' };
}

/** The worker's real fix. */
export function realFix(req: RunRequest) {
  const p = join(req.cwd, 'src', 'price.js');
  writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
  commitAll(req.cwd, 'Ignore non-positive quantities in totals');
  return { summary: 'fixed' };
}

/** Scripted agents: the evaluator writes a failing repro; the worker fixes the bug; the verdict approves. */
export function agents(over: Partial<Record<string, (r: RunRequest) => object>> = {}) {
  return new FakeRunner((req) => {
    const custom = over[req.role];
    if (custom) return { structured: custom(req) };
    if (req.role === 'evaluator-repro') return { structured: writeRepro(req) };
    if (req.role === 'worker') return { structured: realFix(req) };
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req) } };
  });
}

export const easyIssue = (title: string, file: string) => ({ title, body: `Add ${file}.\n\n\`\`\`done_when\n- test: test/price.test.js\n\`\`\`\n`, author: 'example-owner', labels: ['ready'] });

export function coordinator(f: Fixture, runner: FakeRunner, extra: Partial<ConstructorParameters<typeof Coordinator>[0]> = {}) {
  return new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner, repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, machine: f.machine, ...extra });
}

/** The latest event of a type; a clear failure (not a TypeError) when there is none. */
export function lastOf(log: EventLog, type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never): unknown {
  const e = log.read(0, [type]).at(-1);
  assert.ok(e, `no ${type} event (got: ${[...new Set(log.read().map((x) => x.type))].join(', ')})`);
  return e.payload;
}

export const failing = (id: number) => [{ name: 'ci', source: 'check_run' as const, status: 'completed', conclusion: 'failure', id }];
export const passing = [{ name: 'ci', source: 'check_run' as const, status: 'completed', conclusion: 'success', id: 1 }];

/** A diligent evaluator that approves with high confidence and answers the design question. */
export const approve = (design = false) => (req: RunRequest) => ({ patch_correct: true, test_correct: true, confidence: 'high', advice: '', files_reviewed: readAll(req), design_change: design, ...(design ? { design_reason: 'adds a public option' } : {}) });
/** An evaluator that also answers the conflict question. */
export const approveBoth = (kept: boolean, confidence = 'high') => (req: RunRequest) => ({ ...approve()(req), confidence, ...(/both_sides_kept/.test(req.prompt) ? { both_sides_kept: kept } : {}) });

/** PR mode with one required check and fix runs on; runs the task until its PR is open. */
export async function openPr(over: Partial<Record<string, (r: RunRequest) => object>> = {}, opts: { fixes?: boolean; autoMerge?: () => boolean; edit?: (cfg: Fixture['cfg']) => void; deps?: Partial<ConstructorParameters<typeof Coordinator>[0]> } = {}) {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  if (opts.fixes !== false) f.cfg.agents.roles.ci_repair = { enabled: true, model: 'sonnet', max_fixes_per_pr: 2 };
  opts.edit?.(f.cfg);
  const n = f.backlog.open({ title: 'Totals count negative quantities', body: BUG, author: 'example-owner', labels: ['ready'] });
  const runner = agents(over);
  const c = coordinator(f, runner, { prPollMs: 0, ...(opts.autoMerge ? { autoMerge: opts.autoMerge } : {}), ...opts.deps });
  await c.tick();
  await c.idle();
  await c.tick();
  const opened = f.log.read(0, ['pr.opened']).at(-1)!.payload as { number: number; head: string };
  const remoteHead = () => git(f.repo, 'ls-remote', 'origin', `refs/heads/${BRAND.cli}/issue-${n}`).split('\t')[0]!;
  const pr = () => f.backlog.prs().find((p) => p.number === opened.number)!;
  const sync = () => f.backlog.setPr(opened.number, { headSha: remoteHead() });
  return { f, n, c, runner, opened, remoteHead, pr, sync };
}
export type OpenPr = Awaited<ReturnType<typeof openPr>>;

/** A fix-run worker that commits a small real change and says what it did. */
export const fixer = (req: RunRequest) => {
  if (!/CI fix run/.test(req.prompt)) return null;
  const p = join(req.cwd, 'src', 'price.js');
  writeFileSync(p, `${readFileSync(p, 'utf8')}// checked by CI fix\n`);
  commitAll(req.cwd, 'Fix the CI failure');
  return { summary: 'fixed the failing check' };
};

/** The default worker for the first run, `fix` for fix runs. */
export function workerWith(fix: (req: RunRequest) => object | null) {
  return (req: RunRequest) => fix(req) ?? realFix(req);
}

/** A conflict-fix worker: keeps both sides of the totals line. */
export const resolver = () => (req: RunRequest) => {
  if (!/Conflict fix \d/.test(req.prompt)) return null;
  const p = join(req.cwd, 'src', 'price.js');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/<<<<<<<[\s\S]*?>>>>>>>[^\n]*\n/, '  return items.reduce((sum, { cents, qty }) => sum + (qty > 0 ? cents * qty : 0), 0); // audited\n'));
  commitAll(req.cwd, 'Merge main into the branch, keeping both changes');
  return { summary: 'kept the quantity guard and the audit note' };
};

/** Required check green on the PR's head, then one poll. */
export async function green(t: OpenPr) {
  t.f.backlog.setChecks(t.pr().headSha, passing);
  await t.c.tick();
}

/** Merges for real on the test remote (a --no-ff merge commit of the PR head), as GitHub would. */
export function realMerges(t: OpenPr) {
  t.f.backlog.mergeWith = (pr) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gh-merge-')), 'c');
    git(t.f.base, 'clone', '-q', t.f.remote, dir);
    git(dir, 'fetch', '-q', 'origin', pr.head);
    git(dir, '-c', 'user.email=gh@example.com', '-c', 'user.name=GitHub', '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', `Merge pull request #${pr.number}`, pr.headSha);
    git(dir, 'push', '-q', 'origin', 'main');
    return git(dir, 'rev-parse', 'HEAD');
  };
}

/** Someone else's change lands on main. */
export function changeOnMain(t: OpenPr, file: string, edit: (text: string) => string) {
  const dir = join(mkdtempSync(join(tmpdir(), 'other-')), 'c');
  git(t.f.base, 'clone', '-q', t.f.remote, dir);
  writeFileSync(join(dir, file), edit(existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''));
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=o@example.com', '-c', 'user.name=Other', '-c', 'commit.gpgsign=false', 'commit', '-qm', `Change ${file} on main`);
  git(dir, 'push', '-q', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}

/** Someone else's change lands on main on the very line the PR changed: a real conflict (GitHub told when `report`). */
export function conflictOnMain(t: OpenPr, report = true): string {
  const sha = changeOnMain(t, join('src', 'price.js'), (s) => s.replace('sum + cents * qty, 0);', 'sum + cents * qty, 0); // audited'));
  if (report) t.f.backlog.setPr(t.opened.number, { mergeableState: 'dirty' });
  return sha;
}

/** Wait (bounded) until there are at least `count` events of a type. */
export async function waitForCount(log: EventLog, type: Parameters<EventLog['read']>[1] extends (infer U)[] | undefined ? U : never, count: number) {
  for (let i = 0; i < 300 && log.read(0, [type]).length < count; i++) await new Promise((r) => setTimeout(r, 50));
  return log.read(0, [type]).length;
}
