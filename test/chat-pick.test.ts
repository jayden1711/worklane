// The dashboard chat's model and effort picker and its per-conversation budget cap (src/chat-pick.ts): only the
// models routing names, a writer at or below the default's tier, no pick for a viewer, the cap checked before each
// answer, the default from routing.chat, effort as claude's --effort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatModels, chatRunOptions, conversationSpentUsd, MAIN_CONVERSATION, pickableModels } from '../src/chat-pick.js';
import { AgentsConfig } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { cliArgs, type RunRequest } from '../src/runner.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const base = { daily_budget_usd: 10, roles: { workers: { enabled: true, model: 'sonnet', hard_issues_model: 'opus' }, evaluator: { enabled: true, model: 'opus' } } };
const parse = (o: object = {}) => AgentsConfig.parse({ ...base, ...o });
const LOCAL = { providers: { local: { base_url: 'http://127.0.0.1:8080', credential: 'local', model: 'qwen' } } };

test('models: only the Anthropic models routing names; an open model or an unlisted one is never offered and refused, for the owner too', () => {
  const a = parse({ ...LOCAL, routing: { intake_replier: 'local', reflection: 'claude-haiku-4-5' } });
  assert.deepEqual(chatModels(a).sort(), ['claude-haiku-4-5', 'haiku', 'opus', 'sonnet']);
  for (const model of ['local', 'claude-unlisted-9']) {
    const r = chatRunOptions({ agents: a, picker: 'owner', pick: { model }, conversation: MAIN_CONVERSATION, spentUsd: 0, dailyLeftUsd: 10 });
    assert.equal(r.ok, false, model);
  }
});

test("who picks: the owner any routing model; a writer only at or below the default's tier, a model of no known tier refused; a viewer nothing", () => {
  const a = parse({ routing: { chat: 'sonnet', planner: 'fable' } });
  assert.deepEqual(pickableModels(a, 'owner').sort(), ['fable', 'haiku', 'opus', 'sonnet']);
  assert.deepEqual(pickableModels(a, 'writer').sort(), ['haiku', 'sonnet']);
  const run = (picker: 'owner' | 'writer' | 'viewer', model: string) => chatRunOptions({ agents: a, picker, pick: { model }, conversation: MAIN_CONVERSATION, spentUsd: 0, dailyLeftUsd: 10 });
  assert.equal(run('owner', 'opus').ok, true);
  assert.equal(run('writer', 'opus').ok, false, 'above the default');
  assert.equal(run('writer', 'fable').ok, false, 'no known tier');
  assert.equal(run('writer', 'haiku').ok, true);
  assert.equal(run('viewer', 'sonnet').ok, false, "a viewer can't pick, even the default");
});

test("budget: refused at or over the conversation's cap; an answer's cap is the least of the role's, the conversation's and the day's", () => {
  const a = parse({ roles: { ...base.roles, chief_of_staff: { enabled: true, model: 'sonnet', budget_usd: 2, conversation_budget_usd: 3 } } });
  const run = (spentUsd: number, dailyLeftUsd: number) => chatRunOptions({ agents: a, picker: 'viewer', conversation: 'c1', spentUsd, dailyLeftUsd });
  assert.equal(run(3, 10).ok, false, 'at the cap');
  assert.equal(run(3.5, 10).ok, false, 'over it');
  const r = (s: number, d: number) => {
    const x = run(s, d);
    return x.ok ? x.maxBudgetUsd : null;
  };
  assert.deepEqual([r(0, 10), r(2.5, 10), r(0, 0.4)], [2, 0.5, 0.4]);
  // What a conversation spent: its own chat answers; main's one conversation, today's only (a minute before now and two
  // days before: the same and another day in any time zone).
  const now = new Date('2026-10-15T12:00:00Z');
  const cost = (ts: string, p: object) => ({ ts, payload: { role: 'chat', usd: 1, ...p } });
  const costs = [cost('2026-10-15T01:00:00Z', { conversation: 'c1' }), cost('2026-10-01T01:00:00Z', { conversation: 'c1' }), cost('2026-10-15T01:00:00Z', { conversation: 'c2' }), cost('2026-10-15T01:00:00Z', { conversation: 'c1', role: 'worker' }), cost('2026-10-15T11:59:00Z', { conversation: MAIN_CONVERSATION }), cost('2026-10-13T12:00:00Z', { conversation: MAIN_CONVERSATION })];
  assert.deepEqual([conversationSpentUsd(costs, 'c1', now), conversationSpentUsd(costs, MAIN_CONVERSATION, now)], [2, 1]);
});

