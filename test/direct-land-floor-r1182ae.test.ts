// The allowlist (#1182, the owner, 2026-11-11) replaced the earlier reply rules and their note kinds. In this ported
// file every reply note reads as kind 'reply_note': each case still asserts what it answers (nothing, here, unless
// marked) and how many notes it gets; the new kinds are pinned in decision-reply.test.ts and -r1182allowlist.test.ts.
// R1182ae (final) on #1182 at 386b40e8, ported. AE1: the plan question's revise instruction names the decision's id
// (src/plan-mode.ts DECISION_ID, put in by ask()), and so does the dashboard's revise text. AE2: a fence closes only on
// spaces or tabs after it; a fence inside a list item opens and closes there; a <style> block is never read. AE3: an id
// before the option, and a command in a list item, answer nothing with one note. Assertions unchanged, except the AC1
// header comment and import (left over from the file this was built on) are dropped, and AE3's title says "with a note".
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
import { EventLog } from '../src/events/log.js';
import { optionEffect } from '../src/decision-effects.js';
import { planDecision } from '../src/plan-mode.js';
import type { EventPayload } from '../src/events/types.js';
import { DEFAULT_COMMIT_IDENTITY, FakeRunner, type RunRequest } from '../src/runner.js';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = !which('gitleaks') && 'gitleaks not installed';
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const REVIEW = () =>
  ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['app-non-money'], max_lines: 100000 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } }, merge: { wait_categories: [] } });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'r1182z-'));
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
  for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']]) git(repo, 'config', k!, v!);
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
const ISSUE = 'Totals count non-positive quantities.\n\n```done_when\n- test: test/price.test.js\n```\n';
const CI = 'test: { script: [echo ok] }\n';
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
const coord = (f: Fixture, extra: Record<string, string> = {}) =>
  new Coordinator({ cfg: f.cfg, log: f.log, backlog: f.backlog, runner: runner(extra), repo: f.repo, instance: 'alice', stateDir: f.stateDir, slotsDir: f.slotsDir, maxAttempts: 1, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
async function cycle(f: Fixture, extra: Record<string, string> = {}) {
  const c = coord(f, extra);
  await c.tick();
  await c.idle();
}
const asked = (f: Fixture) => f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).filter((q) => q.kind === 'land');
const blobOnMain = (f: Fixture, p: string) => {
  try {
    return git(f.base, '--git-dir', f.remote, 'cat-file', '-p', `main:${p}`);
  } catch {
    return null;
  }
};
const errors = (f: Fixture) => f.log.read(0, ['coordinator.error']).map((e) => e.payload as { kind: string; message: string }).map((p) => (/^reply_/.test(p.kind) ? { ...p, kind: 'reply_note' } : p));
/** Edit a comment in place, as GitHub does: same author, same place, same created_at; the body changes, and it reads as edited. */
async function editComment(f: Fixture, n: number, match: (b: string) => boolean, body: (b: string) => string) {
  const hits = (await f.backlog.comments(n)).filter((c) => match(c.body));
  assert.equal(hits.length, 1, 'control: exactly one comment edited');
  f.backlog.editComment(n, hits[0]!.id!, body(hits[0]!.body));
}
const deleteComment = (f: Fixture, n: number, match: (b: string) => boolean) => {
  const p = join(f.base, 'backlog.json');
  const j = JSON.parse(readFileSync(p, 'utf8'));
  for (const i of j.issues) if (i.number === n) i.comments = i.comments.filter((c: { body: string }) => !match(c.body));
  writeFileSync(p, JSON.stringify(j));
};

const OPTS = ['approve', 'reject'];
const CMD = /^\/worklane\s+(\S+)/m;
type Answer = { by: string; answer: string; role: string } | null;
const commentAnswer = (f: Fixture, q: EventPayload<'decision.asked'>): Promise<Answer> =>
  (coord(f) as unknown as { commentAnswer(n: number, q: EventPayload<'decision.asked'>, w: Set<string>, c: RegExp): Promise<Answer> }).commentAnswer(1, q, new Set(f.cfg.project.owners.writers.map((w) => w.toLowerCase())), CMD);
/** A question exactly as ask() posts it (src/coordinator/base.ts at 48dacc40), through the coordinator itself. */
const ask = async (f: Fixture, kind = 'land') => {
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask(kind, 1, 'example-owner', 'Land?', OPTS, 'reject', ['x']);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === id)!;
};
const unit = () => {
  const f = fixture();
  f.backlog.open({ title: 't', body: ISSUE, author: 'example-owner', labels: ['ready'] });
  return f;
};


