#!/usr/bin/env node
// Re-measures what "covered" means for test/adversarial/guards.test.ts (#707): applies each mutant listed in
// test/adversarial/mutants.json in memory (mutant-hooks.mjs; no file on disk changes) and runs the suite under it.
//
//   npm run build && node test/adversarial/run-mutants.mjs [--whole] [--jobs N] [mutant ids...]
//
// Default: for each mutant, only the cases of the guarantees it lists in `kills`; every one of those guarantees must
// have a case that fails. --whole: the whole file, and the guarantees whose cases fail must be exactly `kills`.
// A mutant whose edits weren't all applied fails, as does an unmutated run of the file (--whole) that isn't all green.
// Runs under the suite's own test isolation (dist/test/isolate.js): a temp home, state dir and temporary directory.
// Not part of CI: one run of the file takes about a minute. test/adversarial/guards.test.ts checks the list itself.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const list = JSON.parse(readFileSync(join(here, 'mutants.json'), 'utf8'));
const args = process.argv.slice(2);
const whole = args.includes('--whole');
const jobsAt = args.indexOf('--jobs');
const jobs = jobsAt >= 0 ? Math.max(1, Number(args[jobsAt + 1]) || 1) : 1;
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--jobs');
const mutants = named.length ? list.mutants.filter((m) => named.includes(m.id)) : list.mutants;
const unknown = named.filter((n) => !list.mutants.some((m) => m.id === n));
if (unknown.length) {
  console.error(`no such mutants: ${unknown.join(', ')}`);
  process.exit(2);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One run of the suite file: the guarantees whose cases failed, and the files the mutant was applied to. */
function runSuite(id, only) {
  const pattern = only ? ['--test-name-pattern', `^adversarial guards / (?:${only.map(escape).join('|')}) \\(`] : [];
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${join(here, 'mutant-register.mjs')}`.trim() };
  if (id) env.ADVERSARIAL_MUTANT = id;
  else delete env.ADVERSARIAL_MUTANT;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './dist/test/isolate.js', '--test', '--test-reporter=tap', ...pattern, 'dist/test/adversarial/guards.test.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      const failed = new Set([...out.matchAll(/^not ok \d+ - adversarial guards \/ ([a-z0-9.-]+) \(/gm)].map((m) => m[1]));
      const tests = Number(/^# tests (\d+)/m.exec(out)?.[1] ?? 0);
      // A child's line can reach here only inside a failing test's quoted message (the push gate runs under git): read
      // the path characters only.
      const applied = new Set([...`${out}\n${err}`.matchAll(/MUTANT-APPLIED ([\w-]+) ([\w/.-]+)/g)].filter((m) => m[1] === id).map((m) => m[2]));
      const broken = /anchor found \d+ times/.exec(`${out}\n${err}`)?.[0] ?? null;
      resolve({ failed, tests, applied, broken });
    });
  });
}

const problems = [];
if (whole && !named.length) {
  const base = await runSuite(null, null);
  console.log(`baseline: ${base.tests} tests, failing: ${[...base.failed].join(', ') || 'none'}`);
  if (base.failed.size || !base.tests) problems.push('the unmutated suite is not all green');
}

let next = 0;
async function worker() {
  while (next < mutants.length) {
    const m = mutants[next++];
    const r = await runSuite(m.id, whole ? null : m.kills);
    const why = [];
    const files = new Set(m.edits.map((e) => e.file));
    if (r.broken) why.push(r.broken);
    for (const f of files) if (!r.applied.has(f)) why.push(`not applied to ${f}`);
    if (!r.tests) why.push('no test ran');
    for (const g of m.kills) if (!r.failed.has(g)) why.push(`survives ${g}'s cases`);
    if (whole) for (const g of r.failed) if (!m.kills.includes(g)) why.push(`also fails ${g}`);
    if (why.length) problems.push(`${m.id}: ${why.join('; ')}`);
    console.log(`${why.length ? 'FAIL' : 'ok  '} ${m.id} (kills ${m.kills.join(', ')}): failing ${[...r.failed].join(', ') || 'none'}${why.length ? ` -- ${why.join('; ')}` : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, mutants.length) }, worker));
console.log(problems.length ? `\n${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}` : `\nall ${mutants.length} mutant(s) killed${whole ? ', each by exactly its listed guarantees' : ''}`);
process.exit(problems.length ? 1 : 0);
