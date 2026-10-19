import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { mayReadDigest, startDashboard } from '../src/dashboard.js';
import { WAIT_KINDS, waitingCached, waitingCount, waitingOnYou, type Digest, type WaitKind } from '../src/digest.js';
import { EventCache } from '../src/events/cache.js';
import { EventLog } from '../src/events/log.js';
import { openReadOnly } from '../src/events/read-only.js';
import { EventSchemas, type EventType } from '../src/events/types.js';
import type { UpdateEntry } from '../src/updates.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';
import { seeded } from './synthetic-events.js';
import { waitingOnYou as reference } from './waiting-reference.js';

async function serve(user: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-waiting-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', { issue: 4, title: 'Round totals', labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
  log.append('decision.asked', { id: 'd1', kind: 'question', issue: 4, owner: 'example-owner', question: 'Which rounding mode?', options: ['half-up', 'banker'], recommendation: 'half-up', receipts: [] }, 'coordinator');
  log.append('merge.stopped', { reason: 'main went red', number: null, sha: null, revert: null }, 'coordinator');
  log.close();
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (path: string, auth = true) => fetch(`${base}${path}`, auth ? { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } } : {});
  return { d, get, db: join(dir, 'events.db') };
}

type Keys = { kind: string; issue: number | null; decision?: string }[];
/** What the state's waiting key should hold for /api/waiting's answer: the count, and each item's kind, issue and decision. */
const keysOf = (items: { kind: string; issue: number | null; decision?: string }[]): { count: number; keys: Keys } => ({ count: items.length, keys: items.map((i) => ({ kind: i.kind, issue: i.issue, ...(i.decision !== undefined ? { decision: i.decision } : {}) })) });

