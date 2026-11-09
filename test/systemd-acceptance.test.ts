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
  summaryProblems: (tap: string, file: string, gates: number, whole?: boolean) => string[];
  gateLikeCount: (text: string) => number;
  signUses: (ts: unknown, path: string, text: string) => string[];
  skipReads: (ts: unknown, path: string, text: string, source: { paths: Set<string>; carries: (m: string, b: string) => boolean; direct?: (m: string, b: string) => boolean }) => string[] & { refused: string[] };
  signTests: (ts: unknown, path: string, text: string, source: unknown, all?: boolean) => { name: string | null; line: number; column: number; label: string; subtests: boolean }[];
  signSource: (ts: unknown, texts: Map<string, string>, allow: Allow) => { select: unknown };
  signUseList: (ts: unknown, path: string, text: string) => { at: string; pin: string }[];
  signProblems: (ts: unknown, texts: Map<string, string>, allow?: Allow) => string[];
};
type Allow = { uses?: Record<string, { why: string; uses: string[] }>; skipImports?: Record<string, string>; runtime?: Record<string, string> };
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

type Step = { run?: string; uses?: string; name?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; 'runs-on'?: unknown; container?: unknown; 'continue-on-error'?: unknown; 'timeout-minutes'?: unknown; steps?: Step[] };

