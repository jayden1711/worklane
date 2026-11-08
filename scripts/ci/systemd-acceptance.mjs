// The acceptance tests that need a booted systemd and passwordless sudo: each test under test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too, in any directory
// under test/ (npm test runs dist/test/**/*.test.js). The gate has one spelling: any other mention of systemCi in a
// test file (`! systemCi`, `!(systemCi)`, a ternary, a check inside a test), a flag or function shaped like it or
// reading systemd's sign under another name, or any of that in src/ or a test helper, stops the job.
//
// Results come from node's own test events (systemd-acceptance-reporter.mjs, R1169f), never from TAP text a test
// could print: each gate is matched by its built file, the line its test() call is on, and its name.
//
//   node scripts/ci/systemd-acceptance.mjs      (after the build: it runs dist/test/<file>.js)
//
// Exit 1: a test failed, skipped, didn't run, ran more than once or has a subtest that didn't pass, or a test here
// skipped naming systemd. Exit 2: no such test was found, a file couldn't be read, or a gate isn't one it reads.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
/** The suite's isolation preload, as every runner of it passes it (test/isolate.ts). */
const PRELOAD = ['--import', './dist/test/isolate.js'];
/** The reporter that writes node's own results as JSON lines (systemd-acceptance-reporter.mjs). */
const REPORTER = fileURLToPath(new URL('./systemd-acceptance-reporter.mjs', import.meta.url));

/** A JS string literal's body, unescaped (\\, \', \", \` and \n; the names here use no other escape). */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * Each `test(<name>, { skip: !systemCi ...` in `text`, as its name. The gate must be the options' first key, as every
 * such test writes it; `gateCount` counts every `skip: !systemCi` so a caller can see none was missed.
 */
export function systemdTests(text) {
  return gatesOf(text).map((g) => g.name);
}

/** The gate regex: `test(<name>, { skip: !systemCi`, `test` with a member's `.` before it (`t.test(`) or not. */
const GATE = /(?<![\w$])test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\{\s*skip:\s*!systemCi\b/g;

/**
 * Each gate in `text`: its name, the line its `test(` is on (1-based, as node reports a test's location), and whether
 * it is a subtest's (`t.test(`), which the job refuses (R1169e): the run selects top-level tests by name.
 */
export function gatesOf(text) {
  return [...text.matchAll(GATE)].map((m) => {
    const before = text.slice(0, m.index);
    // A member call (`t.test(`, `sub.test (`): a `.` right before it on its line.
    return { name: unescape(m[2]), line: before.split('\n').length, member: /\.[ \t]*$/.test(before.slice(before.lastIndexOf('\n') + 1)) };
  });
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
export const detectorNames = (text) => [
  ...[...text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*\/run\/systemd\/system/g)].map((m) => m[1]),
  // A function that reads it (R1169f: `function onSystemd() { return existsSync('/run/systemd/system'); }`).
  ...[...text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{[^}]{0,500}\/run\/systemd\/system/g)].map((m) => m[1]),
];

/** How many `skip:` options read systemd's sign inline (R1169f: `skip: !existsSync('/run/systemd/system')`): each must be a read gate. */
export const inlineSignCount = (text) => [...text.matchAll(/\bskip\s*:([^\n]{0,300})/g)].filter((m) => /\/run\/systemd/.test(m[1])).length;

/**
 * Every gated test under `dir` (test/), at any depth, by its path from `dir` ('/'-separated). Throws when a mention
 * of systemCi isn't a gate in a test() call this can read, when a skip that looks like a systemd gate isn't one, when
 * a flag read from systemd's sign isn't named systemCi, or when any of that is in a file under test/ that isn't a
 * `*.test.ts` (a helper module that registers tests, R1169d): the run is by file, so a gated test must be in one.
 */
