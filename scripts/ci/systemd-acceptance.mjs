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
 * How many `skip:` options in `text` look like a systemd gate: their line, from `skip:` on, names a flag like
 * `system…Ci` (`systemdCi`, `isSystemCi`, `SYSTEM_CI`; a string's words don't count, as "needs systemd" in a test that
 * checks for systemctl itself). Each must be a gate systemdTests reads, so a flag renamed (R1169d:
 * `skip: !systemdCi && ...`) stops the job instead of hiding its test.
 */
export const gateLikeCount = (text) => [...text.matchAll(/\bskip\s*:([^\n]{0,300})/g)].filter((m) => /(?<![\w$])[A-Za-z_$]*system[\w$]*ci(?![\w$])/i.test(m[1].replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''"))).length;

/** The names `text` declares from systemd's own sign (`/run/systemd/system`): each must be systemCi. */
export const detectorNames = (text) => [...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*\/run\/systemd\/system/g)].map((m) => m[1]);

/**
 * Every gated test under `dir` (test/), at any depth, by its path from `dir` ('/'-separated). Throws when a mention
 * of systemCi isn't a gate in a test() call this can read, when a skip that looks like a systemd gate isn't one, when
 * a flag read from systemd's sign isn't named systemCi, or when any of that is in a file under test/ that isn't a
 * `*.test.ts` (a helper module that registers tests, R1169d): the run is by file, so a gated test must be in one.
 */
export function findAll(dir) {
  const found = [];
  const files = readdirSync(dir, { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    const mentions = mentionCount(text);
    const like = gateLikeCount(text);
    const odd = detectorNames(text).filter((n) => n !== 'systemCi');
    if (!f.endsWith('.test.ts')) {
      if (names.length || mentions || like || odd.length) throw new Error(`test/${f}: a systemd gate outside a *.test.ts file (a helper that registers tests): write the gated test in the test file itself, as \`test(<name>, { skip: !systemCi ...\``);
      continue;
    }
    if (names.length !== mentions) throw new Error(`test/${f}: ${mentions} use(s) of systemCi, ${names.length} a gate in a test() call this reads (write it as \`test(<name>, { skip: !systemCi ...\`)`);
    if (like !== names.length) throw new Error(`test/${f}: ${like} skip(s) that look like a systemd gate, ${names.length} a gate this reads (the flag must be named systemCi: \`test(<name>, { skip: !systemCi ...\`)`);
    if (odd.length) throw new Error(`test/${f}: ${odd.join(', ')} read(s) systemd's sign under another name than systemCi`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/** TAP's escapes in a test's name (node's reporter: backslash, #, newline), undone. */
const tapName = (s) => s.replace(/\\([\\#n])/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * node's TAP output as a tree of results: each `ok`/`not ok` line at any depth (its indent, 4 spaces a level), with
 * the results of its subtests (the deeper lines just before it) as its children.
 */
export function tapResults(tap) {
  const all = [];
  const pending = [];
  for (const line of tap.split('\n')) {
    const m = /^((?: {4})*)(not )?ok \d+ - (.*)$/.exec(line);
    if (!m) continue;
    const depth = m[1].length / 4;
    const directive = /^(.*?) # (SKIP|TODO)\b(.*)$/i.exec(m[3]);
    const node = { depth, name: tapName(directive ? directive[1] : m[3]), ok: !m[2], directive: directive ? `${directive[2].toUpperCase()}${directive[3]}` : null, children: pending[depth + 1] ?? [] };
    pending.length = depth + 1;
    (pending[depth] ??= []).push(node);
    all.push(node);
  }
  return all;
}

/**
 * What's wrong with each gated test in `runs`, one entry per file: { file, names, tap }, where `tap` is node's TAP
 * output from running that file alone. Results are keyed by file and name, at any depth (a gated test inside a
 * describe() or a t.test() is a nested line, R1169c), so no other file's result counts for a test, and a name must
 * have exactly one result in its file: a same-named test that passes, nested or not, can't hide the gated one's skip.
 * Each problem is a test that isn't there, failed, ran more than once, was skipped (an option or t.skip()) or marked
 * todo, or has a subtest that did any of that (R1169d: a passing parent whose real check skipped). [] when every one
 * ran once and passed, all of it.
 */
export function problems(runs) {
  return runs.flatMap(({ file, names, tap }) => {
    const results = tapResults(tap);
    return names.flatMap((n) => {
      const rs = results.filter((r) => r.name === n);
      const at = `test/${file}: ${n}`;
      if (!rs.length) return [`${at}: didn't run`];
      if (rs.length > 1) return [`${at}: ran ${rs.length} times (a gated test's name must be unique in its file: the run selects by name)`];
      const [r] = rs;
      if (!r.ok) return [`${at}: failed`];
      if (r.directive) return [`${at}: ${r.directive.trim()} (it must run here: this is the one place it does)`];
      const below = [];
      const walk = (x) => x.children.forEach((c) => (below.push(c), walk(c)));
      walk(r);
      const bad = below.find((c) => !c.ok || c.directive);
      if (bad) return [`${at}: its subtest "${bad.name}" ${bad.ok ? bad.directive.trim() : 'failed'} (all of it must run here)`];
      return [];
    });
  });
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