test('what waits on the owner, and the digest\'s Markdown, are the owner\'s and the writers\'; anyone else is refused and the state says so', async () => {
  for (const user of ['example-owner', 'example-collaborator']) {
    const s = await serve(user);
    try {
      assert.equal((await s.get('/api/waiting', false)).status, 401);
      const r = await s.get('/api/waiting');
      assert.equal(r.status, 200, `${user} reads it`);
      const w = (await r.json()) as { items: { kind: string; issue: number | null; detail: string; title: string | null }[]; markdown: string };
      assert.deepEqual(w.items.map((i) => [i.kind, i.issue]), [['merge_stopped', null], ['awaiting_decision', 4]]);
      assert.equal(w.items[1]!.title, 'Round totals');
      assert.match(w.markdown, /^## Waiting on you: /, 'the digest, named for the project');
      assert.match(w.markdown, /\*\*Decisions waiting for you\*\* \(1\)\n- #4 Round totals: @example-owner: Which rounding mode\? \(waiting \d+ min\)/);
      const state = (await (await s.get('/api/state')).json()) as { canReadDigest: boolean; waiting?: { count: number; keys: Keys } };
      assert.equal(state.canReadDigest, true);
      // #633: the state carries how many things /api/waiting lists (and their keys), so the badge needs no other read.
      assert.deepEqual(state.waiting, keysOf(w.items), `${user}: the state's waiting count is /api/waiting's length`);
      assert.equal(state.waiting!.count, 2);
    } finally {
      await s.d.close();
    }
  }
  const s = await serve('someone-else');
  try {
    const r = await s.get('/api/waiting');
    assert.equal(r.status, 403);
    assert.match(((await r.json()) as { error: string }).error, /^what waits on the owner is for the instance's owners and writers \(admin or write on its repo\); @someone-else is a viewer/);
    const state = (await (await s.get('/api/state')).json()) as Record<string, unknown>;
    assert.equal(state.canReadDigest, false);
    assert.ok(!('waiting' in state), "a viewer's state has no waiting key");
  } finally {
    await s.d.close();
  }
  assert.equal(mayReadDigest('writer'), true);
  assert.equal(mayReadDigest(null), false);
});

test("#633: a new wait is in the state's count on the next read, and an answer, an unblock or a resume takes it out", async () => {
  const s = await serve('example-owner');
  const log = new EventLog(s.db);
  try {
    // The state first, as the shell reads it on a change: its count is from the fold, not from a read of /api/waiting.
    const count = async () => {
      const state = (await (await s.get('/api/state')).json()) as { waiting: { count: number; keys: Keys } };
      const w = (await (await s.get('/api/waiting')).json()) as { items: { kind: string; issue: number | null; decision?: string }[] };
      assert.deepEqual(state.waiting, keysOf(w.items), "the state's count and keys are /api/waiting's");
      return state.waiting.count;
    };
    assert.equal(await count(), 2);
    log.append('decision.asked', { id: 'd2', kind: 'question', issue: null, owner: 'example-owner', question: 'Which region?', options: ['eu', 'us'], recommendation: 'eu', receipts: [] }, 'coordinator');
    assert.equal(await count(), 3, 'a new decision is counted on the next state read');
    log.append('issue.blocked', { issue: 4, owner: 'example-owner', why: 'needs a key' }, 'coordinator');
    assert.equal(await count(), 4, 'a blocked task is counted');
    log.append('emergency.stop', { by: 'example-owner', reason: 'checking something', running: 0 }, 'human');
    assert.equal(await count(), 5, 'an emergency stop is counted');
    log.append('decision.answered', { id: 'd1', by: 'example-owner', answer: 'half-up' }, 'human');
    assert.equal(await count(), 4, 'an answered decision leaves the count');
    log.append('issue.claimed', { issue: 4, instance: 'example', lease: 'a'.repeat(40), base: 'b'.repeat(40), owner: 'example-owner' }, 'coordinator');
    assert.equal(await count(), 3, 'a task claimed again is no longer blocked');
    log.append('emergency.resume', { instance: 'example' }, 'human');
    log.append('merge.resumed', { detail: 'main is green again' }, 'human');
    assert.equal(await count(), 1, 'resumed: only decision d2 waits');
  } finally {
    log.close();
    await s.d.close();
  }
});

test('the event cache steps a fold through each event once, as it is appended; a step that throws starts it again', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'fold-')), 'events.db');
  const log = new EventLog(db);
  const seen = (issue: number) => log.append('issue.seen', { issue, title: `#${issue}`, labels: [], author: 'o', owner: null, actionable: false, why: '' }, 'coordinator');
  seen(1);
  seen(2);
  const cache = new EventCache(db);
  let steps = 0;
  const issues = () => cache.fold('issues', () => [] as number[], (s, e) => (steps++, s.push((e.payload as { issue: number }).issue)));
  assert.deepEqual(issues(), [1, 2]);
  assert.deepEqual(issues(), [1, 2]);
  assert.equal(steps, 2, 'nothing appended: no step');
  seen(3);
  assert.deepEqual(issues(), [1, 2, 3]);
  assert.equal(steps, 3, 'one event appended: one step');
  let fail = true;
  const flaky = () => cache.fold('flaky', () => ({ n: 0 }), (s) => {
    if (fail && s.n === 1) throw new Error('a bad event');
    s.n++;
  });
  assert.throws(flaky, /a bad event/);
  fail = false;
  assert.equal(flaky().n, 3, 'the half-folded state was dropped and the fold read the log again from its first event');
  log.close();
});

test("#633: a snapshot's views are of its own events, after the cache has read more", () => {
  const db = join(mkdtempSync(join(tmpdir(), 'snapshot-')), 'events.db');
  const log = new EventLog(db);
  const seen = (issue: number) => log.append('issue.seen', { issue, title: `#${issue}`, labels: [], author: 'o', owner: null, actionable: false, why: '' }, 'coordinator');
  const issues = (ev: { payload: unknown }[]) => ev.map((e) => (e.payload as { issue: number }).issue);
  const fold = (s: ReturnType<EventCache['snapshot']>) => s.fold('issues', () => [] as number[], (acc, e) => void acc.push((e.payload as { issue: number }).issue));
  seen(1);
  const cache = new EventCache(db);
  const first = cache.snapshot();
  seen(2);
  assert.deepEqual(issues(first.all()), [1], 'appended after it: not in it');
  const second = cache.snapshot();
  assert.deepEqual(fold(second), [1, 2]);
  assert.deepEqual(second.memo('issues', issues), [1, 2]);
  // The cache has kept the second snapshot's fold and memo; the first is answered from its own events, and keeps nothing.
  assert.deepEqual(fold(first), [1], "the first snapshot's fold stops at its own last event");
  assert.deepEqual(first.memo('issues', issues), [1], "the first snapshot's memo is of its own events");
  assert.equal(first.lastId(), 1);
  assert.deepEqual(cache.memo('issues', issues), [1, 2], "the cache's kept memo is still the newest snapshot's");
  assert.deepEqual(cache.fold('issues', () => [] as number[], () => assert.fail('nothing new to step')), [1, 2]);
  assert.equal(second.snapshot(), second, 'a snapshot handed on is itself, never a later read');
  log.close();
});