test('every test gated on the systemd CI flag is found by its gate, and the 3 from #1165 are among them', () => {
  const found = sa.findAll(join(repoRoot, 'test'));
  const names = found.flatMap((f) => f.names);
  for (const want of [
    "acceptance: built as a DynamicUser and installed, the engine is readable by and starts as other users, exec'd through a symlink like the services do",
    "acceptance: lib.sh's sudo_version reads the runner's real sudo -V, as 1.9.10 or later (the pattern rules' minimum)",
    "acceptance: two instances' agent users each get their own /tmp, so a fixed path like /tmp/cc-socks locks neither out",
    // R1169m: it asserts journald is active, so it needs a booted systemd, which the self-hosted container lacks.
    'unit states from the real systemctl (Linux CI): a running unit is active, one not installed is not-found, so it is never reported down',
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
  // R1169s: the machine exactly as the test shards set it up (bubblewrap, subordinate ids, the ci-unshare profile), and
  // a missing sandbox a failure: tests this job runs whole skip without them, and here a skip fails the job.
  const NS = 'bubblewrap (machine.sh), startable by another user; user namespaces for the stand-in tests';
  const shardStep = Object.values(wf.jobs).flatMap((j) => j.steps ?? []).find((st) => st.name === NS && !(job.steps ?? []).includes(st));
  const ownStep = steps.find((st) => st.name === NS);
  assert.ok(shardStep && ownStep, "both the shards and this job have the user-namespace step");
  // Less the shards' first block, their branch for the self-hosted container, which this job never runs in (and whose
  // words the check above keeps out of this job).
  const container = /^if \[ "\$\{WORKLANE_CI_CONTAINER:-\}" = 1 \]; then\n[\s\S]*?\n {2}exit 0\nfi\n/;
  assert.match(shardStep.run!, container, "the shards' step starts with its container branch");
  assert.equal(ownStep.run, shardStep.run!.replace(container, ''), "this job's machine step is the shards' own, word for word");
  assert.ok(steps.indexOf(ownStep) < steps.length - 1, 'before the script');
  assert.equal(steps.at(-1)?.env?.PROJECT_SANDBOX_REQUIRED, '1', 'a missing sandbox fails the tests it runs, as in the shards');
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
    ['a namesake on its line', `false && test('acceptance: x', ${g}, () => {}); test('acceptance: x', () => {});`, {}, /isn't its line's first statement|registers a test inside an expression/],
    ['a template name', `const v = 'x';\ntest(\`acceptance: \${v}\`, ${g}, () => {});`, {}, /computed \(template\) name/],
    ['node:vm in a gated file', `import vm from 'node:vm';\nvoid vm;\n${known}`, {}, /uses node:vm, new Function or eval/],
    ['a detector built from parts', `const booted = existsSync(join('/run', 'sys' + 'temd', 'system')) || existsSync(join('/run', '${'sys'}temd', 'system'));\n${known}\ntest('acceptance: y', { skip: !booted && 'x' }, () => {});`, {}, /test\/x\.test\.ts: 1 use\(s\) of systemd's sign outside/],
    ['a renamed flag on the line after skip:', `const ${'system'}dCi = false;\n${known}\ntest('acceptance: r', { skip:\n  !${'system'}dCi && 'x' }, () => {});`, {}, /2 skip\(s\) that look like a systemd gate, 1 a gate/],
    ['a gate in src/, through a test helper', `import { hostOnly } from '../src/gates.js';\n${known}\ntest('acceptance: h', hostOnly, () => {});`, { 'src/gates.ts': `const ${flag} = true;\nexport const hostOnly = { ${gate()} && 'x' };\n` }, /test\/x\.test\.ts: a skip reads src\/gates\.ts: hostOnly, which carries systemd's sign \(from src\/\)/],
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
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as Record<string, [number, string, string?] | string>;
  const cases = Object.entries(manifest).filter(([k]) => k !== '//') as [string, [number, string, string?]][];
  assert.deepEqual(cases.map(([k]) => k).sort(), readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), 'every fixture folder is in the manifest');
  for (const [name, [want, why, listed]] of cases) {
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
    // A runtime shape (R1169n): the script's list of what it runs here, where systemd is, names it.
    if (listed) assert.match(p.stdout, new RegExp(listed), `${name}, run on the VM: ${what}`);
  }
});


// The sign built from parts, so this file's own text holds none outside its tests' functions.
const sd = `${'sys'}temd`;

test("systemd's sign may be only in the flag's declaration, a gate's reason, a test's or suite's name, or a test's own function (R1169k, R1169n)", () => {
  const uses = (text: string, path = 'test/x.test.ts') => sa.signUses(ts, path, text);
  // Allowed: the flag's declaration in a test file, a gate's reason, a test's or suite's name, a test's own function
  // (which the job runs on the VM, signTests, so a skip or todo there fails it).
  assert.deepEqual(uses(`const ${flag} = existsSync('/run/${sd}/system');\ntest('acceptance: ${sd} unit', { ${gate()} && 'needs ${sd}' }, () => { run('${sd}-run', ['--version']); });\n// a comment: /run/${sd}\n`), []);
  assert.deepEqual(uses(`describe('${sd} unit text', () => {});\ntest('n', (t) => { if (!existsSync('/run/${sd}')) t.skip(); const c = { run: '${sd.slice(0, 6)}ctl x', skip: false }; });`), [], "a suite's name; a test's function, even one that skips (R1169n F1, F2)");
  // Anywhere else, in any spelling the parser sees: a constant, a let, a parameter's default, a template, parts, a regex.
  for (const [what, text, want] of [
    ['a constant', `const DIR = '/run/${sd}/system';`, ['1: systemd']],
    ['parts joined', `const p = '/run' + '/${sd}/system';`, ['1: systemd']],
    ['a template', `const p = \`/run/\${x}/${sd}\`;`, ['1: systemd']],
    ['a regex', `const r = /\\/run\\/${sd}/;`, ['1: systemd']],
    ['an escape, decoded (R1169n N15)', `const r = '/run/\\x73ystemd';`, ['1: systemd']],
    ['process 1', `const c = readFileSync('/proc/1/exe');`, ['1: /proc/1/']],
    ['systemctl', `const ok = spawnSync('${sd.slice(0, 6)}ctl', ['is-system-running']);`, ['1: systemctl', '1: is-system-running']],
    ['its D-Bus name, journalctl, loginctl', `const x = ['org.freedesktop.${sd}1', 'journalctl', 'loginctl'];`, ['1: systemd1', '1: journalctl', '1: loginctl']],
    ['a name starting with it and _', `const x = SYSTEMD_MARKERS ?? ${sd}_booted;`, ['1: SYSTEMD_', '1: systemd_']],
    ['the variables systemd sets', `const sd = process.env.INVOCATION_ID ?? process.env['NOTIFY_SOCKET'];`, ['1: INVOCATION_ID', '1: NOTIFY_SOCKET']],
    ['a non-gate skip', `test('n', { skip: !ok && 'needs ${sd}' }, () => {});`, ['1: systemd']],
    ['a describe() body', `describe('d', () => { const booted = existsSync('/run/${sd}'); });`, ['1: systemd']],
  ] as const) assert.deepEqual(uses(text), want, what);
  // A word that only contains it is not it; the flag declared in a helper (not *.test.ts) is a use.
  assert.deepEqual(uses(`const ${sd}Tests = 1;`), []);
  assert.deepEqual(uses(`export const ${flag} = existsSync('/run/${sd}');`, 'test/helpers.ts'), ['1: systemd']);
  // The tests whose own function holds the sign: the ones the job runs on the VM, a gate's or not, at their call.
  const none = { paths: new Set<string>(), carries: () => false };
  assert.deepEqual(sa.signTests(ts, 'test/x.test.ts', `test('a', () => {});\n  test('b', async (t) => { await t.test('c', () => { run('${sd}-run'); }); });\ndescribe('d', () => { it(\`e \${1}\`, () => { readlinkSync('/proc/1/exe'); }); });\n`, none).map((t) => [t.name, t.line, t.column, t.subtests]), [['b', 2, 3, true], [null, 3, 23, false]]);
});

test('a skip may not read what carries systemd\'s sign: an import from src/, from a file that holds it or named at run time, or a local from any of those, from the sign or from a file read, through any steps in its file (R1169k, R1169m, R1169n)', () => {
  const paths = new Set(['test/x.test.ts', 'test/helpers/runner.ts', 'src/os.ts', 'src/plain.ts']);
  const source = { paths, carries: (m: string) => m === '?' || m === 'test/helpers/runner.ts' || m === 'src/os.ts', direct: (m: string) => m.startsWith('src/') };
  const reads = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source);
  assert.deepEqual(reads(`import { canRun as onVm } from './helpers/runner.js';\ntest('n', { skip: !onVm }, () => {});`), ['test/helpers/runner.ts: canRun']);
  assert.deepEqual(reads(`import * as r from './helpers/runner.js';\ntest('n', { skip: !r.canRun }, () => {});`), ['test/helpers/runner.ts: *']);
  assert.deepEqual(reads(`import canRun from '../src/plain.js';\ntest('n', { skip: !canRun }, () => {});`), ['src/plain.ts: default'], 'any src/ binding, read directly');
  assert.deepEqual(reads(`const { canRun: ok } = await import('../src/os.js');\ntest('n', { skip: !ok }, () => {});`), ['src/os.ts: canRun']);
  assert.deepEqual(reads(`const probe = await import(pathToFileURL(join(dir, 'host-probe.mjs')).href);\ntest('n', { skip: !probe.booted() }, () => {});`), ['?: *'], 'a module named at run time (R1169n N01)');
  // Through locals, any number of steps, in any shape: a const, a let assigned later, destructuring, a function.
  assert.deepEqual(reads(`import { UNIT_DIR } from '../src/os.js';\nconst booted = existsSync(UNIT_DIR) && x;\ntest('n', { skip: !booted }, () => {});`), ['test/x.test.ts: booted'], 'R1169m m01');
  assert.deepEqual(reads(`const UNITS = '/run/${sd}/system';\nconst a = UNITS;\nfunction b() { return existsSync(a); }\nlet c = false;\nif (b()) c = true;\nconst { d } = { d: c };\ntest('n', { todo: !d && 'x' }, () => {});`), ['test/x.test.ts: d'], 'R1169m m03');
  assert.deepEqual(reads(`const paths = JSON.parse(readFileSync('fixtures/host-paths.json', 'utf8'));\nconst booted = existsSync(paths.units);\ntest('n', { skip: !booted }, () => {});`), ['test/x.test.ts: booted'], 'a file read (R1169n N02)');
  assert.deepEqual(reads(`const opts = { skip: !existsSync('/run/${sd}') };\ntest('n', opts, () => {});`), ['test/x.test.ts: opts'], 'options passed by name');
  assert.deepEqual(reads(`import { canRun } from '../src/plain.js';\nconst ok = canRun();\ntest('n', { skip: !ok }, () => {});`), [], 'a local from a src/ file that holds no sign');
  assert.deepEqual(reads(`function f() { const r = readFileSync('x'); return r; }\nfunction g() { const r = 1; return r; }\nconst ok = g();\ntest('n', { skip: !ok }, () => {});`), [], "each function's own r: scopes are read");
  assert.deepEqual(reads(`import { canRun } from './helpers/runner.js';\ntest('n', { timeout: canRun ? 1 : 2 }, () => {});\nconst o = { skip: canRun };`), [], "not a test's skip");
  const texts = new Map([
    ['src/os.ts', `export const up = existsSync('/run/${sd}');\n`],
    ['test/x.test.ts', `import { up } from '../src/os.js';\ntest('n', { skip: !up && 'x' }, () => {});\n`],
  ]);
  const pin = `systemd: export const up = existsSync('/run/${sd}');`;
  assert.deepEqual(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'product code', uses: [pin] } } }).map((p) => p.split(':').slice(0, 3).join(':')), ['test/x.test.ts: a skip reads src/os.ts: up, which carries systemd\'s sign (from src/)'], 'src/ named in uses, but its binding read by a skip');
  assert.deepEqual(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'product code', uses: [pin] } }, skipImports: { 'src/os.ts: up': 'why' } }), []);
  // Each use is pinned by its exact text: one more, one moved or swapped for another, or an entry with no file, each stops it.
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'x', uses: [] } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /src\/os\.ts: 1 use\(s\) of systemd's sign .*not named in/);
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'x', uses: [pin, pin] } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /src\/os\.ts: 1 use\(s\) .* names aren't there any more/);
  const swapped = new Map([...texts, ['src/os.ts', `export const up = existsSync('/etc/${sd}');\n`]]);
  assert.match(sa.signProblems(ts, swapped, { uses: { 'src/os.ts': { why: 'x', uses: [pin] } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /not named in[\s\S]*names aren't there any more/, 'the same count, another text (R1169n D4)');
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'x', uses: [pin] }, 'test/gone.ts': { why: 'x', uses: [] } }, skipImports: { 'src/os.ts: up': 'why' } }).join('\n'), /test\/gone\.ts: named in .*, but the build has no such file/);
  assert.match(sa.signProblems(ts, texts, { uses: { 'src/os.ts': { why: 'x', uses: [pin] } }, skipImports: { 'src/os.ts: up': 'why', 'src/os.ts: down': 'why' } }).join('\n'), /src\/os\.ts: down: named in the allowlist's skipImports, but no skip reads it/);
});

