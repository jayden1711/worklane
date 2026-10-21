#!/usr/bin/env node
// lint-test
// Re-measures what "covered" means for test/adversarial/guards.test.ts (#707): applies each mutant listed in
// test/adversarial/mutants.json in memory (mutant-hooks.mjs; no file on disk changes) and runs the suite under it.
//
//   npm run build && node test/adversarial/run-mutants.mjs [--whole] [--jobs N] [--list <file>] [mutant ids...]
//
// Default: for each mutant, only the cases of the guarantees it lists in `kills`; every one of those guarantees must
// have a case that fails on an assertion (ERR_ASSERTION). A case that fails any other way (a crash, a ReferenceError
// from a broken edit) is not a kill. --whole: the whole file, and the guarantees whose cases fail on an assertion
// must be exactly `kills`, with no other case failing at all. A mutant whose edits weren't all applied fails, as
// does an unmutated run of the file (--whole, no ids) that isn't all green. --list: measure another list (a scratch
// one) with the same rules.
// Runs under the suite's own test isolation (dist/test/isolate.js): a temp home, state dir and temporary directory.
// Not part of CI: one run of the file takes a minute or two. test/adversarial/guards.test.ts checks the list itself.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const valueOf = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const listFile = valueOf('--list') ? resolve(valueOf('--list')) : join(here, 'mutants.json');
const list = JSON.parse(readFileSync(listFile, 'utf8'));
const whole = args.includes('--whole');
const jobs = Math.max(1, Number(valueOf('--jobs')) || 1);
const named = args.filter((a, i) => !a.startsWith('--') && !['--jobs', '--list'].includes(args[i - 1]));
const mutants = named.length ? list.mutants.filter((m) => named.includes(m.id)) : list.mutants;
const unknown = named.filter((n) => !list.mutants.some((m) => m.id === n));
if (unknown.length) {
  console.error(`no such mutants: ${unknown.join(', ')}`);
  process.exit(2);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Each failing case of the run, as its guarantee and whether it failed on an assertion. node:test's TAP gives a
 * failing test's details in the indented block after its `not ok` line: `code: 'ERR_ASSERTION'` for an assertion.
 */
function failures(tap) {
  const out = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - adversarial guards \/ ([a-z0-9.-]+) \(/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^(?:ok|not ok) \d+ /.test(lines[j]) && !/^# /.test(lines[j])) j++;
    out.push({ guarantee: m[1], assertion: lines.slice(i + 1, j).some((l) => /^\s+code: 'ERR_ASSERTION'$/.test(l)) });
  }
  return out;
}

/** One run of the suite file: its failing cases, how many tests ran, and the files the mutant was applied to. */
function runSuite(id, only) {
  const pattern = only ? ['--test-name-pattern', `^adversarial guards / (?:${only.map(escape).join('|')}) \\(`] : [];
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${join(here, 'mutant-register.mjs')}`.trim(), ADVERSARIAL_MUTANT_LIST: listFile };
  if (id) env.ADVERSARIAL_MUTANT = id;
  else delete env.ADVERSARIAL_MUTANT;
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', './dist/test/isolate.js', '--test', '--test-reporter=tap', ...pattern, 'dist/test/adversarial/guards.test.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const tests = Number(/^# tests (\d+)/m.exec(out)?.[1] ?? 0);
      const failedAll = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? 0);
      // A child's line can reach here only inside a failing test's quoted message (the push gate runs under git): read
      // the path characters only.
      const applied = new Set([...`${out}\n${err}`.matchAll(/MUTANT-APPLIED ([\w-]+) ([\w/.-]+)/g)].filter((m) => m[1] === id).map((m) => m[2]));
      const broken = /anchor found \d+ times/.exec(`${out}\n${err}`)?.[0] ?? null;
      done({ failures: failures(out), failedAll, tests, applied, broken });
    });
  });
}

const problems = [];
if (whole && !named.length) {
  const base = await runSuite(null, null);
  console.log(`baseline: ${base.tests} tests, ${base.failedAll} failing`);
  if (base.failedAll || !base.tests) problems.push('the unmutated suite is not all green');
}

let next = 0;
async function worker() {
  while (next < mutants.length) {
    const m = mutants[next++];
    const r = await runSuite(m.id, whole ? null : m.kills);
    const killedBy = new Set(r.failures.filter((f) => f.assertion).map((f) => f.guarantee));
    const crashed = [...new Set(r.failures.filter((f) => !f.assertion).map((f) => f.guarantee))];
    const why = [];
    if (r.broken) why.push(r.broken);
    for (const f of new Set(m.edits.map((e) => e.file))) if (!r.applied.has(f)) why.push(`not applied to ${f}`);
    if (!r.tests) why.push('no test ran');
    for (const g of m.kills) if (!killedBy.has(g)) why.push(`survives ${g}'s cases${crashed.includes(g) ? ' (they fail, but not on an assertion: a crash is not a kill)' : ''}`);
    if (whole) {
      for (const g of killedBy) if (!m.kills.includes(g)) why.push(`also fails ${g}`);
      for (const g of crashed) if (!m.kills.includes(g)) why.push(`also crashes ${g}`);
      const named = r.failures.length;
      if (r.failedAll > named) why.push(`${r.failedAll - named} other test(s) fail`);
    }
    if (why.length) problems.push(`${m.id}: ${why.join('; ')}`);
    console.log(`${why.length ? 'FAIL' : 'ok  '} ${m.id} (kills ${m.kills.join(', ')}): killed by ${[...killedBy].join(', ') || 'none'}${crashed.length ? `; crashed ${crashed.join(', ')}` : ''}${why.length ? ` -- ${why.join('; ')}` : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, mutants.length) }, worker));
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}` : `\nall ${mutants.length} mutant(s) killed${whole ? ', each by exactly its listed guarantees' : ''}`);
process.exit(problems.length ? 1 : 0);
