// Voice intake and spoken approvals, on the server (src/voice.ts, src/intake/voice.ts, the dashboard's routes and the
// one decide path): owners only, from a focused and visible tab, approvals only and never of an exclusion, audited
// "by voice", off by default, and a spoken idea taken through the very intake function a Discord message goes through.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { loadConfig } from '../src/config/load.js';
import { Coordinator } from '../src/coordinator.js';
import { startDashboard } from '../src/dashboard.js';
import { answerDecision } from '../src/decide.js';
import { EventLog } from '../src/events/log.js';
import { IntakeConfig, type IncomingReport, type IntakeSource } from '../src/intake/report.js';
import { submitVoiceIntake, VoiceIntake } from '../src/intake/voice.js';
import { intakeForInstance } from '../src/intake/wire.js';
import { FakeRunner } from '../src/runner.js';
import { voiceExclusion, voiceInboxDir } from '../src/voice.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const OWNER = 'example-owner';
const WRITER = 'example-collaborator';
const TAB = { focused: true, visible: true };

/** A dashboard over a fresh log; `intake`: the instance's intake.yaml (0600), or none. */
async function server(intake?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-dash-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const { dir: root } = exampleProject();
  const stateDir = join(dir, 'state');
  let intakeFile: string | undefined;
  if (intake !== undefined) {
    intakeFile = join(dir, 'intake.yaml');
    writeFileSync(intakeFile, intake, { mode: 0o600 });
  }
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: OWNER, roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots'), ...(intakeFile ? { intakeFile } : {}) });
  const base = d.url.split('/?')[0]!;
  const post = (path: string, as: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(as) }, body: JSON.stringify(body) });
  const get = async (path: string, as: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(as) } })).json();
  return { d, log, stateDir, post, get };
}

type Kind = 'land' | 'question' | 'domain' | 'plan' | 'intake' | 'delegation';
const asked = (id: string, kind: Kind, issue: number | null, receipts: string[] = []) => ({ id, kind, issue, owner: OWNER, question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts });
const audits = (log: EventLog) => log.read(0, ['dashboard.audit']).map((e) => e.payload as { login: string; action: string; detail: Record<string, unknown> });
const inbox = (stateDir: string) => (existsSync(voiceInboxDir(stateDir)) ? readdirSync(voiceInboxDir(stateDir)).filter((f) => f.endsWith('.json')) : []);

test('an excluded item is refused by voice on the server, even when the client sends it; a click still answers it', async () => {
  const s = await server();
  try {
    s.log.append('decision.asked', asked('d-land', 'land', 5), 'c');
    s.log.append('decision.asked', asked('d-money', 'plan', 6, ['holds because high-risk: money-path (src/pay.ts)']), 'c');
    s.log.append('plan.posted', { issue: 6, plan: {}, held: true, reasons: ['high-risk: money-path (src/pay.ts)'], comments_at: 0, decision: 'd-money' }, 'c');
    // Held for a high-risk reason the receipts don't repeat: the plan.posted reasons count on their own.
    s.log.append('decision.asked', asked('d-auth', 'plan', 7), 'c');
    s.log.append('plan.posted', { issue: 7, plan: {}, held: true, reasons: ['high-risk: auth (src/auth/session.ts)'], comments_at: 0, decision: 'd-auth' }, 'c');
    s.log.append('decision.asked', asked('d-deleg', 'delegation', null), 'c');
    s.log.append('decision.asked', asked('d-design', 'plan', 8), 'c');
    s.log.append('plan.posted', { issue: 8, plan: {}, held: true, reasons: ['design: new top-level module (lib/)'], comments_at: 0, decision: 'd-design' }, 'c');
    for (const id of ['d-land', 'd-money', 'd-auth', 'd-deleg']) {
      const r = await s.post('/api/decide', OWNER, { id, answer: 'approve', voice: TAB });
      assert.equal(r.status, 403, `${id} refused by voice`);
      assert.match(((await r.json()) as { error: string }).error, /not approvable by voice/);
    }
    assert.equal(s.log.read(0, ['decision.answered']).length, 0, 'nothing recorded for an excluded item');
    // The page is told before anyone speaks; an owner-only field.
    const st = (await s.get('/api/state', OWNER)) as { decisions: { id: string; voiceRefused?: string | null }[] };
    const refused = Object.fromEntries(st.decisions.map((d) => [d.id, d.voiceRefused]));
    for (const id of ['d-land', 'd-money', 'd-auth', 'd-deleg']) assert.equal(typeof refused[id], 'string', id);
    assert.equal(refused['d-design'], null, 'a design-level plan is approvable by voice');
    const writer = (await s.get('/api/state', WRITER)) as { decisions: { voiceRefused?: unknown }[] };
    assert.ok(writer.decisions.every((d) => !('voiceRefused' in d)), 'not sent to a writer');
    // Not an exclusion: approved by voice.
    assert.equal((await s.post('/api/decide', OWNER, { id: 'd-design', answer: 'approve', voice: TAB })).status, 200);
    // The voice flag only ever tightens: the same owner's click answers the excluded plan.
    assert.equal((await s.post('/api/decide', OWNER, { id: 'd-money', answer: 'approve' })).status, 200);
  } finally {
    await s.d.close();
  }
});

