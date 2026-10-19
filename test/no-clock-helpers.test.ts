// WHY (#687): a test helper that reads the wall clock on every call (`const at = (s) => Math.floor(Date.now() / 1000)
// + s`) gives two calls two clocks. test/github-budget-health.test.ts set a reset time with at(600) and expected
// at(600) again later; when a second ticked in between, it failed. A test reads "now" once and reuses it, pins Date
// (node:test's mock.timers), or gives the code a clock. The helpers already in test/ are allowed by file, each count
// exact, so a fix lowers it here and no file can gain one back; a file with none may never get one.
//
// Narrow on purpose: every wall-clock read in test/ (some 370 in over 100 files, measured on #687) would be noise, and
// many are right: a stamp some while ago compared with a file's real mtime, which a pinned Date cannot move. Only a
// helper declared on one line (`const f = (…) => …` or `function f(…) { … }`) whose body reads the clock is counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoRoot } from './helpers.js';

/** The clock-reading helpers each test file had when this check came in (#687), by file; only ever lowered. */
const ALLOWED: Record<string, number> = {
  'test/delegation-coordinator.test.ts': 2,
  'test/github-budget-health.test.ts': 1,
  'test/github-budget.test.ts': 1,
  'test/login-start-lock.test.ts': 1,
  'test/machine-no-shift.test.ts': 1,
  'test/no-late-shift.test.ts': 1,
  'test/waiting-page.test.ts': 1,
  'test/web-buttons.test.ts': 1,
  'test/web-render.test.ts': 4,
};

/** A read of the wall clock: Date.now(), or a Date made with no argument (not another name ending in Date). */
const READ = String.raw`(?<![\w$])(?:Date\.now\(\)|new Date\(\))`;
/** `const f = (…) => …` or `const f = x => …`, on one line, whose body reads the wall clock. */
const ARROW = new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>.*${READ}`);
/** `function f(…) { … }` on one line whose body reads the wall clock. */
const FUNCTION = new RegExp(String.raw`^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)[^{]*\{.*${READ}`);

/** The lines of `text` that declare a helper reading the wall clock on every call (comment lines left out). */
function clockHelpers(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .filter((l) => ARROW.test(l) || FUNCTION.test(l))
    .map((l) => l.trim());
}

/** Every source file under test/, as a path from the repo root with forward slashes. */
function testSources(dir = join(repoRoot, 'test')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...testSources(p));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(e.name)) out.push(relative(repoRoot, p).split(sep).join('/'));
  }
  return out;
}

test('the lint finds a helper that reads the wall clock on every call, and not a clock read once and reused', () => {
  // Built at run time, so this file has none of its own.
  const now = ['Date', 'now()'].join('.');
  const made = ['new', 'Date()'].join(' ');
  const found = (src: string) => clockHelpers(src).length;
  // The helper that flaked (#687), and its kin.
  assert.equal(found(`const at = (s: number) => Math.floor(${now} / 1000) + s;`), 1);
  assert.equal(found(`  const later = () => new Date(${now} + 60_000);`), 1);
  assert.equal(found(`export const stamp = async () => ${made}.toISOString();`), 1);
  assert.equal(found(`let inAnHour = (): number => ${now} + 3600;`), 1);
  assert.equal(found(`const mins = n => new Date(${now} - n * 60_000);`), 1);
  assert.equal(found(`function at(h: number): string { return new Date(${now} - h).toISOString(); }`), 1);
  assert.equal(found(`export async function stamp() { return ${made}; }`), 1);
  assert.equal(found(`const a = () => ${now};\nconst b = (x) => x;\nconst c = () => ${made};`), 2);
  // Read once, then reused; a fixed date; a Date of a given time; the clock passed by reference; a comment.
  assert.equal(found(`const t0 = ${now};\nconst at = (s: number) => Math.floor(t0 / 1000) + s;`), 0);
  assert.equal(found(`const at = (h: number) => new Date(T0 - h * 3_600_000).toISOString();`), 0);
  assert.equal(found(`const parse = (s: string) => new Date(s);`), 0);
  assert.equal(found(`const clock = { now: Date.now };\nrun({ now: () => FIXED });`), 0);
  assert.equal(found(`// const at = (s) => ${now} + s;\n * const later = () => ${made};`), 0);
  assert.equal(found(`assert.ok(${now} > start);`), 0);
  // The shifted clock's own (test/clock-shift.ts): another Date, not the one a test reads.
  assert.equal(found(`const now = () => Real${now} + ms;`), 0);
});

test('no test file gains a helper that reads the wall clock on every call: read now once, pin Date, or give the code a clock', () => {
  const found = new Map(testSources().map((f) => [f, clockHelpers(readFileSync(join(repoRoot, f), 'utf8'))] as const));
  const over = [...found].filter(([f, h]) => h.length > (ALLOWED[f] ?? 0)).map(([f, h]) => `${f}: ${h.length}, allowed ${ALLOWED[f] ?? 0}: ${h.join(' | ')}`);
  assert.deepEqual(over, [], 'a helper that reads the wall clock on each call gives two calls two clocks (#687): read now once and reuse it, pin Date (mock.timers), or give the code a clock');
  // A file that has fewer now: its allowance comes down with it, so none can come back unseen.
  const under = Object.entries(ALLOWED).filter(([f, n]) => (found.get(f)?.length ?? 0) < n).map(([f, n]) => `${f}: ${found.get(f)?.length ?? 0}, allowed ${n}`);
  assert.deepEqual(under, [], 'fewer clock-reading helpers than allowed: lower (or remove) the allowance in test/no-clock-helpers.test.ts');
});