test('a test whose own function holds the sign runs on the VM: it fails the job unless it ran and passed with no skip or todo, all of it, or the allowlist excuses it (R1169n)', () => {
  const t = { name: 'unit restarts', line: 5, column: 1, label: "'unit restarts'" };
  const run = (events: Ev[], excused: string[] = []) => sa.problems([{ file: 'f.test.ts', gates: [], events, signTests: [t], excused: new Set(excused) } as never]);
  assert.deepEqual(run([ev('unit restarts', 5)]), []);
  assert.deepEqual(run([]), ["test/f.test.ts: unit restarts: didn't run (it reads systemd's sign: its function, a guarded stop or its name; so it must run here. Registered only sometimes, or under a skipped suite?)"]);
  assert.deepEqual(run([ev('unit restarts', 5, { skip: 'needs sudo' })]), ["test/f.test.ts: unit restarts: SKIP needs sudo (it reads systemd's sign: its function, a guarded stop or its name; so it must run here, where systemd is)"]);
  assert.deepEqual(run([ev('unit restarts', 5, { todo: 'later' })]), ["test/f.test.ts: unit restarts: TODO later (it reads systemd's sign: its function, a guarded stop or its name; so it must run here, where systemd is)"]);
  assert.deepEqual(run([ev('half', 6, { nesting: 1, todo: 'x' }), ev('unit restarts', 5)]), ['test/f.test.ts: unit restarts: its subtest "half" TODO x (all of it must run here)']);
  assert.deepEqual(run([ev('unit restarts', 5), ev('unit restarts', 5, { skip: 'x' })]).length, 1, 'each registration is judged (a loop)');
  assert.deepEqual(run([ev('unit restarts', 5, { skip: 'needs root' })], ['unit restarts']), [], 'excused by name: it may skip');
  assert.deepEqual(run([ev('unit restarts', 5, { type: 'test:fail' })], ['unit restarts']), ["test/f.test.ts: unit restarts: failed (it reads systemd's sign: its function, a guarded stop or its name; so it must run here, where systemd is)"], 'never a failure');
  assert.deepEqual(sa.summaryProblems('# tests 3\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n', 'f.test.ts', 1, true), [], 'a whole file may skip its other tests');
  assert.deepEqual(sa.summaryProblems('# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n', 'f.test.ts', 0, true), ['test/f.test.ts: its TAP summary counts no test at all']);
});

