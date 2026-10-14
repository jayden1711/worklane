import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Shard = { files: string[]; ms: number };
const script = join(repoRoot, 'scripts', 'ci', 'shard.mjs');
const s = (await import(pathToFileURL(script).href)) as {
  DEFAULT_MS: number;
  testFiles: () => string[];
  timings: (dir?: string) => Record<string, number>;
  defaultMs: (ms: Record<string, number>, files?: string[]) => number;
  coverage: (files: string[], ms: Record<string, number>) => { untimed: string[]; stale: string[] };
  coverageWarning: (c: { untimed: string[]; stale: string[] }) => string[];
  timingsProblems: (ms: unknown) => string[];
  assign: (files: string[], ms: Record<string, number>, n: number) => Shard[];
  built: (f: string) => string;
  only: (file: string) => string[];
};

const refresher = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'timings.mjs')).href)) as {
  topLevelTests: (log: string) => Map<string, number[]>;
  titlesOf: (src: string) => string[];
  fileMs: (titles: string[], top: Map<string, number[]>) => { ms: number | null; found: number; titles: number };
  refresh: (old: Record<string, number>, files: string[], top: Map<string, number[]>, read: (f: string) => string) => { ms: Record<string, number>; changed: string[]; dropped: string[] };
};

/** What npm test's glob (dist/test/**\/*.test.js) runs once built: the sources, found here without the script. */
const glob = () => globSync('test/**/*.test.ts', { cwd: repoRoot }).map((f) => f.split('\\').join('/')).sort();

test('every test file is in exactly one of the 4 shards, and together they are the whole glob', () => {
  const shards = s.assign(s.testFiles(), s.timings(), 4);
  const all = shards.flatMap((x) => x.files);
  assert.equal(new Set(all).size, all.length, 'no file in two shards');
  assert.deepEqual([...all].sort(), glob());
  assert.ok(glob().length > 100, 'the glob found the suite');
  for (const x of shards) assert.ok(x.files.length > 0);
});

