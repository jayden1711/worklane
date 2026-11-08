import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

// The acceptance tests that need a booted systemd run in one place, ci.yml's systemd-acceptance job on GitHub's VM
// (#1165's follow-up): the self-hosted tests runner's container skips them, and the main-only runner has no sudo.

type Script = {
  systemdTests: (text: string) => string[];
  gateCount: (text: string) => number;
  mentionCount: (text: string) => number;
  findAll: (dir: string) => { file: string; names: string[] }[];
  problems: (runs: { file: string; names: string[]; tap: string }[]) => string[];
  gateLikeCount: (text: string) => number;
};
const sa = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance.mjs')).href)) as Script;

// The gate's identifier built from parts: written whole, it would be a mention of it in this file, which the script
// refuses unless it's a gate it reads (and this file's fixtures would be gates it finds).
const flag = `${'system'}Ci`;
const gate = (sp = ' ') => `skip:${sp}!${flag}`;
const tmp = () => mkdtempSync(join(tmpdir(), 'sa-'));

type Step = { run?: string; uses?: string; name?: string };
type Job = { name?: string; if?: string; 'runs-on'?: unknown; container?: unknown; 'continue-on-error'?: unknown; 'timeout-minutes'?: unknown; steps?: Step[] };

test('every test gated on the systemd CI flag is found by its gate, and the 3 from #1165 are among them', () => {
  const found = sa.findAll(join(repoRoot, 'test'));
  const names = found.flatMap((f) => f.names);
  for (const want of [
    "acceptance: built as a DynamicUser and installed, the engine is readable by and starts as other users, exec'd through a symlink like the services do",
    "acceptance: lib.sh's sudo_version reads the runner's real sudo -V, as 1.9.10 or later (the pattern rules' minimum)",
    "acceptance: two instances' agent users each get their own /tmp, so a fixed path like /tmp/cc-socks locks neither out",
  ]) assert.ok(names.includes(want), want);
  assert.equal(new Set(names).size, names.length, 'each name once: the run selects tests by name');
});

test('a gate outside a test() call the script reads stops it, so no gated test is left out', () => {
  assert.deepEqual(sa.systemdTests(`test('a', { ${gate()} && 'x' }, () => {});\ntest("b's", { ${gate()} }, () => {});`), ['a', "b's"]);
  assert.deepEqual(sa.systemdTests(`test('it\\'s', { ${gate()} && 'x' }, () => {});`), ["it's"]);
  const dir = tmp();
  writeFileSync(join(dir, 'odd.test.ts'), `const o = { ${gate()} };\ntest('a', o, () => {});\n`);
  assert.throws(() => sa.findAll(dir), new RegExp(`test/odd\\.test\\.ts: 1 use\\(s\\) of ${flag}, 0 a gate in a test\\(\\) call`));
  assert.equal(sa.gateCount(`{ ${gate()} } { ${gate('')} }`), 2);
});

test('a gated test passes the run only by running and passing: a skip, a todo, a failure or no result each fail it', () => {
  const names = ['acceptance: a', 'acceptance: b # c'];
  const run = (tap: string) => sa.problems([{ file: 'f.test.ts', names, tap }]);
  assert.deepEqual(run('TAP version 13\nok 1 - acceptance: a\nok 2 - acceptance: b \\# c\n1..2\n'), []);
  assert.deepEqual(run('ok 1 - acceptance: a # SKIP needs systemd\nok 2 - acceptance: b \\# c\n'), ['test/f.test.ts: acceptance: a: SKIP needs systemd (it must run here: this is the one place it does)']);
  assert.deepEqual(run('ok 1 - acceptance: a # TODO later\nok 2 - acceptance: b \\# c\n'), ['test/f.test.ts: acceptance: a: TODO later (it must run here: this is the one place it does)']);
  assert.deepEqual(run('not ok 1 - acceptance: a\nok 2 - acceptance: b \\# c\n'), ['test/f.test.ts: acceptance: a: failed']);
  assert.deepEqual(run('ok 1 - acceptance: a\n'), ["test/f.test.ts: acceptance: b # c: didn't run"]);
  // A gated test inside a describe() is an indented line: its result, read at any depth (R1169c).
  assert.deepEqual(sa.problems([{ file: 'f.test.ts', names: ['acceptance: a'], tap: '    ok 1 - acceptance: a\nok 1 - suite\n' }]), []);
});