const askedPayload = (id: string) => ({ id, kind: 'question' as const, issue: null, owner: 'example-owner', question: `Which ${id}?`, options: ['a', 'b'], recommendation: 'a', receipts: [] });

/** A cache that has folded a log of decisions d1 to d3; `change` then changes what is at the path, and the answer is read again. */
function afterReset(change: (db: string, ask: (log: EventLog, id: string) => void) => void): (string | undefined)[] {
  const dir = mkdtempSync(join(tmpdir(), 'waiting-reset-'));
  const db = join(dir, 'events.db');
  const updates: UpdateEntry[] = [];
  const ask = (log: EventLog, id: string) => void log.append('decision.asked', askedPayload(id), 'coordinator');
  const log = new EventLog(db);
  for (const id of ['d1', 'd2', 'd3']) ask(log, id);
  log.close();
  const cache = new EventCache(db);
  const decisions = () => {
    const now = new Date(Date.now() + 60_000);
    const got = asJson(waitingCached(cache, now, { updates }));
    assert.deepEqual(got, asJson(waitingOnYou(cache.all(), now, { updates })), 'the cached answer is the whole-log one');
    return got.items.map((i) => i.decision);
  };
  assert.deepEqual(decisions(), ['d1', 'd2', 'd3']);
  change(db, ask);
  return decisions();
}

test('#633: a reset of the event cache drops the fold: a log restored over the path is answered from its own events', () => {
  const got = afterReset((db, ask) => {
    // Another log, with fewer events, moved over the path.
    const restored = join(dirname(db), 'restored.db');
    const other = new EventLog(restored);
    ask(other, 'x9');
    other.close();
    renameSync(restored, db);
  });
  assert.deepEqual(got, ['x9'], "the restored file's decisions, not the fold of the file it replaced");
});

test('#633: a reset of the event cache drops the fold: events a migration rewrote (a new user_version) are answered as rewritten', () => {
  const got = afterReset((db) => {
    // The same file and the same number of events, rewritten, under a new user_version.
    const raw = new DatabaseSync(db);
    raw.exec('DROP TRIGGER events_no_update');
    raw.exec("UPDATE events SET payload = json_set(payload, '$.id', 'm' || substr(json_extract(payload, '$.id'), 2)) WHERE type = 'decision.asked'");
    const version = Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    raw.exec(`PRAGMA user_version = ${version + 1}`);
    raw.close();
  });
  assert.deepEqual(got, ['m1', 'm2', 'm3'], "the migrated events' decisions, not the fold of the events before the migration");
});

// --- The incremental answer against the whole-log one, over random logs ---------------------------------------------

const ISSUES = [1, 2, 3, 4, 5, 6];
const IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const SHAS = ['a', 'b', 'c', 'd'].map((c) => c.repeat(40));
const HEADS = ['1', '2', '3'].map((c) => c.repeat(12));
const OUTCOMES = ['pass', 'fail', 'pending', 'cancelled', 'skipped', 'missing'] as const;

