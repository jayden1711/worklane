import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
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
  findAll: (dir: string, prefix?: string) => { file: string; names: string[] }[];
  problems: (runs: { file: string; gates: { name: string; line: number; column: number }[]; events: Ev[] }[]) => string[];
  gatesOf: (text: string) => { name: string; line: number; column: number; member: boolean; first: boolean; computed: boolean }[];
  buildRoots: (dir: string) => string[];
  summaryProblems: (tap: string, file: string, gates: number) => string[];
  gateLikeCount: (text: string) => number;
  signUses: (ts: unknown, path: string, text: string) => string[];
  skipImports: (ts: unknown, path: string, text: string, paths: Set<string>) => string[];
  signProblems: (ts: unknown, texts: Map<string, string>, allow?: { uses?: Record<string, { n: number; why: string }>; skipImports?: Record<string, string> }) => string[];
};
const sa = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance.mjs')).href)) as Script;

// The gate's identifier built from parts: written whole, it would be a mention of it in this file, which the script
// refuses unless it's a gate it reads (and this file's fixtures would be gates it finds).
const flag = `${'system'}Ci`;
const gate = (sp = ' ') => `skip:${sp}!${flag}`;
const tmp = () => mkdtempSync(join(tmpdir(), 'sa-'));
/** The build's typescript package, which the script parses each file with (its sign rule, R1169k). */
const ts = createRequire(join(repoRoot, 'package.json'))('typescript') as unknown;
/** A scratch root's node_modules: the repo's, so the script finds typescript there as CI's npm ci gives it. */
const modules = (r: string) => symlinkSync(join(repoRoot, 'node_modules'), join(r, 'node_modules'));

type Ev = { type: 'test:pass' | 'test:fail'; name: string; nesting: number; file: string | null; line: number | null; column: number | null; skip: string | boolean | null; todo: string | boolean | null };
/** One of node's results, as the reporter writes it: in `file` (built), at `line`, passed unless `o` says otherwise. */
const ev = (name: string, line: number, o: Partial<Ev> = {}, file = '/r/dist/test/f.test.js'): Ev => ({ type: 'test:pass', name, nesting: 0, file, line, column: 1, skip: null, todo: null, ...o });

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
  const gates = [{ name: 'acceptance: a', line: 3, column: 1 }, { name: 'acceptance: b # c', line: 9, column: 1 }];
  const run = (events: Ev[]) => sa.problems([{ file: 'f.test.ts', gates, events }]);
  assert.deepEqual(run([ev('acceptance: a', 3), ev('acceptance: b # c', 9)]), []);
  assert.deepEqual(run([ev('acceptance: a', 3, { skip: 'needs systemd' }), ev('acceptance: b # c', 9)]), ['test/f.test.ts: acceptance: a: SKIP needs systemd (it must run here: this is the one place it does)']);
  assert.deepEqual(run([ev('acceptance: a', 3, { todo: 'later' }), ev('acceptance: b # c', 9)]), ['test/f.test.ts: acceptance: a: TODO later (it must run here: this is the one place it does)']);
  assert.deepEqual(run([ev('acceptance: a', 3, { type: 'test:fail' }), ev('acceptance: b # c', 9)]), ['test/f.test.ts: acceptance: a: failed']);
  assert.deepEqual(run([ev('acceptance: a', 3)]), ["test/f.test.ts: acceptance: b # c: didn't run"]);
  // A gate inside a describe() is a deeper event: its own result all the same, matched by its line.
  assert.deepEqual(sa.problems([{ file: 'f.test.ts', gates: [gates[0]!], events: [ev('acceptance: a', 3, { nesting: 1 }), ev('suite', 2)] }]), []);
});

