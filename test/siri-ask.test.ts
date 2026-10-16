// "Hey Siri, ask" on the coordinator's side (src/siri/ask.ts, src/coordinator/siri.ts), what Siri may say
// (src/siri/speech.ts), the token store (src/siri/tokens.ts) and the Shortcuts' sources (scripts/siri-shortcuts.mjs):
// the answer's run has no tools, no repository and a viewer's view only; it stays within Siri's own cap and the daily
// budget; what is spoken is cut to plain text in code; the Shortcut files hold no address, token, name or contact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { answerSiri, SIRI_BUDGET, SIRI_CAPPED, SIRI_OFF, SIRI_PAUSED, type SiriDeps } from '../src/coordinator/siri.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig } from '../src/intake/report.js';
import { RESEARCH_LANE } from '../src/research.js';
import { FakeRunner, type RunRequest } from '../src/runner.js';
import { askSiri, siriAnswer, SIRI_DENIED, siriAskRun, viewerState } from '../src/siri/ask.js';
import { SPEECH_MAX, toSpeech } from '../src/siri/speech.js';
import { createDevice, RateLimits, verifyToken } from '../src/siri/tokens.js';
import { repoRoot } from './helpers.js';

const ON = IntakeConfig.parse({ version: 1, siri: { enabled: true } });

/** A log with what a viewer may see, and what they may not (costs, runs, intake words, chat). */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'siri-ask-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', { issue: 4, title: 'Show tax on the totals page', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: 'opened by writer' }, 'c');
  log.append('decision.asked', { id: 'd-1', kind: 'question', issue: 4, owner: 'example-owner', question: 'Ship the totals change?', options: ['approve', 'reject'], recommendation: 'approve', receipts: ['holds because PRIVATE-RECEIPT'] }, 'c');
  // WHY: a cost no timestamp or id can hold by chance (#546: '3.21' matched an event time like 12:00:13.215Z).
  log.append('run.cost', { issue: 4, role: 'worker', model: 'opus', usd: 987654.32, turns: 9 }, 'c');
  log.append('run.started', { issue: 4, role: 'worker', model: 'opus', worktree: '/srv/example/PRIVATE-WORKTREE', pid: 1, pgid: 1, attempt: 1 }, 'c');
  log.append('intake.received', { id: 'r1', source: 'discord', sender: 'abc', excerpt: 'PRIVATE-INTAKE-WORDS from a customer' }, 'c');
  return { dir, log };
}

function deps(o: Partial<SiriDeps> & Pick<SiriDeps, 'log' | 'stateDir' | 'runner'>): SiriDeps {
  const root = mkdtempSync(join(tmpdir(), 'siri-root-'));
  return { instance: 'example', intake: () => ON, instanceRoot: root, gid: process.getgid?.() ?? 0, budgetLeft: () => 10, held: () => null, cost: (r) => o.log.append('run.cost', { issue: null, role: 'siri', model: r.model, usd: r.costUsd, turns: r.turns }, 'c'), ...o };
}