test('by voice a decision is only approved, never rejected or answered otherwise', async () => {
  const s = await server();
  try {
    s.log.append('decision.asked', asked('d-1', 'question', 3), 'c');
    const r = await s.post('/api/decide', OWNER, { id: 'd-1', answer: 'reject', voice: TAB });
    assert.equal(r.status, 400);
    assert.equal(s.log.read(0, ['decision.answered']).length, 0);
  } finally {
    await s.d.close();
  }
});

test('answerDecision itself refuses a voice approval from a non-owner, or of an excluded item, whatever route calls it', () => {
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'voice-decide-')), 'events.db'));
  try {
    log.append('decision.asked', asked('d-q', 'question', 3), 'c');
    log.append('decision.asked', asked('d-money', 'plan', 6), 'c');
    log.append('plan.posted', { issue: 6, plan: {}, held: true, reasons: ['high-risk: money-path (src/pay.ts)'], comments_at: 0, decision: 'd-money' }, 'c');
    const call = (id: string, role: 'owner' | 'writer') => answerDecision(log, { id, answer: 'approve', who: { login: role === 'owner' ? OWNER : WRITER, role, via: 'session' }, instance: null, repo: 'example/repo', voice: true });
    const writer = call('d-q', 'writer');
    assert.equal(writer.ok, false, 'a writer approves nothing by voice, even one they may click');
    assert.equal(!writer.ok && writer.status, 403);
    const excluded = call('d-money', 'owner');
    assert.equal(excluded.ok, false, 'an excluded item is refused by voice, even for an owner');
    assert.match(!excluded.ok ? excluded.error : '', /not approvable by voice/);
    assert.equal(log.read(0, ['decision.answered']).length, 0, 'nothing recorded');
    // Without the voice flag, the same calls are the ordinary click path.
    assert.equal(answerDecision(log, { id: 'd-q', answer: 'approve', who: { login: WRITER, role: 'writer', via: 'session' }, instance: null, repo: 'example/repo' }).ok, true);
  } finally {
    log.close();
  }
});

test('the voice exclusions reuse the engine\'s classification: NEVER_FROM_CHAT and the merge policy\'s high-risk reasons', () => {
  assert.match(voiceExclusion({ id: 'x', kind: 'land', receipts: [] }) ?? '', /high-risk merge/);
  for (const c of ['money-path', 'auth', 'secrets', 'deploy-config', 'self-modification']) assert.ok(voiceExclusion({ id: 'x', kind: 'plan', receipts: [`holds because high-risk: ${c} (a)`] }), c);
  assert.equal(voiceExclusion({ id: 'x', kind: 'intake', receipts: ['intake:abc'] }), null);
});