test("main's conversation resets on the local day, not the UTC one: just after local midnight, yesterday's local spend no longer counts", () => {
  const tz = process.env.TZ;
  // WHY: Tokyo (UTC+9, no DST): at 00:30 local on the 16th it is still the 15th in UTC.
  process.env.TZ = 'Asia/Tokyo';
  try {
    const now = new Date('2026-10-15T15:30:00Z');
    const costs = [
      { ts: '2026-10-15T15:10:00Z', payload: { role: 'chat', usd: 1, conversation: MAIN_CONVERSATION } }, // 00:10 on the 16th, local
      { ts: '2026-10-15T14:50:00Z', payload: { role: 'chat', usd: 2, conversation: MAIN_CONVERSATION } }, // 23:50 on the 15th, local
    ];
    assert.equal(conversationSpentUsd(costs, MAIN_CONVERSATION, now), 1);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('default: routing.chat, else chief_of_staff.model; routing.chat may not be an open model, and only chief_of_staff has a conversation cap', () => {
  const cos = { ...base.roles, chief_of_staff: { enabled: true, model: 'haiku' } };
  const model = (o: object) => {
    const r = chatRunOptions({ agents: parse(o), picker: 'viewer', conversation: MAIN_CONVERSATION, spentUsd: 0, dailyLeftUsd: 10 });
    return r.ok ? r.model : null;
  };
  assert.deepEqual([model({}), model({ roles: cos }), model({ roles: cos, routing: { chat: 'opus' } })], ['sonnet', 'haiku', 'opus']);
  assert.equal(AgentsConfig.safeParse({ ...base, ...LOCAL, routing: { chat: 'local' } }).success, false);
  assert.equal(AgentsConfig.safeParse({ ...base, roles: { ...base.roles, workers: { ...base.roles.workers, conversation_budget_usd: 5 } } }).success, false);
});

test("effort reaches claude as --effort, and only a listed value does", () => {
  const req = (effort?: string) => ({ role: 'chat', prompt: '', cwd: '/w', model: 'sonnet', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 1, timeoutMs: 1, ...(effort ? { effort } : {}) }) as RunRequest;
  const at = (a: string[]) => (a.includes('--effort') ? a[a.indexOf('--effort') + 1] : null);
  assert.deepEqual([at(cliArgs(req('high'))), at(cliArgs(req())), at(cliArgs(req('max --dangerously-skip-permissions')))], ['high', null, null]);
});

test("over HTTP: the options per role; a viewer's pick is refused (403), a writer's above the default's tier too (400); a pick is recorded with the role", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-pick-'));
  const { dir: root } = exampleProject();
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb, stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots'), attachmentScan: null });
  const url = d.url.split('/?')[0]!;
  const h = (who: string) => ({ authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(who) });
  const ask = (who: string, pick: object) => fetch(`${url}/api/chat`, { method: 'POST', headers: h(who), body: JSON.stringify({ question: 'why?', pick }) });
  const options = async (who: string) => (await (await fetch(`${url}/api/chat/options`, { headers: h(who) })).json()) as { canPick: boolean; models: string[] };
  try {
    assert.deepEqual((await options('someone-else')), { canPick: false, models: [], efforts: [], defaultModel: 'sonnet', capUsd: 5 });
    assert.deepEqual((await options('example-collaborator')).models.sort(), ['haiku', 'sonnet']);
    assert.deepEqual((await options('example-owner')).models.sort(), ['haiku', 'opus', 'sonnet']);
    assert.equal((await ask('someone-else', { model: 'sonnet' })).status, 403);
    assert.equal((await ask('example-collaborator', { model: 'opus' })).status, 400);
    assert.equal((await ask('example-collaborator', { model: 'haiku', effort: 'low' })).status, 200);
    const reqs = join(dir, 'chat', 'requests');
    const r = JSON.parse(readFileSync(join(reqs, readdirSync(reqs)[0]!), 'utf8')) as { pick: object; picker: string; conversation?: string };
    assert.deepEqual([r.pick, r.picker, r.conversation], [{ model: 'haiku', effort: 'low' }, 'writer', undefined]);
  } finally {
    await d.close();
  }
});
