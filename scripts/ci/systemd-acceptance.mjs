// The acceptance tests that need a booted systemd and passwordless sudo: each test under test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too, in any directory
// under test/ (npm test runs dist/test/**/*.test.js). The gate has one spelling: any other mention of systemCi in a
// test file (`! systemCi`, `!(systemCi)`, a ternary, a check inside a test) stops the job, so no test escapes it.
//
//   node scripts/ci/systemd-acceptance.mjs      (after the build: it runs dist/test/<file>.js)
//
// Exit 1: a test failed, skipped, didn't run or ran more than once. Exit 2: no such test was found, or the files
// couldn't be read, or one mentions systemCi other than as the gate.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
/** The suite's isolation preload, as every runner of it passes it (test/isolate.ts). */
const PRELOAD = ['--import', './dist/test/isolate.js'];

/** A JS string literal's body, unescaped (\\, \', \", \` and \n; the names here use no other escape). */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * Each `test(<name>, { skip: !systemCi ...` in `text`, as its name. The gate must be the options' first key, as every
 * such test writes it; `gateCount` counts every `skip: !systemCi` so a caller can see none was missed.
 */
export function systemdTests(text) {
  const out = [];
  const re = /\btest\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\{\s*skip:\s*!systemCi\b/g;
  for (const m of text.matchAll(re)) out.push(unescape(m[2]));
  return out;
}

/** How many times `text` gates something on systemCi the way systemdTests reads it. */
export const gateCount = (text) => (text.match(/\bskip:\s*!systemCi\b/g) ?? []).length;

/**
 * How many times `text` mentions the identifier systemCi other than to declare it (`const systemCi =`). Each must
 * be a gate systemdTests reads: a gate spelled any other way (`! systemCi`, `!(systemCi)`, `systemCi ? ... : ...`)
 * or a check of it anywhere else is a mention that isn't one, and findAll refuses the file.
 */
export const mentionCount = (text) => (text.match(/\bsystemCi\b/g) ?? []).length - (text.match(/\bconst\s+systemCi\s*=/g) ?? []).length;

/**
 * Every gated test under `dir` (test/), at any depth, by its path from `dir` ('/'-separated). Throws when a mention
 * of systemCi isn't a gate in a test() call this can read.
 */
export function findAll(dir) {
  const found = [];
  const files = readdirSync(dir, { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => x.endsWith('.test.ts')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    const mentions = mentionCount(text);
    if (names.length !== mentions) throw new Error(`test/${f}: ${mentions} use(s) of systemCi, ${names.length} a gate in a test() call this reads (write it as \`test(<name>, { skip: !systemCi ...\`)`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/** TAP's escapes in a test's name (node's reporter: backslash, #, newline), undone. */
const tapName = (s) => s.replace(/\\([\\#n])/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * What's wrong with each gated test in `runs`, one entry per file: { file, names, tap }, where `tap` is node's TAP
 * output from running that file alone. Results are keyed by file and name, so no other file's result counts for
 * a test, and a name must have exactly one result in its file: a same-named test that passes can't hide the gated
 * one's skip. Each problem is a test that isn't there, failed, ran more than once, or was skipped (an option or
 * t.skip()) or marked todo. [] when every one ran once and passed.
 */
export function problems(runs) {
  const key = (file, name) => `${file}\0${name}`;
  const results = new Map();
  for (const { file, tap } of runs) {
    for (const line of tap.split('\n')) {
      const m = /^(not )?ok \d+ - (.*)$/.exec(line);
      if (!m) continue;
      const directive = /^(.*?) # (SKIP|TODO)\b(.*)$/i.exec(m[2]);
      const k = key(file, tapName(directive ? directive[1] : m[2]));
      results.set(k, [...(results.get(k) ?? []), { ok: !m[1], directive: directive ? `${directive[2].toUpperCase()}${directive[3]}` : null }]);
    }
  }
  return runs.flatMap(({ file, names }) => names.flatMap((n) => {
    const rs = results.get(key(file, n)) ?? [];
    const at = `test/${file}: ${n}`;
    if (!rs.length) return [`${at}: didn't run`];
    if (rs.length > 1) return [`${at}: ran ${rs.length} times (a gated test's name must be unique in its file: the run selects by name)`];
    const [r] = rs;
    if (!r.ok) return [`${at}: failed`];
    if (r.directive) return [`${at}: ${r.directive.trim()} (it must run here: this is the one place it does)`];
    return [];
  }));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let found;
  try {
    found = findAll(join(root, 'test'));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const names = found.flatMap((f) => f.names);
  if (!names.length) {
    console.error('no test in test/ is gated on systemCi: nothing to run');
    process.exit(2);
  }
  console.log(`${names.length} systemd acceptance test(s):\n${found.flatMap((f) => f.names.map((n) => `  test/${f.file}: ${n}`)).join('\n')}`);
  // One run per file, so each result is known to come from its own file.
  const runs = [];
  const exits = [];
  for (const f of found) {
    const args = [...PRELOAD, '--test', '--test-reporter=tap', ...f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    process.stdout.write(r.stdout ?? '');
    runs.push({ file: f.file, names: f.names, tap: r.stdout ?? '' });
    if (r.status !== 0) exits.push(`test/${f.file}: the test run exited ${r.status ?? r.signal}`);
  }
  const bad = problems(runs);
  if (!bad.length) bad.push(...exits);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} ran and passed`);
}
