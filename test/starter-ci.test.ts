// #469: a repo with no CI dead-ended at "Required checks named". The starter CI is drafted from what auto-config
// detects, shown, and handed to GitHub's new-file page (the person commits it; the engine never writes a workflow);
// once it ran on the default branch, its check is offered. And an empty required_checks in PR mode is never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { ciChoiceProblem } from '../src/ci-choice.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import type { RunResult, SetupProbe, SetupView } from '../src/setup-steps.js';
import { draftStarterCi, newFileUrl, newFileUrlWith, PINNED, STARTER_CI_PATH, type StarterCiView } from '../src/starter-ci.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'starter-ci-state-'));

/** A repo's files on disk (detection reads them), and its file list. */
function repoOf(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'starter-ci-repo-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return { dir, files: Object.keys(files) };
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { name: string; 'runs-on': string; steps: { uses?: string; run?: string; name?: string; with?: Record<string, unknown> }[] }>;
}

/** The checks every draft must pass: one job named test, read-only, every action pinned by a full commit SHA. */
function shape(file: string): Workflow {
  const w = parse(file) as Workflow;
  assert.deepEqual(Object.keys(w.jobs), ['test']);
  assert.equal(w.jobs.test!.name, 'test', 'the job name is the check name');
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(w.on).sort(), ['pull_request', 'push']);
  for (const s of w.jobs.test!.steps) if (s.uses) assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${s.uses} is pinned by commit`);
  assert.match(file, /uses: actions\/checkout@[0-9a-f]{40} # v\d/, 'with its version beside it');
  return w;
}

test('starter CI: an npm project gets Node, npm ci and npm test on every PR and push to its default branch, as the check test', () => {
  const r = repoOf({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}', 'test/a.test.js': "import assert from 'node:assert';\n" });
  const ci = draftStarterCi({ ...r, branch: 'main' });
  assert.equal(ci.path, '.github/workflows/ci.yml');
  assert.equal(ci.check, 'test');
  assert.equal(ci.placeholder, false);
  assert.equal(ci.summary, 'Runs `npm test` on Node 22 for every PR and every push to main, as the check `test`, with read-only permissions.');
  const w = shape(ci.file);
  assert.deepEqual((w.on.push as { branches: string[] }).branches, ['main']);
  const steps = w.jobs.test!.steps;
  assert.equal(steps[0]!.uses, PINNED.checkout.split(' ')[0]);
  assert.equal(steps[0]!.with?.['persist-credentials'], false);
  assert.equal(steps[1]!.uses, PINNED.node.split(' ')[0]);
  assert.equal(steps[1]!.with?.['node-version'], '22');
  assert.deepEqual(steps.slice(2).map((s) => s.run), ['npm ci', 'npm test']);
});

test("starter CI: the config's own test command wins, and a Node version file is used", () => {
  const r = repoOf({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}', '.nvmrc': '24\n' });
  const ci = draftStarterCi({ ...r, branch: 'trunk', configured: 'npm run test:all' });
  const w = shape(ci.file);
  assert.equal(w.jobs.test!.steps[1]!.with?.['node-version-file'], '.nvmrc');
  assert.equal(w.jobs.test!.steps.at(-1)!.run, 'npm run test:all');
  assert.match(ci.summary, /^Runs `npm run test:all` on Node \(the version in \.nvmrc\) for every PR and every push to trunk/);
  // "no tests yet" (tests.yaml's `true`) is not a test command: detection's is used.
  assert.equal(parse(draftStarterCi({ ...r, branch: 'main', configured: 'true' }).file).jobs.test.steps.at(-1).run, 'npm test');
});

test('starter CI: python (pytest), go and rust get their own pinned setup; each runs its test command', () => {
  const py = draftStarterCi({ ...repoOf({ 'requirements.txt': 'pytest\n', 'tests/test_a.py': 'def test_a():\n    assert True\n' }), branch: 'main' });
  const pw = shape(py.file);
  assert.equal(pw.jobs.test!.steps[1]!.uses, PINNED.python.split(' ')[0]);
  assert.deepEqual(pw.jobs.test!.steps.slice(2).map((s) => s.run), ['python -m pip install -r requirements.txt', 'python -m pip install pytest', 'python3 -m pytest']);
  const go = shape(draftStarterCi({ ...repoOf({ 'go.mod': 'module example.com/x\n\ngo 1.23\n' }), branch: 'main' }).file);
  assert.equal(go.jobs.test!.steps[1]!.uses, PINNED.go.split(' ')[0]);
  assert.equal(go.jobs.test!.steps[1]!.with?.['go-version-file'], 'go.mod');
  assert.equal(go.jobs.test!.steps.at(-1)!.run, 'go test ./...');
  const rs = draftStarterCi({ ...repoOf({ 'Cargo.toml': '[package]\nname = "x"\n' }), branch: 'main' });
  assert.equal(parse(rs.file).jobs.test.steps.at(-1).run, 'cargo test');
  assert.match(rs.summary, /on Rust/);
});

test('starter CI: nothing detected drafts a placeholder that fails until it is edited, never one that passes', () => {
  const ci = draftStarterCi({ ...repoOf({ 'README.md': '# hello\n' }), branch: 'main' });
  assert.equal(ci.placeholder, true);
  assert.equal(ci.command, null);
  const w = shape(ci.file);
  const last = w.jobs.test!.steps.at(-1)!;
  assert.match(last.name!, /no test command yet/);
  assert.match(last.run!, /\bexit 1\s*$/);
  // Run as GitHub would (bash -e): it fails, and says what to do.
  const r = (() => {
    try {
      execFileSync('bash', ['-ec', last.run!], { stdio: ['ignore', 'pipe', 'pipe'] });
      return { failed: false, err: '' };
    } catch (e) {
      return { failed: true, err: String((e as { stderr?: Buffer }).stderr ?? '') };
    }
  })();
  assert.equal(r.failed, true, 'the placeholder fails');
  assert.match(r.err, /replace this step/);
  assert.match(ci.summary, /fails for every PR and every push to main until you replace it/);
});

test("starter CI: the pins are full commit SHAs with their tags, and checkout and setup-node are this repo's own workflows' pins", () => {
  const ours = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  for (const [k, v] of Object.entries(PINNED)) assert.match(v, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, k);
  assert.ok(ours.includes(`uses: ${PINNED.checkout}`), 'checkout as ci.yml pins it');
  assert.ok(ours.includes(`uses: ${PINNED.node}`), 'setup-node as ci.yml pins it');
});

test("starter CI: Confirm is GitHub's new-file page with the file in it; the engine builds a link, never a commit", () => {
  const base = newFileUrl('example-org/example-shop', 'main');
  assert.equal(base, 'https://github.com/example-org/example-shop/new/main?filename=.github%2Fworkflows%2Fci.yml');
  const file = 'name: ci\non: [push]\n# a & b\n';
  const u = new URL(newFileUrlWith(base, file));
  assert.equal(u.searchParams.get('filename'), STARTER_CI_PATH);
  assert.equal(u.searchParams.get('value'), file, 'the file, exactly, edits included');
  assert.equal(newFileUrl('example-org/example-shop', 'release/1.x', 'https://ghe.example.com'), 'https://ghe.example.com/example-org/example-shop/new/release%2F1.x?filename=.github%2Fworkflows%2Fci.yml');
});

test('an empty required_checks in PR mode is a config problem, with the fix; direct landing and a named check are not', () => {
  const problem = ciChoiceProblem({ land_mode: 'pr', required_checks: [] });
  assert.match(problem ?? '', /^required_checks is empty and no CI is chosen: no PR is ever marked ready, so nothing ever merges\. Fix: .*starter CI/);
  assert.equal(ciChoiceProblem({ land_mode: 'pr', required_checks: ['test'] }), null);
  assert.equal(ciChoiceProblem({ land_mode: 'direct', required_checks: [] }), null);
});

// ---------- the step, through the dashboard ----------

const probe: SetupProbe = {
  which: (c) => `/stand-in/${c}`,
  run: (cmd, args, o = {}) => {
    if (cmd !== 'git') return { status: 1, stdout: '', stderr: 'no stand-in' };
    try {
      return { status: 0, stdout: execFileSync('git', args, { cwd: o.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
    } catch (e) {
      return { status: 1, stdout: '', stderr: String((e as { stderr?: string }).stderr ?? '') };
    }
  },
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
};

test('the Required checks step on a repo with no workflows: blocked with the fix; the starter CI drafted (nothing pushed); after it merged and ran on main, its check is offered', async () => {
  const { dir } = exampleProject();
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const origin = join(mkdtempSync(join(tmpdir(), 'starter-ci-origin-')), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, origin]);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'fetch', '-q', 'origin');
  install({ root: dir });
  // A stand-in GitHub: no check runs anywhere until the workflow's first run on main.
  let run: string | null = null;
  const calls: string[][] = [];
  const gh = (args: string[]): RunResult => {
    calls.push(args);
    if (args[0] === 'api' && /\/check-runs\?check_name=test$/.test(args[1]!)) return { status: 0, stdout: run ? `${run}\n` : '', stderr: '' };
    if (args[0] === 'api' && /\/check-runs$/.test(args[1]!)) return { status: 0, stdout: run ? 'test\n' : '', stderr: '' };
    if (args[0] === 'api' && /\/status$/.test(args[1]!)) return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'no stand-in' };
  };
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'sc-slots-')), setupProbe: probe, setupActions: { gh } });
  const base = d.url.split('/?')[0]!;
  const get = async <T>(path: string, user = 'example-owner') => {
    const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } });
    return { status: r.status, body: (await r.json()) as T };
  };
  const refs = () => git(origin, 'for-each-ref', '--format=%(refname)').trim();
  try {
    const before = refs();
    const step = (await get<{ setup: SetupView }>('/api/first-run?fresh=1')).body.setup.groups.flatMap((g) => g.steps).find((s) => s.id === 'required-checks')!;
    assert.equal(step.done, false);
    assert.match(step.detail, /required_checks is empty and no CI is chosen: no PR is ever marked ready.*Fix: .*starter CI/);
    assert.deepEqual((await get<{ checks: string[] }>('/api/first-run/checks-seen')).body.checks, [], 'GitHub ran nothing');
    assert.equal((await get('/api/first-run/starter-ci', 'example-viewer')).status, 403, 'writers and owners only');
    const v = (await get<StarterCiView>('/api/first-run/starter-ci')).body;
    assert.equal(v.onBranch, false);
    assert.deepEqual(v.firstRun, { state: 'none', conclusion: null });
    assert.equal(v.newFile, 'https://github.com/example-org/example-shop/new/main?filename=.github%2Fworkflows%2Fci.yml');
    assert.match(v.summary, /^Runs `node --test --test-reporter=spec` on Node 22 for every PR and every push to main, as the check `test`/);
    shape(v.file);
    assert.equal(refs(), before, 'nothing pushed: no branch, no commit');
    assert.equal(git(dir, 'status', '--porcelain', '--', '.github'), '', 'nothing written in the checkout');
    // The person commits it on GitHub and merges its PR: main has it, its run still going.
    const person = join(mkdtempSync(join(tmpdir(), 'starter-ci-person-')), 'p');
    execFileSync('git', ['clone', '-q', origin, person]);
    mkdirSync(join(person, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(person, STARTER_CI_PATH), v.file);
    git(person, 'add', STARTER_CI_PATH);
    git(person, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'starter CI');
    git(person, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin');
    run = 'in_progress\t';
    assert.deepEqual((await get<StarterCiView>('/api/first-run/starter-ci')).body.firstRun, { state: 'running', conclusion: null });
    run = 'completed\tsuccess';
    const after = (await get<StarterCiView>('/api/first-run/starter-ci')).body;
    assert.equal(after.onBranch, true);
    assert.deepEqual(after.firstRun, { state: 'done', conclusion: 'success' });
    // Asked about the exact tip of main, by the check's name.
    const tip = git(dir, 'rev-parse', 'origin/main').trim();
    assert.ok(calls.some((a) => a[1] === `repos/example-org/example-shop/commits/${tip}/check-runs?check_name=test`));
    // Still nothing written: required_checks changes only through the form's own Review and Propose.
    assert.deepEqual(loadConfig(dir).project.required_checks, []);
    assert.ok(!calls.some((a) => a[0] === 'pr' || a.includes('--method')), 'no PR, no write to GitHub');
  } finally {
    await d.close();
  }
});