/** One random event about a few issues, PRs, decisions and deploys, of every kind Waiting on you reads, and some noise. */
function randomEvent(r: ReturnType<typeof seeded>): [EventType, Record<string, unknown>] {
  const issue = r.pick(ISSUES);
  const number = 100 + issue;
  const head = r.pick(HEADS);
  const sha = r.pick(SHAS);
  const makers: (() => [EventType, Record<string, unknown>])[] = [
    () => ['issue.seen', { issue, title: `Task ${issue}${r.chance(0.3) ? ' renamed' : ''}`, labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }],
    () => ['issue.closed', { issue }],
    () => ['issue.claimed', { issue, instance: 'x', lease: sha, base: sha, owner: 'example-owner' }],
    () => ['run.started', { issue, role: 'worker', model: 'm', worktree: '/w', pid: 1, pgid: null, attempt: 1 }],
    () => ['issue.blocked', { issue, owner: 'example-owner', why: r.pick(['needs a key', 'which way?\nmore']) }],
    () => ['issue.blocked', { issue, owner: 'example-owner', why: 'blocked again' }],
    () => {
      const outcome = r.pick(['landed', 'pr_opened', 'conflict', 'red', 'rejected', 'error', 'deferred'] as const);
      return ['land.result', { issue, outcome, landed: outcome === 'landed' ? sha : null, detail: 'land detail\nmore' }];
    },
    () => ['issue.released', { issue, instance: 'x', why: r.pick(['landed', 'issue closed on GitHub', 'done']) }],
    () => ['pr.opened', { issue, number, url: 'u', head, draft: false }],
    () => ['pr.closed', { issue, number, merged: r.chance(0.5) }],
    () => ['merge.done', { issue, number, head, sha, url: 'u', title: `Fix #${issue}` }],
    () => ['emergency.stop', { by: 'example-owner', reason: 'checking', running: 0 }],
    () => ['emergency.resume', { instance: 'x' }],
    () => ['merge.stopped', { reason: 'main went red', number: r.chance(0.5) ? number : null, sha: null, revert: null }],
    () => ['merge.resumed', { detail: 'green' }],
    () => ['merge.main_result', { issue, number, sha, outcome: r.pick(['green', 'red', 'timed_out'] as const), failed: r.pick([[], ['test']]) }],
    () => ['decision.asked', { id: r.pick(IDS), kind: r.pick(['land', 'question', 'plan', 'domain'] as const), issue: r.chance(0.2) ? null : issue, owner: 'example-owner', question: 'Which one?\nmore', options: ['a', 'b'], recommendation: 'a', receipts: [] }],
    () => ['decision.asked', { id: r.pick(IDS), kind: 'question', issue, owner: 'example-owner', question: 'Again?', options: ['a', 'b'], recommendation: 'a', receipts: [] }],
    () => ['decision.answered', { id: r.pick(IDS), by: 'example-owner', answer: 'a' }],
    () => ['plan.posted', { issue, plan: {}, held: r.chance(0.6), reasons: r.pick([[], ['risky']]), comments_at: 0, decision: r.chance(0.3) ? null : r.pick(IDS) }],
    () => ['plan.decided', { issue, decision: r.pick(IDS), answer: r.pick(['approve', 'revise', 'reject'] as const), by: 'example-owner', note: '' }],
    () => ['merge.decided', { issue, number, head, auto: r.chance(0.4), reasons: r.pick([[], ['big change', 'protected path']]), ...(r.chance(0.5) ? { why: [{ category: 'protected', text: 'src/a.ts' }] } : {}) }],
    () => ['conflict_fix.finished', { issue, number, base_sha: null, strategy: 'merge', outcome: r.pick(['pushed', 'gave_up', 'no_push'] as const), head: null, files: [], waits_owner: r.chance(0.6), reasons: [], detail: 'conflicts\nmore' }],
    () => ['ci_fix.gave_up', { issue, number, head, reason: 'flaky test' }],
    () => ['ci_fix.started', { issue, number, head, checks: ['test'], attempt: 1, lease: sha }],
    () => ['pr.ready', { issue, number, head }],
    () => ['pr.status', { issue, number, head, ready: r.chance(0.3), reasons: [], checks: [{ name: 'test', outcome: r.pick(OUTCOMES) }, { name: 'lint', outcome: r.pick(OUTCOMES) }] }],
    () => ['deploy.failed', { env: r.pick(['staging', 'prod']), sha, why: 'health check failed\nmore' }],
    () => ['deploy.verified', { env: r.pick(['staging', 'prod']), sha }],
    () => ['hotspot.held', { issue, by: r.pick(ISSUES), files: r.pick([['a.ts'], ['a.ts', 'b.ts', 'c.ts', 'd.ts']]), reason: 'same files' }],
    () => ['hotspot.released', { issue, waited_ms: 0, files: [], started: false }],
    () => ['dependency.held', { issue, on: [r.pick(ISSUES)], reason: `Depends on #${r.pick(ISSUES)}` }],
    () => ['dependency.unblocked', { issue, on: [1], waited_ms: 0, why: 'closed' }],
    () => ['review.level_set', { issue, head, level: r.pick(['L0', 'L1', 'L2', 'L3'] as const), reasons: [] }],
    () => ['eval.verdict', { issue, head, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: r.pick(['high', 'medium', 'low'] as const), advice: '' }],
    () => ['pr_batch.queued', { issue, number, head }],
    () => ['pr_batch.step', { id: r.pick(['b1', 'b2']), step: r.pick(['built', 'green', 'red', 'finished', 'dropped'] as const), prs: [{ issue, number, head }], sha: null, base: null, parent: null, tier: null, run: null, detail: 'batch step' }],
    () => ['coordinator.tick', { instance: 'x', dispatched: 0, reconciled: 0 }],
  ];
  return r.pick(makers)();
}

