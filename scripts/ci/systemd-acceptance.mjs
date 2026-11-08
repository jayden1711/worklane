// The acceptance tests that need a booted systemd and passwordless sudo: each test in test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too.
//
//   node scripts/ci/systemd-acceptance.mjs      (after the build: it runs dist/test/<file>.js)
//
// Exit 1: a test failed, skipped or didn't run. Exit 2: no such test was found, or the files couldn't be read.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Every gated test under `dir` (test/), by file. Throws when a gate isn't in a test() call this can read. */
export function findAll(dir) {
  const found = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.ts')).sort()) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    if (names.length !== gateCount(text)) throw new Error(`test/${f}: ${gateCount(text)} systemCi gate(s), ${names.length} in a test() call this reads`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/** TAP's escapes in a test's name (node's reporter: backslash, #, newline), undone. */
const tapName = (s) => s.replace(/\\([\\#n])/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * What's wrong with each of `names` in node's TAP output `tap`: a test that isn't there, failed, or was skipped
 * (an option or t.skip()) or marked todo. [] when every one ran and passed.
 */
export function problems(tap, names) {
  const results = new Map();
  for (const line of tap.split('\n')) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(line);
    if (!m) continue;
    const directive = /^(.*?) # (SKIP|TODO)\b(.*)$/i.exec(m[2]);
    const name = tapName(directive ? directive[1] : m[2]);
    results.set(name, { ok: !m[1], directive: directive ? `${directive[2].toUpperCase()}${directive[3]}` : null });
  }
  return names.flatMap((n) => {
    const r = results.get(n);
    if (!r) return [`${n}: didn't run`];
    if (!r.ok) return [`${n}: failed`];
    if (r.directive) return [`${n}: ${r.directive.trim()} (it must run here: this is the one place it does)`];
    return [];
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
  const args = [...PRELOAD, '--test', '--test-reporter=tap', ...names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`), ...found.map((f) => `dist/test/${f.file.replace(/\.ts$/, '.js')}`)];
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(r.stdout ?? '');
  const bad = problems(r.stdout ?? '', names);
  if (r.status !== 0 && !bad.length) bad.push(`the test run exited ${r.status ?? r.signal}`);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} ran and passed`);
}
