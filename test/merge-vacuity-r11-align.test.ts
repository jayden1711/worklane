// #784 round 11: how the merge gate aligns a PR's change. Unchanged lines whose code/comment reading turned between
// hunks (T1); a large hunk's lines paired by their code only (L1-L5); and a reader that refuses a request without the
// base its removed lines are read in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { readTouchedInChild, type TouchedRequest } from '../src/vacuity.js';
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
  cfg.review.merge.max_lines = 10_000;
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

// ---- T1: unchanged lines between two hunks turned from code into a comment, or back

const TG = "export function guard(u) {\n  const r = 'ok';\n  if (u.guest) {\n    throw new Error('denied');\n  }\n  return r;\n}\n";
const T1 = TG.replace("  const r = 'ok';\n", "  const r = 'ok' /*\n").replace('  return r;\n', '  */ return r;\n');

test('must hold: T1: a braced guard commented out by a /* */ opened and closed around its unchanged lines (the `;` above moves into the comment)', async () => {
  const d = await decided({ 'src/g.js': TG }, { 'src/g.js': T1, 'test/x.test.js': calls('g.js', 'guard', 'guard({})', "'ok'") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/g.js')]]);
});

test('control: T1: a test that takes the guard still holds (a fail-closed false hold: the removed code holds `if` and `{`)', async () => {
  const d = await decided({ 'src/g.js': TG }, { 'src/g.js': T1, 'test/x.test.js': calls('g.js', 'guard', 'guard({ guest: true })', "'ok'") });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/g.js')]]);
});

const UNCOMMENT_BEFORE = 'export function t(x) {\n  return x;\n} /*\nexport function v(x) {\n  return x + 1;\n}\n*/\n';
const UNCOMMENT_AFTER = 'export function t(x) {\n  return x;\n}\nexport function v(x) {\n  return x + 1;\n}\n';

test('must hold: T1: a function a comment held turned into code by its markers removed, and no test calls it', async () => {
  const d = await decided({ 'src/v.js': UNCOMMENT_BEFORE }, { 'src/v.js': UNCOMMENT_AFTER, 'test/x.test.js': calls('v.js', 't', 't(1)', '1') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/v.js')]]);
});

test('control: T1: a function a comment held turned into code, and a test calls it, merges (its lines are added code)', async () => {
  const d = await decided({ 'src/v.js': UNCOMMENT_BEFORE }, { 'src/v.js': UNCOMMENT_AFTER, 'test/x.test.js': calls('v.js', 'v', 'v(1)', '2') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

// ---- L1-L5: hunks too large to align whole, every line's comment edited, so no line is equal

const pad = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `// ${tag} padding note number ${i} about nothing at all here ok\n`).join('');
const tagged = (lines: string[], tag: string) => lines.map((l, i) => `${l} // ${tag}${i}`).join('\n') + '\n';
const TU = ['export function t(x) {', '  return x + 1;', '}', 'export function u(y) {', "  if (!y.ok) throw new Error('no');", '  return y;', '}'];
const TU_AFTER = TU.filter((l) => !l.includes('throw'));
const T_CALL = calls('l.js', 't', 't(1)', '2');

const LARGE: Record<string, [string, string]> = {
  'L1: one comment line added at the top, a guard removed from an untested function': [tagged(TU, 'old') + pad('old', 70), '// a new note at the top\n' + tagged(TU_AFTER, 'new') + pad('new', 70)],
  'L1b: a guard removed from an untested function, no line added': [tagged(TU, 'old') + pad('old', 70), tagged(TU_AFTER, 'new') + pad('new', 70)],
  'L2: two lines swapped in an untested branch': [
    tagged(['export function t(x) {', '  return x + 1;', '}', 'export function u(y, log) {', '  if (y.guest) {', "    if (!y.ok) return 'denied';", '    log.push(y);', '  }', "  return 'ok';", '}'], 'old') + pad('old', 70),
    tagged(['export function t(x) {', '  return x + 1;', '}', 'export function u(y, log) {', '  if (y.guest) {', '    log.push(y);', "    if (!y.ok) return 'denied';", '  }', "  return 'ok';", '}'], 'new') + pad('new', 70),
  ],
  'L3: a guard moved from one untested function to another below': [
    tagged([...TU, 'export function v(z) {', '  return z;', '}'], 'old') + pad('old', 70),
    tagged([...TU_AFTER, 'export function v(z) {', "  if (!z.ok) throw new Error('no');", '  return z;', '}'], 'new') + pad('new', 70),
  ],
  'L4: a comment line added at the end, a guard removed from an untested function': [tagged(TU, 'old') + pad('old', 70) + '// tail\n', tagged(TU_AFTER, 'new') + pad('new', 70) + '// one more\n// tail\n'],
};

for (const [name, [before, after]] of Object.entries(LARGE)) {
  test(`must hold: ${name}, every comment edited (a hunk too large to align whole); the test calls only the tested function`, async () => {
    const d = await decided({ 'src/l.js': before }, { 'src/l.js': after, 'test/x.test.js': T_CALL });
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/l.js')]]);
  });
}

test('control: L5: the same large hunk of edited comments and a tested change in the tested function merges', async () => {
  const before = tagged(['export function t(x) {', '  return x + 1;', '}'], 'old') + pad('old', 70);
  const after = tagged(['export function t(x) {', '  return x + 2;', '}'], 'new') + pad('new', 70);
  const d = await decided({ 'src/l.js': before }, { 'src/l.js': after, 'test/x.test.js': calls('l.js', 't', 't(1)', '3') });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});

test('control: L1: a test that calls the function the guard was removed from still holds (a fail-closed false hold: the removed code holds `if`)', async () => {
  const [before, after] = LARGE['L1: one comment line added at the top, a guard removed from an untested function']!;
  const d = await decided({ 'src/l.js': before }, { 'src/l.js': after, 'test/x.test.js': calls('l.js', 'u', 'u({ ok: true })', '{ ok: true }') });
  assert.deepEqual([d.auto, d.reasons], [false, [ranNone('src/l.js')]]);
});

// ---- the reader refuses a request without the base its removed lines are read in

test('the coverage reader refuses a request without the base or the clone, never lexing removed lines out of their file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vac-r11-'));
  mkdirSync(join(dir, 'cov'));
  mkdirSync(join(dir, 'base'));
  const req = { coverageDir: join(dir, 'cov'), baselineDir: join(dir, 'base'), root: dir, appPaths: ['src/**'], only: ['src/a.js'], hunks: { 'src/a.js': [{ at: 1, added: [], removed: ['  check();'], from: 2, oldPath: 'src/a.js' }] } };
  const refused = { error: 'the coverage read was asked without the base to read removed lines in' };
  assert.deepEqual(await readTouchedInChild(req as unknown as TouchedRequest), refused);
  assert.deepEqual(await readTouchedInChild({ ...req, base: 'HEAD' } as unknown as TouchedRequest), refused);
  assert.deepEqual(await readTouchedInChild({ ...req, repo: dir } as unknown as TouchedRequest), refused);
});
