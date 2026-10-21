// #784 round 10 (the round-9 final check E1-E3, the second review A1a-A2, C1-C5): a removal counts only when the code
// on its sides ran, and never when it crosses a block or clause boundary; the removed side is lexed in its base file, so
// an edited line inside a block comment or JSDoc is no code change, and `<!--` in script code is a comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
type Run = { tests: string[]; appPaths: string[] };
type Gate = { mergeDecisionFor(n: number, number: number, pr: PullRequest): { auto: boolean; reasons: string[]; vacuityRun?: Run }; vacuityRun(w: EventPayload<'pr.opened'>, pr: PullRequest, run: Run): Promise<void> };

function commit(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'step');
  return git(dir, 'rev-parse', 'HEAD');
}

/** A ready PR over the example project with a real remote at its base, decided after its coverage run. */
async function decided(before: Record<string, string>, after: Record<string, string>) {
  const dir = exampleProject().dir;
  const base = commit(dir, { 'dist/.keep': '', ...before });
  const head = commit(dir, after);
  const bare = join(dir, '..', 'origin.git');
  git(join(dir, '..'), 'init', '-q', '--bare', bare);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', '--force', 'origin', `${base}:refs/heads/main`);
  git(dir, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  log.append('issue.claimed', { issue: 7, instance: 'i', lease: 'a'.repeat(40), base, owner: 'example-owner' }, 'i');
  const w = { issue: 7, number: 9, url: 'u', head, draft: false };
  log.append('pr.opened', w, 'i');
  log.append('eval.verdict', { issue: 7, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true }) as unknown as Gate;
  const p: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: head, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  const first = c.mergeDecisionFor(7, 9, p);
  if (first.vacuityRun) await c.vacuityRun(w, p, first.vacuityRun);
  return c.mergeDecisionFor(7, 9, p);
}

const H = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const calls = (file: string, name: string, call: string, want: string) => `${H}import { ${name} } from '../src/${file}';\ntest('${name}', () => { assert.deepEqual(${call}, ${want}); });\n`;
const ranNone = (app: string) => `design: vacuity: its tests (test/x.test.js) ran none of the app code it changes (${app})`;
const NOTHING = 'design: vacuity: its coverage run failed: nothing to measure: its changes to app code are only blank lines, whitespace, comments or renames, so no changed line holds code a test can run';

const SWITCH = "export function role(r) {\n  switch (r) {\n    case 'guest':\n      return 'denied';\n    case 'admin':\n      return 'granted';\n  }\n  return 'none';\n}\n";
const BREAK = "export function role(r) {\n  let out = 'none';\n  switch (r) {\n    case 'guest':\n      out = 'denied';\n      break;\n    case 'admin':\n      out = 'granted';\n  }\n  return out;\n}\n";

/** Each: the file, before, after, a test that takes only the other path (holds), a test that takes the changed one (merges). */
const CASES: Record<string, { file: string; before: string; after: string; hold: string; merge: string }> = {
  'E1: an untaken ternary arm shortened by a removal (-x * 2 to -x)': {
    file: 'abs.js',
    before: 'export function abs(x) {\n  return x > 0 ? x : -x * 2;\n}\n',
    after: 'export function abs(x) {\n  return x > 0 ? x : -x;\n}\n',
    hold: calls('abs.js', 'abs', 'abs(5)', '5'),
    merge: calls('abs.js', 'abs', 'abs(-5)', '5'),
  },
  'E2: an untaken `||` right side shortened by a removal': {
    file: 'label.js',
    before: "export function label(o) {\n  return o.name || o.id + '-anon';\n}\n",
    after: 'export function label(o) {\n  return o.name || o.id;\n}\n',
    hold: calls('label.js', 'label', "label({ name: 'a', id: 1 })", "'a'"),
    merge: calls('label.js', 'label', 'label({ id: 1 })', '1'),
  },
  'E3: no-semicolon style, an untaken if body shortened (10 to 1)': {
    file: 'clamp.js',
    before: 'export function clamp(x) {\n  if (x < 0) return 10\n  return x\n}\n',
    after: 'export function clamp(x) {\n  if (x < 0) return 1\n  return x\n}\n',
    hold: calls('clamp.js', 'clamp', 'clamp(5)', '5'),
    merge: calls('clamp.js', 'clamp', 'clamp(-5)', '1'),
  },
  "A1a: a case's return removed, so it falls through": {
    file: 'role.js',
    before: SWITCH,
    after: SWITCH.replace("      return 'denied';\n", ''),
    hold: calls('role.js', 'role', "role('admin')", "'granted'"),
    merge: calls('role.js', 'role', "role('guest')", "'granted'"),
  },
  "A1b: a case's break removed": {
    file: 'role.js',
    before: BREAK,
    after: BREAK.replace('      break;\n', ''),
    hold: calls('role.js', 'role', "role('admin')", "'granted'"),
    merge: calls('role.js', 'role', "role('guest')", "'granted'"),
  },
  "A1c: a case's break commented out": {
    file: 'role.js',
    before: BREAK,
    after: BREAK.replace('      break;\n', '      // break;\n'),
    hold: calls('role.js', 'role', "role('admin')", "'granted'"),
    merge: calls('role.js', 'role', "role('guest')", "'granted'"),
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`must hold: ${name}: the test takes only the other path`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.hold });
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone(`src/${c.file}`)]]);
  });
  test(`control: ${name}: a test that takes the changed path merges`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.merge });
    assert.deepEqual([d.auto, d.reasons], [true, []]);
  });
}

