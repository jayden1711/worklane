// A synthetic event log of a chosen size, the same for the same seed: for the dashboard's speed measurement
// (scripts/dev/perf-dashboard.mjs) and the tests that compare its views read whole against read incrementally.
// Payloads are the real shapes: each one is checked against its schema (src/events/types.ts) before it is written.
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { EventSchemas, type EventType } from '../src/events/types.js';

/** A small seeded PRNG (mulberry32): the same seed, the same log. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
    hex: (n: number) => {
      let s = '';
      while (s.length < n) s += Math.floor(next() * 0x100000000).toString(16).padStart(8, '0');
      return s.slice(0, n);
    },
  };
}

export interface SyntheticOptions {
  /** How many events to write (exactly). */
  count: number;
  seed: number;
  /** The instance name ticks and claims carry. */
  instance?: string;
  /** The last event's time; the log spans `days` before it. Default: a fixed day, so a test's log is the same every run. */
  end?: Date;
  days?: number;
}

type Row = [type: EventType, payload: unknown, actor: string, source: 'coordinator' | 'human' | 'agent'];

const TITLES = ['Totals count negative quantities', 'Free shipping threshold', 'Cart badge flickers on update', 'Search ignores accents', 'Checkout times out on slow cards', 'Refund email has the wrong currency', 'Order history paginates twice', 'Coupon stacking rule', 'Address form loses the second line', 'Inventory sync drops variants'];
const FILES = ['src/cart/totals.ts', 'src/cart/badge.tsx', 'src/search/index.ts', 'src/checkout/pay.ts', 'src/mail/refund.ts', 'src/orders/history.ts', 'src/coupons/rules.ts', 'src/forms/address.tsx', 'src/inventory/sync.ts', 'test/totals.test.ts'];
const CHECKS = ['lint', 'typecheck', 'test', 'e2e', 'build'];
const MODELS = ['sonnet', 'opus', 'haiku'];
const HEARTBEATS = ['running npm test', 'editing src/cart/totals.ts', 'reading the failing test', 'waiting on the type checker', 'writing a regression test'];

/** One issue's life, from seen to merged (or blocked), as the coordinator records it. */
function lifecycle(r: ReturnType<typeof seeded>, issue: number, instance: string, prNumber: number): Row[] {
  const head = r.hex(40);
  const base = r.hex(40);
  const files = [r.pick(FILES), r.pick(FILES)];
  const rows: Row[] = [
    ['issue.seen', { issue, title: `${r.pick(TITLES)} (#${issue})`, labels: ['ready', r.pick(['size:S', 'size:M', 'size:L'])], author: 'example-owner', owner: null, actionable: true, why: 'opened by writer example-owner' }, 'coordinator', 'coordinator'],
    ['contract.agreed', { issue, done_when: [{ test: 'npm test', expect: 'pass' }], by: 'example-owner' }, 'coordinator', 'coordinator'],
    ['issue.claimed', { issue, instance, lease: r.hex(40), base, owner: 'example-owner' }, 'coordinator', 'coordinator'],
    ['run.started', { issue, role: 'worker', model: r.pick(MODELS), worktree: `/srv/work/issue-${issue}`, pid: r.int(1000, 60000), pgid: r.int(1000, 60000), attempt: 1 }, 'coordinator', 'coordinator'],
  ];
  const beats = r.int(10, 40);
  for (let i = 0; i < beats; i++) rows.push(['run.heartbeat', { issue, role: 'worker', note: r.pick(HEARTBEATS) }, 'worker', 'agent']);
  rows.push(
    ['worker.claims', { issue, claims: ['npm test passes', `${files[0]} handles the edge case`], risk_class: r.pick(['docs-only', 'logic', 'logic', 'protected'] as const) }, 'worker', 'agent'],
    ['run.cost', { issue, role: 'worker', model: r.pick(MODELS), usd: Math.round(r.next() * 300) / 100, turns: r.int(5, 60), tokens_in: r.int(10_000, 900_000), tokens_out: r.int(1000, 40_000), secs: r.int(60, 1800) }, 'coordinator', 'coordinator'],
    ['run.finished', { issue, role: 'worker', reason: r.pick(['succeeded', 'succeeded', 'succeeded', 'failed', 'timed_out'] as const), detail: '' }, 'coordinator', 'coordinator'],
    ['change.proposed', { issue, branch: `worklane/issue-${issue}`, base, head, files, lines: r.int(4, 400), added: r.int(2, 300), removed: r.int(0, 100), patch_hash: r.hex(64) }, 'coordinator', 'coordinator'],
    ['check.result', { issue, head, stage: 'verify', checks: CHECKS.slice(0, 3).map((check) => ({ check, status: r.chance(0.9) ? 'pass' : 'fail', exitCode: 0, duration_ms: r.int(200, 90_000) })) }, 'coordinator', 'coordinator'],
    ['eval.verdict', { issue, head, patch_hash: r.hex(64), patch_correct: r.chance(0.9), test_correct: r.chance(0.9), confidence: r.pick(['high', 'medium', 'low'] as const), advice: r.chance(0.3) ? 'Add a test for the empty cart.' : '', model: 'opus' }, 'evaluator', 'agent'],
    ['run.cost', { issue, role: 'evaluator', model: 'opus', usd: Math.round(r.next() * 100) / 100, turns: r.int(2, 20) }, 'coordinator', 'coordinator'],
    ['review.level_set', { issue, head, level: r.pick(['L0', 'L1', 'L2', 'L3'] as const), reasons: ['logic change in one module'] }, 'coordinator', 'coordinator'],
    ['pr.opened', { issue, number: prNumber, url: `https://github.com/example-org/shop/pull/${prNumber}`, head, draft: true }, 'coordinator', 'coordinator'],
  );
  const statuses = r.int(2, 8);
  for (let i = 0; i < statuses; i++) {
    const done = i === statuses - 1;
    rows.push(['pr.status', { issue, number: prNumber, head, ready: done, reasons: done ? [] : ['test pending'], checks: CHECKS.map((name) => ({ name, outcome: done ? 'pass' : r.pick(['pass', 'pending', 'pending'] as const) })) }, 'coordinator', 'coordinator']);
  }
  rows.push(['pr.stats', { issue, number: prNumber, head, additions: r.int(1, 300), deletions: r.int(0, 100), files: files.length, comments: r.int(0, 6) }, 'coordinator', 'coordinator']);
  rows.push(['ci.pr_timing', { number: prNumber, head, wall_ms: r.int(60_000, 900_000), first_started: null, last_completed: null, why: null }, 'coordinator', 'coordinator']);
  if (r.chance(0.12)) {
    rows.push(['decision.asked', { id: `d-${issue}-${r.hex(6)}`, kind: 'land', issue, owner: 'example-owner', question: `Merge #${prNumber}?`, options: ['approve', 'reject'], recommendation: 'approve', receipts: ['every required check passed'] }, 'coordinator', 'coordinator']);
  }
  if (r.chance(0.1)) {
    rows.push(['issue.blocked', { issue, owner: 'example-owner', why: 'the worker needs the owner to pick a threshold' }, 'coordinator', 'coordinator']);
    return rows;
  }
  const sha = r.hex(40);
  rows.push(
    ['pr.ready', { issue, number: prNumber, head }, 'coordinator', 'coordinator'],
    ['merge.decided', { issue, number: prNumber, head, auto: r.chance(0.7), reasons: ['every required check passed on the evaluated commit', `${r.int(4, 400)} lines in ${files.length} files`] }, 'coordinator', 'coordinator'],
    ['merge.done', { issue, number: prNumber, head, sha, url: `https://github.com/example-org/shop/pull/${prNumber}`, title: `Fix #${issue}` }, 'coordinator', 'coordinator'],
    ['pr.closed', { issue, number: prNumber, merged: true }, 'coordinator', 'coordinator'],
    ['merge.main_result', { issue, number: prNumber, sha, outcome: r.chance(0.95) ? 'green' : 'red', failed: [] }, 'coordinator', 'coordinator'],
    ['main_watch.checked', { sha, how: 'harness', number: prNumber }, 'coordinator', 'coordinator'],
    ['ci.test_durations', { sha, job: 'test', tests: Array.from({ length: r.int(3, 12) }, (_, i) => ({ name: `suite ${i} > case ${r.int(1, 40)}`, ms: r.int(5, 20_000) })), parsed: 12, error: null }, 'coordinator', 'coordinator'],
  );
  return rows;
}

