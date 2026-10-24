// The tamper guard's assertion count (#986): linear in the text, the same count as the regular expressions it
// replaced, and past ASSERTION_COUNT_CHARS never taken, the file flagged instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Coordinator } from '../src/coordinator.js';
import type { ChangeFile } from '../src/review.js';
// A namespace import, so the file still loads against a vacuity.ts without the cap (fail-without).
import * as vacuity from '../src/vacuity.js';
import { repoRoot } from './helpers.js';

const { countAssertions, stripComments } = vacuity;
const ASSERTION_COUNT_CHARS = (vacuity as { ASSERTION_COUNT_CHARS?: number }).ASSERTION_COUNT_CHARS ?? 1024 * 1024;

/** The comment stripping the tamper guard used before #986, kept as the reference. */
const regexStrip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const PATTERN = '\\b(assert|expect|check)\\b';
const regexCount = (src: string, pattern = PATTERN) => [...regexStrip(src).matchAll(new RegExp(pattern, 'g'))].length;

test('the stripped text and the count are the same as the regular expressions gave, on hand-picked cases', () => {
  const cases = [
    '// assert.equal(1, 1)\n/* expect(x) */\nassert.ok(true)',
    "const u = 'http://x/y'; assert(u)\nconst e = 'a\\// b'; // expect(1)\n",
    ':///x\n///x\n//x\nassert//x\n',
    '/* open\nassert(1)\n// close */ expect(2)\n',
    '// a note /* that opens\nassert(1)\n*/ check(2)\n',
    'a//* c */ assert(1)\n:/* c */// assert(2)\n/*/ assert(3) */ expect(4)\n/**/check(5)',
    "glob('src/*'); assert(1);\nglob('test/**'); expect(2) // tail\n",
    'assert(1) // \r assert(2)\n// x\u2028assert(3)\u2029// y\r\nassert(4)',
    '/* unclosed\nassert(1)\n/* still */ expect(2)\n',
    '',
    '//',
    '/*',
    '*/',
  ];
  for (const c of cases) {
    assert.equal(stripComments(c), regexStrip(c), JSON.stringify(c));
    assert.equal(countAssertions(c, PATTERN), regexCount(c), JSON.stringify(c));
  }
});

test('the stripped text is the same as the regular expressions gave, on random text of comment characters', () => {
  // A fixed seed: the same strings every run.
  let seed = 986;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
  const alphabet = ['/', '*', ':', '\\', '\n', '\r', '\u2028', 'a', ' ', "'", 'assert'];
  for (let k = 0; k < 20_000; k++) {
    let s = '';
    for (let n = next() % 40; n > 0; n--) s += alphabet[next() % alphabet.length];
    assert.equal(stripComments(s), regexStrip(s), JSON.stringify(s));
  }
});

test("the count is the same as the regular expressions gave on every one of this repo's test files", () => {
  const dir = join(repoRoot, 'test');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 100, `read ${files.length} test files`);
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.equal(countAssertions(text, PATTERN), regexCount(text), f);
  }
});

test('a text over ASSERTION_COUNT_CHARS is not counted; one at it is', () => {
  const unit = 'assert(1);\n';
  const at = unit.repeat(Math.ceil(ASSERTION_COUNT_CHARS / unit.length)).slice(0, ASSERTION_COUNT_CHARS);
  assert.equal(countAssertions(at, PATTERN), regexCount(at));
  assert.equal(countAssertions(`${at}a`, PATTERN), null);
});

test('512 KiB of unclosed comment openers is counted in well under a second and a half (it took seconds)', () => {
  const src = '/*\n'.repeat(Math.floor((512 * 1024) / 3));
  const t = performance.now();
  assert.equal(countAssertions(`${src}assert(1)`, PATTERN), 1);
  const ms = performance.now() - t;
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function write(dir: string, files: Record<string, string | null>) {
  for (const [p, text] of Object.entries(files)) {
    if (text === null) rmSync(join(dir, p));
    else {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
  }
}

/** The tamper guard's flags on a change from `base` to `head` (file text; null: none there). */
function flags(base: Record<string, string>, head: Record<string, string | null>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'tamper-count-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']]) git(dir, 'config', k!, v!);
    write(dir, base);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const sha = git(dir, 'rev-parse', 'HEAD');
    write(dir, head);
    const files: ChangeFile[] = Object.keys(head).map((path) => ({ path, added: 1, removed: 1, addedLines: [], removedLines: [] }));
    const c = Object.create(Coordinator.prototype) as object;
    Object.defineProperty(c, 'd', { value: { cfg: { tests: {} } } });
    return (c as { tamperFlags(path: string, base: string, files: ChangeFile[]): string[] }).tamperFlags(dir, sha, files);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the tamper guard flags a test file too large to count in, before or after the change, and still flags fewer assertions', () => {
  const big = 'assert(1);\n'.repeat(Math.ceil(ASSERTION_COUNT_CHARS / 11) + 1);
  // Over the base read's buffer too: git's output is cut off, which is no new file.
  const huge = 'assert(1);\n'.repeat(Math.ceil((3 * ASSERTION_COUNT_CHARS) / 11) + 1);
  const notCounted = ['assertions not counted in test/a.test.js: over 1048576 characters before or after the change'];
  assert.deepEqual(flags({ 'test/a.test.js': 'assert(1);\n' }, { 'test/a.test.js': big }), notCounted, 'after the change');
  assert.deepEqual(flags({ 'test/a.test.js': big }, { 'test/a.test.js': 'assert(1);\n' }), notCounted, 'before the change');
  assert.deepEqual(flags({ 'test/a.test.js': huge }, { 'test/a.test.js': 'assert(1);\n' }), notCounted, 'before, past the read buffer');
  assert.deepEqual(flags({ 'test/a.test.js': huge }, { 'test/a.test.js': null }), ['deleted test test/a.test.js'], 'deleted, past the read buffer');
  assert.deepEqual(flags({ 'test/a.test.js': 'assert(1);\nassert(2);\n' }, { 'test/a.test.js': 'assert(1);\n// assert(2);\n' }), ['fewer assertions in test/a.test.js']);
  assert.deepEqual(flags({ 'test/a.test.js': 'assert(1);\n' }, { 'test/a.test.js': 'assert(1);\nassert(2);\n' }), []);
  assert.deepEqual(flags({}, { 'test/new.test.js': big }), [], 'a new file has nothing to compare with');
});