test("this repo's build roots hold systemd's sign only where the rule or its allowlist says, so a PR breaks it here, before main's job (R1169k)", () => {
  const texts = new Map<string, string>();
  for (const r of sa.buildRoots(repoRoot)) for (const f of readdirSync(join(repoRoot, r), { recursive: true }).map((x) => String(x).split('\\').join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts'))) texts.set(`${r}/${f}`, readFileSync(join(repoRoot, r, f), 'utf8'));
  const allow = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance-allow.json'), 'utf8')) as Required<Allow>;
  for (const [p, e] of Object.entries(allow.uses)) assert.ok(e.why.trim(), `${p}: named with why`);
  assert.deepEqual(sa.signProblems(ts, texts, allow), []);
});

test('R1169o/p: the sign is allowed in a test function only in a *.test.ts file; a nameless test reads its options; createRequire and modules outside the build are named at run time; JOURNAL_STREAM is the sign; a pin is every line of its use', () => {
  const uses = (text: string, path = 'test/x.test.ts') => sa.signUses(ts, path, text);
  // C1/D1: a helper module's test() is never picked for the VM, so its function may not hold the sign.
  assert.deepEqual(uses(`export function cases() { test('a unit restarts', () => { run('${sd}-run'); }); }`, 'test/helpers/cases.ts'), ['1: systemd']);
  assert.deepEqual(uses(`test('a unit restarts', () => { run('${sd}-run'); });`), [], 'in a *.test.ts file it is');
  // D3: a nameless test's options are options, never a name.
  assert.deepEqual(uses(`test({ skip: !existsSync('/run/${sd}') && 'x' }, function unitRestarts() {});`), ['1: systemd']);
  assert.deepEqual(uses(`describe({ skip: !existsSync('/run/${sd}') && 'x' }, () => {});`), ['1: systemd']);
  const paths = new Set(['test/x.test.ts', 'src/os.ts']);
  const source = { paths, carries: (m: string) => m === '?' || m === 'src/os.ts', direct: (m: string) => m.startsWith('src/') };
  const reads = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source);
  assert.deepEqual(reads(`import { up } from '../src/os.js';\ntest({ skip: !up }, () => {});`), ['src/os.ts: up'], 'test(options, fn)');
  // C2: createRequire, called at once or kept, and a relative module outside the build roots.
  assert.deepEqual(reads(`const probe = createRequire(import.meta.url)(join(dir, 'host-probe.cjs'));\ntest('n', { skip: !probe.booted() }, () => {});`), ['?: *']);
  assert.deepEqual(reads(`const req = createRequire(import.meta.url);\nconst probe = req(path);\ntest('n', { skip: !probe.booted() }, () => {});`), ['?: *']);
  assert.deepEqual(reads(`import probe from '../scripts/ci/host-probe.mjs';\ntest('n', { skip: !probe() }, () => {});`), ['?: default']);
  // Minor: JOURNAL_STREAM, set by systemd for a unit's output.
  assert.deepEqual(uses(`const j = process.env.JOURNAL_STREAM;`), ['1: JOURNAL_STREAM']);
  // A use over several lines is pinned by its first line and each line holding the sign (R1169o: a change on its
  // second line was missed); a line without the sign is not, so a long text's unrelated edits aren't changes.
  assert.deepEqual(sa.signUseList(ts, 'test/x.test.ts', 'const STUB = `#!/bin/sh\nset -e\nsystemctl is-system-running || exit 77\n`;').map((u) => u.pin), ['systemctl: const STUB = `#!/bin/sh\nsystemctl is-system-running || exit 77\n`;'], 'and, since R1169r, the statement\'s last line');
});

test('R1169p D2: a test whose skip, todo or early return turns on what carries the sign, one name away, is picked for the VM; one that only uses such a name is not', () => {
  const texts = new Map([
    ['src/os.ts', `export function lingerEnabled() { return run('loginctl'); }\nexport function plain() { return 1; }\n`],
    ['test/x.test.ts', ''],
  ]);
  const select = sa.signSource(ts, texts, { uses: { 'src/os.ts': { why: 'x', uses: [] } } }).select;
  const picked = (text: string) => sa.signTests(ts, 'test/x.test.ts', text, select).map((t) => t.name);
  const head = `import { lingerEnabled, plain } from '../src/os.js';\n`;
  assert.deepEqual(picked(`${head}test('a', (t) => { const l = lingerEnabled(); if (l === null) { t.skip('x'); return; } });`), ['a'], 'a body skip on a local from it');
  assert.deepEqual(picked(`${head}test('b', () => { if (lingerEnabled() === null) return; });`), ['b'], 'an early return');
  assert.deepEqual(picked(`${head}test('c', (t) => lingerEnabled() === null && t.todo('x'));`), ['c'], 'cond && t.todo()');
  assert.deepEqual(picked(`${head}test('d', () => { assert.equal(lingerEnabled(), true); });`), [], 'used, never a skip or a return on it');
  assert.deepEqual(picked(`${head}test('e', (t) => { if (plain() === 1) return t.skip(); });`), [], "an export that doesn't carry it");
  const local = `const UNITS = '/run/${sd}/system';\ntest('f', (t) => { if (!existsSync(UNITS)) return t['skip']('x'); });`;
  assert.deepEqual(picked(local), ['f'], 'an allowlisted local, and a bracket skip');
});

test('the owner\'s option (b), zero subtests: a gate or a sign test whose function starts subtests and ran none fails (R1169o C3, R1169p D5)', () => {
  const t = { name: 'every unit restarts', line: 5, column: 1, label: '', subtests: true };
  const run = (events: Ev[]) => sa.problems([{ file: 'f.test.ts', gates: [], events, signTests: [t], excused: new Set() } as never]);
  assert.deepEqual(run([ev('every unit restarts', 5)]), ['test/f.test.ts: every unit restarts: ran no subtest (its function starts subtests, and none ran: it checked nothing)']);
  assert.deepEqual(run([ev('u1', 6, { nesting: 1 }), ev('every unit restarts', 5)]), []);
  const gates = [{ name: 'acceptance: g', line: 7, column: 1, subtests: true }];
  assert.deepEqual(sa.problems([{ file: 'f.test.ts', gates, events: [ev('acceptance: g', 7)] } as never]), ['test/f.test.ts: acceptance: g: ran no subtest (its function starts subtests, and none ran: it checked nothing)']);
});

test('R1169o C4: a local the allowlist excuses is pinned by what makes it carry the sign, so an edit to it is a change', () => {
  const text = `import { lingerEnabled } from '../src/os.js';\nconst SUDO = hostTool('sudo');\nconst canSwitch = spawnSync(SUDO, ['-n', 'true']).status === 0;\ntest('n', { skip: !canSwitch && 'x' }, () => {});\n`;
  const texts = new Map([['test/host.ts', `export const hostTool = (t) => ['${sd.slice(0, 6)}ctl'].includes(t);\n`], ['src/os.ts', `export const lingerEnabled = () => run('loginctl');\n`], ['test/x.test.ts', `import { hostTool } from './host.js';\n${text}`]]);
  const usesOf = (p: string) => sa.signUseList(ts, p, texts.get(p)!).map((u) => u.pin);
  const allow = (pin: string[]) => ({ uses: { 'test/host.ts': { why: 'x', uses: usesOf('test/host.ts') }, 'src/os.ts': { why: 'x', uses: usesOf('src/os.ts') } }, skipImports: { 'test/x.test.ts: canSwitch': { why: 'sudo', pin } } as never });
  const pin = ["const SUDO = hostTool('sudo');", "const canSwitch = spawnSync(SUDO, ['-n', 'true']).status === 0;", 'import test/host.ts: hostTool'];
  assert.deepEqual(sa.signProblems(ts, texts, allow(pin)), []);
  const edited = new Map([...texts, ['test/x.test.ts', texts.get('test/x.test.ts')!.replace("status === 0;", "status === 0 && lingerEnabled() !== null;")]]);
  assert.match(sa.signProblems(ts, edited, allow(pin)).join('\n'), /test\/x\.test\.ts: a skip reads test\/x\.test\.ts: canSwitch, named in the allowlist's skipImports, but what makes it carry systemd's sign isn't its pin there/);
});

test('R1169q/r: subtests are reads of `test` on the context; a name holding the sign picks its tests; a pin holds the statement around a use', () => {
  const none = { paths: new Set<string>(), carries: () => false };
  const pick = (text: string) => sa.signTests(ts, 'test/x.test.ts', text, none).map((t) => [t.name, t.subtests]);
  // C1: another object's .test is no subtest (a regex); D5: t['test'](...) and t.test.bind(t) are; a nested subtest's own.
  assert.deepEqual(pick(`test('a', () => { run('${sd}-run'); assert.ok(/re/.test('re')); });`), [['a', false]]);
  assert.deepEqual(pick(`test('b', async (t) => { run('${sd}-run'); await t['test']('s', () => {}); });`), [['b', true]]);
  assert.deepEqual(pick(`test('c', async (t) => { run('${sd}-run'); const sub = t.test.bind(t); await sub('s', () => {}); });`), [['c', true]]);
  assert.deepEqual(pick(`test('d', async (t) => { run('${sd}-run'); await t.test('s', async (u) => { await u.test('n', () => {}); }); });`), [['d', true]]);
  // D1: a test whose name holds the sign, and every test under a suite whose name does.
  assert.deepEqual(pick(`test('/run/${sd}/system', (t) => { if (!existsSync(t.name)) t.skip(); });`), [['/run/systemd/system', false]]);
  assert.deepEqual(pick(`describe('/run/${sd}/system', (s) => { it('e', { skip: !existsSync(s.name) }, () => {}); });`), [['e', false]]);
  // D6: the statement's first and last lines are pinned with the use; q2: a later line's escaped sign is pinned.
  const pins = (text: string) => sa.signUseList(ts, 'test/x.test.ts', text).map((u) => u.pin);
  assert.deepEqual(pins('const STUB =\n  `#!/bin/sh\nsystemctl is-system-running\n`;'), ['systemctl: const STUB =\n`#!/bin/sh\nsystemctl is-system-running\n`;']);
  assert.deepEqual(pins('const S = `#!/bin/sh\necho "\\x73ystemctl"\nexit 0`;'), ['systemctl: const S = `#!/bin/sh\necho "\\x73ystemctl"\nexit 0`;']);
});

test('R1169t: a registration chosen on what carries the sign is read; a for-of variable carries it; subtests through a bare test(), an alias, destructuring or a same-file helper; a compound statement is pinned whole; a getter skip is read', () => {
  const paths = new Set(['test/x.test.ts', 'src/os.ts']);
  const source = { paths, carries: (m: string) => m === 'src/os.ts', direct: (m: string) => m.startsWith('src/') };
  const reads = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source);
  const nt = `import { test, it, describe } from 'node:test';\n`;
  const head = `${nt}import { lingerEnabled } from '../src/os.js';\n`;
  const refused = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source).refused.join('\n');
  // D1: a ternary choosing test.skip or describe.skip is a use of node:test's value that isn't a call: refused since R1169v.
  assert.match(refused(`${head}const maybe = lingerEnabled() === null ? test.skip : test;\nmaybe('n', () => {});`), /`test\.skip` uses node:test's test as a value/);
  assert.match(refused(`${head}(lingerEnabled() === null ? describe.skip : describe)('s', () => { it('n', () => {}); });`), /uses node:test's describe as a value/);
  // D2: an if, or && / ||, around a registration (the latter refused too: not a statement); a return from a suite's body.
  assert.deepEqual(reads(`${head}if (lingerEnabled() !== null) test('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${head}lingerEnabled() !== null && test('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.match(refused(`${head}lingerEnabled() !== null && test('n', () => {});`), /registers a test inside an expression/);
  assert.deepEqual(reads(`${head}describe('s', () => {\n  if (lingerEnabled() === null) return;\n  it('n', () => {});\n});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${head}if (lingerEnabled() !== null) console.log('x');\ntest('n', () => {});`), [], 'an if that registers nothing');
  // A registration read in a file with no skip or todo text; a local holding test is refused, whatever chooses it.
  assert.match(refused(`${head}const go = lingerEnabled();\nconst maybe = go ? test : test.skip;\nmaybe('n', { timeout: 1 }, () => {});`), /uses node:test's test as a value/);
  assert.match(refused(`${head}const on = test;\non('n', () => {});`), /`on = test` uses node:test's test as a value/);
  // A function the file defines under such a name is its own helper, not node:test's; a wrapper of node:test's is refused.
  assert.deepEqual(reads(`${head}function suite(a, b) { return [a, b]; }\nconst r = lingerEnabled();\nsuite(r, { x: 1 });`), []);
  assert.equal(refused(`${head}function suite(a, b) { return [a, b]; }\nsuite(1, { x: 1 });`), '');
  assert.match(refused(`import { test as nodeTest } from 'node:test';\nconst test = wrap(nodeTest);\ntest('n', () => {});`), /`wrap\(nodeTest\)` uses node:test's nodeTest as a value/);
  // D7: a getter (or a method) named skip or todo is read.
  assert.deepEqual(reads(`${head}test('n', { get skip() { return lingerEnabled() === null; } }, () => {});`), ['src/os.ts: lingerEnabled']);
  // D3: a for-of loop variable carries what it iterates.
  const loop = `for (const dir of ['/run/${sd}/system']) {\n  test('n', { skip: !existsSync(dir) && 'x' }, () => {});\n}`;
  assert.match(sa.signProblems(ts, new Map([['test/x.test.ts', loop]]), { uses: { 'test/x.test.ts': { why: 'x', uses: sa.signUseList(ts, 'test/x.test.ts', loop).map((u) => u.pin) } } }).join('\n'), /a skip reads test\/x\.test\.ts: dir/);
  // D4: subtests started by a nested bare test()/it(), an alias of the context, destructuring, or a same-file helper.
  const none = { paths: new Set<string>(), carries: () => false };
  const subs = (text: string) => sa.signTests(ts, 'test/x.test.ts', text, none).map((t) => [t.name, t.subtests]);
  const body = `run('${sd}-run');`;
  assert.deepEqual(subs(`test('a', async () => { ${body} await test('s', () => {}); });`), [['a', true]]);
  assert.deepEqual(subs(`test('b', async () => { ${body} await it('s', () => {}); });`), [['b', true]]);
  assert.deepEqual(subs(`test('c', async (t) => { const ctx = t; ${body} await ctx.test('s', () => {}); });`), [['c', true]]);
  assert.deepEqual(subs(`test('d', async ({ test: sub }) => { ${body} await sub('s', () => {}); });`), [['d', true]]);
  assert.deepEqual(subs(`test('e', async (t) => { const { test: sub } = t; ${body} await sub('s', () => {}); });`), [['e', true]]);
  assert.deepEqual(subs(`async function each(c, names) { for (const n of names) await c.test(n, () => {}); }\ntest('f', async (t) => { ${body} await each(t, []); });`), [['f', true]]);
  assert.deepEqual(subs(`function log(c) { c.diagnostic('x'); }\ntest('g', (t) => { ${body} log(t); });`), [['g', false]], 'a helper that starts none');
  // D5: a use in an if (or a loop, a function, a block) pins the whole statement, so its body is pinned too.
  const pins = (text: string) => sa.signUseList(ts, 'test/x.test.ts', text).map((u) => u.pin);
  assert.deepEqual(pins(`if (existsSync('/run/${sd}/system')) {\n  console.log('x');\n}`), [`systemd: if (existsSync('/run/${sd}/system')) {\nconsole.log('x');\n}`]);
});

test('R1169u/v: node:test read by binding, failing closed: every use a call as a statement; what decides a registration read through loops, exits, labels, functions and callers; parameters traced; options by name settled; a stop anywhere in the code a test runs picks it', () => {
  const paths = new Set(['test/x.test.ts', 'src/os.ts', 'test/helpers/reg.ts']);
  const source = { paths, carries: (m: string) => m === 'src/os.ts', direct: (m: string) => m.startsWith('src/') };
  const run = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source);
  const reads = (text: string) => [...run(text)];
  const refused = (text: string) => run(text).refused.join('\n');
  const linger = `import { lingerEnabled } from '../src/os.js';\n`;
  const skip = `{ skip: lingerEnabled() === null }`;
  // D2: renamed, default, namespace, require() and import() bindings are node:test's test; their options are read.
  assert.deepEqual(reads(`import { test as check } from 'node:test';\n${linger}check('n', ${skip}, () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`import nt from 'node:test';\n${linger}nt('n', ${skip}, () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`import * as nt from 'node:test';\n${linger}nt.test('n', ${skip}, () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${linger}const nt = (await import('node:test')).default;\nnt('n', ${skip}, () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${linger}const { test } = await import('node:test');\ntest('n', ${skip}, () => {});`), ['src/os.ts: lingerEnabled']);
  // Any use that isn't a call, or a call of .skip/.only/.todo (a hook or mock member is fine), is refused.
  const nt = `import { test } from 'node:test';\n`;
  for (const [use, why] of [[`Reflect.apply(test, null, ['n', () => {}]);`, 'Reflect.apply'], [`test.call(null, 'n', () => {});`, '.call'], [`[test, test.skip][0]('n', () => {});`, 'an array'], [`test[process.env.X ? 'skip' : 'only']('n', () => {});`, 'a computed key'], [`let m = test;\nm('n', () => {});`, 'a let'], [`export { test };`, 'a re-export']]) assert.match(refused(`${nt}${use}`), /uses node:test's test as a value/, why);
  assert.equal(refused(`${nt}test.afterEach(() => {});\ntest.skip('n', () => {});\nawait test('m', () => {});`), '', 'a hook member, .skip and an awaited call');
  // A registration must be a statement of its own.
  assert.match(refused(`${nt}const r = test('n', () => {});`), /registers a test inside an expression/);
  assert.match(refused(`${nt}const reg = (n) => test(n, () => {});\nreg('x');`), /registers a test inside an expression/);
  // D4: a loop's iterable (a fixed table isn't read), an early exit in a function, a label or an IIFE, a callback's receiver.
  const nl = `${nt}${linger}`;
  assert.deepEqual(reads(`${nl}for (const _ of lingerEnabled() !== null ? [1] : []) test('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}const T = [{ n: 'a' }, { n: 'b' }];\nfor (const r of T) test(r.n, () => {});`), [], 'a const literal table');
  assert.deepEqual(reads(`${nl}const T = lingerEnabled() ? ['a'] : [];\nfor (const r of T) test(\`\${r}\`, () => {});`), ['test/x.test.ts: T'], 'a table that varies');
  assert.deepEqual(reads(`${nl}function register() {\n  if (lingerEnabled() === null) return;\n  test('n', () => {});\n}\nregister();`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}await (async () => {\n  if (lingerEnabled() === null) return;\n  test('n', () => {});\n})();`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}if (lingerEnabled() !== null) (() => {\n  test('n', () => {});\n})();`), ['src/os.ts: lingerEnabled'], 'a guard outside an IIFE');
  // R1169w: an earlier process.exit() (as a statement's condition, or through a same-file function) stops what follows.
  assert.deepEqual(reads(`${nl}if (lingerEnabled() === null) process.exit(0);\ntest('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}lingerEnabled() === null && process.exit(0);\ntest('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}function quit() { process.exit(0); }\nif (lingerEnabled() === null) quit();\ntest('n', () => {});`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}if (lingerEnabled() === null) console.log('x');\nconst v = lingerEnabled() && String(1);\ntest('n', () => {});`), [], 'a call that ends nothing, and a value');
  // process.getBuiltinModule('node:test') is node:test, as an import is.
  assert.match(refused(`const nt = process.getBuiltinModule('node:test');\nconst t2 = nt.test;\nt2('n', () => {});`), /uses node:test's nt as a value/);
  assert.deepEqual(reads(`${nl}reg: {\n  if (lingerEnabled() === null) break reg;\n  test('n', () => {});\n}`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}(lingerEnabled() !== null ? ['a'] : []).forEach((n) => { test(\`\${n}\`, () => {}); });`), ['src/os.ts: lingerEnabled']);
  assert.deepEqual(reads(`${nl}function cases() { test('n', () => {}); }\nif (lingerEnabled() !== null) cases();`), ['src/os.ts: lingerEnabled'], "a same-file function's caller");
  assert.match(refused(`${nl}function cases() { test('n', () => {}); }\nconst all = [cases];`), /uses cases, a function that registers tests, as a value/);
  // D3: a parameter is what each call passes; one of an exported function, read by a skip, is refused.
  assert.deepEqual(reads(`${nl}function needs(name, skip) {\n  test(name, { skip }, () => {});\n}\nneeds('n', lingerEnabled() === null);`), ['test/x.test.ts: skip']);
  assert.match(refused(`${nl}export function needs(name, skip) {\n  test(name, { skip }, () => {});\n}`), /reads `skip`, a parameter of a function that is exported/);
  // D5: options by name: a const literal used only as options is read; one changed or used elsewhere is refused.
  assert.deepEqual(reads(`${nl}const o = ${skip};\ntest('n', o, () => {});`), ['src/os.ts: lingerEnabled']);
  assert.match(refused(`${nl}const o = {};\nObject.defineProperty(o, 'skip', { get: () => lingerEnabled() === null, enumerable: true });\ntest('n', o, () => {});`), /options \(or name\) are `o`/);
  assert.match(refused(`${nl}let o = {};\ntest('n', o, () => {});`), /options \(or name\) are `o`/);
  assert.equal(refused(`${nl}for (const u of ['a', 'b']) test(u, () => { console.log(u); });`), '', 'a loop variable read only as a name and inside its test');
  // D6: a subtest registered under a condition on what carries the sign; a subtest's loop is the run's to judge.
  const sub = `${nl}test('t', async (t) => {\n  const up = lingerEnabled() !== null;\n`;
  assert.deepEqual(reads(`${sub}  if (up) await t.test('s', () => {});\n});`), ['test/x.test.ts: up']);
  assert.deepEqual(reads(`${sub}  for (const u of up ? ['a'] : []) await t.test(\`\${u}\`, () => {});\n});`), []);
  // U7: t['test'](...)'s options are read as t.test(...)'s.
  assert.deepEqual(reads(`${nl}test('t', async (t) => { await t['test']('s', ${skip}, () => {}); });`), ['src/os.ts: lingerEnabled']);
  // Bindings: product code's own describe() isn't node:test's; a test-side module's test is.
  assert.equal(refused(`import { describe } from '../src/os.js';\nconst x = [describe(1)];`), '');
  assert.match(refused(`import { test } from './helpers/reg.js';\nconst r = test('n', () => {});`), /registers a test inside an expression/);
  // D1, picking: a stop through a same-file helper, a hook, a bound skip, a computed key or an IIFE is judged on the VM.
  const none = { paths: new Set<string>(), carries: () => false };
  const picked = (body: string) => sa.signTests(ts, 'test/x.test.ts', `import { test, describe, it, beforeEach } from 'node:test';\nlet booted = false;\ntest('probe', () => { booted = existsSync('/run/${sd}/system'); });\n${body}`, none).map((t) => t.name);
  assert.deepEqual(picked(`const onBoot = (t, fn) => (booted ? fn() : t.skip('x'));\ntest('a', (t) => onBoot(t, () => {}));`), ['probe', 'a']);
  assert.deepEqual(picked(`describe('s', () => {\n  beforeEach((t) => { if (!booted && 'skip' in t) t.skip('x'); });\n  it('b', () => {});\n});`), ['probe', 'b']);
  assert.deepEqual(picked(`test('c', (t) => { const s = t.skip.bind(t); if (!booted) s('x'); });`), ['probe', 'c']);
  assert.deepEqual(picked(`test('d', (t) => { t[booted ? 'diagnostic' : 'skip']('x'); });`), ['probe', 'd']);
  assert.deepEqual(picked(`test('e', (t) => { if (!booted) (() => t.skip('x'))(); });`), ['probe', 'e']);
  assert.deepEqual(picked(`test('f', () => { assert.equal(booted, booted); });`), ['probe'], 'reads it, never a stop');
});

test("R1169w: a sign test the allowlist lets skip on the VM still runs for real somewhere: each runtime entry names where, and that place runs it", () => {
  const allow = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'ci', 'systemd-acceptance-allow.json'), 'utf8')) as { runtime: Record<string, { why: string; runsIn: string }> };
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, { steps?: { name?: string; run?: string; env?: Record<string, string> }[] }> };
  const shards = Object.entries(wf.jobs).filter(([k]) => /^test-shard-/.test(k));
  assert.ok(shards.length >= 2, 'the test shards');
  type Node = { kind: number; text?: string; arguments?: Node[]; expression?: Node; properties?: Node[]; name?: Node; getText: () => string; getStart: () => number };
  const T = ts as { createSourceFile: (f: string, t: string, v: number, p: boolean) => Node; ScriptTarget: { Latest: number }; forEachChild: (n: Node, f: (c: Node) => void) => void; isCallExpression: (n: Node) => boolean; isObjectLiteralExpression: (n: Node) => boolean; isShorthandPropertyAssignment: (n: Node) => boolean; isArrowFunction: (n: Node) => boolean; isFunctionExpression: (n: Node) => boolean };
  /** The test() call with this name, its options (an object literal, or null) and its own function's text. */
  const testOf = (file: string, text: string, name: string) => {
    const sf = T.createSourceFile(file, text, T.ScriptTarget.Latest, true);
    let call: Node | null = null;
    const walk = (n: Node) => {
      if (call) return;
      const first = T.isCallExpression(n) ? n.arguments?.[0] : undefined;
      if (first && (first.getText() === name || first.getText() === `'${name}'` || first.getText() === `"${name}"` || (name.startsWith('`') && first.getText().startsWith(name)))) call = n;
      else T.forEachChild(n, walk);
    };
    walk(sf);
    assert.ok(call, `${file}: the test named ${name.slice(0, 60)}`);
    const args = (call as Node).arguments!;
    const fn = args[args.length - 1]!;
    assert.ok(T.isArrowFunction(fn) || T.isFunctionExpression(fn), `${file}: its function is inline`);
    return { options: args.length === 3 ? args[1]! : null, body: fn.getText() };
  };
  // Where each kind runs for real, checked against the workflow that runs it; and that the test's skip is that one.
  const holds: Record<string, (file: string, text: string, t: { options: Node | null; body: string }) => void> = {
    // A web-UI test whose only skip is webUiSkip's own: every shard builds the UI before its tests and sets
    // CI_REQUIRE_WEB=1, under which webUiSkip throws instead of skipping (test/browser-helpers.ts), so in the shards
    // it runs or fails. Exactly that skip (R1169w D5): the const is webUiSkip(chrome) alone, the options' only skip or
    // todo is it, and the test's own function mentions neither.
    web: (file, text, t) => {
      assert.match(text, /^const chrome = findChrome\(process\.env\.CHROME\);$/m, `${file}: chrome is findChrome's`);
      assert.ok(t.options && T.isObjectLiteralExpression(t.options), `${file}: its options are an object literal`);
      const stops = t.options!.properties!.filter((x) => /skip|todo/i.test(x.name?.getText() ?? x.getText()));
      // `{ skip }` with `const skip = webUiSkip(chrome);`, or `skip: webUiSkip(chrome)` itself; nothing else.
      const only = stops.length === 1 && (stops[0]!.getText() === 'skip: webUiSkip(chrome)' || (T.isShorthandPropertyAssignment(stops[0]!) && stops[0]!.getText() === 'skip' && /^const skip = webUiSkip\(chrome\);$/m.test(text)));
      assert.ok(only, `${file}: its options' only skip or todo is webUiSkip(chrome), and nothing more`);
      assert.doesNotMatch(t.body, /skip|todo/i, `${file}: its own function holds no other skip or todo`);
      assert.match(readFileSync(join(repoRoot, 'test', 'browser-helpers.ts'), 'utf8'), /if \(!chrome\) required\(/, 'webUiSkip throws under CI_REQUIRE_WEB');
      for (const [k, j] of shards) {
        const steps = j.steps ?? [];
        const build = steps.findIndex((st) => /npm run build:web/.test(st.run ?? ''));
        const tests = steps.findIndex((st) => st.name === "this shard's tests");
        assert.ok(build >= 0 && tests > build, `${k}: builds the UI before its tests`);
        assert.equal(steps[tests]!.env?.CI_REQUIRE_WEB, '1', `${k}: a missing UI or Chrome fails the web tests`);
      }
    },
    // A check on the whole history: the security-fixed workflow runs the same check on a full checkout. The test's only
    // stop is the shallow-checkout one (R1169w D5): no options, and nothing else in its function skips.
    'security-fixed': (file, _text, t) => {
      const guard = "if (git('rev-parse', '--is-shallow-repository') === 'true') return t.skip('a shallow checkout (the CI shards): the security-fixed job checks this');";
      assert.equal(t.options, null, `${file}: no options`);
      assert.equal(t.body.split(guard).length, 2, `${file}: its function's shallow-checkout guard, once`);
      assert.doesNotMatch(t.body.replace(guard, ''), /skip|todo/i, `${file}: and no other skip or todo`);
      const sf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'security-fixed.yml'), 'utf8')) as { jobs: Record<string, { steps: { with?: { 'fetch-depth'?: number }; run?: string }[] }> };
      const steps = Object.values(sf.jobs).flatMap((j) => j.steps);
      assert.ok(steps.some((st) => st.with?.['fetch-depth'] === 0), 'the whole history');
      assert.ok(steps.some((st) => /^node scripts\/ci\/security-fixed\.mjs\b/.test(st.run ?? '')), 'runs the check');
    },
  };
  for (const [key, entry] of Object.entries(allow.runtime)) {
    // Its own key, never one inherited from Object.prototype ("constructor", "toString": R1169w D5).
    assert.ok(entry.why && typeof entry.runsIn === 'string' && Object.hasOwn(holds, entry.runsIn), `${key}: names why, and where it runs for real (runsIn: ${Object.keys(holds).join(' or ')})`);
    const file = key.slice(0, key.indexOf(': '));
    const text = readFileSync(join(repoRoot, file), 'utf8');
    holds[entry.runsIn]!(file, text, testOf(file, text, key.slice(file.length + 2)));
  }
});

