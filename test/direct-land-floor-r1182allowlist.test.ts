// #1182, the allowlist (the owner, 2026-11-11): end to end, with the note kinds the coordinator records. A reply is the
// comment's one line, `/worklane <option> <id> [note]`, the note in letters, digits, spaces and . , : ; - (no apostrophe:
// "1182 allowlist: yes (no apostrophe)"); only an open decision's id counts as a second id ("1182 dword: b"); the
// allowlist is on the typed text, and GitHub's body_text is read only for an open id or a second command ("1182 fv: b").
// Fixture copied from attack-1182al.test.ts (as in r1182akal); non-ASCII as \u escapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = () =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: [] } });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182al-'));
  const repo = join(base, 'clone');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const cfg = loadConfig(repo);
  cfg.project.land_mode = 'direct';
  cfg.review = REVIEW();
  const slotsDir = join(base, 'slots');
  mkdirSync(slotsDir);
  writeFileSync(join(slotsDir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir, { recursive: true });
  const backlog = new FileBacklog(join(base, 'backlog.json'), 'coordinator');
  backlog.open({ title: 't', body: 'x', author: 'example-owner', labels: ['ready'] });
  backlog.open({ title: 't2', body: 'x', author: 'example-owner', labels: ['ready'] });
  return { base, repo, cfg, backlog, log: new EventLog(join(base, 'events.db')), slotsDir, stateDir };
}
type Fixture = ReturnType<typeof fixture>;
const coord = (f: Fixture) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: new FakeRunner(() => ({ structured: {} })), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });

const CMD = /^\/worklane\s+(\S+)/m;
const LAND = ['approve', 'reject'];
const PLAN = ['approve', 'revise', 'reject'];
type Answer = { by: string; answer: string; role: string } | null;
type Q = EventPayload<'decision.asked'>;
const commentAnswer = (f: Fixture, q: Q, n = 1): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: Q, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(n, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
const ask = async (f: Fixture, kind: string, options: string[], question = 'Land?', issue = 1): Promise<Q> => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, issue, 'example-owner', question, options, '', ['x']);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as Q).find((x) => x.id === id)!;
};
const notes = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).filter((p) => p.kind.startsWith('reply_'));
const handle = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const answered = (f: Fixture) => f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>);
const queued = (f: Fixture) => f.log.read(0, ['land.queued']).length;
const levelL3 = (f: Fixture) => f.log.append('review.level_set', { issue: 1, head: 'a'.repeat(40), level: 'L3', reasons: ['high-risk: ci-config (.gitlab-ci.yml): held for the owner'] }, 'alice');
const OWNER = 'example-owner';
const QL3 = async (f: Fixture) => { levelL3(f); return ask(f, 'land', LAND, 'Approve landing #1 (L3)?'); };
const land = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await QL3(f);
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return { f, q };
};
const planNote = async (body: (id: string) => string) => {
  const f = fixture();
  const q = await ask(f, 'plan', PLAN, 'Approve the plan for #1?');
  f.backlog.humanComment(1, OWNER, body(q.id));
  await handle(f);
  return f.log.read(0, ['plan.decided']).map((e) => e.payload as EventPayload<'plan.decided'>);
};
const strike = (s: string) => [...s].map((x) => x + '\u0336').join('');
const under = (s: string) => [...s].map((x) => x + '\u0331').join('');


const kinds = (f: Fixture) => notes(f).map((n) => n.kind);
const landWith = async (body: (id: string) => string, text?: (id: string) => string | null) => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, body(q.id));
  if (text) f.backlog.setCommentText(1, c, text(q.id));
  await handle(f);
  return { f, q };
};