test("a same-named test that passes can't hide a gated test's skip, in its own file or another (R1169b #1)", () => {
  // In the same file: both run (the run selects by name), and the later pass would overwrite the skip.
  const dup = 'ok 1 - acceptance: x # SKIP needs systemd\nok 2 - acceptance: x\n';
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', names: ['acceptance: x'], tap: dup }]), [
    "test/a.test.ts: acceptance: x: ran 2 times (a gated test's name must be unique in its file: the run selects by name)",
  ]);
  // In another file: results are keyed by file and name, so b's pass is not a's result.
  assert.deepEqual(sa.problems([
    { file: 'a.test.ts', names: ['acceptance: x'], tap: 'ok 1 - acceptance: x # SKIP needs systemd\n' },
    { file: 'b.test.ts', names: ['acceptance: y'], tap: 'ok 1 - acceptance: x\nok 2 - acceptance: y\n' },
  ]), ['test/a.test.ts: acceptance: x: SKIP needs systemd (it must run here: this is the one place it does)']);
});

test('a gated test in a subdirectory of test/ is found, by its path from test/ (R1169b #2)', () => {
  const dir = tmp();
  mkdirSync(join(dir, 'adversarial', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'top.test.ts'), `test('acceptance: top', { ${gate()} && 'x' }, () => {});\n`);
  writeFileSync(join(dir, 'adversarial', 'deep', 'nested.test.ts'), `test('acceptance: nested', { ${gate()} && 'x' }, () => {});\n`);
  assert.deepEqual(sa.findAll(dir), [
    { file: 'adversarial/deep/nested.test.ts', names: ['acceptance: nested'] },
    { file: 'top.test.ts', names: ['acceptance: top'] },
  ]);
});

test('the gate spelled any other way, or the flag used anywhere but the gate, stops it (R1169b #3)', () => {
  const decl = `const ${flag} = process.platform === 'linux';\n`;
  for (const [what, body] of [
    ['a space after !', `test('n', { skip: ! ${flag} && 'x' }, () => {});`],
    ['parentheses', `test('n', { skip: !(${flag}) && 'x' }, () => {});`],
    ['a ternary', `test('n', { skip: ${flag} ? false : 'x' }, () => {});`],
    ['not the first key', `test('n', { timeout: 5, ${gate()} && 'x' }, () => {});`],
    ['a check inside the test', `test('n', (t) => { if (!${flag}) return t.skip(); });`],
    ['a second, unread use beside a gate', `test('n', { ${gate()} && 'x' }, () => {});\nconst also = !${flag};`],
  ] as const) {
    const dir = tmp();
    writeFileSync(join(dir, 'x.test.ts'), decl + body + '\n');
    assert.throws(() => sa.findAll(dir), new RegExp(`test/x\\.test\\.ts: \\d use\\(s\\) of ${flag}`), what);
  }
  // Its declaration is not a use; the gate as written is read.
  assert.equal(sa.mentionCount(decl), 0);
  const dir = tmp();
  writeFileSync(join(dir, 'ok.test.ts'), `${decl}test('acceptance: n', { ${gate()} && 'x' }, () => {});\n`);
  assert.deepEqual(sa.findAll(dir), [{ file: 'ok.test.ts', names: ['acceptance: n'] }]);
});

test("ci.yml's systemd-acceptance job: GitHub's VM on each push to main, never self-hosted, running the script last", () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { on: { push?: { branches?: string[] } }; jobs: Record<string, Job> };
  assert.deepEqual(wf.on.push?.branches, ['main'], 'a push runs it on main only');
  const job = wf.jobs['systemd-acceptance'];
  assert.ok(job, 'the job is there');
  assert.equal(job.name, 'systemd acceptance (real systemd)');
  assert.equal(job.if, "github.event_name == 'push'", 'each push to main, never a PR');
  // A literal GitHub image: no expression could route it to a self-hosted runner, and no container (no systemd there).
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.container, undefined);
  assert.equal(job['continue-on-error'], undefined, 'its failure is a failure');
  assert.ok(typeof job['timeout-minutes'] === 'number' && job['timeout-minutes'] <= 120, 'a hung test fails it within a bound (R1169d)');
  assert.doesNotMatch(JSON.stringify(job), /CI_SELF_HOSTED|self-hosted|trusted-/);
  const steps = job.steps ?? [];
  assert.equal(steps.at(-1)?.run, 'node scripts/ci/systemd-acceptance.mjs', 'the script is the last step, run as itself');
  const i = (pred: (s: Step) => boolean) => steps.findIndex(pred);
  const pins = i((s) => s.run === 'node scripts/ci/check-pins.mjs');
  assert.ok(i((s) => s.run === 'npm ci --ignore-scripts') >= 0 && pins > i((s) => s.run === 'npm ci --ignore-scripts'), 'installed with no package scripts, pins checked before the build');
  assert.ok(i((s) => /tsc -p tsconfig\.json/.test(s.run ?? '')) > pins, 'built with the locked tsc after the pin check');
  assert.ok(i((s) => /scripts\/setup\/machine\.sh/.test(s.run ?? '')) < steps.length - 1, 'machine.sh before the tests');
});

