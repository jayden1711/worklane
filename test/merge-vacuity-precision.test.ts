// #784 round 4 (the second adversarial review): the gate counts code that ran on the lines a PR changes, not a file
// whose module merely loaded; an import of an assertion module is no assertion; a bundle's map counts only the
// sources whose code ran; the coverage read and the scratch worktree's setup never hold the coordinator's thread; the
// gate's git reads take no replace ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { vacuityCheck } from '../src/merge-policy-vacuity.js';
import { FakeRunner } from '../src/runner.js';
import * as vacuity from '../src/vacuity.js';
import { exampleProject } from './helpers.js';
import { knownTip } from './vacuity-tip.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

function write(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A ready PR over the example project: `before` on its base, `after` at its head; a coordinator of its own. */
function pr(before: Record<string, string>, after: Record<string, string>, tune: (c: ReturnType<typeof loadConfig>) => void = () => {}) {
  const dir = exampleProject().dir;
  const base = write(dir, { 'dist/.keep': '', ...before });
  const head = write(dir, after);
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  tune(cfg);
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  knownTip(c, dir, base);
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return { c, w, p, log, dir, head };
}

/** The decision after the coverage run it asks for; and the longest the event loop was held during that run (ms). */
async function decided(t: ReturnType<typeof pr>) {
  const first = t.c.mergeDecisionFor(7, 9, t.p);
  let stall = 0;
  if (first.vacuityRun) {
    let last = performance.now();
    const tick = setInterval(() => {
      const now = performance.now();
      stall = Math.max(stall, now - last);
      last = now;
    }, 10);
    try {
      await t.c.vacuityRun(t.w, t.p, first.vacuityRun);
    } finally {
      clearInterval(tick);
      stall = Math.max(stall, performance.now() - last);
    }
  }
  return { d: t.c.mergeDecisionFor(7, 9, t.p), first, stall };
}

const ranNone = (test: string, app: string) => `design: vacuity: its tests (${test}) ran none of the app code it changes (${app})`;
const IMPORTS = (paths: string[]) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createRequire } from 'node:module';\n${paths.map((p) => (p.endsWith('.cjs') ? `createRequire(import.meta.url)('../${p}');` : `import '../${p}';`)).join('\n')}\ntest('loads', () => { assert.ok(true); });\n`;

// ---- (attack 2) a test that only imports the changed file: four module shapes that run code as they load

/** Each: the file before, and after the PR changed only the body of a function no test calls. */
const SHAPES: Record<string, [string, string, string]> = {
  'a helper called as the module loads': ['src/table.js', 'function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n\nexport function price(x) {\n  return x * 2;\n}\n', 'function buildTable(n) {\n  return Array.from({ length: n }, (_, i) => i * 2);\n}\nexport const TABLE = buildTable(4);\n\nexport function price(x) {\n  if (x < 0) throw new Error(\'negative\');\n  return x * 3;\n}\n'],
  'a class static field': ['src/cart.js', 'export class Cart {\n  static EMPTY = Object.freeze([]);\n  total(items) {\n    return items.reduce((s, i) => s + i, 0);\n  }\n}\n', 'export class Cart {\n  static EMPTY = Object.freeze([]);\n  total(items) {\n    return items.reduce((s, i) => s + i * 2, 0);\n  }\n}\n'],
  "tsc's __decorate": ['src/service.cjs', '"use strict";\nvar __decorate = (this && this.__decorate) || function (decorators, target) {\n  return decorators.reduceRight((t, d) => d(t) || t, target);\n};\nlet Service = class Service {\n  run() {\n    return 1;\n  }\n};\nService = __decorate([(t) => t], Service);\nexports.Service = Service;\n', '"use strict";\nvar __decorate = (this && this.__decorate) || function (decorators, target) {\n  return decorators.reduceRight((t, d) => d(t) || t, target);\n};\nlet Service = class Service {\n  run() {\n    return 2;\n  }\n};\nService = __decorate([(t) => t], Service);\nexports.Service = Service;\n'],
  "esbuild's keepNames __name": ['src/discount.js', "var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, 'name', { value, configurable: true });\nexport function discount(x) {\n  return x - 1;\n}\n__name(discount, 'discount');\n", "var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, 'name', { value, configurable: true });\nexport function discount(x) {\n  return x - 2;\n}\n__name(discount, 'discount');\n"],
  'a nested function never called, inside one that ran': ['src/outer.js', 'export const made = outer();\nfunction outer() {\n  const inner = (x) => {\n    return x + 1;\n  };\n  return 1;\n}\n', 'export const made = outer();\nfunction outer() {\n  const inner = (x) => {\n    return x + 2;\n  };\n  return 1;\n}\n'],
};

for (const [shape, [file, before, after]] of Object.entries(SHAPES)) {
  test(`attack 2, must hold: ${shape}: a test that only imports the file runs none of the lines the PR changes`, async () => {
    const t = pr({ [file]: before }, { [file]: after, 'test/imports.test.js': IMPORTS([file]) });
    const { d, first } = await decided(t);
    assert.ok(first.vacuityRun, 'measured');
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/imports.test.js', file)]]);
  });
}

test('attack 2, control: a test that calls the changed function merges', async () => {
  const [file, before, after] = SHAPES['a helper called as the module loads']!;
  const calls = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { price } from '../src/table.js';\ntest('price', () => { assert.equal(price(2), 6); });\n";
  const { d } = await decided(pr({ [file]: before }, { [file]: after, 'test/calls.test.js': calls }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- (attack 3) an import of an assertion module is no assertion

test('attack 3: a test whose only "assert" is its import has no assertion', () => {
  const cfg = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\b(assert|expect)\\b', app_paths: ['src/**'], dynamic: true };
  const files: Record<string, string> = {
    'src/a.js': 'x',
    'test/a.test.js': "import assert from 'node:assert';\nimport { strict as assert2 } from 'node:assert';\nconst expect = require('expect');\nimport test from 'node:test';\ntest('x', () => {});\n",
  };
  const v = vacuityCheck({ cfg, runOne: 'node --test {file}', changed: Object.keys(files), atHead: (p) => files[p] ?? null, runs: { started: 0, last: null } });
  assert.deepEqual(v, { reasons: ['design: vacuity: its tests (test/a.test.js) have no assertion matching /\\b(assert|expect)\\b/'] });
});

// ---- (attack 4) a bundle whose map names two sources: only the source whose code ran counts

const BUNDLE = '//#region src/a.js\nfunction fa(x) {\n\treturn x + 1;\n}\n//#endregion\n//#region src/b.js\nfunction fb(x) {\n\tif (x < 0) throw new Error("negative");\n\treturn x * 100;\n}\n//#endregion\nexport { fa, fb };\n\n//# sourceMappingURL=bundle.js.map';
const BUNDLE_MAP = JSON.stringify({ version: 3, file: 'bundle.js', names: [], sources: ['../src/a.js', '../src/b.js'], mappings: ';AAAA,SAAgB,GAAG,GAAG;CACpB,OAAO,IAAI;AACb;;;ACDA,SAAgB,GAAG,GAAG;CACpB,IAAI,IAAI,GAAG,MAAM,IAAI,MAAM,UAAU;CACrC,OAAO,IAAI;AACb' });
const SRC_A = 'export function fa(x) {\n  return x + 1;\n}\n';
const SRC_B = "// The file the PR changes. No test calls fb.\nexport function fb(x) {\n  if (x < 0) throw new Error('negative');\n  return x * 100;\n}\n";
const FA_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fa } from '../dist/bundle.js';\ntest('fa', () => { assert.equal(fa(1), 2); });\n";

test('attack 4, must hold: a bundle map naming two sources, the PR changes the one whose code never ran', async () => {
  const { d } = await decided(pr({ 'src/a.js': SRC_A, 'src/b.js': SRC_B.replace('x * 100', 'x * 10') }, { 'src/b.js': SRC_B, 'dist/bundle.js': BUNDLE, 'dist/bundle.js.map': BUNDLE_MAP, 'test/fa.test.js': FA_TEST }));
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/fa.test.js', 'src/b.js')]]);
});

test('attack 4, control: the same bundle, the PR changes the source whose code ran', async () => {
  const { d } = await decided(pr({ 'src/a.js': SRC_A.replace('x + 1', 'x + 0 + 1'), 'src/b.js': SRC_B }, { 'src/a.js': SRC_A, 'dist/bundle.js': BUNDLE, 'dist/bundle.js.map': BUNDLE_MAP, 'test/fa.test.js': FA_TEST }));
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- (attack 6, attack 11) the coordinator's thread: the coverage read and the worktree's setup run off it

test('attack 6: a coverage directory of deep-path script URLs never holds the coordinator\'s event loop', async () => {
  // The PR's test builds a deep chain of folders in its worktree and writes 150 script entries through it.
  const deep = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { pathToFileURL } from 'node:url';\nimport { totalCents } from '../src/price.js';\ntest('t', () => {\n  const dir = join(process.cwd(), ...Array(1800).fill('a'));\n  mkdirSync(dir, { recursive: true });\n  const result = [];\n  for (let i = 0; i < 150; i++) {\n    writeFileSync(join(dir, 'f' + i + '.js'), 'export function f() {}\\n');\n    result.push({ url: pathToFileURL(join(dir, 'f' + i + '.js')).href, functions: [{ functionName: 'f', ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] });\n  }\n  mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });\n  writeFileSync(join(process.env.NODE_V8_COVERAGE, 'deep.json'), JSON.stringify({ result }));\n  assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6);\n});\n`;
  const { stall } = await decided(pr({}, { 'src/price.js': 'export function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0) + 0;\n}\n\nexport function applyDiscount(cents, pct) {\n  return Math.round(cents * (100 - pct) / 100);\n}\n', 'test/deep.test.js': deep }));
  assert.ok(stall < 1_000, `the event loop was held ${Math.round(stall)} ms`);
});