test("a result counts for a gate only at its own file, line and name: a namesake elsewhere, or in another file, can't stand in for it (R1169b #1, R1169e, R1169f)", () => {
  const gates = [{ name: 'acceptance: x', line: 4, column: 1 }];
  // The gate skipped; a same-named test on another line passes.
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', gates, events: [ev('acceptance: x', 4, { skip: 'needs systemd' }, '/r/dist/test/a.test.js'), ev('acceptance: x', 5, {}, '/r/dist/test/a.test.js')] }]), ['test/a.test.ts: acceptance: x: SKIP needs systemd (it must run here: this is the one place it does)']);
  // Registered only sometimes (under an env var): no result at its line, while a namesake on the next line passes.
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', gates, events: [ev('acceptance: x', 5, {}, '/r/dist/test/a.test.js')] }]), ["test/a.test.ts: acceptance: x: didn't run"]);
  // The same line and name at another column (a namesake sharing the gate's line, R1169h).
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', gates, events: [ev('acceptance: x', 4, { column: 40 }, '/r/dist/test/a.test.js')] }]), ["test/a.test.ts: acceptance: x: didn't run"]);
  // Another file's pass at the same line and name.
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', gates, events: [ev('acceptance: x', 4, {}, '/r/dist/test/b.test.js')] }]), ["test/a.test.ts: acceptance: x: didn't run"]);
  // Twice at its line and name (a loop registering it): it ran more than once.
  assert.deepEqual(sa.problems([{ file: 'a.test.ts', gates, events: [ev('acceptance: x', 4, {}, '/r/dist/test/a.test.js'), ev('acceptance: x', 4, {}, '/r/dist/test/a.test.js')] }]), ['test/a.test.ts: acceptance: x: ran 2 times']);
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

test("a gated test passes only when all of it ran: a subtest that skips, is a todo or fails fails it (R1169d #3); a test here skipped for systemd fails the run (R1169f's floor)", () => {
  const gates = [{ name: 'acceptance: parent', line: 7, column: 1 }];
  const run = (events: Ev[]) => sa.problems([{ file: 'f.test.ts', gates, events }]);
  assert.deepEqual(run([ev('the real check', 8, { nesting: 1, skip: 'no systemd' }), ev('acceptance: parent', 7)]), ['test/f.test.ts: acceptance: parent: its subtest "the real check" SKIP no systemd (all of it must run here)']);
  assert.deepEqual(run([ev('deeper', 9, { nesting: 2, todo: 'later' }), ev('step', 8, { nesting: 1 }), ev('acceptance: parent', 7)]), ['test/f.test.ts: acceptance: parent: its subtest "deeper" TODO later (all of it must run here)']);
  assert.deepEqual(run([ev('step', 8, { nesting: 1, type: 'test:fail' }), ev('acceptance: parent', 7)]), ['test/f.test.ts: acceptance: parent: its subtest "step" failed (all of it must run here)']);
  assert.deepEqual(run([ev('step', 8, { nesting: 1 }), ev('acceptance: parent', 7)]), [], 'its subtests all passed');
  // Another test's subtests are not its own.
  assert.deepEqual(run([ev('skipped', 3, { nesting: 1, skip: 'x' }), ev('other', 2), ev('acceptance: parent', 7)]), []);
  // The floor: any other test in the run skipped naming systemd.
  assert.deepEqual(run([ev('acceptance: parent', 7), ev('a host test', 12, { skip: 'needs systemd' })]), ['test/f.test.ts: a host test: SKIP needs systemd (a test skipped for systemd here, where systemd is)']);
});

test('a gate on a subtest (t.test), a function or an inline check that reads systemd\'s sign, or a gate in src/, stops it (R1169e, R1169f)', () => {
  let dir = tmp();
  writeFileSync(join(dir, 'sub.test.ts'), `test('outer', async (t) => {\n  await t.test('acceptance: inner', { ${gate()} && 'x' }, () => {});\n});\n`);
  assert.throws(() => sa.findAll(dir), /test\/sub\.test\.ts: a gate on a subtest/);
  assert.deepEqual(sa.gatesOf(`// it ends with a dot.\ntest('acceptance: top', { ${gate()} && 'x' }, () => {});\n`).map((g) => [g.line, g.member]), [[2, false]], 'a dot on the line before is not a member call');
  assert.deepEqual(sa.signUses(ts, 'test/fn.test.ts', `function onHost() { return existsSync('${'/run/sys'}temd/system'); }\ntest('acceptance: g', { skip: !onHost() && 'x' }, () => {});\n`), ['1: systemd']);
  assert.deepEqual(sa.signUses(ts, 'test/inline.test.ts', `test('acceptance: g', { skip: !existsSync('${'/run/sys'}temd/system') && 'x' }, () => {});\n`), ['1: systemd']);
  dir = tmp();
  writeFileSync(join(dir, 'gates.ts'), `export const hostOnly = { ${gate()} && 'x' };\n`);
  assert.throws(() => sa.findAll(dir, 'src/'), /src\/gates\.ts: a systemd gate outside a \*\.test\.ts file/);
});

test('end to end, the script and its reporter on real node --test runs: a faked line, a gate under an env var, a crash and a skipped subtest fail it; a real pass passes', { timeout: 120_000 }, () => {
  const fixture = (src: string, o: { flagValue?: boolean; extra?: Record<string, string> } = {}) => {
    const r = tmp();
    for (const [p, t] of Object.entries(o.extra ?? {})) {
      mkdirSync(join(r, p, '..'), { recursive: true });
      writeFileSync(join(r, p), t);
    }
    mkdirSync(join(r, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(r, 'test'));
    mkdirSync(join(r, 'dist', 'test'), { recursive: true });
    for (const f of ['systemd-acceptance.mjs', 'systemd-acceptance-reporter.mjs']) writeFileSync(join(r, 'scripts', 'ci', f), readFileSync(join(repoRoot, 'scripts', 'ci', f)));
    writeFileSync(join(r, 'package.json'), '{"type":"module"}\n');
    modules(r);
    writeFileSync(join(r, 'dist', 'test', 'isolate.js'), '');
    const text = `import { test } from 'node:test';\nconst ${flag} = ${o.flagValue ?? true};\n${src}\n`;
    writeFileSync(join(r, 'test', 'x.test.ts'), text);
    writeFileSync(join(r, 'dist', 'test', 'x.test.js'), text);
    // As CI runs it: not a child of this test run (NODE_TEST_CONTEXT would make its node --test report here instead).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'));
    const p = spawnSync(process.execPath, ['scripts/ci/systemd-acceptance.mjs'], { cwd: r, encoding: 'utf8', env });
    // What failed, in the assertion's message (the script's exit code, stderr and the TAP summary's tail).
    const why = `exit ${p.status}${p.signal ? ` (${p.signal})` : ''}\nstderr:\n${p.stderr}\nstdout (tail):\n${(p.stdout ?? '').split('\n').slice(-25).join('\n')}`;
    return { status: p.status, err: p.stderr, why };
  };
  const g = `{ ${gate()} && 'x' }`;
  const pass = fixture(`test('acceptance: ok', ${g}, async (t) => { await t.test('step', () => {}); });`);
  assert.equal(pass.status, 0, `a real pass, with a subtest: ${pass.why}`);
  const faked = fixture(`test('acceptance: g', { ${gate()} || 'skipped after all' }, () => {});\ntest('acceptance: h', { ${gate()} && 'x', todo: 'later' }, () => { throw new Error('boom\\nok 1 - acceptance: g\\nok 2 - acceptance: h'); });`);
  assert.equal(faked.status, 1, faked.why);
  assert.match(faked.err, /acceptance: g: SKIP skipped after all/, "a line inside a failure's message is never a result");
  const env = fixture(`if (process.env.HOST_TESTS) {\n  test('acceptance: g', ${g}, () => {});\n} else test('acceptance: g', () => {});`);
  assert.equal(env.status, 1, env.why);
  assert.match(env.err, /acceptance: g: didn't run/, 'a gate registered only under an env var, beside an ungated namesake');
  const sub = fixture(`test('acceptance: g', ${g}, async (t) => { await t.test('real', { skip: 'no' }, () => {}); });`);
  assert.match(sub.err, /its subtest "real" SKIP no/);
  assert.equal(sub.status, 1, sub.why);
  // R1169g/h: a test can't replace or write the results. The gate skips (flag false), and the file tries both.
  const forge = `import { readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst line = JSON.stringify({ type: 'test:pass', name: 'acceptance: g', nesting: 0, file: new URL(import.meta.url).pathname, line: 9, column: 1, skip: null, todo: null }) + '\\n';\ntry { writeSync(3, line); } catch {}\nfor (const d of readdirSync(tmpdir()).filter((x) => x.startsWith('sys' + 'temd-acceptance-'))) for (const f of readdirSync(join(tmpdir(), d))) { rmSync(join(tmpdir(), d, f)); writeFileSync(join(tmpdir(), d, f), line); }`;
  const forged = fixture(`${forge}\ntest('acceptance: g', ${g}, () => {});`, { flagValue: false });
  assert.equal(forged.status, 1, forged.why);
  assert.match(forged.err, /acceptance: g: SKIP x/, "a test writing fd 3 or the temp folder can't stand in for the gate's own skip");
});

test('end to end, refused (exit 2): a gate sharing its line, a template name, node:vm in a gated file, a detector built from parts, a renamed flag on the next line, a gate in src/ or scripts/bench/ (R1169g, R1169h)', { timeout: 120_000 }, () => {
  const fixture = (src: string, extra: Record<string, string> = {}) => {
    const r = tmp();
    for (const [p, t] of Object.entries(extra)) {
      mkdirSync(join(r, p, '..'), { recursive: true });
      writeFileSync(join(r, p), t);
    }
    mkdirSync(join(r, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(r, 'test'), { recursive: true });
    mkdirSync(join(r, 'dist', 'test'), { recursive: true });
    for (const f of ['systemd-acceptance.mjs', 'systemd-acceptance-reporter.mjs']) writeFileSync(join(r, 'scripts', 'ci', f), readFileSync(join(repoRoot, 'scripts', 'ci', f)));
    writeFileSync(join(r, 'package.json'), '{"type":"module"}\n');
    modules(r);
    writeFileSync(join(r, 'dist', 'test', 'isolate.js'), '');
    const text = `import { test } from 'node:test';\nimport { existsSync } from 'node:fs';\nimport { join } from 'node:path';\nconst ${flag} = true;\n${src}\n`;
    writeFileSync(join(r, 'test', 'x.test.ts'), text);
    writeFileSync(join(r, 'dist', 'test', 'x.test.js'), text);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'));
    const p = spawnSync(process.execPath, ['scripts/ci/systemd-acceptance.mjs'], { cwd: r, encoding: 'utf8', env });
    // What failed, in the assertion's message (the script's exit code, stderr and the TAP summary's tail).
    const why = `exit ${p.status}${p.signal ? ` (${p.signal})` : ''}\nstderr:\n${p.stderr}\nstdout (tail):\n${(p.stdout ?? '').split('\n').slice(-25).join('\n')}`;
    return { status: p.status, err: p.stderr, why };
  };
  const g = `{ ${gate()} && 'x' }`;
  const known = `test('acceptance: known', ${g}, () => {});`;
  const cases: [string, string, Record<string, string>, RegExp][] = [
    ['a namesake on its line', `false && test('acceptance: x', ${g}, () => {}); test('acceptance: x', () => {});`, {}, /isn't its line's first statement/],
    ['a template name', `const v = 'x';\ntest(\`acceptance: \${v}\`, ${g}, () => {});`, {}, /computed \(template\) name/],
    ['node:vm in a gated file', `import vm from 'node:vm';\nvoid vm;\n${known}`, {}, /uses node:vm, new Function or eval/],
    ['a detector built from parts', `const booted = existsSync(join('/run', 'sys' + 'temd', 'system')) || existsSync(join('/run', '${'sys'}temd', 'system'));\n${known}\ntest('acceptance: y', { skip: !booted && 'x' }, () => {});`, {}, /test\/x\.test\.ts: 1 use\(s\) of systemd's sign outside/],
    ['a renamed flag on the line after skip:', `const ${'system'}dCi = false;\n${known}\ntest('acceptance: r', { skip:\n  !${'system'}dCi && 'x' }, () => {});`, {}, /2 skip\(s\) that look like a systemd gate, 1 a gate/],
    ['a gate in src/, through a test helper', `import { hostOnly } from '../src/gates.js';\n${known}\ntest('acceptance: h', hostOnly, () => {});`, { 'src/gates.ts': `const ${flag} = true;\nexport const hostOnly = { ${gate()} && 'x' };\n` }, /src\/gates\.ts: a systemd gate outside a \*\.test\.ts file/],
    ['a gate in scripts/bench/', `${known}`, { 'scripts/bench/gates.ts': `const ${flag} = true;\nexport const hostOnly = { ${gate()} && 'x' };\n` }, /scripts\/bench\/gates\.ts: a systemd gate outside a \*\.test\.ts file/],
    ['a gate in a fourth root tsconfig.json names (R1169i)', `${known}`, { 'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts', 'test/**/*.ts', 'scripts/bench/**/*.ts', 'tools/**/*.ts'] }), 'tools/gates.ts': `const ${flag} = true;\nexport const hostOnly = { ${gate()} && 'x' };\n` }, /tools\/gates\.ts: a systemd gate outside a \*\.test\.ts file/],
  ];
  for (const [what, src, extra, re] of cases) {
    const r = fixture(src, extra);
    assert.equal(r.status, 2, `${what}: ${r.why}`);
    assert.match(r.err, re, what);
  }
});

test('a systemd flag under another name, or a gate in a helper module, stops it, so no gated test is hidden (R1169d #1, #2)', () => {
  // Renamed (the flag spelled with a d): its skip names a flag shaped like the gate, and no gate this reads.
  let dir = tmp();
  writeFileSync(join(dir, 'engine.test.ts'), `const ${'system'}dCi = false;\ntest('acceptance: renamed', { skip: !${'system'}dCi && 'x' }, () => {});\n`);
  assert.throws(() => sa.findAll(dir), /test\/engine\.test\.ts: 1 skip\(s\) that look like a systemd gate, 0 a gate this reads/);
  // A flag read from systemd's sign under another name.
  dir = tmp();
  assert.deepEqual(sa.signUses(ts, 'test/engine.test.ts', `const onVm = existsSync('${'/run/sys'}temd/system');\ntest('acceptance: other', { skip: !onVm && 'x' }, () => {});\n`), ['1: systemd']);
  // A gated test registered from a helper module (not *.test.ts), as test/browser-helpers.ts registers tests.
  dir = tmp();
  writeFileSync(join(dir, 'sys-helpers.ts'), `export function acceptance() { test('acceptance: from a helper', { ${gate()} && 'x' }, () => {}); }\n`);
  writeFileSync(join(dir, 'user.test.ts'), "import { acceptance } from './sys-helpers.js';\nacceptance();\n");
  assert.throws(() => sa.findAll(dir), /test\/sys-helpers\.ts: a systemd gate outside a \*\.test\.ts file/);
  // A test that checks for systemctl itself, with "systemd" only in its reason, is not a gate.
  assert.equal(sa.gateLikeCount("{ skip: process.platform !== 'linux' || !which('systemctl') ? 'needs systemd' : false }"), 0);
});

test("the build's roots come from tsconfig.json's include; node's TAP summary must agree with a clean run (R1169g)", () => {
  assert.deepEqual(sa.buildRoots(repoRoot), ['src', 'test', 'scripts/bench'], "this repo's tsconfig");
  const dir = tmp();
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ include: ['lib/**/*.ts', 'test/**/*.ts', 'tools/x/*.ts'] }));
  assert.deepEqual(sa.buildRoots(dir), ['lib', 'test', 'tools/x']);
  const clean = '# tests 2\n# suites 0\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.deepEqual(sa.summaryProblems(clean, 'f.test.ts', 2), []);
  assert.deepEqual(sa.summaryProblems(clean.replace('# skipped 0', '# skipped 1'), 'f.test.ts', 2), ['test/f.test.ts: its TAP summary says 1 skipped']);
  assert.deepEqual(sa.summaryProblems(clean, 'f.test.ts', 3), ['test/f.test.ts: its TAP summary counts 2 test(s), fewer than its 3 gate(s)']);
  assert.deepEqual(sa.summaryProblems('', 'f.test.ts', 1).length, 4, 'no summary: fail closed');
});

