import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertsIntake, alertsQuery, pullAlerts, readAlertsState } from '../src/intake/alerts.js';
import { decide } from '../src/intake/decide.js';
import { IntakeConfig, isTrusted } from '../src/intake/report.js';
import { intakeForInstance } from '../src/intake/wire.js';

type Row = { id: number; kind: string; message: string; created_at: string };

/** A fake production read: rows newer than the query's cursor, as the read-only client prints them. Records each SQL. */
function fakeProd(rows: Row[]) {
  const sqls: string[] = [];
  const run = (sql: string) => {
    sqls.push(sql);
    const after = Number(/> '(\d+)'/.exec(sql)?.[1] ?? 'NaN');
    const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1]);
    const out = rows.filter((r) => r.id > after).slice(0, limit);
    return { ok: true, output: JSON.stringify({ rowCount: out.length, truncated: false, fields: ['id', 'kind', 'message', 'created_at'], rows: out }) };
  };
  return { rows, sqls, run };
}

const cfgWith = (o: object = {}) => IntakeConfig.parse({ version: 1, alerts: { enabled: true, ...o } }).alerts;
const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 12, 0) + min * 60_000).toISOString();
const clock = (min: number) => () => new Date(at(min));
const dir = () => mkdtempSync(join(tmpdir(), 'alerts-'));

test('alerts: off by default, and wired only with intake.yaml on and the production read path', () => {
  assert.equal(IntakeConfig.parse({ version: 1 }).alerts.enabled, false);
  const home = dir();
  const wire = (yaml: string, prodRead?: ReturnType<typeof fakeProd>['run']) => {
    writeFileSync(join(home, 'intake.yaml'), yaml, { mode: 0o600 });
    const log: string[] = [];
    const w = intakeForInstance({ home, repo: 'example/shop', githubToken: async () => 'unused', stateDir: join(home, 'state'), prodRead, log: (l) => log.push(l) })!;
    return { names: w.sources.map((s) => s.name), log };
  };
  const prod = fakeProd([]);
  assert.deepEqual(wire('version: 1\n', prod.run).names, [], 'not in intake.yaml: no alerts source, even with a read path');
  const noPath = wire('version: 1\nalerts: { enabled: true }\n');
  assert.deepEqual(noPath.names, [], 'on, but no production read path: nothing pulled');
  assert.match(noPath.log.join('\n'), /no production read path/);
  assert.deepEqual(wire('version: 1\nalerts: { enabled: true }\n', prod.run).names, ['alerts']);
  assert.deepEqual(prod.sqls, [], 'wiring reads nothing');
});

test('alerts: the query is fixed from plain identifiers, and the cursor is validated before any read', () => {
  assert.equal(
    alertsQuery(cfgWith({ table: 'ops.alerts', columns: { id: 'alert_id', kind: 'type' } })),
    'SELECT "alert_id" AS id, "type" AS kind, "message" AS message, "created_at" AS created_at FROM "ops"."alerts" WHERE "alert_id" > :after ORDER BY "alert_id" LIMIT 500',
  );
  assert.throws(() => alertsQuery({ ...cfgWith(), table: 'alerts; drop table users' }), /not a plain identifier/);
  assert.equal(IntakeConfig.safeParse({ version: 1, alerts: { table: 'a" or 1=1 --' } }).success, false);

  const state = dir();
  const prod = fakeProd([{ id: 1, kind: 'x', message: 'm', created_at: at(0) }]);
  mkdirSync(join(state, 'intake'), { recursive: true });
  writeFileSync(join(state, 'intake', 'alerts-state.json'), JSON.stringify({ after: "0' OR '1'='1", baseline: false }));
  assert.throws(() => pullAlerts(state, cfgWith(), prod.run, clock(0)), /refusing an unexpected cursor/);
  assert.deepEqual(prod.sqls, [], 'a tampered cursor never reaches the production read');
});

test('alerts: kinds already there are learned; a new kind becomes one report, never repeated, and survives a crash before it is recorded', async () => {
  const state = dir();
  const prod = fakeProd([
    { id: 1, kind: 'db_timeout', message: 'old', created_at: at(-600) },
    { id: 2, kind: 'db_timeout', message: 'old', created_at: at(-500) },
  ]);
  const src = new AlertsIntake({ stateDir: state, config: () => cfgWith(), run: prod.run, now: clock(0) });
  assert.deepEqual(await src.take(), [], 'the first catch-up only learns the kinds already there');
  prod.rows.push({ id: 3, kind: 'payout_failed', message: 'payout 77 failed', created_at: at(-1) }, { id: 4, kind: 'payout_failed', message: 'again', created_at: at(0) }, { id: 5, kind: 'db_timeout', message: 'again', created_at: at(0) });
  const got = await src.take();
  assert.deepEqual(got.map((r) => [r.source, r.sourceId, r.sender.id]), [['alerts', 'new:payout_failed', 'payout_failed']]);
  assert.match(got[0]!.text, /New production alert kind "payout_failed".*payout 77 failed/);
  assert.match(prod.sqls.at(-1)!, /> '2'/, 'the cursor moved past what was read');
  // Not recorded yet (a crash): the same report again, once, and no new one for the same kind.
  prod.rows.push({ id: 6, kind: 'payout_failed', message: 'third', created_at: at(1) });
  assert.deepEqual((await src.take()).map((r) => r.sourceId), ['new:payout_failed']);
  await src.ack(['new:payout_failed']);
  prod.rows.push({ id: 7, kind: 'payout_failed', message: 'fourth', created_at: at(2) });
  assert.deepEqual(await src.take(), [], 'a kind already reported is never new again');
  assert.equal(readAlertsState(state).after, '7');
});

