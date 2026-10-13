// Auto-config (src/auto-config.ts), init's Repo config step for a repo with no config folder: each ecosystem's
// commands detected from its files; every ambiguity a question with its choices, never a guess; each command run on
// the default branch in a scratch worktree, a failing one a question; the draft valid against the schema; the
// scaffold proposed from its own branch as a PR (a stand-in gh, a bare repo as GitHub), the default branch never pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { applyAnswer, autoConfigure, detectProject, draftTests, emptyAutoConfig, failureQuestion, NO_TESTS, planFrom, SETUP_BRANCH, type Answer, type AutoConfigIo, type AutoConfigState, type Question } from '../src/auto-config.js';
import { loadConfigAt } from '../src/config/load.js';
import { TestsConfig } from '../src/config/schema.js';
import { firstRunView, initCommand, localInitFile, readInitState, type InitArgs, type InitIo } from '../src/init.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'auto-config-state-'));

/** A fixture: files written under a fresh directory; the tracked-file list is their paths. */
function fixture(files: Record<string, string>): { dir: string; files: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ac-fixture-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return { dir, files: Object.keys(files).sort() };
}
const detect = (files: Record<string, string>, answers: Record<string, Answer> = {}) => {
  const f = fixture(files);
  return detectProject(f.dir, f.files, answers);
};
const pkg = (o: object) => JSON.stringify(o);
const ids = (qs: Question[]) => qs.map((q) => q.id);
const plan = (files: Record<string, string>, answers: Record<string, Answer> = {}) => {
  const d = detect(files, answers);
  return planFrom(d, { answers, overrides: {} });
};

test('detection, node: scripts.test with the package manager from the lockfile, its setup, one file by the framework, the test globs', () => {
  const d = detect({ 'package.json': pkg({ scripts: { test: 'vitest run', 'test:watch': 'vitest' }, devDependencies: { vitest: '1' } }), 'package-lock.json': '{}', 'src/a.ts': '', 'src/a.test.ts': '', 'test/b.spec.ts': '' });
  assert.deepEqual(d.ecosystems, ['node (npm, from its lockfile)']);
  assert.deepEqual(d.full.map((c) => c.command), ['npm test'], 'a watch script is never a test run');
  assert.equal(d.one?.command, 'npx vitest run {file}');
  assert.deepEqual(d.setup, ['npm ci']);
  assert.deepEqual(d.testGlobs, ['src/**/*.test.ts', 'test/**/*.spec.ts']);
  assert.deepEqual(d.appPaths, ['src/**']);
  assert.deepEqual(d.questions, []);
  const p = detect({ 'package.json': pkg({ scripts: { test: 'jest', 'test:changed': 'jest -o' }, devDependencies: { jest: '1' } }), 'pnpm-lock.yaml': '' });
  assert.deepEqual([p.full.map((c) => c.command), p.changed?.command, p.one?.command, p.setup], [['pnpm test'], 'pnpm run test:changed', 'pnpm exec jest {file}', ['pnpm install --frozen-lockfile']]);
  const y = detect({ 'package.json': pkg({ scripts: { test: 'node --test test/' } }), 'yarn.lock': '' });
  assert.deepEqual([y.full.map((c) => c.command), y.one?.command], [['yarn test'], 'node --test {file}']);
  const declared = detect({ 'package.json': pkg({ packageManager: 'bun@1.1.0', scripts: { test: 'bun test' } }) });
  assert.deepEqual([declared.full.map((c) => c.command), declared.setup], [['bun test'], ['bun install']], "package.json's packageManager says it");
  assert.deepEqual(detect({ 'package.json': pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), 'package-lock.json': '{}' }).full, [], "npm's placeholder is no test command");
});

