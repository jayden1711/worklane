// #784 round 11 (the round-10 second review P1-P6, the final check H1, H2, J1-J3): a removal counts only when the code
// on BOTH its sides ran within the same innermost V8 range, and never when the removed code holds a construct that
// opens a sub-statement or a nested function (`if`, `for`, `while`, `=>`, ...). Each must-hold has a control where the
// test takes the changed path: those that merge say so; those that hold are fail-closed false holds, named in the body.
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
export async function decided(before: Record<string, string>, after: Record<string, string>, tune?: (dir: string) => void) {
  const dir = exampleProject().dir;
  tune?.(dir);
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

const GUARD = "export function guard(u) {\n  if (u.guest) throw new Error('denied');\n  return 'ok';\n}\n";
const SAVE = "export function save(xs) {\n  for (const x of xs) audit(x);\n  return xs.length;\n}\nfunction audit(x) {\n  if (!x.ok) throw new Error('bad');\n}\n";
const START = "export function run(job, onFail) {\n  if (job.bad && onFail) onFail();\n  return job.id;\n}\nexport function start(job) {\n  return run(job, () => rollback(job));\n}\nfunction rollback(job) {\n  job.rolled = true;\n}\n";
const COUNT = "export function count(xs) {\n  let n = 0;\n  for (const x of xs) {\n    if (x.drop) continue;\n    n++;\n  }\n  return n;\n}\n";
const TRIM = "export function trim(q) {\n  while (q.length > 3) q.shift();\n  return q.length;\n}\n";
const LINE = "const log = [];\nexport function guard(u) {\n  log.push(u); if (u.guest) throw new Error('denied');\n  return 'ok';\n}\n";
const H1 = 'export function f(x) {\n  if (x) return g;\n  audit();\n  function g() {\n    return 1;\n  }\n  return null;\n}\nfunction audit() {}\n';
const H2 = 'export const seen = [];\nseen.push(1);\nfunction g() {\n  return 1;\n}\nexport const api = () => g();\n';
const J1 = 'export function f(xs) {\n  let n = 0;\n  for (const x of xs) {\n    if (x) continue;\n    n += 1;\n  }\n  return n;\n}\n';
const J2 = 'export function f(u) {\n  if (u.a) {\n    if (u.b) return 1;\n    check(u); }\n  return 0;\n}\nfunction check() {}\n';
const J3 = 'export function f(xs) {\n  for (const x of xs) {\n    if (x) {\n      return 1;\n    }\n    audit(x);\n  }\n  return 0;\n}\nfunction audit() {}\n';

/**
 * Each: the file, before, after, a test that never reaches the removed code (holds), and a control that takes the
 * changed path, with what it gets now: 'merges', or 'holds' (a fail-closed false hold, by design).
 */
const CASES: Record<string, { file: string; before: string; after: string; hold: string; control: string; controlGets: 'merges' | 'holds' }> = {
  'P1: a braceless guard removed': { file: 'g.js', before: GUARD, after: GUARD.replace("  if (u.guest) throw new Error('denied');\n", ''), hold: calls('g.js', 'guard', 'guard({})', "'ok'"), control: calls('g.js', 'guard', 'guard({ guest: true })', "'ok'"), controlGets: 'holds' },
  'P2: a braceless for body removed': { file: 's.js', before: SAVE, after: SAVE.replace('  for (const x of xs) audit(x);\n', ''), hold: calls('s.js', 'save', 'save([])', '0'), control: calls('s.js', 'save', 'save([{ ok: true }])', '1'), controlGets: 'holds' },
  'P3: a concise-arrow callback removed': { file: 'r.js', before: START, after: START.replace(', () => rollback(job)', ''), hold: calls('r.js', 'start', 'start({ id: 1 })', '1'), control: calls('r.js', 'start', 'start({ id: 1, bad: true })', '1'), controlGets: 'holds' },
  'P4: a braceless `continue` guard removed': { file: 'c.js', before: COUNT, after: COUNT.replace('    if (x.drop) continue;\n', ''), hold: calls('c.js', 'count', 'count([{}])', '1'), control: calls('c.js', 'count', 'count([{ drop: true }])', '1'), controlGets: 'holds' },
  'P5: a braceless while loop removed': { file: 'q.js', before: TRIM, after: TRIM.replace('  while (q.length > 3) q.shift();\n', ''), hold: calls('q.js', 'trim', 'trim([1])', '1'), control: calls('q.js', 'trim', 'trim([1, 2, 3, 4, 5])', '5'), controlGets: 'holds' },
  'P6: a braceless guard removed at a line end': { file: 'g.js', before: LINE, after: LINE.replace(" if (u.guest) throw new Error('denied');", ''), hold: calls('g.js', 'guard', 'guard({})', "'ok'"), control: calls('g.js', 'guard', 'guard({ guest: true })', "'ok'"), controlGets: 'holds' },
  'H1: removed before a hoisted function, after an early return': { file: 'h1.js', before: H1, after: H1.replace('  audit();\n', ''), hold: calls('h1.js', 'f', 'f(true)()', '1'), control: calls('h1.js', 'f', 'f(false)', 'null'), controlGets: 'holds' },
  'H2: a top-level statement (only loading runs it) removed before a function': { file: 'h2.js', before: H2, after: H2.replace('seen.push(1);\n', ''), hold: calls('h2.js', 'api', 'api()', '1'), control: calls('h2.js', 'seen', 'seen.length', '0'), controlGets: 'holds' },
  'J1: removed after `if (x) continue;`': { file: 'j1.js', before: J1, after: J1.replace('    n += 1;\n', ''), hold: calls('j1.js', 'f', 'f([true])', '0'), control: calls('j1.js', 'f', 'f([false])', '0'), controlGets: 'holds' },
  'J2: removed at a line start after `if (b) return`, before `}`': { file: 'j2.js', before: J2, after: J2.replace('    check(u); }\n', '    }\n'), hold: calls('j2.js', 'f', 'f({ a: true, b: true })', '1'), control: calls('j2.js', 'f', 'f({ a: true, b: false })', '0'), controlGets: 'holds' },
  'J3: removed after a braced if that returns, at the end of a loop body': { file: 'j3.js', before: J3, after: J3.replace('    audit(x);\n', ''), hold: calls('j3.js', 'f', 'f([true])', '1'), control: calls('j3.js', 'f', 'f([false])', '0'), controlGets: 'holds' },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`must hold: ${name}: the test never reaches the removed code`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.hold });
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone(`src/${c.file}`)]]);
  });
  test(`control: ${name}: a test that takes the changed path ${c.controlGets === 'merges' ? 'merges' : 'still holds (a fail-closed false hold)'}`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.control });
    assert.deepEqual([d.auto, d.reasons], c.controlGets === 'merges' ? [true, []] : [false, [ranNone(`src/${c.file}`)]]);
  });
}

test('control: a plain statement removed between two statements of one block a test runs merges', async () => {
  const f = "const seen = [];\nexport function access(u) {\n  if (u.admin) {\n    const id = u.id;\n    seen.push(u);\n    return 'all ' + id;\n  }\n  return 'some';\n}\n";
  const d = await decided({ 'src/a.js': f }, { 'src/a.js': f.replace('    seen.push(u);\n', ''), 'test/x.test.js': calls('a.js', 'access', '{ v: access({ admin: true, id: 1 }) }', "{ v: 'all 1' }") });
  assert.deepEqual([d.auto, d.reasons], [true, []]);
});
