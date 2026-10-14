#!/usr/bin/env node
// Refreshes test/timings.json (what scripts/ci/shard.mjs balances the CI test shards on) from a green `ci` run on
// main: each test file's duration is the sum of its top-level tests' duration_ms in that run's Node 22 shard logs
// (TAP; Node 24's reporter prints no per-test durations). Tests are matched to files by their titles in the source,
// so run it on a checkout of the commit the run tested, or near it.
// By hand, when shard.mjs --plan warns that files have no timing (nothing fails without one), then open a PR with
// the result. No workflow runs this: writing the file back would take a bot commit on main.
//
//   node scripts/ci/timings.mjs                 the newest green ci run on main (needs gh, signed in)
//   node scripts/ci/timings.mjs --run <id>      that run
//   node scripts/ci/timings.mjs --log <file>    a saved `gh run view <id> --log`
//   add --dry-run to print what would change and write nothing
//
// A file with every test found gets the measured number; one with none found (a new file the run didn't have, a
// file whose titles are built at run time) keeps what it had; an entry for a file that is gone is dropped.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './shard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SHARD_22 = /^test shard \d+\/\d+ \([^,]+, 22\)$/;

/**
 * The top-level tests of a `gh run view --log` (job TAB step TAB line): title to the durations seen, from the Node
 * 22 shards' TAP ("# Subtest: <title>" at column 0, then its "  duration_ms: <n>"; a subtest's are indented deeper).
 */
export function topLevelTests(log) {
  const top = new Map();
  let title = null;
  for (const raw of String(log).split('\n')) {
    const cols = raw.split('\t');
    if (!SHARD_22.test(cols[0] ?? '')) continue;
    const line = cols.slice(2).join('\t').replace(/^﻿?\S+Z /, '');
    let m;
    if ((m = /^# Subtest: (.*)$/.exec(line))) title = m[1].replace(/\\([#\\])/g, '$1');
    else if (title !== null && (m = /^ {2}duration_ms: ([\d.]+)$/.exec(line))) {
      if (!top.has(title)) top.set(title, []);
      top.get(title).push(Number(m[1]));
      title = null;
    }
  }
  return top;
}

/** The titles of a test file's top-level test(...) calls, as written (a template literal keeps its ${...}). */
export function titlesOf(src) {
  const out = [];
  const re = /^\s*test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
  let m;
  while ((m = re.exec(src))) out.push(m[2].replace(/\\(['"`\\])/g, '$1'));
  return out;
}

/**
 * One file's duration from the run: { ms, found, titles }. A title seen once counts; one built from a template
 * counts every top-level test that fits it. ms is null when none of its tests was found.
 */
export function fileMs(titles, top) {
  let sum = 0;
  let found = 0;
  for (const t of titles) {
    if (t.includes('${')) {
      const re = new RegExp(`^${t.split(/\$\{[^}]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      let any = false;
      for (const [k, d] of top) if (re.test(k)) (sum += d.reduce((a, b) => a + b, 0)), (any = true);
      if (any) found++;
      continue;
    }
    const d = top.get(t);
    if (d && d.length === 1) (sum += d[0]), found++;
  }
  return { ms: found ? Math.max(1, Math.round(sum)) : null, found, titles: titles.length };
}

/**
 * The refreshed timings: for each test file, the run's number when every one of its tests was found, else what
 * `old` had (nothing for a file never timed); entries for files that are gone are dropped. Sorted by path.
 */
export function refresh(old, files, top, read) {
  const ms = {};
  const changed = [];
  for (const f of [...files].sort()) {
    const r = fileMs(titlesOf(read(f)), top);
    const whole = r.ms !== null && r.found === r.titles;
    const next = whole ? r.ms : old[f];
    if (next !== undefined) ms[f] = next;
    if (next !== old[f]) changed.push(`${f}: ${old[f] ?? 'untimed'} -> ${next}`);
    else if (!whole) changed.push(`${f}: kept ${old[f] ?? 'untimed'} (${r.found}/${r.titles} of its tests found in the run)`);
  }
  const dropped = Object.keys(old).filter((f) => !files.includes(f));
  return { ms, changed, dropped };
}

function main(args) {
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 1 << 30 });
  let log;
  let source;
  if (opt('--log')) {
    log = readFileSync(opt('--log'), 'utf8');
    source = `the saved log ${opt('--log')}`;
  } else {
    let id = opt('--run');
    let sha = '';
    if (!id) {
      const run = JSON.parse(gh(['run', 'list', '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', '1', '--json', 'databaseId,headSha']))[0];
      if (!run) throw new Error('no green ci run on main found');
      id = String(run.databaseId);
      sha = run.headSha.slice(0, 7);
    }
    log = gh(['run', 'view', id, '--log']);
    source = `CI run ${id}${sha ? ` (main at ${sha})` : ''}`;
  }
  const top = topLevelTests(log);
  if (!top.size) throw new Error('no top-level test durations in the log (is it a ci run with the Node 22 test shards?)');
  const file = join(root, 'test', 'timings.json');
  const old = JSON.parse(readFileSync(file, 'utf8'));
  const r = refresh(old.ms, testFiles(), top, (f) => readFileSync(join(root, f), 'utf8'));
  for (const c of r.changed) console.log(c);
  for (const d of r.dropped) console.log(`${d}: dropped (no such test file)`);
  if (args.includes('--dry-run')) return;
  const note = `${source}, the test shard jobs on Node 22: each file is the sum of its top-level tests duration_ms; a file whose tests weren't all in that run keeps its earlier number`;
  writeFileSync(file, `${JSON.stringify({ source: note, ms: r.ms }, null, 1)}\n`);
  console.log(`wrote test/timings.json: ${Object.keys(r.ms).length} files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`timings: ${e.message}`);
    process.exit(2);
  }
}
