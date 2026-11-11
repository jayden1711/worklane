// #1182, the structural fix after R1182ao/ap (the organizer, 2026-11-11): the reply reader also checks the tracker's own
// rendering of each comment as text, GitHub's body_text (asked for with Accept: application/vnd.github.full+json). The
// ASCII rule, rule (c) and the second-command scan run on it as well as on the body and its readings; any reading that
// fires voids. Missing or null body_text is unknown, and the comment is judged as before. Measured (gh api, issue 533):
// body_text leaves out an image's alt text, so the alt and title reading stays. Not measured: whether body_text keeps
// bidi controls (no existing comment holds one, and nothing was posted); the bidi checks stay either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog } from '../src/backlog/github.js';
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
/** The owner's comment, with the tracker's rendering of it (GitHub's body_text) set as given. */
const landWith = async (body: (id: string) => string, text: (id: string) => string | null) => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, body(q.id));
  f.backlog.setCommentText(1, c, text(q.id));
  await handle(f);
  return { f, q };
};

// ======== The tracker's own rendering (GitHub's body_text) is read too: any reading that fires voids ========
test('body_text that shows a live id none of the readings find voids (reply_id_elsewhere)', async () => {
  // The body as typed holds the id once (the slot); the tracker's rendering shows it twice.
  const { f } = await landWith((id) => `/worklane approve ${id}\nsee the plan`, (id) => `/worklane approve ${id}\nsee the plan ${id}`);
  assert.deepEqual([answered(f).length, queued(f), kinds(f)], [0, 0, ['reply_id_elsewhere']]);
});
test('body_text that shows a second command voids (reply_more_than_one)', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id}\nok`, (id) => `/worklane approve ${id}\n/worklane reject ${id}`);
  assert.equal(answered(f).length, 0);
  assert.equal(kinds(f).length, 1);
});
test('body_text holding a character outside plain ASCII voids (reply_not_ascii, naming it)', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id}\nok`, (id) => `/worklane approve ${id}\nok \u202E`);
  assert.deepEqual([answered(f).length, kinds(f)], [0, ['reply_not_ascii']]);
  // R1182aq D1: a rendering-only character is named as such, with its line in the rendering (no shortcode here).
  assert.match(notes(f)[0]!.message, /in GitHub's rendering of it \(U\+202E on line 2 of the rendering;/);
});
test('body_text that matches the body (the id once, in the slot) answers', async () => {
  const { f } = await landWith((id) => `/worklane approve ${id}\nlooks *good*`, (id) => `/worklane approve ${id}\nlooks good`);
  assert.deepEqual([answered(f)[0]?.answer, queued(f), kinds(f)], ['approve', 1, []]);
});
test('body_text missing or null fails closed: judged on the body and its readings alone, as before', async () => {
  for (const text of [null, undefined]) {
    const ok = await landWith((id) => `/worklane approve ${id}`, () => text as string | null);
    assert.equal(answered(ok.f)[0]?.answer, 'approve', `${text}: a good reply still answers`);
    // changed by the character rule (R1182as/at, the organizer, 2026-11-11: no backtick, <, >, $, & or ~ anywhere): an entity now voids first (reply_markup), so the readings are tested with an emphasis-split id instead.
    const bad = await landWith((id) => `/worklane approve ${id}\nreject *d*${id.slice(1)}`, () => text as string | null);
    assert.deepEqual([answered(bad.f).length, kinds(bad.f)], [0, ['reply_id_elsewhere']], `${text}: the readings still void`);
  }
});
test('an edit makes the stored rendering unknown (FileBacklog): the edited comment is judged on its body', async () => {
  const f = fixture();
  const q = await QL3(f);
  const c = f.backlog.humanComment(1, OWNER, `/worklane approve ${q.id}`);
  f.backlog.setCommentText(1, c, `/worklane approve ${q.id}\n${q.id}`);
  f.backlog.editComment(1, c, `/worklane approve ${q.id}`);
  await handle(f);
  assert.equal(answered(f)[0]?.answer, 'approve');
});

// ======== The GitHub backlog asks for body_text and passes it on ========
test('GitHubBacklog.comments asks with Accept: application/vnd.github.full+json and returns body_text as text (null when missing)', async () => {
  const seen: string[] = [];
  const f = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string> | undefined)?.accept));
    const rows = [
      { id: 1, user: { login: OWNER }, body: '/worklane approve d-1-abcdef', body_text: '/worklane approve d-1-abcdef', created_at: '2026-11-09T01:00:00Z' },
      { id: 2, user: { login: OWNER }, body: 'no text given', created_at: '2026-11-09T01:01:00Z' },
      { id: 3, user: { login: OWNER }, body: 'a number', body_text: 7, created_at: '2026-11-09T01:02:00Z' },
    ];
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const list = await new GitHubBacklog('o/r', () => 't', f).comments(1);
  assert.deepEqual(seen, ['application/vnd.github.full+json']);
  assert.deepEqual(list.map((c) => c.text), ['/worklane approve d-1-abcdef', null, null]);
});