const asJson = (d: unknown) => JSON.parse(JSON.stringify(d)) as Digest;
const keyOf = (i: { kind: string; issue: number | null; pr: number | null; decision?: string }) => `${i.kind}:${i.issue}:${i.pr}:${i.decision ?? ''}`;

test('#633: the cached, incremental Waiting on you answers what reading the whole log answered (#627), over random logs', (t) => {
  const MIN = 60_000;
  let viaFold = 0;
  let aheadRead = 0;
  const kinds = new Set<WaitKind>();
  const ended = new Map<string, number>();
  for (let seed = 1; seed <= 25; seed++) {
    const r = seeded(seed);
    const db = join(mkdtempSync(join(tmpdir(), 'waiting-fold-')), 'events.db');
    new EventLog(db).close();
    const raw = new DatabaseSync(db);
    // A test log: no wait for the disk on each append.
    raw.exec('PRAGMA synchronous = OFF');
    const insert = raw.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)');
    const cache = new EventCache(db);
    let clock = Date.parse('2026-06-01T08:00:00Z');
    // The machine's engine update log: an install, a held rollback, a later install, at random times.
    const updates: UpdateEntry[] = Array.from({ length: r.int(0, 3) }, () => ({ at: new Date(clock + r.int(0, 2400) * MIN).toISOString(), event: r.pick(['installed', 'rolled_back'] as const), held: r.chance(0.7), from: r.pick(SHAS), reason: 'migration failed\nmore' })).sort((a, b) => a.at.localeCompare(b.at));
    let prev = new Set<string>();
    let latest = -Infinity;
    let now = clock;
    const compare = (at: number) => {
      const all = cache.all();
      const when = new Date(at);
      const want = asJson(reference(all, when, { updates }));
      assert.deepEqual(asJson(waitingOnYou(all, when, { updates })), want, `seed ${seed}: the whole-log read answers as before`);
      assert.deepEqual(asJson(waitingCached(cache, when, { updates })), want, `seed ${seed}, ${all.length} events, now ${when.toISOString()}: the cached answer is the whole-log one`);
      assert.deepEqual(waitingCount(cache, when, { updates }), keysOf(want.items), `seed ${seed}: the state's count is the list's length`);
      if (latest <= at) viaFold++;
      else aheadRead++;
      for (const i of want.items) kinds.add(i.kind);
      const keys = new Set(want.items.map(keyOf));
      for (const k of prev) if (!keys.has(k)) ended.set(k.split(':')[0]!, (ended.get(k.split(':')[0]!) ?? 0) + 1);
      prev = keys;
    };
    for (let n = 0; n < 250; ) {
      const batch = r.int(1, 12);
      for (let b = 0; b < batch; b++, n++) {
        clock += r.int(0, 20) * MIN;
        // Mostly in order; some stamped earlier than the last, some later than the next read (another clock ahead).
        const t = r.chance(0.05) ? clock - r.int(1, 180) * MIN : r.chance(0.02) ? clock + r.int(1, 120) * MIN : r.chance(0.002) ? clock + 3 * 1440 * MIN : clock;
        const [type, payload] = randomEvent(r);
        const valid = EventSchemas[type].safeParse(payload);
        assert.ok(valid.success, `${type}: ${valid.error?.message}`);
        insert.run(new Date(t).toISOString(), type, 'coordinator', 'coordinator', JSON.stringify(payload));
        latest = Math.max(latest, t);
      }
      now = Math.max(now, clock + r.int(-30, 60) * MIN);
      compare(now);
      // The same log read again later: the fold is reused, and only the time moves.
      if (r.chance(0.3)) compare((now += r.int(1, 600) * MIN));
      // A clock stepped back (an NTP correction): read at an earlier time, then the clock goes on from where it was.
      if (r.chance(0.15)) compare(now - r.int(1, 240) * MIN);
    }
    raw.close();
  }
  // Both ways the cache answers were taken: from the fold of every event, and, while an event was stamped ahead, from
  // the read at that time (the events not after it, folded once per change of the log or of which stamps are passed).
  t.diagnostic(`compared ${viaFold + aheadRead} times: from the fold ${viaFold}, from the read at a time some stamp is after ${aheadRead}; ended: ${JSON.stringify(Object.fromEntries(ended))}`);
  assert.ok(viaFold > aheadRead && aheadRead > 0, `from the fold ${viaFold} times, from the read at a time some stamp is after ${aheadRead}`);
  assert.deepEqual([...kinds].sort(), [...WAIT_KINDS].sort(), 'every kind of wait was listed at some point');
  for (const k of ['awaiting_decision', 'plan_held', 'blocked', 'landing_failed', 'needs_owner', 'check_held', 'hotspot_held', 'emergency_halt', 'merge_stopped', 'deploy_failed']) assert.ok(ended.get(k), `some ${k} ended (answered, unblocked, resumed, merged, released...)`);
});