test('the CLI prints each shard\'s built files; the 4 together are the glob, built', () => {
  const out = [1, 2, 3, 4].flatMap((k) => {
    const r = spawnSync(process.execPath, [script, `${k}/4`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n');
  });
  assert.deepEqual(out.sort(), glob().map((f) => s.built(f)).sort());
  assert.equal(s.built('test/a/b.test.ts'), 'dist/test/a/b.test.js');
  for (const bad of ['5/4', '0/4', 'x', '']) assert.equal(spawnSync(process.execPath, [script, bad], { encoding: 'utf8' }).status, 2, bad);
});

test('the split is deterministic: the same files and timings, in any order, give the same shards', () => {
  const files = s.testFiles();
  const a = s.assign(files, s.timings(), 4);
  const b = s.assign([...files].reverse(), s.timings(), 4);
  assert.deepEqual(a, b);
  const ties = s.assign(['test/c.test.ts', 'test/a.test.ts', 'test/b.test.ts', 'test/d.test.ts'], {}, 2);
  assert.deepEqual(ties.map((x) => x.files), [['test/a.test.ts', 'test/c.test.ts'], ['test/b.test.ts', 'test/d.test.ts']]);
});

test('a file the timings don\'t list is weighed as the median file and still runs; with no timings at all, a fixed default', () => {
  assert.equal(s.defaultMs({ a: 10, b: 30, c: 2000 }), 30, 'the median, not the mean: one long file doesn\'t move it');
  assert.equal(s.defaultMs({ a: 10, b: 30, c: 50, d: 2000 }), 40);
  assert.equal(s.defaultMs({}), s.DEFAULT_MS);
  // The estimate is what the split uses for the new file: its shard's load says so.
  const ms = { 'test/a.test.ts': 100, 'test/b.test.ts': 300, 'test/c.test.ts': 9000 };
  const shards = s.assign(['test/new.test.ts', ...Object.keys(ms)], ms, 2);
  assert.deepEqual(shards, [{ files: ['test/c.test.ts'], ms: 9000 }, { files: ['test/a.test.ts', 'test/b.test.ts', 'test/new.test.ts'], ms: 700 }], 'new weighs 300, the median');
  assert.deepEqual(s.assign(['test/new.test.ts', 'test/old.test.ts'], { 'test/old.test.ts': 10 }, 2), [{ files: ['test/new.test.ts'], ms: 10 }, { files: ['test/old.test.ts'], ms: 10 }]);
  assert.throws(() => s.assign([], {}, 0), /positive integer/);
});

test('many new files without timings can\'t unbalance or break the split', () => {
  // The suite as it is, and a fifth more files nobody has timed yet.
  const ms = s.timings();
  const fresh = Array.from({ length: Math.ceil(s.testFiles().length / 5) }, (_, i) => `test/brand-new-${i}.test.ts`);
  const files = [...s.testFiles(), ...fresh];
  const shards = s.assign(files, ms, 4);
  assert.deepEqual(shards.flatMap((x) => x.files).sort(), [...files].sort(), 'every file runs, once');
  const loads = shards.map((x) => x.ms);
  const mean = loads.reduce((x, y) => x + y, 0) / 4;
  const longest = Math.max(...Object.values(ms));
  assert.ok(Math.max(...loads) <= Math.max(longest, mean * 1.1) && Math.min(...loads) >= mean * 0.75, `loads ${loads.join(', ')}`);
  // The untimed files are spread over the shards, not piled on one.
  const perShard = shards.map((x) => x.files.filter((f) => fresh.includes(f)).length);
  assert.ok(Math.max(...perShard) - Math.min(...perShard) <= Math.ceil(fresh.length / 4), `new files per shard: ${perShard.join(', ')}`);
});

test('a test file with no timing is a warning that lists it, never a failure; so is an entry for a file that is gone', () => {
  const ms = { 'test/a.test.ts': 10, 'test/gone.test.ts': 20 };
  const c = s.coverage(['test/a.test.ts', 'test/new.test.ts', 'test/newer.test.ts'], ms);
  assert.deepEqual(c, { untimed: ['test/new.test.ts', 'test/newer.test.ts'], stale: ['test/gone.test.ts'] });
  assert.deepEqual(s.coverageWarning(c), [
    'warning: 2 test file(s) have no timing in test/timings.json and are weighed as the median file (node scripts/ci/timings.mjs refreshes it): test/new.test.ts, test/newer.test.ts',
    'warning: test/timings.json lists 1 file(s) that no longer exist (ignored): test/gone.test.ts',
  ]);
  assert.deepEqual(s.coverageWarning(s.coverage(['test/a.test.ts'], { 'test/a.test.ts': 10 })), [], 'nothing to say when all are timed');
  // A whole repo where most files are untimed: the plan still comes out (exit 0), with the warning in it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'shard-untimed-'))); // the script compares its real path with argv[1]
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'scripts', 'ci', 'shard.mjs'), readFileSync(script));
  for (const f of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(dir, 'test', `${f}.test.ts`), '');
  writeFileSync(join(dir, 'test', 'timings.json'), JSON.stringify({ ms: { 'test/a.test.ts': 500, 'test/gone.test.ts': 20 } }));
  const plan = spawnSync(process.execPath, [join(dir, 'scripts', 'ci', 'shard.mjs'), '--plan', '2'], { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /^shard 1\/2: \d files, ~\d s\nshard 2\/2: \d files, ~\d s\nwarning: 4 test file\(s\) have no timing .*: test\/b\.test\.ts, test\/c\.test\.ts, test\/d\.test\.ts, test\/e\.test\.ts\nwarning: test\/timings\.json lists 1 file\(s\) that no longer exist \(ignored\): test\/gone\.test\.ts\n$/);
  const files = [1, 2].flatMap((k) => spawnSync(process.execPath, [join(dir, 'scripts', 'ci', 'shard.mjs'), `${k}/2`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  assert.deepEqual(files.sort(), ['a', 'b', 'c', 'd', 'e'].map((f) => `dist/test/${f}.test.js`), 'and every file is in a shard, with no warning mixed into the list');
});

test('a timings file that is really wrong fails: not JSON, no ms object, or a duration that isn\'t a positive number', () => {
  assert.deepEqual(s.timingsProblems({ 'test/a.test.ts': 10 }), []);
  assert.deepEqual(s.timingsProblems({ 'test/a.test.ts': 0, 'test/b.test.ts': -5, 'test/c.test.ts': '12', 'test/d.test.ts': null, 'test/e.test.ts': 7 }).length, 4);
  assert.match(s.timingsProblems({ 'test/a.test.ts': 0 })[0]!, /test\/a\.test\.ts is 0, not a positive number of milliseconds/);
  assert.deepEqual(s.timingsProblems(undefined), ['test/timings.json has no "ms" object']);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'shard-bad-')));
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  writeFileSync(join(dir, 'scripts', 'ci', 'shard.mjs'), readFileSync(script));
  writeFileSync(join(dir, 'test', 'a.test.ts'), '');
  const run = () => spawnSync(process.execPath, [join(dir, 'scripts', 'ci', 'shard.mjs'), '1/1'], { encoding: 'utf8' });
  for (const [body, why] of [['{ not json', /can't be read as JSON/], [JSON.stringify({ ms: { 'test/a.test.ts': -1 } }), /not a positive number/], [JSON.stringify({ source: 'x' }), /no "ms" object/]] as const) {
    writeFileSync(join(dir, 'test', 'timings.json'), body);
    const r = run();
    assert.equal(r.status, 2, body);
    assert.match(r.stderr, why);
  }
  assert.throws(() => s.timings(dir), /no "ms" object/);
});

test('on the measured timings the shards are balanced: none past the longest file or 10% over the mean, none under 75% of it; what has no timing is said, not failed', (t) => {
  const ms = s.timings();
  const files = s.testFiles();
  const fallback = s.defaultMs(ms);
  const weights = files.map((f) => ms[f] ?? fallback);
  const mean = weights.reduce((x, y) => x + y, 0) / 4;
  const longest = Math.max(...weights);
  const loads = s.assign(files, ms, 4).map((x) => x.ms);
  assert.ok(Math.max(...loads) <= Math.max(longest, mean * 1.1), `loads ${loads.join(', ')}, longest file ${longest}, mean ${mean}`);
  assert.ok(Math.min(...loads) >= mean * 0.75, `loads ${loads.join(', ')}, mean ${mean}`);
  for (const line of s.coverageWarning(s.coverage(files, ms))) t.diagnostic(line);
});

test('--only splits just the files a selection lists, balanced the same way; an empty list leaves every shard empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-only-'));
  const list = (name: string, files: string[]) => {
    writeFileSync(join(dir, name), files.map((f) => `${f}\n`).join(''));
    return join(dir, name);
  };
  const run = (...a: string[]) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  const picked = glob().slice(0, 3);
  const sel = list('sel', picked);
  const out = [1, 2, 3, 4].flatMap((k) => run(`${k}/4`, '--only', sel).stdout.split('\n').filter(Boolean));
  assert.deepEqual(out.sort(), picked.map((f) => s.built(f)).sort(), 'each selected file in exactly one shard, nothing else');
  assert.deepEqual(s.only(sel), picked);
  const empty = list('empty', []);
  for (const k of [1, 2, 3, 4]) assert.deepEqual([run(`${k}/4`, '--only', empty).status, run(`${k}/4`, '--only', empty).stdout], [0, ''], `shard ${k}`);
  const bad = run('1/4', '--only', list('bad', ['test/not-a-file.test.ts']));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not a test file of the suite/);
  assert.equal(run('1/4', '--only').status, 2);
});

