// #744: the desktop window is removed, with its lockfile, docs and build steps. Its CI job stays one more release as
// a job that only succeeds (#746, the owner's option (a)): an updater from v0.5.2 or older requires a successful
// "desktop" run on every commit it installs, so the job and its required check go together a release later (#877).
// Kept true here: every required check is a job some workflow defines (so neither a merge nor an engine install
// waits on a check that never runs again), the desktop job can only succeed, and nothing but the release notes
// still names the removed app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

type Job = { name?: string; strategy?: { matrix?: Record<string, unknown> } };

/**
 * Every check name the workflows in `dir` can create: each job's name (its key when it has none), a matrix job
 * expanded as GitHub names it (the values substituted where the name uses them, else appended in parentheses).
 */
function jobNames(dir: string): Set<string> {
  const out = new Set<string>();
  for (const f of workflowFiles(dir)) for (const n of fileJobNames(join(dir, f))) out.add(n);
  return out;
}

function workflowFiles(dir: string): string[] {
  return readdirSync(dir).filter((x) => /\.ya?ml$/.test(x));
}

/** The check names one workflow file can create (see jobNames). */
function fileJobNames(file: string): Set<string> {
  const out = new Set<string>();
  const wf = parse(readFileSync(file, 'utf8')) as { jobs?: Record<string, Job> };
  for (const [key, job] of Object.entries(wf.jobs ?? {})) {
    const name = job.name ?? key;
    const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v)) as [string, unknown[]][];
    let combos: string[][] = [[]];
    for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, String(v)]));
    for (const c of combos) {
      const vars = Object.fromEntries(axes.map(([k], i) => [k, c[i]!]));
      out.add(name.includes('${{') ? name.replace(/\$\{\{ matrix\.([a-z]+) \}\}/g, (m, k: string) => vars[k] ?? m) : c.length ? `${name} (${c.join(', ')})` : name);
    }
  }
  return out;
}

/**
 * Why `job` might end any way but success on a commit: anything beyond GitHub's runner and one step that runs
 * `true`. No `if` (a skipped required check is refused by a v0.5.2 updater), no `needs` (a failed or skipped
 * dependency skips it), no `name` (the check must keep the job id as its name), and no `continue-on-error`,
 * `uses`, matrix, container, environment or timeout of its own: nothing that can turn it red, skip it or rename it.
 */
function notOnlySuccess(job: Record<string, unknown> | undefined): string[] {
  if (!job) return ['no such job'];
  const out = Object.keys(job).filter((k) => k !== 'runs-on' && k !== 'steps').map((k) => `has ${k}`);
  if (job['runs-on'] !== 'ubuntu-latest') out.push(`runs-on ${JSON.stringify(job['runs-on'])}`);
  if (JSON.stringify(job.steps) !== JSON.stringify([{ run: 'true' }])) out.push(`steps ${JSON.stringify(job.steps)}`);
  return out;
}

type Workflow = { on?: Record<string, unknown>; defaults?: unknown; env?: unknown; jobs?: Record<string, Record<string, unknown>> };

/** ci.yml's triggers, exactly: every push to main and every pull request (opened, synchronized, reopened). */
const CI_ON = { push: { branches: ['main'] }, pull_request: { types: ['opened', 'synchronize', 'reopened'] } };

/**
 * Why ci.yml might not give every main commit and every pull request a desktop run that succeeds, outside the job
 * itself: a trigger other than exactly CI_ON (a `paths`, `paths-ignore` or `branches` filter, narrowed `types`, a
 * trigger dropped), or workflow-level `defaults` (a `run.shell` or `working-directory` that fails the `true` step)
 * or `env` (a `BASH_ENV` the step's shell would source first). ci.yml has neither today.
 */
function workflowProblems(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [event, want] of Object.entries(CI_ON)) {
    const got = wf.on?.[event];
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`on.${event} ${JSON.stringify(got)}`);
  }
  if (wf.defaults !== undefined) out.push(`defaults ${JSON.stringify(wf.defaults)}`);
  if (wf.env !== undefined) out.push(`env ${JSON.stringify(wf.env)}`);
  return out;
}

/** The names in `required` that no workflow in `dir` defines: checks nothing will ever run. */
function undefinedChecks(dir: string, required: string[]): string[] {
  const names = jobNames(dir);
  return required.filter((n) => !names.has(n));
}