test('alerts: a spike is more than the threshold within the window, reported once per window', async () => {
  const state = dir();
  const cfg = cfgWith({ spike: { threshold: 3, window_minutes: 60 } });
  const prod = fakeProd([{ id: 1, kind: 'slow_query', message: 'seen before', created_at: at(-300) }]);
  let now = 0;
  const src = new AlertsIntake({ stateDir: state, config: () => cfg, run: prod.run, now: () => new Date(at(now)) });
  await src.take();
  const spikes = async () => (await src.take()).filter((r) => r.sourceId.startsWith('spike:')).map((r) => r.sourceId);
  // Three in the window (the old one is outside it): at the threshold, not over it.
  prod.rows.push(...[2, 3, 4].map((id) => ({ id, kind: 'slow_query', message: `q${id}`, created_at: at(-10) })));
  assert.deepEqual(await spikes(), []);
  prod.rows.push({ id: 5, kind: 'slow_query', message: 'q5 with detail', created_at: at(-1) });
  const [first] = await spikes();
  assert.equal(first, `spike:slow_query:${at(0)}`);
  const report = (await src.take()).find((r) => r.sourceId === first)!;
  assert.match(report.text, /Spike in production alert "slow_query": more than 3 in the last 60 minutes.*q5 with detail/);
  await src.ack([first!]);
  now = 30;
  prod.rows.push({ id: 6, kind: 'slow_query', message: 'q6', created_at: at(29) });
  assert.deepEqual(await spikes(), [], 'still the same window: not reported again');
  now = 200;
  prod.rows.push(...[7, 8, 9, 10].map((id) => ({ id, kind: 'slow_query', message: `q${id}`, created_at: at(195) })));
  assert.deepEqual(await spikes(), [`spike:slow_query:${at(200)}`], 'a later spike is a new report');
});

test('alerts: a secret in an alert never reaches a report or the stored state', async () => {
  const state = dir();
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const conn = 'postgres://app:hunter2secret@db.internal/app';
  const prod = fakeProd([]);
  const src = new AlertsIntake({ stateDir: state, config: () => cfgWith(), run: prod.run, now: clock(0) });
  await src.take();
  prod.rows.push({ id: 1, kind: 'auth_error', message: `token ${secret} rejected at ${conn}`, created_at: at(0) });
  const [r] = await src.take();
  assert.ok(r);
  for (const where of [r.text, readFileSync(join(state, 'intake', 'alerts-state.json'), 'utf8')]) {
    assert.doesNotMatch(where, /A1b2C3d4E5f6G7h8I9j0/);
    assert.doesNotMatch(where, /hunter2secret/);
  }
  assert.match(r.text, /REDACTED/);
});

test('alerts: trusted kinds file ready, others are an Inbox decision; a draft naming a money-path file is marked high-risk', () => {
  const cfg = IntakeConfig.parse({ version: 1, trusted: { alerts: ['payout_failed'] }, alerts: { enabled: true } });
  const sender = (id: string) => ({ source: 'alerts' as const, id });
  assert.equal(isTrusted(sender('payout_failed'), cfg), true);
  assert.equal(isTrusted(sender('db_timeout'), cfg), false);
  const body = (src: string) => `**Outcome:** Payouts retry.\n**Sources:** ${src}\n**Constraints:** none.\n**Deliverable:**\n\`\`\`done_when\n- command: |\n    npm test\n\`\`\`\n**Review point:** L1.\n`;
  const report = { source: 'alerts' as const, sourceId: 'new:payout_failed', sender: sender('payout_failed'), text: 'New production alert kind', receivedAt: at(0) };
  const money = [/^src\/payments\//];
  const run = (src: string, trusted: boolean) => decide({ report, redacted: report.text, triage: { kind: 'bug', draft: { title: 'Payouts fail', body: body(src) } }, trusted, shown: [], moneyPaths: money });
  const filed = run('`src/payments/payout.ts` and the logs.', true);
  assert.equal(filed.action, 'file');
  assert.deepEqual(filed.action === 'file' && filed.labels, ['ready', 'bug', 'money-path']);
  assert.match(filed.action === 'file' ? filed.body : '', /High risk:.*src\/payments\/payout\.ts/);
  const asked = run('src/payments/payout.ts', false);
  assert.deepEqual(asked.action === 'decision' && asked.labels, ['bug', 'money-path'], 'an Inbox draft keeps the mark for when it is filed');
  const plain = run('src/ui/button.tsx', true);
  assert.deepEqual(plain.action === 'file' && plain.labels, ['ready', 'bug']);
});