test('detection, python: pytest through the lockfile tool, or unittest; go; rust; make targets', () => {
  const uv = detect({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'uv.lock': '', 'pkg/m.py': '', 'tests/test_m.py': '' });
  assert.deepEqual([uv.ecosystems, uv.full.map((c) => c.command), uv.one?.command, uv.setup], [['python (pytest via uv)'], ['uv run pytest'], 'uv run pytest {file}', ['uv sync']]);
  assert.deepEqual([uv.testGlobs, uv.assertion, uv.appPaths], [['tests/**/test_*.py'], '\\bassert\\b', ['pkg/**']]);
  const poetry = detect({ 'pyproject.toml': '[tool.poetry.group.dev.dependencies]\npytest = "^8"\n', 'poetry.lock': '' });
  assert.deepEqual([poetry.full.map((c) => c.command), poetry.setup], [['poetry run pytest'], ['poetry install']]);
  const plain = detect({ 'setup.py': '', 'test_x.py': '' });
  assert.deepEqual([plain.full.map((c) => c.command), plain.setup], [['python3 -m unittest discover'], []]);
  assert.match(plain.notes.join('\n'), /no Python lockfile/, 'said, not silently assumed');

  const g = detect({ 'go.mod': 'module x\n', 'pkg/a.go': '', 'pkg/a_test.go': '' });
  assert.deepEqual([g.ecosystems, g.full.map((c) => c.command), g.one?.command, g.setup, g.testGlobs], [['go'], ['go test ./...'], 'go test "./$(dirname {file})"', ['go mod download'], ['pkg/**/*_test.go']]);
  const r = detect({ 'Cargo.toml': '[package]\nname = "x"\n', 'src/lib.rs': '', 'tests/it.rs': '' });
  assert.deepEqual([r.ecosystems, r.full.map((c) => c.command), r.one?.command, r.testGlobs], [['rust'], ['cargo test'], 'cargo test --test "$(basename {file} .rs)"', ['tests/**/*.rs']]);
  assert.deepEqual(detect({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n' }).full.map((c) => c.command), ['cargo test --workspace']);
  const m = detect({ Makefile: '.PHONY: test\nbuild:\n\tcc x.c\ntest: build\n\t./run-tests\nX := 1\n' });
  assert.deepEqual([m.ecosystems, m.full.map((c) => c.command)], [['make'], ['make test']]);
  assert.deepEqual(detect({ Makefile: 'check:\n\ttrue\n' }).full.map((c) => c.command), ['make check']);
});

test('never a silent guess: two lockfiles, no lockfile, two test commands, none, a monorepo, no single-file runner: each a question with its choices', () => {
  const two = detect({ 'package.json': pkg({ scripts: { test: 'x' } }), 'package-lock.json': '{}', 'yarn.lock': '' });
  assert.deepEqual(ids(two.questions), ['package-manager']);
  assert.deepEqual(two.questions[0]!.choices.map((c) => c.id), ['npm', 'yarn']);
  assert.deepEqual(two.full, [], 'no command drafted until it is answered');
  const answered = detect({ 'package.json': pkg({ scripts: { test: 'x' } }), 'package-lock.json': '{}', 'yarn.lock': '' }, { 'package-manager': { choice: 'yarn' } });
  assert.deepEqual([answered.questions, answered.full.map((c) => c.command)], [[], ['yarn test']]);
  const none = detect({ 'package.json': pkg({ scripts: { test: 'x' } }) });
  assert.deepEqual(none.questions[0]!.choices.map((c) => c.id), ['npm', 'pnpm', 'yarn', 'bun']);
  assert.match(none.questions[0]!.ask, /no lockfile and no packageManager field/);

  // Two test commands: package.json and the Makefile.
  const both = plan({ 'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }), 'package-lock.json': '{}', Makefile: 'test:\n\tnpm test\n' });
  assert.deepEqual(ids(both.open), ['test-command']);
  assert.deepEqual(both.open[0]!.choices.map((c) => [c.id, c.command]), [['1', 'npm test'], ['2', 'make test'], ['all', 'npm test && make test'], ['custom', undefined]]);
  const scripts = plan({ 'package.json': pkg({ scripts: { test: 'a', 'test:unit': 'b', 'test:e2e': 'c' } }), 'package-lock.json': '{}' });
  assert.deepEqual(scripts.open[0]!.choices.map((c) => c.command ?? c.id), ['npm test', 'npm run test:unit', 'npm run test:e2e', 'npm test && npm run test:unit && npm run test:e2e', 'custom']);
  const picked = plan({ 'package.json': pkg({ scripts: { test: 'a', 'test:unit': 'b' } }), 'package-lock.json': '{}' }, { 'test-command': { choice: '2' }, 'one-test-file': { choice: 'none' } });
  assert.deepEqual([picked.open, picked.commands.full, picked.commands.changed, picked.commands.one, picked.commands.setup], [[], 'npm run test:unit', 'npm run test:unit', null, 'npm ci']);

  // No test command at all.
  const empty = plan({ 'README.md': '' });
  assert.deepEqual(ids(empty.open), ['no-test-command']);
  assert.deepEqual(empty.open[0]!.choices.map((c) => c.id), ['custom', 'none']);
  assert.equal(plan({ 'README.md': '' }, { 'no-test-command': { choice: 'none' } }).commands.full, NO_TESTS, 'only when answered so');

  // Monorepos: workspaces, or projects only in subdirectories.
  const ws = plan({ 'package.json': pkg({ workspaces: ['packages/*'], scripts: { test: 'turbo test' } }), 'package-lock.json': '{}' });
  assert.deepEqual(ids(ws.open), ['monorepo']);
  assert.match(ws.open[0]!.ask, /monorepo \(package\.json workspaces\)/);
  assert.deepEqual(ws.open[0]!.choices.map((c) => c.command ?? c.id), ['npm test', 'npm test --workspaces --if-present', 'custom']);
  const subdirs = plan({ 'web/package.json': pkg({ scripts: { test: 'vitest' } }), 'web/package-lock.json': '{}', 'api/go.mod': 'module api\n' });
  assert.deepEqual(ids(subdirs.open), ['monorepo']);
  assert.match(subdirs.open[0]!.ask, /projects in api\/, web\//);
  assert.deepEqual(subdirs.open[0]!.choices.map((c) => [c.id, c.command]), [['1', 'cd api && go test ./...'], ['2', 'cd web && npm test'], ['all', 'cd api && go test ./... && cd web && npm test'], ['custom', undefined]]);
  const sub = plan({ 'web/package.json': pkg({ scripts: { test: 'vitest' } }), 'web/package-lock.json': '{}', 'api/go.mod': 'module api\n' }, { monorepo: { choice: 'all' }, 'one-test-file': { choice: 'none' } });
  assert.deepEqual([sub.commands.full, sub.commands.setup], ['cd api && go test ./... && cd web && npm test', 'cd api && go mod download && cd web && npm ci']);

  // No way to run one test file.
  const noOne = plan({ 'package.json': pkg({ scripts: { test: 'custom-runner' } }), 'package-lock.json': '{}' });
  assert.deepEqual(ids(noOne.open), ['one-test-file']);
  assert.deepEqual(noOne.open[0]!.choices.map((c) => c.id), ['none', 'custom']);
  const typed = plan({ 'package.json': pkg({ scripts: { test: 'custom-runner' } }), 'package-lock.json': '{}' }, { 'one-test-file': { choice: 'custom', command: 'custom-runner {file}' } });
  assert.equal(typed.commands.one, 'custom-runner {file}');
  const noFile = plan({ 'package.json': pkg({ scripts: { test: 'custom-runner' } }), 'package-lock.json': '{}' }, { 'one-test-file': { choice: 'custom', command: 'custom-runner' } });
  assert.match(noFile.open[0]!.ask, /must contain \{file\}/, 'a runner.one without {file} is asked again, not drafted');
});

test('a command failing on the default branch is a question: use it anyway, pick another, or skip; each answer recorded', () => {
  const d = detect({ 'package.json': pkg({ scripts: { test: 'a', 'test:unit': 'b' } }), 'package-lock.json': '{}' });
  const q = failureQuestion('full', 'npm test', d);
  assert.equal(q.id, 'full-fails');
  assert.match(q.ask, /`npm test` fails on the default branch: use it anyway, pick another, or skip\?/);
  assert.deepEqual(q.choices.map((c) => c.command ?? c.id), ['npm test', 'npm run test:unit', 'custom', 'skip']);
  const s = emptyAutoConfig();
  assert.match(applyAnswer(s, q, { choice: 'nope' })!, /isn't an answer to full-fails/);
  assert.equal(applyAnswer(s, q, { choice: 'use' }), null);
  assert.deepEqual(s.accepted, ['npm test']);
  applyAnswer(s, q, { choice: '1' });
  assert.equal(s.overrides.full, 'npm run test:unit');
  applyAnswer(s, q, { choice: 'skip' });
  assert.equal(s.overrides.full, NO_TESTS);
  applyAnswer(s, failureQuestion('one', 'x {file}', d), { choice: 'skip' });
  assert.equal(s.overrides.one, null, 'runner.one skipped: unset');
});

test('the draft: tests.yaml validates against the schema, with each command and its result on the default branch', () => {
  const p = plan({ 'package.json': pkg({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }), 'package-lock.json': '{}', 'src/a.ts': '', 'src/a.test.ts': '' });
  const text = draftTests(p, [{ slot: 'full', command: 'npm test', base: 'abcdef1234', code: 0, passed: true, ms: 4000, tail: '', at: '' }]);
  const t = TestsConfig.parse(parse(text));
  assert.deepEqual([t.runner.full, t.runner.changed, t.runner.one, t.worktree.setup, t.vacuity?.test_globs], ['npm test', 'npm test', 'npx vitest run {file}', ['npm ci'], ['src/**/*.test.ts']]);
  assert.match(text, /runner\.full: npm test {2}-> passed on abcdef12 in 4 s/);
  assert.match(text, /runner\.changed is the full run/);
});

// ---------- end to end: a scratch worktree, the runs, the branch and the PR ----------

/** A repo whose origin is a bare repo standing in for GitHub (at a path ending github.com/<owner>/<name>.git, so it reads as that repo), with `files` on main. */
function project(files: Record<string, string>): { root: string; bare: string; mainSha: () => string } {
  const base = mkdtempSync(join(tmpdir(), 'ac-repo-'));
  const bare = join(base, 'github.com', 'example-org', 'example-shop.git');
  mkdirSync(dirname(bare), { recursive: true });
  const root = join(base, 'shop');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  mkdirSync(root);
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']] as const) git(root, 'config', k, v);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  git(root, 'add', '--', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, bare, mainSha: () => git(bare, 'rev-parse', 'refs/heads/main').trim() };
}

/** A stand-in gh: what auto-config asks of it, recorded. */
function ghStandIn(prState = 'OPEN') {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const a = args.join(' ');
    if (a.startsWith('repo view')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (a.startsWith('api user')) return { status: 0, stdout: 'ada\n', stderr: '' };
    if (a.startsWith('pr list')) return { status: 0, stdout: '', stderr: '' };
    if (a.startsWith('pr create')) return { status: 0, stdout: 'https://github.com/example-org/example-shop/pull/7\n', stderr: '' };
    if (a.startsWith('pr view')) return { status: 0, stdout: `${prState}\n`, stderr: '' };
    return { status: 1, stdout: '', stderr: `no stand-in for gh ${a}` };
  };
  return { calls, gh };
}

function acIo(gh: ReturnType<typeof ghStandIn>['gh'], answers: (string | null)[] = []): AutoConfigIo & { said: string[] } {
  const said: string[] = [];
  return {
    said,
    git: (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    gh: (args) => gh(args),
    ask: async () => (answers.length ? answers.shift()! : null),
    say: (l) => said.push(l),
  };
}

const FAILS = 'node -e "process.exit(3)"';
const PASSES = 'node -e "process.exit(0)"';

test('verified on the default branch in a scratch worktree: a failing command is a question, never dropped, and nothing is proposed while it is open', async () => {
  const p = project({ 'README.md': 'shop\n' });
  const before = p.mainSha();
  const g = ghStandIn();
  const state: AutoConfigState = emptyAutoConfig();
  let saves = 0;
  const io = acIo(g.gh);
  const r = await autoConfigure({ root: p.root, repo: 'example-org/example-shop', io, state, given: { 'no-test-command': `custom:${FAILS}`, 'one-test-file': 'none' }, save: () => saves++ });
  assert.equal(r.kind, 'questions', JSON.stringify(r));
  assert.deepEqual(r.kind === 'questions' && r.open.map((q) => q.id), ['full-fails']);
  assert.match(r.kind === 'questions' ? r.detail : '', /full-fails \(use \/ custom \/ skip\)/);
  assert.match(io.said.join('\n'), /running runner\.full on main \([0-9a-f]{8}\): node -e "process\.exit\(3\)"\n {5}FAILED \(exit 3\)/);
  const v = state.verified.find((x) => x.command === FAILS)!;
  assert.deepEqual([v.slot, v.passed, v.code, v.base], ['full', false, 3, before], 'recorded: the exit status, on main as it is');
  assert.deepEqual(state.questions.map((q) => q.id), ['full-fails'], 'kept for the checklist and the First-run page');
  assert.deepEqual(state.answers, { 'no-test-command': { choice: 'custom', command: FAILS }, 'one-test-file': { choice: 'none' } });
  assert.ok(saves > 0, 'answers and results are saved as they come');
  assert.equal(g.calls.filter((c) => c[0] === 'pr').length, 0, 'nothing proposed while a question is open');
  assert.equal(spawnSync('git', ['ls-remote', '--exit-code', p.bare, `refs/heads/${SETUP_BRANCH}`]).status, 2, 'nothing pushed either');
  assert.equal(p.mainSha(), before);

  // A time limit: a command that outlives it is stopped and recorded as failing (no exit status).
  const slow = emptyAutoConfig();
  const t0 = Date.now();
  const timed = await autoConfigure({ root: p.root, repo: 'example-org/example-shop', io: acIo(g.gh), state: slow, given: { 'no-test-command': 'custom:node -e "setTimeout(() => {}, 60000)"', 'one-test-file': 'none' }, timeoutMs: 1500, save: () => undefined });
  assert.ok(Date.now() - t0 < 30_000);
  assert.equal(timed.kind, 'questions');
  assert.deepEqual(slow.verified.map((x) => [x.passed, x.code]), [[false, null]]);

  // Answered "use it anyway": kept, as answered, and proposed.
  const used = await autoConfigure({ root: p.root, repo: 'example-org/example-shop', io: acIo(g.gh), state, given: { 'full-fails': 'use' }, save: () => undefined });
  assert.equal(used.kind, 'proposed', JSON.stringify(used));
  assert.deepEqual(state.accepted, [FAILS]);
  assert.equal(p.mainSha(), before, 'main on the remote is untouched');
});

test('the PR: answered on the terminal, the scaffold is drafted on the setup branch, validated, pushed there only, and opened with gh against main', async () => {
  const p = project({ 'README.md': 'shop\n' });
  const before = p.mainSha();
  const g = ghStandIn();
  const state = emptyAutoConfig();
  // The terminal: no test command -> a typed one that fails; one-test-file -> none; full-fails -> pick another (passes).
  const io = acIo(g.gh, ['custom', FAILS, 'none', 'custom', PASSES]);
  const r = await autoConfigure({ root: p.root, repo: 'example-org/example-shop', io, state, save: () => undefined });
  assert.equal(r.kind, 'proposed', JSON.stringify(r) + io.said.join('\n'));
  assert.match(r.kind === 'proposed' ? r.detail : '', /proposed in PR #7 \(https:\/\/github\.com\/example-org\/example-shop\/pull\/7\), from worklane\/setup: review and merge it/);
  assert.deepEqual(state.pr, { number: 7, url: 'https://github.com/example-org/example-shop/pull/7', branch: SETUP_BRANCH });
  assert.deepEqual(state.verified.map((x) => [x.command, x.passed]), [[FAILS, false], [PASSES, true]]);
  assert.equal(p.mainSha(), before, 'main on the remote is untouched');
  const create = g.calls.find((c) => c[0] === 'pr' && c[1] === 'create')!;
  assert.deepEqual([create[create.indexOf('--base') + 1], create[create.indexOf('--head') + 1]], ['main', SETUP_BRANCH]);
  const body = create[create.indexOf('--body') + 1]!;
  assert.match(body, /\| full \| `node -e "process\.exit\(0\)"` \| passed on [0-9a-f]{8} in \d+ s \|/);
  assert.match(body, /Owner and writer: @ada/);
  // The pushed branch holds a config that loads with the engine's own loader and schema.
  execFileSync('git', ['fetch', '-q', 'origin', SETUP_BRANCH], { cwd: p.root });
  const cfg = loadConfigAt(p.root, `origin/${SETUP_BRANCH}`);
  assert.deepEqual([cfg.tests.runner.full, cfg.tests.runner.changed, cfg.tests.runner.one, cfg.project.project.repo, cfg.project.owners.default], [PASSES, PASSES, undefined, 'example-org/example-shop', 'ada']);
  assert.equal(execFileSync('git', ['rev-list', '--count', `origin/main..origin/${SETUP_BRANCH}`], { cwd: p.root, encoding: 'utf8' }).trim(), '1', 'one commit on top of main');
  assert.deepEqual(execFileSync('git', ['diff', '--name-only', `origin/main`, `origin/${SETUP_BRANCH}`], { cwd: p.root, encoding: 'utf8' }).split('\n').filter(Boolean).every((f) => f.startsWith(`${BRAND.configDir}/`)), true, 'only the config folder');
  assert.ok(!existsSync(join(p.root, BRAND.configDir)), "the person's checkout is untouched (a scratch worktree did it)");
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${SETUP_BRANCH}`], { cwd: p.root }).status, 1, 'the scratch branch is cleaned up locally');

  // A rerun with the PR open: checked, not opened again.
  const again = await autoConfigure({ root: p.root, repo: 'example-org/example-shop', io: acIo(g.gh), state, save: () => undefined });
  assert.equal(again.kind, 'proposed');
  assert.equal(g.calls.filter((c) => c[1] === 'create').length, 1);
});

test('init: the questions in the checklist and on the First-run page with their choices; --answer resumes; once merged, the checkout fast-forwards and the hooks go in', async () => {
  const p = project({ 'README.md': 'shop\n' });
  const g = ghStandIn();
  const prefix = mkdtempSync(join(tmpdir(), 'ac-prefix-'));
  const said: string[] = [];
  const io: InitIo = {
    which: (c) => (['git', 'gitleaks', 'claude', 'gh'].includes(c) ? `/stand-in/${c}` : null),
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude') return { status: 0, stdout: '{"loggedIn": true}', stderr: '' };
      if (cmd === 'gh' && a === 'auth status') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'gh' && a.endsWith('--jq .permissions.push')) return { status: 0, stdout: 'true\n', stderr: '' };
      if (cmd === 'gh' && a.endsWith('/protection --silent')) return { status: 1, stdout: '', stderr: 'HTTP 404' };
      if (cmd === 'gh') return g.gh(args);
      return { status: 1, stdout: '', stderr: 'no stand-in' };
    },
    interactive: async () => 0,
    ask: async () => null,
    say: (l) => said.push(l),
    download: async () => undefined,
    plan: () => null,
    addProject: async () => ({ code: 1, steps: {}, last: '' }),
  };
  const args = (a: Partial<InitArgs> = {}): InitArgs => ({ target: p.root, mode: 'local', instance: undefined, yes: false, reset: false, cwd: p.root, prefix, interactive: false, ...a });
  assert.equal(await initCommand(args(), io), 1);
  const s1 = readInitState(localInitFile(p.root))!;
  assert.equal(s1.steps['repo-config']?.status, 'failed', said.join('\n'));
  assert.match(s1.steps['repo-config']!.detail, /1 question to answer before the config is proposed: no-test-command \(custom \/ none\)/);
  assert.match(s1.steps['repo-config']!.detail, /`worklane init --answer <id>=<choice>`/);
  const f = firstRunView(localInitFile(p.root), { root: p.root, repo: 'example-org/example-shop', instance: null });
  assert.deepEqual(f.autoConfig?.questions.map((q) => [q.id, q.choices.map((c) => c.id)]), [['no-test-command', ['custom', 'none']]]);
  assert.equal(f.autoConfig?.answer, `worklane init ${p.root} --answer <id>=<choice>`);

  // Answered on the command line: it resumes, runs the command on main, proposes.
  assert.equal(await initCommand(args({ answers: { 'no-test-command': `custom:${PASSES}`, 'one-test-file': 'none' } }), io), 1);
  const s2 = readInitState(localInitFile(p.root))!;
  assert.match(s2.steps['repo-config']!.detail, /proposed in PR #7/);
  const f2 = firstRunView(localInitFile(p.root), { root: p.root, repo: 'example-org/example-shop', instance: null });
  assert.deepEqual([f2.autoConfig?.questions, f2.autoConfig?.pr, f2.autoConfig?.verified.map((v) => [v.slot, v.command, v.passed])], [[], { number: 7, url: 'https://github.com/example-org/example-shop/pull/7' }, [['full', PASSES, true]]]);

  // The owner merges it on GitHub (here: the branch fast-forwarded into the bare repo's main).
  execFileSync('git', ['push', '-q', p.bare, `refs/heads/${SETUP_BRANCH}:refs/heads/main`], { cwd: p.bare });
  const code = await initCommand(args(), io);
  const s3 = readInitState(localInitFile(p.root))!;
  assert.equal(s3.steps['repo-config']!.status, 'done', s3.steps['repo-config']!.detail + said.join('\n'));
  assert.equal(code, 0);
  assert.ok(existsSync(join(p.root, BRAND.configDir, 'tests.yaml')), 'the checkout fast-forwarded to the merged config');
  assert.ok(existsSync(join(p.root, '.claude', 'settings.json')), 'the hooks for local runs, from it');
  assert.match(readFileSync(join(p.root, BRAND.configDir, 'tests.yaml'), 'utf8'), /full: node -e "process\.exit\(0\)"/);
});