const handleDecisions = (f: Fixture) => (coord(f) as unknown as { handleDecisions(): Promise<void> }).handleDecisions();
const answeredOf = (f: Fixture, id: string) => f.log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((x) => x.id === id)?.answer ?? null;
const answerOnDashboard = (f: Fixture, id: string, answer: string) => f.log.append('decision.answered', { id, by: 'example-owner', answer, role: 'owner' }, 'example-owner', 'human');


// R1182ae probes. A DEFECT test asserts the safe or consistent outcome, so it fails at 386b40e8; each has a control.

/** The plan question exactly as the coordinator asks it: planDecision's question, options and receipts, through ask(). */
const askPlan = async (f: Fixture) => {
  const d = planDecision(['high-risk: ci-config (.gitlab-ci.yml)']);
  const c = coord(f) as unknown as { ask(k: string, i: number, o: string, q: string, opts: string[], rec: string, detail: string[]): Promise<string> };
  const id = await c.ask('plan', 1, 'example-owner', d.question, d.options, d.recommendation, d.receipts);
  return f.log.read(0, ['decision.asked']).map((e) => e.payload as EventPayload<'decision.asked'>).find((x) => x.id === id)!;
};

test('AE1 control: `/worklane revise <id> <note>` on the plan question answers revise', async () => {
  const f = unit();
  const plan = await askPlan(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane revise ${plan.id} split it in two`);
  assert.equal((await commentAnswer(f, plan))?.answer, 'revise');
});

test('AE1 (stale instruction): the plan question must not tell the owner to reply `/worklane revise <note>` without the id; following it answers nothing', async () => {
  const f = unit();
  const plan = await askPlan(f);
  const body = (await f.backlog.comments(1)).find((c) => c.body.includes(plan.id))!.body;
  f.backlog.humanComment(1, 'example-owner', '/worklane revise split it in two'); // exactly as the receipt line says
  const got = await commentAnswer(f, plan);
  const notes = errors(f).filter((e) => e.kind === 'reply_note').length;
  assert.ok(!/reply `\/worklane revise <note>`/.test(body), `STALE INSTRUCTION: the question says "reply \`/worklane revise <note>\`" (no id); following it gives answer=${JSON.stringify(got)} and ${notes} reply_without_id note(s). Question body:\n${body}`);
});

// Rendered as code by a CommonMark renderer (markdown-it-py, commonmark preset: parser-probe.py), read by commandLines.
const codeShown: [string, (id: string) => string][] = [
  ['NBSP after a closing fence (CommonMark allows only spaces or tabs)', (id) => `\`\`\`\nquoted\n\`\`\` \n/worklane approve ${id}\n\`\`\``],
  ['a fence inside a list item shifts the fence state', (id) => `- \`\`\`\n  \`\`\`\n\`\`\`\n/worklane approve ${id}\n\`\`\``],
  ['a <style> block (GitHub drops it, so the line is never shown)', (id) => `<style>\n/worklane approve ${id}\n</style>`],
];
test('AE2 control: the same command in a plain fence is not read', async () => {
  const f = unit();
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `\`\`\`\n/worklane approve ${land.id}\n\`\`\``);
  assert.equal(await commentAnswer(f, land), null);
});
for (const [name, body] of codeShown) {
  test(`AE2 (minor, ${name}): a command the comment shows as code (or not at all) must not answer`, async () => {
    const f = unit();
    const land = await ask(f);
    f.backlog.humanComment(1, 'example-owner', body(land.id));
    const got = await commentAnswer(f, land);
    assert.equal(got, null, `CODE READ: ${JSON.stringify(got)}`);
  });
}

