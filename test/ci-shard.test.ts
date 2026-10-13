import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Shard = { files: string[]; ms: number };
const script = join(repoRoot, 'scripts', 'ci', 'shard.mjs');
const s = (await import(pathToFileURL(script).href)) as {
  DEFAULT_MS: number;
  testFiles: () => string[];
  timings: () => Record<string, number>;
  assign: (files: string[], ms: Record<string, number>, n: number) => Shard[];
  built: (f: string) => string;
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

test('a file the timings don\'t list gets the default weight and still runs', () => {
  const shards = s.assign(['test/new.test.ts', 'test/old.test.ts'], { 'test/old.test.ts': 10 }, 2);
  assert.deepEqual(shards, [{ files: ['test/new.test.ts'], ms: s.DEFAULT_MS }, { files: ['test/old.test.ts'], ms: 10 }]);
  assert.throws(() => s.assign([], {}, 0), /positive integer/);
});

test('on the measured timings the shards are balanced: none past the longest file or 10% over the mean, none under 75% of it', () => {
  const ms = s.timings();
  const files = s.testFiles();
  const weights = files.map((f) => ms[f] ?? s.DEFAULT_MS);
  const mean = weights.reduce((x, y) => x + y, 0) / 4;
  const longest = Math.max(...weights);
  const loads = s.assign(files, ms, 4).map((x) => x.ms);
  assert.ok(Math.max(...loads) <= Math.max(longest, mean * 1.1), `loads ${loads.join(', ')}, longest file ${longest}, mean ${mean}`);
  assert.ok(Math.min(...loads) >= mean * 0.75, `loads ${loads.join(', ')}, mean ${mean}`);
  assert.ok(files.filter((f) => ms[f] === undefined).length < files.length / 10, 'test/timings.json covers most of the suite');
});