test("the answer's run: no tools at all, the research lane (no repository), an empty working directory, a viewer's state only", async () => {
  const { dir, log } = seeded();
  const stateDir = join(dir, 'state');
  const runner = new FakeRunner(() => ({ structured: { answer: 'One decision waits: ship the totals change.' } }));
  const repo = join(dir, 'checkout');
  mkdirSync(repo);
  const q = askSiri({ stateDir, device: 'abcdefghij', question: 'what waits for me?' });
  await answerSiri(deps({ log, stateDir, runner }), { v: 1, id: q.id, at: '', device: 'abcdefghij', question: 'what waits for me?' });
  assert.equal(runner.calls.length, 1);
  const req = runner.calls[0]! as RunRequest;
  assert.deepEqual(req.allowedTools, [], 'no tool is allowed');
  for (const t of ['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'Task', 'mcp__*']) assert.ok(req.disallowedTools!.includes(t), t);
  assert.equal(req.lane, RESEARCH_LANE, 'the lane with no repository access');
  assert.ok(!req.cwd.startsWith(repo), 'never the checkout');
  assert.deepEqual(readdirSync(req.cwd), ['README.md'], 'an empty bundle');
  assert.equal(req.role, 'siri');
  assert.equal(req.interactive, true, 'someone is listening: it does not queue behind agent runs');
  assert.equal(req.model, 'haiku');
  // What it knows: a viewer's view. Never costs, runs, worktrees, intake words or decision receipts.
  assert.match(req.prompt, /Show tax on the totals page/);
  assert.match(req.prompt, /Ship the totals change\?/);
  for (const secret of ['987654', 'PRIVATE-WORKTREE', 'PRIVATE-INTAKE-WORDS', 'PRIVATE-RECEIPT', 'opus']) assert.ok(!req.prompt.includes(secret), secret);
  assert.deepEqual(siriAnswer(stateDir, q.id), { v: 1, id: q.id, at: siriAnswer(stateDir, q.id)!.at, device: 'abcdefghij', state: 'answered', speech: 'One decision waits: ship the totals change.' });
  assert.equal(log.read(0, ['run.cost']).filter((e) => (e.payload as { role: string }).role === 'siri').length, 1, 'its cost is recorded as siri');
});

test('the spec itself: siriAskRun never allows a tool, and viewerState is built from the viewer allowlist only', () => {
  const spec = siriAskRun({ bundleDir: '/x', model: 'haiku', state: 's', question: 'q', maxBudgetUsd: 0.1 });
  assert.deepEqual(spec.allowedTools, []);
  assert.deepEqual(spec.disallowedTools, [...SIRI_DENIED]);
  assert.equal(spec.lane, RESEARCH_LANE);
  const { log } = seeded();
  const s = viewerState(log.read(), 'example');
  assert.doesNotMatch(s, /PRIVATE|987654|opus/);
  assert.match(s, /#4 .*Show tax on the totals page/);
});

test('refused aloud, with no run: Siri off, agents held, over the Siri cap, over the daily budget; a failed run says so too', async () => {
  const { dir, log } = seeded();
  const stateDir = join(dir, 'state');
  const runner = new FakeRunner(() => ({ structured: { answer: 'x' } }));
  const ask = async (d: Partial<SiriDeps>) => {
    const q = askSiri({ stateDir, device: 'abcdefghij', question: 'how is it going?' });
    await answerSiri(deps({ log, stateDir, runner, ...d }), { v: 1, id: q.id, at: '', device: 'abcdefghij', question: 'how is it going?' });
    return siriAnswer(stateDir, q.id)!;
  };
  assert.equal((await ask({ intake: () => IntakeConfig.parse({ version: 1 }) })).state, 'refused');
  assert.equal((await ask({ intake: () => null })).state, 'refused');
  assert.match(JSON.stringify(await ask({ intake: () => null })), new RegExp(SIRI_OFF));
  assert.match(JSON.stringify(await ask({ held: () => 'agents are stopped' })), new RegExp(SIRI_PAUSED.replace(/[.?]/g, '\\$&')));
  assert.match(JSON.stringify(await ask({ budgetLeft: () => 0 })), new RegExp(SIRI_BUDGET.replace(/[.?']/g, '.')));
  assert.equal(runner.calls.length, 0, 'none of these ran anything');
  // The day's Siri spend reaches the cap ($1 by default): refused, still no run.
  log.append('run.cost', { issue: null, role: 'siri', model: 'haiku', usd: 1, turns: 1 }, 'c');
  assert.match(JSON.stringify(await ask({})), new RegExp(SIRI_CAPPED.slice(0, 20).replace(/'/g, '.')));
  assert.equal(runner.calls.length, 0);
  // A run that fails, or answers nothing: a spoken failure, never its output.
  const { dir: d2, log: l2 } = seeded();
  const failing = new FakeRunner(() => ({ reason: 'failed', structured: { answer: 'PRIVATE half answer' } }));
  const q = askSiri({ stateDir: join(d2, 'state'), device: 'abcdefghij', question: 'q' });
  await answerSiri(deps({ log: l2, stateDir: join(d2, 'state'), runner: failing }), { v: 1, id: q.id, at: '', device: 'abcdefghij', question: 'q' });
  assert.equal(siriAnswer(join(d2, 'state'), q.id)!.state, 'refused');
  assert.doesNotMatch(JSON.stringify(siriAnswer(join(d2, 'state'), q.id)), /PRIVATE/);
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('the coordinator takes a Siri question and writes the spoken answer (checkSiri), with intake.yaml siri on', async () => {
  const base = mkdtempSync(join(tmpdir(), 'siri-coord-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(base, 'slots'));
  const runner = new FakeRunner((req) => ({ structured: req.role === 'siri' ? { answer: 'All quiet. Nothing waits for you.' } : {} }));
  const c = new Coordinator({
    cfg: loadConfig(repo),
    log,
    backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'),
    runner,
    repo,
    instance: 'example',
    stateDir,
    slotsDir: join(base, 'slots'),
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => ON, sources: [], pullMs: 0 },
  });
  const q = askSiri({ stateDir, device: 'abcdefghij', question: 'anything for me?' });
  await c.checkSiri();
  assert.equal(siriAnswer(stateDir, q.id)!.state, 'answered');
  assert.equal((siriAnswer(stateDir, q.id) as { speech: string }).speech, 'All quiet. Nothing waits for you.');
  assert.ok(!existsSync(join(stateDir, 'siri', 'requests', `${q.id}.json`)), 'taken once');
  const call = runner.calls.find((r) => r.role === 'siri')!;
  assert.ok(!call.cwd.startsWith(repo));
  log.close();
});

// ---------------------------------------------------------------- what is spoken

test('speech: plain text, no links, ids, paths or markdown, at most 400 characters, cut at a sentence end', () => {
  const s = toSpeech('**PR 7** is ready: see [the PR](https://github.com/o/r/pull/7). Code is in src/siri/ask.ts.');
  assert.doesNotMatch(s, /https?:|\*|\[|\]|src\/siri|run:|event:/);
  assert.match(s, /^PR 7 is ready: see the PR\. Code is in/);
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const cut = toSpeech(long);
  assert.ok(cut.length <= SPEECH_MAX, String(cut.length));
  assert.match(cut, /\.$/, 'ends at a sentence');
  assert.ok(toSpeech('x'.repeat(2000)).length <= SPEECH_MAX);
  // A token-shaped string, put together here so no secret-looking literal sits in the source.
  const fake = ['ghp', '_', '0123456789abcdefghij', 'ABCDEFGHIJ012345'].join('');
  assert.ok(!toSpeech(`the key is ${fake} ok`).includes(fake), 'redacted');
});

// ---------------------------------------------------------------- the token store

test('tokens: a wrong secret is refused; names are unique; limits per device (20 tells, 10 asks an hour)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'siri-tok-'));
  const { token, device } = createDevice({ stateDir, instance: 'example', name: 'Phone', by: 'example-owner' });
  const node = { id: 'nPhone1CNTRL', name: 'phone.example.test' };
  assert.equal(verifyToken({ stateDir, instance: 'example', token, node }).ok, true);
  // One wrong secret: refused.
  assert.equal(verifyToken({ stateDir, instance: 'example', token: `${token.slice(0, -3)}AAA`, node }).ok, false);
  assert.match(device.id, /^[a-z2-7]{10}$/);
  assert.throws(() => createDevice({ stateDir, instance: 'example', name: 'Phone', by: 'x' }), /exists already/);
  const limits = new RateLimits(() => 1000);
  for (let i = 0; i < 20; i++) assert.ok(limits.take('a', 'tell'));
  assert.equal(limits.take('a', 'tell'), false);
  assert.ok(limits.take('b', 'tell'), 'per device');
  for (let i = 0; i < 10; i++) assert.ok(limits.take('a', 'ask'));
  assert.equal(limits.take('a', 'ask'), false);
});

// ---------------------------------------------------------------- the Shortcuts' sources

test('the Shortcut sources: what scripts/siri-shortcuts.mjs writes, and no address, token, person or contact in them', async () => {
  const gen = (await import(pathToFileURL(join(repoRoot, 'scripts', 'siri-shortcuts.mjs')).href)) as { FILES: Record<string, string> };
  for (const [rel, body] of Object.entries(gen.FILES)) {
    const have = readFileSync(join(repoRoot, rel), 'utf8');
    assert.equal(have, body, `${rel} is stale: run node scripts/siri-shortcuts.mjs`);
    // Only the values: the DOCTYPE line names Apple's DTD, which is no address of ours.
    const values = [...have.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
    for (const v of values) {
      assert.doesNotMatch(v, /https?:\/\/(?!<)|\.ts\.net|tailscale\.com|\b100\.\d+\.\d+\.\d+\b/i, `${rel}: an address: ${v}`);
      assert.doesNotMatch(v, /_siri_|Bearer [A-Za-z0-9]/, `${rel}: a token: ${v}`);
      // An action's UUID is the one long run of digits a Shortcut may hold.
      if (!/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(v)) assert.doesNotMatch(v, /@|\+?\d[\d -]{7,}\d/, `${rel}: a contact: ${v}`);
    }
    assert.doesNotMatch(have, /WFContact|WFEmailAddress|WFPhoneNumber|SigningCertificate|AEA1/i, `${rel}: no contact or signature`);
    // The token and the address are import questions, answered on the phone.
    assert.equal((have.match(/<key>ParameterKey<\/key>/g) ?? []).length, 2);
    assert.match(have, /<key>WFHTTPMethod<\/key>\s*<string>POST<\/string>/);
  }
});