// --- One snapshot of the log per answer -----------------------------------------------------------------------------

/** A log with tasks 4 to 9 seen and claimed: a red landing for one of them makes it a failed landing, not a block. */
function claimedLog(): { db: string; log: EventLog } {
  const db = join(mkdtempSync(join(tmpdir(), 'waiting-snap-')), 'events.db');
  const log = new EventLog(db);
  for (let issue = 4; issue <= 9; issue++) {
    log.append('issue.seen', { issue, title: `Task ${issue}`, labels: ['ready'], author: 'o', owner: 'example-owner', actionable: true, why: '' }, 'coordinator');
    log.append('issue.claimed', { issue, instance: 'x', lease: 'a'.repeat(40), base: 'a'.repeat(40), owner: 'example-owner' }, 'coordinator');
  }
  return { db, log };
}
const landedRed = (log: EventLog, issue: number) => log.append('land.result', { issue, outcome: 'red', landed: null, detail: 'checks red' }, 'coordinator');

test('#633: one answer reads one snapshot of the log: an event another process appends mid-read is in all of it or in none of it', () => {
  const updates: UpdateEntry[] = [];
  const later = () => new Date(Date.now() + 60_000);
  const reads: [string, (c: EventCache, now: Date) => unknown, (d: Digest) => unknown][] = [
    ['waitingCached', (c, now) => asJson(waitingCached(c, now, { updates })).items, (d) => asJson(d).items],
    ['waitingCount', (c, now) => waitingCount(c, now, { updates }), (d) => keysOf(d.items)],
  ];
  let sawIt = 0;
  for (const [name, read, shape] of reads) {
    for (let k = 1; k <= 4; k++) {
      const { db, log } = claimedLog();
      let opens = 0;
      let armAt = 0;
      // Another process appends a red landing for task 4 just before this cache's k-th read of the file from here on.
      const cache = new EventCache(db, (p) => {
        if (++opens === armAt) landedRed(log, 4);
        return openReadOnly(p);
      });
      read(cache, later());
      const before = [...cache.all()];
      armAt = opens + k;
      const now = later();
      const got = read(cache, now);
      const after = new EventCache(db).all();
      const whole = [before, after].map((evs) => shape(waitingOnYou(evs, now, { updates })));
      assert.ok(
        whole.some((w) => isDeepStrictEqual(w, got)),
        `${name}, the append at read ${k}: ${JSON.stringify(got)} is the whole-log answer of the log before the append (${JSON.stringify(whole[0])}) or after it (${JSON.stringify(whole[1])})`,
      );
      if (isDeepStrictEqual(whole[1], got) && !isDeepStrictEqual(whole[0], got)) sawIt++;
      log.close();
    }
  }
  assert.ok(sawIt > 0, 'some answer was read after the append (the landing is in it)');
});