test('a non-owner is refused anything by voice, though a writer may answer the same decision with a click', async () => {
  const s = await server('version: 1\nvoice:\n  enabled: true\n');
  try {
    s.log.append('decision.asked', asked('d-1', 'question', 3), 'c');
    const r = await s.post('/api/decide', WRITER, { id: 'd-1', answer: 'approve', voice: TAB });
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /owners' only/);
    const i = await s.post('/api/voice/intake', WRITER, { text: 'add a dark mode', voice: TAB });
    assert.equal(i.status, 403);
    assert.deepEqual(inbox(s.stateDir), [], 'nothing left for intake');
    assert.equal(s.log.read(0, ['decision.answered']).length, 0);
    assert.equal((await s.post('/api/decide', WRITER, { id: 'd-1', answer: 'approve' })).status, 200, 'the click path is unchanged');
  } finally {
    await s.d.close();
  }
});

test('an unfocused or hidden tab gets no action by voice, and a voice claim of any other shape is refused as voice', async () => {
  const s = await server('version: 1\nvoice:\n  enabled: true\n');
  try {
    s.log.append('decision.asked', asked('d-1', 'question', 3), 'c');
    for (const voice of [{ focused: false, visible: true }, { focused: true, visible: false }, {}, true, 'yes', { focused: 'true', visible: 1 }]) {
      const r = await s.post('/api/decide', OWNER, { id: 'd-1', answer: 'approve', voice });
      assert.equal(r.status, 403, JSON.stringify(voice));
      assert.match(((await r.json()) as { error: string }).error, /focused and visible/);
      assert.equal((await s.post('/api/voice/intake', OWNER, { text: 'an idea', voice })).status, 403, JSON.stringify(voice));
    }
    assert.equal(s.log.read(0, ['decision.answered']).length, 0);
    assert.deepEqual(inbox(s.stateDir), []);
    // The intake route takes only voice: without the claim it is no way to file anything.
    assert.equal((await s.post('/api/voice/intake', OWNER, { text: 'an idea' })).status, 400);
  } finally {
    await s.d.close();
  }
});

test('everything done by voice is audited "by voice", refusals too, and the audit never carries the words', async () => {
  const s = await server('version: 1\nvoice:\n  enabled: true\n');
  try {
    s.log.append('decision.asked', asked('d-1', 'intake', 4, ['intake:abc']), 'c');
    assert.equal((await s.post('/api/decide', OWNER, { id: 'd-1', answer: 'approve', voice: TAB })).status, 200);
    const sent = await s.post('/api/voice/intake', OWNER, { text: 'the totals page should show tax separately', voice: TAB });
    assert.equal(sent.status, 200);
    const { id } = (await sent.json()) as { id: string };
    assert.equal((await s.post('/api/voice/intake', OWNER, { text: 'x', voice: { focused: false, visible: true } })).status, 403);
    const a = audits(s.log);
    const answered = a.find((x) => x.action === 'decision.answered')!;
    assert.equal(answered.detail.by, 'voice');
    const intake = a.find((x) => x.action === 'intake.voice')!;
    assert.deepEqual(intake.detail, { id, chars: 42, by: 'voice' });
    assert.deepEqual(a.find((x) => x.action === 'voice.refused')?.detail.by, 'voice');
    assert.doesNotMatch(JSON.stringify(s.log.read()), /tax separately/, 'the words stay out of the event log');
    assert.deepEqual(inbox(s.stateDir), [`${id}.json`], 'left for the coordinator');
    // A click is not marked as voice.
    s.log.append('decision.asked', asked('d-2', 'question', 9), 'c');
    await s.post('/api/decide', OWNER, { id: 'd-2', answer: 'approve' });
    assert.equal(audits(s.log).filter((x) => x.action === 'decision.answered').at(-1)!.detail.by, undefined);
  } finally {
    await s.d.close();
  }
});

test('voice intake is off by default: the config, the dashboard and the coordinator all take nothing until intake.yaml turns it on', async () => {
  assert.equal(IntakeConfig.parse({ version: 1 }).voice.enabled, false);
  for (const yaml of [undefined, 'version: 1\n', 'version: 1\nvoice:\n  enabled: false\n']) {
    const s = await server(yaml);
    try {
      const r = await s.post('/api/voice/intake', OWNER, { text: 'an idea', voice: TAB });
      assert.equal(r.status, 403, String(yaml));
      assert.match(((await r.json()) as { error: string }).error, /intake is off|voice intake is off/);
      assert.deepEqual(inbox(s.stateDir), []);
    } finally {
      await s.d.close();
    }
  }
  const home = mkdtempSync(join(tmpdir(), 'voice-home-'));
  const stateDir = join(home, 'state');
  const wired = (yaml: string) => {
    writeFileSync(join(home, 'intake.yaml'), yaml, { mode: 0o600 });
    return intakeForInstance({ home, repo: 'example/repo', githubToken: async () => 't', stateDir, log: () => {} })!.sources.map((x) => x.name);
  };
  assert.ok(!wired('version: 1\n').includes('voice'), 'no voice source by default');
  assert.ok(wired('version: 1\nvoice:\n  enabled: true\n').includes('voice'));
});

