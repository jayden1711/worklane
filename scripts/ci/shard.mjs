#!/usr/bin/env node
// Splits the unit tests (what `npm test` runs: dist/test/**/*.test.js) across CI jobs, balanced by the measured
// per-file durations in test/timings.json: longest file first, each to the least-loaded shard (ties to the lowest
// shard). A file the timings don't list yet gets DEFAULT_MS, so a new test file always runs somewhere.
//
//   node scripts/ci/shard.mjs 2/4        the built test files shard 2 of 4 runs, one per line
//   node scripts/ci/shard.mjs --plan 4   every shard's files and estimated seconds
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The weight of a test file test/timings.json doesn't list (a new one): a few seconds, more than most files. */
export const DEFAULT_MS = 2000;

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Every unit test file, as its source path (test/x.test.ts), sorted: the sources of dist/test/**\/*.test.js. */
export function testFiles(dir = root) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.test.ts')) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(join(dir, 'test'));
  return out.sort();
}

/** test/timings.json's durations: source path to milliseconds. */
export function timings(dir = root) {
  return JSON.parse(readFileSync(join(dir, 'test', 'timings.json'), 'utf8')).ms;
}

/** Greedy split into n shards: [{ files, ms }], files sorted within each shard. Deterministic for the same input. */
export function assign(files, ms, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, not ${n}`);
  const weight = (f) => (Number.isFinite(ms[f]) ? ms[f] : DEFAULT_MS);
  const shards = Array.from({ length: n }, () => ({ files: [], ms: 0 }));
  const order = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const f of order) {
    let min = shards[0];
    for (const s of shards) if (s.ms < min.ms) min = s;
    min.files.push(f);
    min.ms += weight(f);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/** The built file node --test runs for a source test file. */
export const built = (f) => 'dist/' + f.replace(/\.ts$/, '.js');

function main(args) {
  const plan = args[0] === '--plan';
  const m = plan ? /^(\d+)$/.exec(args[1] ?? '') : /^(\d+)\/(\d+)$/.exec(args[0] ?? '');
  if (!m) throw new Error('usage: shard.mjs <k>/<n> | --plan <n>');
  const n = Number(plan ? m[1] : m[2]);
  const shards = assign(testFiles(), timings(), n);
  if (plan) {
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${n}: ${s.files.length} files, ~${Math.round(s.ms / 1000)} s`));
    return;
  }
  const k = Number(m[1]);
  if (k < 1 || k > n) throw new Error(`shard ${k} is not one of 1..${n}`);
  for (const f of shards[k - 1].files) console.log(built(f));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`shard: ${e.message}`);
    process.exit(2);
  }
}