test('AE3 (liveness): the id before the option (`/worklane <id> approve`) answers nothing, with a note', async () => {
  const f = unit();
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane ${land.id} approve`);
  const got = await commentAnswer(f, land);
  const notes = errors(f).filter((e) => /^reply_/.test(e.kind)).length;
  assert.equal(got, null, 'never an answer (held)');
  assert.ok(notes > 0, `SILENT: no answer and ${notes} notes`);
});

test('AE4 (held): the decision id inside a longer token, after a letter or before more word characters, is no id', async () => {
  const f = unit();
  const land = await ask(f);
  for (const b of [`/worklane approve x${land.id}`, `/worklane approve ${land.id}0`, `/worklane approve ${land.id}_x`, `/worklane approve ${land.id.slice(0, -1)}`]) f.backlog.humanComment(1, 'example-owner', b);
  assert.equal(await commentAnswer(f, land), null);
});

test('AE5 (held): a look-alike of the id with a soft hyphen or a two-em dash is no id (fails closed, with a note)', async () => {
  const f = unit();
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${land.id.replace('-', '­-')}`);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${land.id.replace('-', '⸺')}`);
  assert.equal(await commentAnswer(f, land), null);
  assert.ok(errors(f).some((e) => /^reply_/.test(e.kind)));
});

test('AE6 (held): `[worklane]` after leading whitespace is still skipped; `[Worklane]` (not the coordinator\'s form) is read', async () => {
  const f = unit();
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `  \n[worklane] note\n/worklane approve ${land.id}`);
  assert.equal(await commentAnswer(f, land), null);
  f.backlog.humanComment(1, 'example-owner', `[Worklane] mine\n/worklane reject ${land.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it): the reject is line 2, so it answers nothing (was 'reject'); the comment is still read (its note shows it).
  assert.equal(await commentAnswer(f, land), null);
  assert.deepEqual(errors(f).filter((e) => /^reply_/.test(e.kind)).map((e) => e.kind), ['reply_note']);
});

test('AE7 (held): two commands in one comment answer nothing, one note each (changed by (b); was: the last named line wins)', async () => {
  const f = unit();
  const land = await ask(f);
  const other = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve ${land.id}\n/worklane reject ${land.id}`);
  f.backlog.humanComment(1, 'example-owner', `/worklane approve\n/worklane approve ${land.id} ${other.id}`);
  // changed by (b) (the owner, 2026-11-10: only a comment's first line is read, in plain text; a second command voids it): both comments hold two commands, so neither answers (was 'reject' for land), one note each (was one
  // reply_several_ids).
  assert.equal(await commentAnswer(f, land), null);
  assert.equal(await commentAnswer(f, other), null);
  const notes = errors(f).filter((e) => /^reply_/.test(e.kind));
  assert.deepEqual(notes.map((n) => n.kind), ['reply_note', 'reply_note'], JSON.stringify(notes));
});

test('AE1 (dashboard): the plan revise text names the id, and the question names this decision\'s', async () => {
  assert.doesNotMatch(optionEffect('plan', 'revise').does, /revise <note>/, 'no bare revise instruction');
  assert.match(optionEffect('plan', 'revise').does, /revise <decision id> <note>/);
  const f = unit();
  const plan = await askPlan(f);
  const body = (await f.backlog.comments(1)).find((c) => c.body.includes(plan.id))!.body;
  assert.ok(body.includes(`comment the one line \`/worklane revise ${plan.id} <note>\` and nothing else`), body); // changed by the allowlist (#1182, the owner, 2026-11-11: a reply is the comment's one line)
  assert.ok(plan.receipts.some((r) => r.includes(`revise ${plan.id} <note>`)), 'the recorded receipt (the dashboard) too');
});

test('AE3b (liveness): a command in a list item answers nothing, with one note (reply_not_first_line under (b))', async () => {
  const f = unit();
  const land = await ask(f);
  f.backlog.humanComment(1, 'example-owner', `- /worklane approve ${land.id}`);
  assert.equal(await commentAnswer(f, land), null);
  assert.deepEqual(errors(f).filter((e) => /^reply_/.test(e.kind)).map((e) => e.kind), ['reply_note']);
});