test('R1169w D1-D4: a test function passed by name is the test\'s own; node:test loaded where it can\'t be bound, or a registration in a method, is refused; a test with subtests in carrying code is picked', () => {
  const paths = new Set(['test/x.test.ts', 'src/os.ts']);
  const source = { paths, carries: (m: string) => m === 'src/os.ts', direct: (m: string) => m.startsWith('src/') };
  const run = (text: string) => sa.skipReads(ts, 'test/x.test.ts', text, source);
  const refused = (text: string) => run(text).refused.join('\n');
  const nl = `import { test } from 'node:test';\nimport { lingerEnabled } from '../src/os.js';\n`;
  // D1: picked through a function by name, a same-file object's or class's method; an unreadable function refused.
  const none = { paths: new Set<string>(), carries: () => false };
  const picked = (body: string) => sa.signTests(ts, 'test/x.test.ts', `import { test } from 'node:test';\nlet booted = false;\ntest('probe', () => { booted = existsSync('/run/${sd}/system'); });\n${body}`, none).map((t) => t.name);
  assert.deepEqual(picked(`function body(t) { if (!booted) { t.skip('x'); return; } }\ntest('a', body);`), ['probe', 'a']);
  assert.deepEqual(picked(`const body = (t) => { if (!booted) t.skip('x'); };\ntest('b', body);`), ['probe', 'b']);
  assert.deepEqual(picked(`const host = { need(t) { if (!booted) t.skip('x'); } };\ntest('c', (t) => { host.need(t); });`), ['probe', 'c']);
  assert.deepEqual(picked(`class Host { static need(t) { if (!booted) t.skip('x'); } }\ntest('d', (t) => { Host.need(t); });`), ['probe', 'd']);
  assert.match(refused(`${nl}import { body } from './helpers/body.js';\ntest('n', body);`), /registers a test whose function isn't one this file defines/);
  assert.match(refused(`${nl}test('n', make());`), /registers a test whose function isn't one this file defines/);
  assert.equal(refused(`${nl}const o = { timeout: 1 };\ntest('n', o);\ntest.todo('m');`), '', 'options or a name last: no function');
  assert.match(refused(`${nl}import { body } from './helpers/body.js';\ntest('t', async (t) => { await t.test('s', body); });`), /registers a test whose function isn't one this file defines/, "a subtest's, on its context");
  assert.equal(refused(`class B { test(a, b) { return a + b; } run(x) { return this.test(1, x); } }`), '', "product code's own this.test(...)");
  assert.equal(refused(`const calc = { test(a, b) { return a + b; } };\nconst x = 2;\ncalc.test(1, x);`), '', "an object's own test(a, b), not a context's");
  // A module named at run time could be node:test: its test() calls are registrations, read in full (a loop around one).
  assert.deepEqual([...run(`import { lingerEnabled } from '../src/os.js';\nconst m = await import(process.env.M);\nfor (const x of lingerEnabled() ? [1] : []) m.test(\`\${x}\`, () => {});`)], ['src/os.ts: lingerEnabled']);
  // D2: node:test by name, loaded where no declaration binds it, or re-exported; a 'node:test' that loads nothing is data.
  assert.match(refused(`await import('node:test').then(({ test: t }) => { t('n', () => {}); });`), /names node:test where this can't bind it/);
  assert.match(refused(`export { test as check } from 'node:test';`), /names node:test where this can't bind it/);
  assert.match(refused(`const name = 'node:test';\nawait import(name).then((m) => m.test('n', () => {}));`), /names node:test where this can't bind it/);
  assert.equal(refused(`const { test: check } = process.getBuiltinModule('node:test');\ncheck('n', () => {});\nconst mods = ['node:test'];\nmods.includes('node:test');`), '');
  assert.deepEqual([...run(`${nl}const { test: check } = process.getBuiltinModule('node:test');\ncheck('n', { skip: lingerEnabled() === null }, () => {});`)], ['src/os.ts: lingerEnabled']);
  // D3: a registration in an object's method, a constructor or a static method is refused; a declared function is followed.
  for (const [what, code] of [['a method', `const reg = { run() { test('n', () => {}); } };\nreg.run();`], ['a constructor', `class R { constructor() { test('n', () => {}); } }\nnew R();`], ['a static method', `class R { static run() { test('n', () => {}); } }\nR.run();`]]) assert.match(refused(`${nl}${code}`), /registers a test inside a method, a constructor or a function kept as a property/, what);
  assert.deepEqual([...run(`${nl}function reg() { test('n', () => {}); }\nif (lingerEnabled() !== null) reg();`)], ['src/os.ts: lingerEnabled']);
  // D4: a test whose code reads what carries the sign and starts subtests is picked, so the zero-subtest rule judges it.
  const sub = (text: string) => sa.signTests(ts, 'test/x.test.ts', text, source).map((t) => [t.name, t.subtests]);
  assert.deepEqual(sub(`${nl}test('y', async (t) => {\n  for (const _ of lingerEnabled() === null ? [] : [1]) await t.test('s', () => {});\n});`), [['y', true]]);
  assert.deepEqual(sub(`${nl}test('z', async (t) => { await t.test('s', () => {}); });`), [], 'subtests, nothing carrying');
});