export function findAll(dir, prefix = 'test/') {
  const found = [];
  const files = readdirSync(dir, { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    const mentions = mentionCount(text);
    const like = gateLikeCount(text);
    const odd = detectorNames(text).filter((n) => n !== 'systemCi');
    const inline = inlineSignCount(text);
    if (!f.endsWith('.test.ts')) {
      if (names.length || mentions || like || odd.length || inline) throw new Error(`${prefix}${f}: a systemd gate outside a *.test.ts file (a helper that registers tests): write the gated test in the test file itself, as \`test(<name>, { skip: !systemCi ...\``);
      continue;
    }
    if (names.length !== mentions) throw new Error(`${prefix}${f}: ${mentions} use(s) of systemCi, ${names.length} a gate in a test() call this reads (write it as \`test(<name>, { skip: !systemCi ...\`)`);
    if (like !== names.length) throw new Error(`${prefix}${f}: ${like} skip(s) that look like a systemd gate, ${names.length} a gate this reads (the flag must be named systemCi: \`test(<name>, { skip: !systemCi ...\`)`);
    if (odd.length) throw new Error(`${prefix}${f}: ${odd.join(', ')} read(s) systemd's sign under another name than systemCi`);
    if (inline) throw new Error(`${prefix}${f}: ${inline} skip(s) that read systemd's sign inline: gate the test on systemCi, as \`test(<name>, { skip: !systemCi ...\``);
    const member = gatesOf(text).filter((g) => g.member);
    if (member.length) throw new Error(`${prefix}${f}: a gate on a subtest (\`t.test(\`: ${JSON.stringify(member[0].name)}); gate a top-level test(), which the run selects by name`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/**
 * What's wrong with each gate in `runs`, one entry per file: { file, gates: [{ name, line }], events }, where `events`
 * are node's own results from running that file alone (systemd-acceptance-reporter.mjs: { type, name, nesting, file,
 * line, skip, todo }, in the order they finished). A gate's result is the event of its file (`dist/test/<file>.js`),
 * its line and its name, so a namesake elsewhere, a gate registered only sometimes (under an env var), or a line a
 * test prints can't stand in for it (R1169e, R1169f). Each problem is a gate with no result, more than one, a failure,
 * a skip or a todo, or a subtest (the deeper events just before it) that didn't pass. And a floor: any test in the
 * run that skipped with a reason naming systemd. [] when every gate ran once and passed, all of it.
 */
export function problems(runs) {
  return runs.flatMap(({ file, gates, events }) => {
    const built = `dist/test/${file.replace(/\.ts$/, '.js')}`;
    const inFile = (e) => typeof e.file === 'string' && (e.file.split(sep).join('/').endsWith(`/${built}`) || e.file === built);
    const out = [];
    const matched = new Set();
    for (const g of gates) {
      const at = `test/${file}: ${g.name}`;
      const ks = events.flatMap((e, k) => (inFile(e) && e.line === g.line && e.name === g.name ? [k] : []));
      ks.forEach((k) => matched.add(k));
      if (!ks.length) {
        out.push(`${at}: didn't run`);
        continue;
      }
      if (ks.length > 1) {
        out.push(`${at}: ran ${ks.length} times`);
        continue;
      }
      const r = events[ks[0]];
      if (r.type !== 'test:pass') out.push(`${at}: failed`);
      else if (r.skip !== null && r.skip !== false) out.push(`${at}: SKIP${typeof r.skip === 'string' ? ` ${r.skip}` : ''} (it must run here: this is the one place it does)`);
      else if (r.todo !== null && r.todo !== false) out.push(`${at}: TODO${typeof r.todo === 'string' ? ` ${r.todo}` : ''} (it must run here: this is the one place it does)`);
      else {
        // Its subtests: the events just before it, deeper than it, until one at its depth or shallower.
        for (let k = ks[0] - 1; k >= 0 && events[k].nesting > r.nesting; k--) {
          matched.add(k);
          const c = events[k];
          const bad = c.type !== 'test:pass' ? 'failed' : c.skip !== null && c.skip !== false ? `SKIP${typeof c.skip === 'string' ? ` ${c.skip}` : ''}` : c.todo !== null && c.todo !== false ? `TODO${typeof c.todo === 'string' ? ` ${c.todo}` : ''}` : null;
          if (bad) {
            out.push(`${at}: its subtest "${c.name}" ${bad} (all of it must run here)`);
            break;
          }
        }
      }
    }
    // The floor: a test here (not a gate) skipped for systemd, as a gate spelled some way this doesn't read would be.
    events.forEach((e, k) => {
      if (!matched.has(k) && typeof e.skip === 'string' && /systemd/i.test(e.skip)) out.push(`test/${file}: ${e.name}: SKIP ${e.skip} (a test skipped for systemd here, where systemd is)`);
    });
    return out;
  });
}

/** The reporter's JSON lines, read; a line that isn't one is a problem (fail closed). */
export function eventsOf(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let found;
  try {
    found = findAll(join(root, 'test'));
    // src/ holds no gate: one there (re-exported through a test helper, R1169f) would be run nowhere.
    if (existsSync(join(root, 'src'))) findAll(join(root, 'src'), 'src/').forEach(() => {});
    // The built files are what runs: each gate's line is read there, and its names must be the source's.
    for (const f of found) {
      const built = readFileSync(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js')), 'utf8');
      f.gates = gatesOf(built).filter((g) => !g.member);
      const a = [...f.names].sort();
      const b = f.gates.map((g) => g.name).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`test/${f.file}: its gates ${JSON.stringify(a)} aren't the built file's ${JSON.stringify(b)} (build again)`);
    }
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
  // One run per file; TAP to the log, node's own results to a file only this process names.
  const runs = [];
  const exits = [];
  const out = mkdtempSync(join(tmpdir(), 'systemd-acceptance-'));
  try {
    for (const [k, f] of found.entries()) {
      const results = join(out, `${k}.jsonl`);
      const args = [...PRELOAD, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${results}`, ...f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
      // Never a child of another test run's reporter (NODE_TEST_CONTEXT): its results come here, to the file above.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
      const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
      process.stdout.write(r.stdout ?? '');
      let events;
      try {
        events = eventsOf(existsSync(results) ? readFileSync(results, 'utf8') : '');
      } catch (e) {
        console.error(`test/${f.file}: its results couldn't be read (${e.message})`);
        process.exit(1);
      }
      runs.push({ file: f.file, gates: f.gates, events });
      if (r.status !== 0) exits.push(`test/${f.file}: the test run exited ${r.status ?? r.signal}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const bad = problems(runs);
  if (!bad.length) bad.push(...exits);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} ran and passed`);
}