// ---------------------------------------------------------------- the same intake function as Discord

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const DRAFT = { title: 'Show tax separately', body: '**Outcome:** Totals show tax on its own line.\n**Sources:** the totals code.\n**Constraints:** none.\n**Deliverable:**\n```done_when\n- command: |\n    npm test\n```\n**Review point:** L1.\n' };

test('voice intake reaches the same intake function as a Discord message, and waits for an approval like an untrusted sender', async () => {
  const base = mkdtempSync(join(tmpdir(), 'voice-coord-'));
  const repo = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', 'add', '-A');
  git(repo, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const log = new EventLog(join(base, 'events.db'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  mkdirSync(join(base, 'slots'));
  const discordReport: IncomingReport = { source: 'discord', sourceId: 'm1', sender: { source: 'discord', id: '123456789012' }, text: 'bug: the totals page hides the tax', receivedAt: '2026-10-01T10:00:00.000Z', thread: { kind: 'channel', id: 't1' } };
  let batches = [[discordReport]];
  const discord: IntakeSource = { name: 'discord', take: async () => batches.shift() ?? [], reply: async () => true };
  const voice = new VoiceIntake({ stateDir }).source();
  const { id } = submitVoiceIntake({ stateDir, text: 'show the tax separately on the totals page', by: OWNER });
  const config = IntakeConfig.parse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'], allowed_senders: ['123456789012'] }, voice: { enabled: true } });
  const c = new Coordinator({
    cfg: loadConfig(repo),
    log,
    backlog: new FileBacklog(join(base, 'backlog.json'), 'coordinator'),
    runner: new FakeRunner(() => ({ structured: { kind: 'feature', draft: DRAFT } })),
    repo,
    instance: 'example',
    stateDir,
    slotsDir: join(base, 'slots'),
    machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) },
    settings: () => ({ settings: {}, error: null }),
    intake: { config: () => config, sources: [discord, voice], pullMs: 0 },
  });
  // The one function every source's report goes through (src/coordinator/intake.ts intakeReport): recorded per call.
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(c)) as Record<string, unknown>;
  let owner = proto;
  while (owner && !Object.hasOwn(owner, 'intakeReport')) owner = Object.getPrototypeOf(owner) as Record<string, unknown>;
  assert.ok(owner, 'intakeReport is found');
  const original = owner.intakeReport as (this: unknown, cfg: unknown, r: IncomingReport) => Promise<void>;
  const through: string[] = [];
  owner.intakeReport = function (this: unknown, cfg: unknown, r: IncomingReport) {
    through.push(r.source);
    return original.call(this, cfg, r);
  };
  try {
    await c.checkIntake();
  } finally {
    owner.intakeReport = original;
  }
  assert.deepEqual(through.sort(), ['discord', 'voice'], 'both sources go through the one intake function');
  const received = log.read(0, ['intake.received']).map((e) => e.payload as { source: string });
  assert.deepEqual(received.map((r) => r.source).sort(), ['discord', 'voice']);
  // The owner's spoken idea is never trusted: its draft waits for an approval, in the Inbox.
  const decisions = log.read(0, ['decision.asked']).map((e) => e.payload as { kind: string; question: string });
  assert.ok(decisions.some((d) => d.kind === 'intake' && /via voice/.test(d.question)), 'an intake approval, attributed to voice');
  assert.equal(log.read(0, ['intake.awaiting']).length, 2, 'both wait for an approval (neither sender is trusted here)');
  assert.ok(!readdirSync(voiceInboxDir(stateDir)).includes(`${id}.json`), 'taken from the inbox once recorded');
  batches = [];
  log.close();
});