/**
 * Write a log of exactly `count` events to `path` (a new file): issues worked from seen to merge, interleaved with
 * the coordinator's ticks, the odd error and a report a day. About 55% ticks, as a busy instance's log has.
 */
export function writeSyntheticLog(path: string, o: SyntheticOptions): { count: number; issues: number } {
  const r = seeded(o.seed);
  const instance = o.instance ?? 'perf';
  // Made by the engine's own log: its schema, triggers and state version.
  new EventLog(path).db.close();
  const rows: Row[] = [];
  let issue = 0;
  let pr = 1000;
  // Three issues in flight at once, their events interleaved with each other and with the ticks.
  const flight: Row[][] = [];
  while (rows.length < o.count) {
    while (flight.length < 3) flight.push(lifecycle(r, ++issue, instance, ++pr));
    if (r.chance(0.55)) rows.push(['coordinator.tick', { instance, dispatched: r.int(0, 2), reconciled: r.int(0, 3) }, 'coordinator', 'coordinator']);
    else if (r.chance(0.01)) rows.push(['coordinator.error', { instance, where: r.pick(['pr hygiene', 'dispatch', 'main watch']), kind: 'transient', message: 'GitHub answered 502' }, 'coordinator', 'coordinator']);
    else if (r.chance(0.002)) rows.push(['report.posted', { day: '2026-01-01', slot: 'evening', issue: null }, 'coordinator', 'coordinator']);
    else {
      const i = r.int(0, flight.length - 1);
      rows.push(flight[i]!.shift()!);
      if (!flight[i]!.length) flight.splice(i, 1);
    }
  }
  rows.length = o.count;
  const end = (o.end ?? new Date('2026-06-01T12:00:00Z')).getTime();
  const span = (o.days ?? 30) * 86_400_000;
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; BEGIN');
  const insert = db.prepare('INSERT INTO events (ts, type, actor, source, payload) VALUES (?, ?, ?, ?, ?)');
  rows.forEach(([type, payload, actor, source], i) => {
    EventSchemas[type].parse(payload);
    insert.run(new Date(end - span + Math.floor((span * (i + 1)) / o.count)).toISOString(), type, actor, source, JSON.stringify(payload));
  });
  db.exec('COMMIT');
  db.close();
  return { count: o.count, issues: issue };
}