test('attack 6: the reader process has a wall-clock limit: past it the read fails, with fixed text', async () => {
  const read = (vacuity as unknown as { readTouchedInChild?: (r: object, ms: number) => Promise<{ error?: string }> }).readTouchedInChild;
  assert.equal(typeof read, 'function', 'the read runs in a process of its own');
  const cov = mkdtempSync(join(tmpdir(), 'slow-cov-'));
  const t0 = performance.now();
  const r = await read!({ coverageDir: cov, baselineDir: cov, root: cov, appPaths: ['src/**'], only: [], hunks: {} }, 1);
  assert.match(r.error ?? '', /^the coverage directory took longer than \d+ s to read$/);
  assert.ok(performance.now() - t0 < 5_000);
});

test('attack 11: the scratch worktree\'s setup (the PR\'s own install steps) never holds the coordinator\'s event loop', async () => {
  const calls = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('t', () => { assert.equal(totalCents([{ cents: 2, qty: 3 }]), 6); });\n";
  const { d, stall } = await decided(pr({}, { 'src/price.js': 'export function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0) + 0;\n}\n\nexport function applyDiscount(cents, pct) {\n  return Math.round(cents * (100 - pct) / 100);\n}\n', 'test/calls.test.js': calls }, (c) => void (c.tests.worktree.setup = ['sleep 3'])));
  assert.ok(stall < 1_000, `the event loop was held ${Math.round(stall)} ms`);
  assert.deepEqual([d.auto, d.reasons], [true, []], 'and it measured as before');
});

// ---- (attack 14) the gate's reads of the head take no replace ref

test('attack 14: a replace ref can\'t swap the test the gate reads at the head', async () => {
  const noAssert = "import { test } from 'node:test';\ntest('x', () => {});\n";
  const t = pr({}, { 'src/price.js': '// changed\nexport function totalCents(items) {\n  return items.reduce((s, { cents, qty }) => s + cents * qty, 0);\n}\n', 'test/x.test.js': noAssert });
  // Someone with the repo makes the test's blob read as one that asserts.
  const real = git(t.dir, 'rev-parse', `${t.head}:test/x.test.js`);
  const fake = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: t.dir, encoding: 'utf8', input: "import assert from 'node:assert/strict';\nassert.ok(true);\n" }).trim();
  git(t.dir, 'replace', real, fake);
  const d = t.c.mergeDecisionFor(7, 9, t.p);
  assert.deepEqual([d.auto, d.reasons], [false, ['design: vacuity: its tests (test/x.test.js) have no assertion matching /\\b(assert|expect)\\b/']]);
});