const workflows = join(repoRoot, '.github', 'workflows');
const requiredChecks = () => (parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] }).required_checks;
/** UPDATE_DEFAULT_CHECKS as scripts/setup/lib.sh declares it: the checks a new install's updater requires. */
function updaterDefaults(): string[] {
  const m = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8').match(/^UPDATE_DEFAULT_CHECKS=\((.*)\)$/m);
  assert.ok(m, 'lib.sh declares UPDATE_DEFAULT_CHECKS');
  return [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

test('every required check, the repo\'s and the updater\'s defaults, is a job some workflow defines', () => {
  assert.deepEqual(undefinedChecks(workflows, requiredChecks()), [], 'config.yaml required_checks');
  assert.deepEqual(undefinedChecks(workflows, updaterDefaults()), [], 'UPDATE_DEFAULT_CHECKS in scripts/setup/lib.sh');
});

test('a required check whose job was removed first is caught, matrix names expanded as GitHub gives them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(
    join(dir, 'ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    strategy: { matrix: { os: [ubuntu-latest], node: [22, 24] } }',
      '    runs-on: x',
      '  shard:',
      '    name: shard ${{ matrix.n }}/2',
      '    strategy: { matrix: { n: [1, 2] } }',
      '    runs-on: x',
      '  lint:',
      '    name: lint all',
      '    runs-on: x',
      '',
    ].join('\n'),
  );
  assert.deepEqual([...jobNames(dir)].sort(), ['lint all', 'shard 1/2', 'shard 2/2', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)']);
  // The desktop job gone, its check still required: the order #744 forbids.
  assert.deepEqual(undefinedChecks(dir, ['test (ubuntu-latest, 22)', 'desktop', 'lint all', 'lint']), ['desktop', 'lint']);
});

/** Text that names the removed app: its folder, its framework, its build script, its window, its env var or flag. */
const NAMES_IT = /\bTauri\b|(^|[^\w.-])desktop\/|build:desktop|_DESKTOP\b|\bdesktop (app|window|shell)\b|dashboard --app\b/i;

/**
 * The files that may still name it. The CHANGELOG, which records the removal (#744). docs/progress.md, the dated
 * build log, which records what each step shipped then. docs/prior-art.md, whose rows describe other projects.
 * .worklane/review.yaml, whose `engine` globs keep `desktop/**` (owner-only review for the folder) until #877:
 * dropping a glob is a loosening, the owner's call, so it goes with the job's removal, not here.
 */
const MAY_NAME_IT = new Set(['CHANGELOG.md', 'docs/progress.md', 'docs/prior-art.md', '.worklane/review.yaml']);

function filesUnder(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

test('the desktop check stays one more release: one job that only succeeds, on every pull request and push to main, still required (#746, #877)', () => {
  const ci = parse(readFileSync(join(workflows, 'ci.yml'), 'utf8')) as Workflow;
  assert.deepEqual(notOnlySuccess(ci.jobs?.desktop), [], 'ci.yml\'s desktop job: one `true` step on GitHub\'s runner, nothing that could skip, fail or rename it');
  assert.deepEqual(workflowProblems(ci), [], 'ci.yml runs on every push to main (where the updater reads it) and every pull request, with no filter and no workflow defaults');
  assert.deepEqual(workflowFiles(workflows).filter((f) => fileJobNames(join(workflows, f)).has('desktop')), ['ci.yml'], 'one job makes the desktop check: no second run of that name can be the one an updater reads');
  assert.ok(requiredChecks().includes('desktop'), 'config.yaml still requires desktop, until #877 removes the job and the check together');
  assert.ok(updaterDefaults().includes('desktop'), 'a new install\'s updater still lists desktop, until #877');
});

test('the no-op shape check catches whatever could make the desktop check anything but success', () => {
  const ok = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] };
  assert.deepEqual(notOnlySuccess(ok), []);
  assert.deepEqual(notOnlySuccess(undefined), ['no such job'], 'the job removed before its check: v0.5.2 installs would wait forever');
  assert.deepEqual(notOnlySuccess({ if: "github.event_name == 'pull_request'", ...ok }), ['has if'], 'skipped on main: a v0.5.2 updater refuses a skipped required check');
  assert.deepEqual(notOnlySuccess({ ...ok, needs: 'test-22' }), ['has needs']);
  assert.deepEqual(notOnlySuccess({ ...ok, name: 'desktop (no-op)' }), ['has name'], 'renamed: the check "desktop" would never run again');
  assert.deepEqual(notOnlySuccess({ ...ok, 'continue-on-error': true }), ['has continue-on-error']);
  assert.deepEqual(notOnlySuccess({ ...ok, steps: [{ run: 'false' }] }), ['steps [{"run":"false"}]']);
  assert.deepEqual(notOnlySuccess({ ...ok, steps: [{ uses: 'actions/checkout@x' }, { run: 'true' }] }), ['steps [{"uses":"actions/checkout@x"},{"run":"true"}]']);
  assert.deepEqual(notOnlySuccess({ ...ok, 'runs-on': ['self-hosted'] }), ['runs-on ["self-hosted"]']);
});

