// #784 round 9 (the round-8 final check P1-P5, the second review S1-S3, R1 and a moved line): a change is measured at
// the characters it changed, from a character alignment of each hunk, never by its whole line. A shortened line, a
// line split by a formatter, a moved line, or a comment or blank line added beside a change each hold when the test only
// takes the other path; each control, where the test reaches the changed code, merges.
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
const ranNone = (test: string, app: string) => `design: vacuity: its tests (${test}) ran none of the app code it changes (${app})`;

/** Each: the file, before, after, a test that takes only the other path (holds), a test that reaches the change (merges). */
const CASES: Record<string, { file: string; before: string; after: string; hold: string; merge: string }> = {
  'S1: a ternary arm shortened (-x to 0)': {
    file: 'abs.js',
    before: 'export function abs(x) {\n  return x > 0 ? x : -x;\n}\n',
    after: 'export function abs(x) {\n  return x > 0 ? x : 0;\n}\n',
    hold: calls('abs.js', 'abs', 'abs(5)', '5'),
    merge: calls('abs.js', 'abs', 'abs(-5)', '0'),
  },
  'S2: a deny arm turned into a grant (shorter)': {
    file: 'gate.js',
    before: "export function grant(u) {\n  return 'granted ' + u.id;\n}\nexport function denyAndLog(u) {\n  return 'denied ' + u.id;\n}\nexport function decide(u) {\n  return u.admin ? grant(u) : denyAndLog(u);\n}\n",
    after: "export function grant(u) {\n  return 'granted ' + u.id;\n}\nexport function denyAndLog(u) {\n  return 'denied ' + u.id;\n}\nexport function decide(u) {\n  return u.admin ? grant(u) : grant(u);\n}\n",
    hold: calls('gate.js', 'decide', "decide({ admin: true, id: 1 })", "'granted 1'"),
    merge: calls('gate.js', 'decide', "decide({ admin: false, id: 1 })", "'granted 1'"),
  },
  'S3: an untaken if body shortened (100 to 0)': {
    file: 'clamp.js',
    before: 'export function clamp(x) {\n  if (x < 0) return 100;\n  return x;\n}\n',
    after: 'export function clamp(x) {\n  if (x < 0) return 0;\n  return x;\n}\n',
    hold: calls('clamp.js', 'clamp', 'clamp(5)', '5'),
    merge: calls('clamp.js', 'clamp', 'clamp(-5)', '0'),
  },
  'R1: a formatter splits a line that grew': {
    file: 'fee.js',
    before: 'export function fee(premium, base) {\n  return premium ? 0 : base / 10;\n}\n',
    after: 'export function fee(premium, base) {\n  return premium ? 0\n    : base / 100;\n}\n',
    hold: calls('fee.js', 'fee', 'fee(true, 50)', '0'),
    merge: calls('fee.js', 'fee', 'fee(false, 50)', '0.5'),
  },
  'a moved line, inside a branch the test never takes': {
    file: 'order.js',
    before: 'const log = [];\nexport function order(x) {\n  if (x < 0) {\n    log.push(1);\n    log.push(2);\n  }\n  return x;\n}\n',
    after: 'const log = [];\nexport function order(x) {\n  if (x < 0) {\n    log.push(2);\n    log.push(1);\n  }\n  return x;\n}\n',
    hold: calls('order.js', 'order', 'order(5)', '5'),
    merge: calls('order.js', 'order', 'order(-5)', '-5'),
  },
  'P1: an untaken if body (10 to 1)': {
    file: 'clamp.js',
    before: 'export function clamp(x) {\n  if (x < 0) return 10;\n  return x;\n}\n',
    after: 'export function clamp(x) {\n  if (x < 0) return 1;\n  return x;\n}\n',
    hold: calls('clamp.js', 'clamp', 'clamp(5)', '5'),
    merge: calls('clamp.js', 'clamp', 'clamp(-5)', '1'),
  },
  'P2: an untaken throw message shortened': {
    file: 'check.js',
    before: "export function check(ok) {\n  if (!ok) throw new Error('denied: not allowed');\n  return 'fine';\n}\n",
    after: "export function check(ok) {\n  if (!ok) throw new Error('no');\n  return 'fine';\n}\n",
    hold: calls('check.js', 'check', 'check(true)', "'fine'"),
    merge: `${H}import { check } from '../src/check.js';\ntest('check', () => { assert.throws(() => check(false), /no/); });\n`,
  },
  'P3: a ternary arm 0 - x to -x': {
    file: 'neg.js',
    before: 'export function neg(x) {\n  return x > 0 ? x : 0 - x;\n}\n',
    after: 'export function neg(x) {\n  return x > 0 ? x : -x;\n}\n',
    hold: calls('neg.js', 'neg', 'neg(5)', '5'),
    merge: calls('neg.js', 'neg', 'neg(-5)', '5'),
  },
  'P4: an untaken if body changed, a comment line added under it': {
    file: 'clamp.js',
    before: 'export function clamp(x) {\n  if (x < 0) return 0;\n  return x;\n}\n',
    after: 'export function clamp(x) {\n  if (x < 0) return -1;\n  // negatives map to -1\n  return x;\n}\n',
    hold: calls('clamp.js', 'clamp', 'clamp(5)', '5'),
    merge: calls('clamp.js', 'clamp', 'clamp(-5)', '-1'),
  },
  'P5: an untaken if body changed, a blank line added under it': {
    file: 'clamp.js',
    before: 'export function clamp(x) {\n  if (x < 0) return 0;\n  return x;\n}\n',
    after: 'export function clamp(x) {\n  if (x < 0) return -1;\n\n  return x;\n}\n',
    hold: calls('clamp.js', 'clamp', 'clamp(5)', '5'),
    merge: calls('clamp.js', 'clamp', 'clamp(-5)', '-1'),
  },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`must hold: ${name}: the test takes only the other path`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.hold });
    assert.deepEqual([d.auto, d.reasons], [false, [ranNone('test/x.test.js', `src/${c.file}`)]]);
  });
  test(`control: ${name}: a test that reaches the change merges`, async () => {
    const d = await decided({ [`src/${c.file}`]: c.before }, { [`src/${c.file}`]: c.after, 'test/x.test.js': c.merge });
    assert.deepEqual([d.auto, d.reasons], [true, []]);
  });
}