// ======== The allowlist (the owner, 2026-11-11: "1182 allowlist: yes (no apostrophe)") ========
test('a reply is the one line `/worklane <option> <id> [note]`, the note in letters, digits, spaces and . , : ; -', async () => {
  for (const b of [(id: string) => `/worklane approve ${id}`, (id: string) => `/worklane approve ${id}, ok: 2 of 2 checks green - fine.`, (id: string) => `/WORKLANE APPROVE ${id.toUpperCase()}\n\n`]) {
    const { f } = await landWith(b);
    assert.deepEqual([answered(f)[0]?.answer, queued(f), kinds(f)], ['approve', 1, []], b('ID'));
  }
});
test('anything else voids, with one note naming why: another line, a character outside the list, the wrong shape', async () => {
  for (const [b, kind, re] of [
    [(id: string) => `/worklane approve ${id}\nthanks`, 'reply_not_one_line', /more than one line/],
    [(id: string) => `Looks right.\n/worklane approve ${id}`, 'reply_not_one_line', /more than one line/],
    [(id: string) => `/worklane approve ${id} don't wait`, 'reply_not_plain', /U\+0027 on line 1/],
    [(id: string) => `/worklane approve ${id} see #12`, 'reply_not_plain', /U\+0023 on line 1/],
    [(id: string) => `/worklane approve ${id} caf\u00E9`, 'reply_not_plain', /U\+00E9 on line 1/],
    [(id: string) => `/worklane approve not yet ${id}`, 'reply_shape', /the option, then the id right after it/],
    [(id: string) => `/worklane ${id} approve`, 'reply_shape', /the option, then the id right after it/],
  ] as [(id: string) => string, string, RegExp][]) {
    const { f } = await landWith(b);
    assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, [kind]], b('ID'));
    assert.match(notes(f)[0]!.message, re);
  }
});
test('an unknown id, or an option the decision lacks, voids with its own note', async () => {
  const a = await landWith(() => '/worklane approve d-1-0badid');
  assert.deepEqual(kinds(a.f), ['reply_unknown_id']);
  const b = await landWith((id) => `/worklane revise ${id}`);
  assert.deepEqual(kinds(b.f), ['reply_unknown_option']);
});
test('a comment that names neither the command nor an open id gets no note (discussion stays quiet)', async () => {
  const { f } = await landWith(() => 'Looks fine to me, see the run.\nMore later.');
  assert.deepEqual(kinds(f), []);
});

// ======== "1182 dword: b": only an open decision's id counts as a second id ========
test('"1182 dword: b": a d-word in the note is fine; an open decision\'s id in it voids', async () => {
  const ok = await landWith((id) => `/worklane approve ${id} after d-day, and drop d-bus`);
  assert.deepEqual([answered(ok.f)[0]?.answer, kinds(ok.f)], ['approve', []]);
  const again = await landWith((id) => `/worklane approve ${id} as in ${id}`);
  assert.deepEqual([answered(again.f).length, kinds(again.f)], [0, ['reply_several_ids']]);
  const f = fixture();
  const a = await QL3(f);
  const b = await ask(f, 'land', LAND, 'Other?');
  f.backlog.humanComment(1, OWNER, `/worklane approve ${a.id} and ${b.id}`);
  await handle(f);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_several_ids']]);
});

// ======== "1182 fv: b": the allowlist is on the typed text; body_text only for an open id or a second command ========
test('"1182 fv: b": a :tada: in the note that GitHub draws as an emoji does not void the reply', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id} thanks :tada:`, (id) => `/worklane approve ${id} thanks \u{1F389}`);
  assert.deepEqual([answered(f)[0]?.answer, queued(f), kinds(f)], ['approve', 1, []]);
});
test('"1182 fv: b": body_text showing a second command, or an open id again, voids (reply_rendering_shows_more)', async () => {
  // The second command without the id, too: it is the command that counts, not only the id.
  for (const text of [(id: string) => `/worklane approve ${id} ok\n/worklane reject ${id}`, (id: string) => `/worklane approve ${id} ok\n/worklane reject`, (id: string) => `/worklane approve ${id} ok ${id}`]) {
    const { f } = await landWith((id) => `/worklane approve ${id} ok`, text);
    assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, ['reply_rendering_shows_more']]);
  }
  const plain = await landWith((id) => `/worklane approve ${id} ok`, (id) => `/worklane approve ${id} ok`);
  assert.equal(answered(plain.f)[0]?.answer, 'approve', 'control: the same line answers');
});