test('the workflow check catches a filter on either trigger, a narrowed or dropped trigger, and workflow defaults', () => {
  const pr = CI_ON.pull_request;
  const wf = (on: Record<string, unknown>, extra: Record<string, unknown> = {}): Workflow => ({ on, ...extra });
  assert.deepEqual(workflowProblems(wf({ ...CI_ON })), []);
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, paths: ['src/**'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"paths":["src/**"]}'], 'a PR paths filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, 'paths-ignore': ['docs/**'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"paths-ignore":["docs/**"]}'], 'a PR paths-ignore filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, branches: ['release'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"branches":["release"]}'], 'a PR branches filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { types: ['closed'] } })), ['on.pull_request {"types":["closed"]}'], 'PR types narrowed');
  assert.deepEqual(workflowProblems(wf({ push: CI_ON.push })), ['on.pull_request undefined'], 'the PR trigger dropped');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, push: { branches: ['main'], paths: ['src/**'] } })), ['on.push {"branches":["main"],"paths":["src/**"]}'], 'a push paths filter: main commits without a run strand v0.5.2');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON }, { defaults: { run: { shell: 'false {0}' } } })), ['defaults {"run":{"shell":"false {0}"}}'], 'a workflow-level shell that fails every run step');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON }, { env: { BASH_ENV: '/nonexistent' } })), ['env {"BASH_ENV":"/nonexistent"}'], 'a workflow-level env the step\'s shell reads');
});

test('the desktop app is gone: its folder, module, build script, notice and docs', () => {
  for (const p of ['desktop', join('src', 'desktop.ts'), join('test', 'desktop.test.ts')]) assert.ok(!existsSync(join(repoRoot, p)), `${p} is removed`);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(!('build:desktop' in pkg.scripts), 'no build:desktop script');

  const files = [
    ...filesUnder(workflows, (p) => /\.ya?ml$/.test(p)),
    ...filesUnder(join(repoRoot, 'docs'), (p) => p.endsWith('.md')),
    ...filesUnder(join(repoRoot, '.worklane'), (p) => /\.(ya?ml|md)$/.test(p)),
    ...['README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'scripts/lib/denylist.mjs', 'scripts/setup/lib.sh', 'src/cli.ts'].map((p) => join(repoRoot, p)),
  ];
  const named = files
    .map((f) => relative(repoRoot, f).split('\\').join('/'))
    .filter((r) => !MAY_NAME_IT.has(r))
    .flatMap((r) => readFileSync(join(repoRoot, r), 'utf8').split('\n').map((line, i) => ({ at: `${r}:${i + 1}`, line })).filter((x) => NAMES_IT.test(x.line)))
    .map((x) => `${x.at}: ${x.line.trim()}`);
  assert.deepEqual(named, [], 'nothing but the CHANGELOG (and the dated build log and other projects\' rows) names it');
});

test('the release notes say what replaces it, that the desktop check stays one more release, and that v0.5.2 installs rerun updates.sh', () => {
  // The fragment until the release step moves it into CHANGELOG.md: read both, so the release PR passes too.
  const dir = join(repoRoot, 'changelog.d');
  const notes = [join(repoRoot, 'CHANGELOG.md'), ...readdirSync(dir).filter((f) => f !== 'README.md').map((f) => join(dir, f))].map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.match(notes, /desktop window[^\n]*removed[^\n]*#744/i);
  assert.match(notes, /open the dashboard in (a|your) browser/i);
  assert.match(notes, /`desktop` (CI )?check stays[^\n]*one more release/i);
  assert.match(notes, /v0\.5\.2 installs[^\n]*rerun `updates\.sh` once/i);
});

test('the fixture helpers read a real tree: this test would see a desktop job if one came back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'ci.yml'), 'jobs:\n  desktop:\n    runs-on: x\n');
  assert.ok(jobNames(dir).has('desktop'));
  assert.ok(NAMES_IT.test('The optional desktop window (`desktop/`) is built with Tauri'));
  assert.ok(!NAMES_IT.test('screenshots (desktop, dark mode, phone width)'), 'the word alone, for a viewport, is fine');
});