test("every review's attack on this script, kept as a fixture, still exits as it must: 2 refused statically, 1 at run time (R1169g, R1169h; the owner's decision)", { timeout: 300_000 }, () => {
  const base = join(repoRoot, 'test', 'fixtures', 'systemd-acceptance');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as Record<string, [number, string] | string>;
  const cases = Object.entries(manifest).filter(([k]) => k !== '//') as [string, [number, string]][];
  assert.deepEqual(cases.map(([k]) => k).sort(), readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), 'every fixture folder is in the manifest');
  for (const [name, [want, why]] of cases) {
    const r = tmp();
    mkdirSync(join(r, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(r, 'test'));
    mkdirSync(join(r, 'dist', 'test'), { recursive: true });
    for (const f of ['systemd-acceptance.mjs', 'systemd-acceptance-reporter.mjs']) writeFileSync(join(r, 'scripts', 'ci', f), readFileSync(join(repoRoot, 'scripts', 'ci', f)));
    writeFileSync(join(r, 'package.json'), '{"type":"module"}\n');
    modules(r);
    writeFileSync(join(r, 'dist', 'test', 'isolate.js'), '');
    for (const f of readdirSync(join(base, name), { recursive: true }).map(String).filter((x) => x.endsWith('.txt'))) {
      const text = readFileSync(join(base, name, f), 'utf8');
      mkdirSync(join(r, 'test', f, '..'), { recursive: true });
      mkdirSync(join(r, 'dist', 'test', f, '..'), { recursive: true });
      writeFileSync(join(r, 'test', f.replace(/\.txt$/, '')), text);
      writeFileSync(join(r, 'dist', 'test', f.replace(/\.ts\.txt$/, '.js')), text);
    }
    // A file outside test/ (src/, a root's own file): `<path>.root`, at <path> from the root.
    for (const f of readdirSync(join(base, name), { recursive: true }).map(String).filter((x) => x.endsWith('.root'))) {
      mkdirSync(join(r, f, '..'), { recursive: true });
      writeFileSync(join(r, f.replace(/\.root$/, '')), readFileSync(join(base, name, f)));
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'));
    const p = spawnSync(process.execPath, ['scripts/ci/systemd-acceptance.mjs'], { cwd: r, encoding: 'utf8', env, timeout: 60_000 });
    const what = `${name}: exit ${p.status}\nstderr:\n${p.stderr}\nstdout (tail):\n${(p.stdout ?? '').split('\n').slice(-15).join('\n')}`;
    assert.equal(p.status, want, what);
    assert.match(p.stderr, new RegExp(why), `${name}, refused for its own reason: ${what}`);
  }
});


// The sign built from parts, so this file's own text holds none outside its tests' functions.
const sd = `${'sys'}temd`;

test("systemd's sign may be only in the flag's declaration, a gate's reason, a test's name or a test's own function that skips nothing (R1169k)", () => {
  const uses = (text: string, path = 'test/x.test.ts') => sa.signUses(ts, path, text);
  // Allowed: the flag's declaration in a test file, a gate's reason, a test's name, a test's function.
  assert.deepEqual(uses(`const ${flag} = existsSync('/run/${sd}/system');\ntest('acceptance: ${sd} unit', { ${gate()} && 'needs ${sd}' }, () => { run('${sd}-run', ['--version']); });\n// a comment: /run/${sd}\n`), []);
  // Anywhere else, in any spelling the parser sees: a constant, a let, a parameter's default, a template, parts, a regex.
  for (const [what, text, want] of [
    ['a constant', `const DIR = '/run/${sd}/system';`, ['1: systemd']],
    ['parts joined', `const p = '/run' + '/${sd}/system';`, ['1: systemd']],
    ['a template', `const p = \`/run/\${x}/${sd}\`;`, ['1: systemd']],
    ['a regex', `const r = /\\/run\\/${sd}/;`, ['1: systemd']],
    ['process 1', `const c = readFileSync('/proc/1/exe');`, ['1: /proc/1/']],
    ['systemctl', `const ok = spawnSync('${sd.slice(0, 6)}ctl', ['is-system-running']);`, ['1: systemctl', '1: is-system-running']],
    ['the variables systemd sets', `const sd = process.env.INVOCATION_ID ?? process.env['NOTIFY_SOCKET'];`, ['1: INVOCATION_ID', '1: NOTIFY_SOCKET']],
    ['a non-gate skip', `test('n', { skip: !ok && 'needs ${sd}' }, () => {});`, ['1: systemd']],
    ["a test's function that skips", `test('n', (t) => { if (!existsSync('/run/${sd}')) t.skip(); });`, ['1: systemd']],
    ['a describe() body', `describe('d', () => { const booted = existsSync('/run/${sd}'); });`, ['1: systemd']],
  ] as const) assert.deepEqual(uses(text), want, what);
  // A word that only contains it is not it; the flag declared in a helper (not *.test.ts) is a use.
  assert.deepEqual(uses(`const ${sd}Tests = 1;`), []);
  assert.deepEqual(uses(`export const ${flag} = existsSync('/run/${sd}');`, 'test/helpers.ts'), ['1: systemd']);
});

test('a skip may read a binding from src/, or from a file that holds the sign, only as the allowlist names it, in any import form (R1169k)', () => {
  const paths = new Set(['test/x.test.ts', 'test/helpers/runner.ts', 'src/os.ts']);
  const reads = (text: string) => sa.skipImports(ts, 'test/x.test.ts', text, paths);
  assert.deepEqual(reads(`import { canRun as onVm } from './helpers/runner.js';\ntest('n', { skip: !onVm }, () => {});`), ['test/helpers/runner.ts: canRun']);
  assert.deepEqual(reads(`import * as r from './helpers/runner.js';\ntest('n', { skip: !r.canRun }, () => {});`), ['test/helpers/runner.ts: *']);
  assert.deepEqual(reads(`import canRun from '../src/os.js';\ntest('n', { skip: !canRun }, () => {});`), ['src/os.ts: default']);
  assert.deepEqual(reads(`const { canRun: ok } = await import('../src/os.js');\ntest('n', { skip: !ok }, () => {});`), ['src/os.ts: canRun']);
  assert.deepEqual(reads(`const os = require('../src/os.js');\nconst skip = !os.up;\ntest('n', { skip }, () => {});`), [], 'a shorthand skip reads its own local, which is no import');
  assert.deepEqual(reads(`import { canRun } from './helpers/runner.js';\ntest('n', { timeout: canRun ? 1 : 2 }, () => {});`), [], 'not a skip');
  const texts = new Map([
    ['src/os.ts', `export const up = existsSync('/run/${sd}');\n`],
    ['test/x.test.ts', `import { up } from '../src/os.js';\ntest('n', { skip: !up && 'x' }, () => {});\n`],
  ]);
  assert.deepEqual(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { n: 1, why: 'product code' } } }).map((p) => p.split(':').slice(0, 3).join(':')), ['test/x.test.ts: a skip reads src/os.ts: up, from src/'], 'src/ named in uses, but its binding read by a skip');
  assert.deepEqual(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { n: 1, why: 'product code' } }, skipImports: { 'src/os.ts: up': 'why' } }), []);
  // The counts hold: one more use, one fewer, or an entry with no file, each stops it.
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { n: 2, why: 'x' } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /src\/os\.ts: 1 use\(s\) of systemd's sign .*, 2 named/);
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { n: 1, why: 'x' }, 'test/gone.ts': { n: 1, why: 'x' } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /test\/gone\.ts: named in .*, but the build has no such file/);
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { n: 1, why: 'x' } }, skipImports: { 'src/os.ts: up': 'why', 'src/os.ts: down': 'why' } }).join('\n'), /src\/os\.ts: down: named in the allowlist's skipImports, but no skip reads it/);
});

test("this repo's build roots hold systemd's sign only where the rule or its allowlist says, so a PR breaks it here, before main's job (R1169k)", () => {
  const texts = new Map<string, string>();
  for (const r of sa.buildRoots(repoRoot)) for (const f of readdirSync(join(repoRoot, r), { recursive: true }).map((x) => String(x).split('\\').join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts'))) texts.set(`${r}/${f}`, readFileSync(join(repoRoot, r, f), 'utf8'));
  const allow = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance-allow.json'), 'utf8')) as { uses: Record<string, { n: number; why: string }>; skipImports: Record<string, string> };
  for (const [p, e] of Object.entries(allow.uses)) assert.ok(e.why.trim(), `${p}: named with why`);
  assert.deepEqual(sa.signProblems(ts, texts, allow), []);
});