test('timings.mjs: a file\'s duration is the sum of its top-level tests in the Node 22 shards of a CI run\'s log', () => {
  const row = (job: string, line: string) => `${job}\tUNKNOWN STEP\t2026-10-14T02:52:36.4505805Z ${line}`;
  const n22 = 'test shard 2/4 (ubuntu-latest, 22)';
  const log = [
    row(n22, '# Subtest: adds two numbers'),
    row(n22, '    # Subtest: a subtest of it'),
    row(n22, '    ok 1 - a subtest of it'),
    row(n22, '      ---'),
    row(n22, '      duration_ms: 999'),
    row(n22, 'ok 1 - adds two numbers'),
    row(n22, '  ---'),
    row(n22, '  duration_ms: 120.4'),
    row(n22, '# Subtest: refused since \\#340: it\'s the planner\'s'),
    row(n22, 'ok 2 - refused since \\#340'),
    row(n22, '  duration_ms: 30.2'),
    row(n22, '# Subtest: wired: a build that changes tests is thrown out'),
    row(n22, '  duration_ms: 1000'),
    row(n22, '# Subtest: wired: a build that changes config is thrown out'),
    row(n22, '  duration_ms: 500'),
    row('test shard 2/4 (ubuntu-latest, 24)', '# Subtest: adds two numbers'),
    row('test shard 2/4 (ubuntu-latest, 24)', '  duration_ms: 77777'),
    row('desktop', '# Subtest: not a test shard'),
    row('desktop', '  duration_ms: 5'),
  ].join('\n');
  const top = refresher.topLevelTests(log);
  assert.deepEqual([...top], [['adds two numbers', [120.4]], ["refused since #340: it's the planner's", [30.2]], ['wired: a build that changes tests is thrown out', [1000]], ['wired: a build that changes config is thrown out', [500]]], 'top-level tests of the Node 22 shards only; a subtest\'s duration is not its parent\'s');
  const src = "test('adds two numbers', () => {});\ntest('refused since #340: it\\'s the planner\\'s', async () => {});\n";
  assert.deepEqual(refresher.titlesOf(src), ['adds two numbers', "refused since #340: it's the planner's"]);
  assert.deepEqual(refresher.fileMs(refresher.titlesOf(src), top), { ms: 151, found: 2, titles: 2 });
  // Titles built in a loop: every test that fits the template.
  const looped = 'for (const k of kinds) {\n  test(`wired: a build that changes ${k.name} is thrown out`, { skip }, async () => {});\n}\n';
  assert.deepEqual(refresher.fileMs(refresher.titlesOf(looped), top), { ms: 1500, found: 1, titles: 1 });
  assert.deepEqual(refresher.fileMs(['never ran'], top), { ms: null, found: 0, titles: 1 });
  // The refresh: measured files get the run's number; one the run didn't have keeps what it had (or stays untimed);
  // one only partly found keeps its number; an entry for a file that is gone is dropped.
  const sources: Record<string, string> = { 'test/a.test.ts': src, 'test/loop.test.ts': looped, 'test/new.test.ts': "test('never ran', () => {});\n", 'test/part.test.ts': "test('adds two numbers', () => {});\ntest('never ran', () => {});\n" };
  const r = refresher.refresh({ 'test/a.test.ts': 9, 'test/part.test.ts': 44, 'test/gone.test.ts': 5 }, Object.keys(sources), top, (f) => sources[f]!);
  assert.deepEqual(r.ms, { 'test/a.test.ts': 151, 'test/loop.test.ts': 1500, 'test/part.test.ts': 44 });
  assert.deepEqual(r.dropped, ['test/gone.test.ts']);
  assert.deepEqual(r.changed, ['test/a.test.ts: 9 -> 151', 'test/loop.test.ts: untimed -> 1500', 'test/new.test.ts: kept untimed (0/1 of its tests found in the run)', 'test/part.test.ts: kept 44 (1/2 of its tests found in the run)']);
  assert.deepEqual(s.timingsProblems(r.ms), [], 'what it writes is a valid timings object');
});
