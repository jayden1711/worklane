#!/usr/bin/env node
// Splits the unit tests (what `npm test` runs: dist/test/**/*.test.js) across CI jobs, balanced by the measured
// per-file durations in test/timings.json: longest file first, each to the least-loaded shard (ties to the lowest
// shard). A file the timings don't list yet (a new one) is weighed as the median of the measured files, so it
// always runs somewhere and can't unbalance the split. A missing timing never fails anything: --plan and
// test/ci-shard.test.ts print a warning that lists the untimed files (and the entries for files that are gone), and
// scripts/ci/timings.mjs refreshes test/timings.json from a green CI run on main. Only a timings file that is
// really wrong fails: not JSON, or a duration that isn't a positive number.
//
//   node scripts/ci/shard.mjs 2/4        the built test files shard 2 of 4 runs, one per line
//   node scripts/ci/shard.mjs --plan 4   every shard's files and estimated seconds
//   add --only <file> to split only the test files that file lists (scripts/ci/affected.mjs's selection, one
//   source path per line), balanced the same way; an empty list leaves every shard empty
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The weight of an untimed test file when no file has a timing at all (defaultMs: the median otherwise). */
export const DEFAULT_MS = 2000;

/**
 * The weight of a test file the timings don't list: the median of the durations of `files` that have one (all the
 * timings when no files are given), so a new file sits in the middle of the split whatever the suite's scale.
 */
export function defaultMs(ms, files) {
  const known = (files ? files.map((f) => ms[f]) : Object.values(ms)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!known.length) return DEFAULT_MS;
  const mid = known.length >> 1;
  return known.length % 2 ? known[mid] : Math.round((known[mid - 1] + known[mid]) / 2);
}

/** What the timings don't cover, for a warning (never a failure): test files with no timing, and entries for files that are gone. */
export function coverage(files, ms) {
  const have = new Set(files);
  return { untimed: files.filter((f) => ms[f] === undefined).sort(), stale: Object.keys(ms).filter((f) => !have.has(f)).sort() };
}

/** The warning's lines for coverage()'s answer; none when everything is timed. */
export function coverageWarning({ untimed, stale }) {
  const out = [];
  if (untimed.length) out.push(`warning: ${untimed.length} test file(s) have no timing in test/timings.json and are weighed as the median file (node scripts/ci/timings.mjs refreshes it): ${untimed.join(', ')}`);
  if (stale.length) out.push(`warning: test/timings.json lists ${stale.length} file(s) that no longer exist (ignored): ${stale.join(', ')}`);
  return out;
}

/** A timings object that is really wrong: the reasons, none when it is fine. */
export function timingsProblems(ms) {
  if (!ms || typeof ms !== 'object' || Array.isArray(ms)) return ['test/timings.json has no "ms" object'];
  return Object.entries(ms).filter(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0).map(([f, v]) => `test/timings.json: ${f} is ${JSON.stringify(v)}, not a positive number of milliseconds`);
}

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

/** test/timings.json's durations: source path to milliseconds. Throws when the file is wrong (timingsProblems). */
export function timings(dir = root) {
  let ms;
  try {
    ms = JSON.parse(readFileSync(join(dir, 'test', 'timings.json'), 'utf8')).ms;
  } catch (e) {
    throw new Error(`test/timings.json can't be read as JSON: ${e.message}`);
  }
  const problems = timingsProblems(ms);
  if (problems.length) throw new Error(problems.join('; '));
  return ms;
}

/** Greedy split into n shards: [{ files, ms }], files sorted within each shard. Deterministic for the same input. */
export function assign(files, ms, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, not ${n}`);
  const fallback = defaultMs(ms);
  const weight = (f) => (Number.isFinite(ms[f]) ? ms[f] : fallback);
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

/** The test files `--only <file>` lists: each must be one of the suite's. */
export function only(file, all = testFiles()) {
  const known = new Set(all);
  const list = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const f of list) if (!known.has(f)) throw new Error(`--only lists ${f}, which is not a test file of the suite`);
  return [...new Set(list)];
}

function main(args) {
  const at = args.indexOf('--only');
  const selected = at < 0 ? null : args[at + 1];
  if (at >= 0) {
    if (!selected) throw new Error('--only needs a file');
    args = [...args.slice(0, at), ...args.slice(at + 2)];
  }
  const plan = args[0] === '--plan';
  const m = plan ? /^(\d+)$/.exec(args[1] ?? '') : /^(\d+)\/(\d+)$/.exec(args[0] ?? '');
  if (!m) throw new Error('usage: shard.mjs <k>/<n> | --plan <n>');
  const n = Number(plan ? m[1] : m[2]);
  const ms = timings();
  const shards = assign(selected ? only(selected) : testFiles(), ms, n);
  if (plan) {
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${n}: ${s.files.length} files, ~${Math.round(s.ms / 1000)} s`));
    // WHY here: the plan is printed in every shard's log; a missing timing is said, never failed.
    for (const line of coverageWarning(coverage(testFiles(), ms))) console.log(line);
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