// ---- a removal across a clause boundary never counts

const ACCESS = "export function access(u) {\n  if (u.admin) {\n    return 'all';\n  } else if (u.banned) {\n    return 'none';\n  }\n  return 'some';\n}\n";
const NO_BANNED = ACCESS.replace("  } else if (u.banned) {\n    return 'none';\n", '');

test('must hold: A2: an `else if` branch removed, the test takes the admin path', async () => {
  const d = await decided({ 'src/access.js': ACCESS }, { 'src/access.js': NO_BANNED, 'test/x.test.js': calls('access.js', 'access', '{ v: access({ admin: true }) }', "{ v: 'all' }") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/access.js')]]);
});

test('A2 by design: a removal across a clause boundary holds even when a test takes the path it changed (the owner decides)', async () => {
  const d = await decided({ 'src/access.js': ACCESS }, { 'src/access.js': NO_BANNED, 'test/x.test.js': calls('access.js', 'access', '{ v: access({ banned: true }) }', "{ v: 'some' }") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/access.js')]]);
});

test('control: a statement removed inside the branch a test takes, crossing no boundary, merges', async () => {
  const before = "const seen = [];\nexport function access(u) {\n  if (u.admin) {\n    seen.push(u);\n    return 'all';\n  }\n  return 'some';\n}\n";
  const d = await decided({ 'src/access.js': before }, { 'src/access.js': before.replace('    seen.push(u);\n', ''), 'test/x.test.js': calls('access.js', 'access', '{ v: access({ admin: true }) }', "{ v: 'all' }") });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- the removed side lexed in its base file

const CART = 'export class Cart {\n  /**\n   * The total of the cart.\n   */\n  total(items) {\n    return items.length;\n  }\n  check(u) {\n    if (!u.ok) throw new Error(\'no\');\n    return 1;\n  }\n}\n';
const totals = `${H}import { Cart } from '../src/cart.js';\ntest('total', () => { assert.equal(new Cart().total([1, 2]), 2); });\n`;

test('must hold: C1: one JSDoc line edited above a tested method is nothing to measure', async () => {
  const d = await decided({ 'src/cart.js': CART }, { 'src/cart.js': CART.replace('The total of the cart.', 'The sum over the cart.'), 'test/x.test.js': totals });
  assert.deepEqual([d.auto, d.reasons], [false, [NOTHING]]);
});

test('must hold: C2: one line edited inside a block comment in a tested function is nothing to measure', async () => {
  const f = 'export function f(x) {\n  /* Old note\n     about x. */\n  return x + 1;\n}\n';
  const d = await decided({ 'src/f.js': f }, { 'src/f.js': f.replace('     about x.', '     about y.'), 'test/x.test.js': calls('f.js', 'f', 'f(1)', '2') });
  assert.deepEqual([d.auto, d.reasons], [false, [NOTHING]]);
});

test('must hold: C3: the JSDoc edit on a tested method, plus a guard removed from an untested one', async () => {
  const d = await decided({ 'src/cart.js': CART }, { 'src/cart.js': CART.replace('The total of the cart.', 'The sum over the cart.').replace("    if (!u.ok) throw new Error('no');\n", ''), 'test/x.test.js': totals });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/cart.js')]]);
});

test('must hold: C5: an `<!--` comment edited in a tested CommonJS function, plus a guard removed from an untested one', async () => {
  const c = "exports.f = function (x) {\n  <!-- old note\n  return x + 1;\n};\nexports.g = function (u) {\n  if (!u.ok) throw new Error('no');\n  return 1;\n};\n";
  const t = `${H}import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\ntest('f', () => { assert.equal(require('../src/c.cjs').f(1), 2); });\n`;
  const d = await decided({ 'src/c.cjs': c }, { 'src/c.cjs': c.replace('old note', 'new note').replace("  if (!u.ok) throw new Error('no');\n", ''), 'test/x.test.js': t });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/c.cjs')]]);
});

test('control: an edited code line under a JSDoc still counts', async () => {
  const f = '/**\n * Adds one.\n */\nexport function f(x) {\n  return x + 1;\n}\n';
  const d = await decided({ 'src/f.js': f }, { 'src/f.js': f.replace('x + 1', 'x + 2'), 'test/x.test.js': calls('f.js', 'f', 'f(1)', '3') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});