test("#633: /api/state's waiting is read from the same snapshot of the log as the rest of the state", async () => {
  const { db, log } = claimedLog();
  const dir = dirname(db);
  let opens = 0;
  let armAt = 0;
  let issue = 4;
  const { dir: root } = exampleProject();
  const d = await startDashboard({
    root,
    cfg: loadConfig(root),
    eventsDb: db,
    stateDir: dir,
    user: 'example-owner',
    roleOf: exampleRoles,
    slotsDir: join(dir, 'slots'),
    // Another process appends a red landing just before the dashboard's k-th read of the file from here on.
    openEvents: (p) => {
      if (++opens === armAt) landedRed(log, issue);
      return openReadOnly(p);
    },
  });
  const base = d.url.split('/?')[0]!;
  try {
    for (let k = 1; k <= 6; k++, issue++) {
      armAt = opens + k;
      const state = (await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson('example-owner') } })).json()) as { lastId: number; waiting: { count: number; keys: Keys } };
      // The log as the state's lastId says it was read: its waiting is what a whole-log read of exactly that answers.
      const evs = new EventCache(db).all().filter((e) => e.id <= state.lastId);
      assert.deepEqual(state.waiting, keysOf(waitingOnYou(evs).items), `the append at read ${k}: the state's waiting is from its own snapshot (lastId ${state.lastId})`);
    }
  } finally {
    log.close();
    await d.close();
  }
});

// --- Stamps the clock hasn't reached, or can't read ------------------------------------------------------------------

test('#633: an event whose time cannot be read counts as passed, in the whole-log read and the cached one alike; one stamped ahead costs a pass over the log once per change, not on every read', () => {
  const MIN = 60_000;
  const db = join(mkdtempSync(join(tmpdir(), 'waiting-stamps-')), 'events.db');
  new EventLog(db).close();
  const raw = new DatabaseSync(db);
  const insert = (ts: string, id: string) => raw.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)').run(ts, 'decision.asked', 'coordinator', 'coordinator', JSON.stringify(askedPayload(id)));
  const t0 = Date.parse('2026-06-01T08:00:00Z');
  const at = (m: number) => new Date(t0 + m * MIN);
  const updates: UpdateEntry[] = [];
  const cache = new EventCache(db);
  const listed = (now: Date) => {
    const whole = asJson(waitingOnYou(cache.all(), now, { updates }));
    assert.deepEqual(asJson(waitingCached(cache, now, { updates })), whole, `${now.toISOString()}: the cached answer is the whole-log one`);
    assert.deepEqual(waitingCount(cache, now, { updates }), keysOf(whole.items), `${now.toISOString()}: the state's count is the list's`);
    return whole.items.map((i) => i.decision);
  };
  insert(at(0).toISOString(), 'd1');
  insert('not a time', 'u1');
  assert.deepEqual(listed(at(1)), ['d1', 'u1'], 'a decision with an unreadable time waits, as the projection already has it');
  const runs = cache.memoRuns;
  for (let m = 2; m < 6; m++) assert.deepEqual(listed(at(m)), ['d1', 'u1']);
  assert.equal(cache.memoRuns, runs, 'an unchanged log with an unreadable time in it: every read is from the fold, with no pass over the log');

  insert(at(60).toISOString(), 'f1');
  assert.deepEqual(listed(at(10)), ['d1', 'u1'], 'stamped an hour ahead: not listed yet');
  const ahead = cache.memoRuns;
  assert.ok(ahead > runs, 'the read at a time before that stamp was folded once, and kept');
  for (let m = 11; m < 60; m += 12) assert.deepEqual(listed(at(m)), ['d1', 'u1']);
  assert.equal(cache.memoRuns, ahead, 'later reads before that stamp, the log unchanged: no pass over the log');
  assert.deepEqual(listed(at(61)), ['d1', 'f1', 'u1'], 'listed once the clock passes its time');
  assert.deepEqual(listed(at(30)), ['d1', 'u1'], 'and left out again by a clock stepped back before it');
  // Read at exactly an event's time, while a later one is still ahead: its time is not after now, so it is read.
  insert(at(120).toISOString(), 'f2');
  assert.deepEqual(listed(at(59)), ['d1', 'u1']);
  assert.deepEqual(listed(at(60)), ['d1', 'f1', 'u1'], 'read at exactly its time: listed');
  raw.close();
});