test('a gated test nested in a describe() or a t.test() is read at its depth: a same-named pass elsewhere in the file can\'t hide its skip (R1169c)', () => {
  const names = ['acceptance: x'];
  // The gated test inside a describe() skips; an ungated top-level test of the same name passes after it.
  const hidden = '    ok 1 - acceptance: x # SKIP needs systemd\nok 1 - suite\nok 2 - acceptance: x\n';
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', names, tap: hidden }]), [
    "test/a.test.ts: acceptance: x: ran 2 times (a gated test's name must be unique in its file: the run selects by name)",
  ]);
  // Alone and nested, it fails on its skip as a top-level one would.
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', names, tap: '    ok 1 - acceptance: x # SKIP needs systemd\nok 1 - suite\n' }]), ['test/a.test.ts: acceptance: x: SKIP needs systemd (it must run here: this is the one place it does)']);
});

test("a gated test passes only when all of it ran: a subtest that skips, is a todo or fails fails it (R1169d #3)", () => {
  const names = ['acceptance: parent'];
  const run = (tap: string) => sa.problems([{ file: 'p.test.ts', names, tap }]);
  assert.deepEqual(run('    ok 1 - the real check # SKIP no systemd\nok 1 - acceptance: parent\n'), ['test/p.test.ts: acceptance: parent: its subtest "the real check" SKIP no systemd (all of it must run here)']);
  assert.deepEqual(run('        ok 1 - deeper # TODO later\n    ok 1 - step\nok 1 - acceptance: parent\n'), ['test/p.test.ts: acceptance: parent: its subtest "deeper" TODO later (all of it must run here)']);
  assert.deepEqual(run('    not ok 1 - step\nok 1 - acceptance: parent\n'), ['test/p.test.ts: acceptance: parent: its subtest "step" failed (all of it must run here)']);
  assert.deepEqual(run('    ok 1 - step\nok 1 - acceptance: parent\n'), [], 'its subtests all passed');
  // Another test's subtests are not its own.
  assert.deepEqual(run('    ok 1 - skipped # SKIP x\nok 1 - other\nok 2 - acceptance: parent\n'), []);
});

test('a systemd flag under another name, or a gate in a helper module, stops it, so no gated test is hidden (R1169d #1, #2)', () => {
  // Renamed (the flag spelled with a d): its skip names a flag shaped like the gate, and no gate this reads.
  let dir = tmp();
  writeFileSync(join(dir, 'engine.test.ts'), `const ${'system'}dCi = false;\ntest('acceptance: renamed', { skip: !${'system'}dCi && 'x' }, () => {});\n`);
  assert.throws(() => sa.findAll(dir), /test\/engine\.test\.ts: 1 skip\(s\) that look like a systemd gate, 0 a gate this reads/);
  // A flag read from systemd's sign under another name.
  dir = tmp();
  writeFileSync(join(dir, 'engine.test.ts'), `const onVm = existsSync('${'/run/systemd'}/system');\ntest('acceptance: other', { skip: !onVm && 'x' }, () => {});\n`);
  assert.throws(() => sa.findAll(dir), /onVm read\(s\) systemd's sign under another name/);
  // A gated test registered from a helper module (not *.test.ts), as test/browser-helpers.ts registers tests.
  dir = tmp();
  writeFileSync(join(dir, 'sys-helpers.ts'), `export function acceptance() { test('acceptance: from a helper', { ${gate()} && 'x' }, () => {}); }\n`);
  writeFileSync(join(dir, 'user.test.ts'), "import { acceptance } from './sys-helpers.js';\nacceptance();\n");
  assert.throws(() => sa.findAll(dir), /test\/sys-helpers\.ts: a systemd gate outside a \*\.test\.ts file/);
  // A test that checks for systemctl itself, with "systemd" only in its reason, is not a gate.
  assert.equal(sa.gateLikeCount("{ skip: process.platform !== 'linux' || !which('systemctl') ? 'needs systemd' : false }"), 0);
});

