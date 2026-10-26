#!/usr/bin/env node
// The weekly clock-shift job's test run (.github/workflows/clock-shift.yml, #848): every test file under the given
// directories, each in a `node --test` of its own, as many at once as `node --test` runs. A file passes only when its
// run exits 0 with a summary. A file whose process is still there after --file-timeout (a test that hangs past
// --test-timeout, or a handle left open after its tests) is killed with everything it started, and fails, named.
//
// WHY not one `node --test` with --test-force-exit: force-exit ends a file's process once the tests it knows of are
// done, so tests registered after a top-level await never ran, and the run still said 0 fail (#848). Without it, on
// Node 24 a file with a handle left open is never ended (--test-timeout bounds tests, not the file's process), and
// the run waits for the step's own time limit, with no summary (#774).
//
//   node scripts/ci/clock-shift-run.mjs --test-timeout=<ms> --file-timeout=<ms> <dir>...
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Relative to `root`, each file's run's working directory, as in npm test.
const PRELOAD = ['--import', './dist/test/isolate.js'];

function usage(why) {
  process.stderr.write(`clock-shift-run: ${why}\nusage: node scripts/ci/clock-shift-run.mjs --test-timeout=<ms> --file-timeout=<ms> <dir>...\n`);
  process.exit(2);
}

const opts = {};
const dirs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--(test-timeout|file-timeout)=(\d+)$/.exec(a);
  if (m) opts[m[1]] = Number(m[2]);
  else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else dirs.push(a);
}
if (!opts['test-timeout'] || !opts['file-timeout']) usage('--test-timeout and --file-timeout are both needed, in ms, above 0');
if (dirs.length === 0) usage('no directory given');

/** Every *.test.js under `dir`, sorted. */
function testFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.js'))
    .map((e) => resolve(e.parentPath, e.name))
    .sort();
}

const files = dirs.flatMap(testFiles);
if (files.length === 0) usage(`no *.test.js file under ${dirs.join(', ')}`);

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const totals = Object.fromEntries(KEYS.map((k) => [k, 0]));
const failed = [];
const running = new Map();

/** The run's own summary, from the last top-level `# <key> <n>` lines of its TAP output; null without one. */
function summary(out) {
  const s = {};
  for (const k of KEYS) {
    const all = [...out.matchAll(new RegExp(`^# ${k} (\\d+)$`, 'gm'))];
    if (all.length === 0) return null;
    s[k] = Number(all.at(-1)[1]);
  }
  return s;
}

function runFile(file) {
  return new Promise((done) => {
    const name = relative(process.cwd(), file);
    const p = spawn(process.execPath, [...PRELOAD, '--test', `--test-timeout=${opts['test-timeout']}`, '--test-reporter=tap', file], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.set(name, p);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {}
    }, opts['file-timeout']);
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      running.delete(name);
      const s = summary(out);
      if (s) for (const k of KEYS) totals[k] += s[k];
      let why = null;
      if (timedOut) why = `still running after --file-timeout=${opts['file-timeout']} ms: killed`;
      else if (code !== 0) why = signal ? `ended by ${signal}` : `exit ${code}`;
      else if (!s) why = 'no summary';
      if (why) failed.push(`${name}: ${why}`);
      process.stdout.write(`# file: ${name}${why ? ` FAILED (${why})` : ''}\n${out}${out.endsWith('\n') ? '' : '\n'}`);
      done();
    });
  });
}

function report() {
  process.stdout.write(`\n# clock-shift run: ${files.length} files\n`);
  for (const k of KEYS) process.stdout.write(`# ${k} ${totals[k]}\n`);
  if (running.size > 0) process.stdout.write(`# still running (ended unfinished):\n${[...running.keys()].map((n) => `#   ${n}\n`).join('')}`);
  if (failed.length > 0) process.stdout.write(`# failed files: ${failed.length}\n${failed.map((f) => `#   ${f}\n`).join('')}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of running.values()) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {}
    }
    report();
    process.exit(1);
  });
}

const queue = [...files];
const workers = Array.from({ length: Math.max(1, Math.min(availableParallelism() - 1, files.length)) }, async () => {
  while (queue.length > 0) await runFile(queue.shift());
});
await Promise.all(workers);
report();
process.exit(failed.length > 0 ? 1 : 0);
