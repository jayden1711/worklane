// The machine's shared GitHub API budget on the Health page (#198, slice 3): per credential, what is left and when it
// resets, whether a back-off is in force, and the top consumers. Read-only, for owners and writers; never names a
// credential by anything derived from its token; reading is bounded and never takes or waits for the budget's lock.
// Every budget here lives in a temporary slot directory, never the machine's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { budgetFor, credentialKey, GitHubBudget } from '../src/github/budget.js';
import { BUDGET_HEALTH_LIMITS, githubBudgetHealth } from '../src/github/budget-health.js';
import { healthView } from '../src/health.js';
import { tryLock } from '../src/locks.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';
import { testMachine } from './isolate.js';

const posix = process.platform !== 'win32';
/** A slot directory of this test's own, under the temporary directory: never the machine's. */
function slots(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gh-budget-health-'));
  assert.ok(!relative(tmpdir(), dir).startsWith('..'), `${dir} is a temporary directory`);
  return dir;
}
const at = (s: number) => Math.floor(Date.now() / 1000) + s;
function window(b: GitHubBudget, resource: string, remaining: number, reset: number, limit = 5000): void {
  b.observe(resource, { 'x-ratelimit-limit': String(limit), 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': resource });
}
async function takes(b: GitHubBudget, consumer: string, n: number, resource = 'core'): Promise<void> {
  for (let i = 0; i < n; i++) await b.take(consumer, resource);
}
/** A valid state file for a key, written as the budget would (a whole JSON object). */
function stateFile(dir: string, key: string, body: unknown): string {
  const f = join(dir, `github-budget-${key}.json`);
  writeFileSync(f, JSON.stringify(body));
  return f;
}

test('per credential: what is left and when it resets per resource, the back-off in force, and the top consumers; numbered, never named by the token', async (ctx) => {
  // A fixed clock, 1 ms before a second boundary: the setup below crosses it (#687). The test read the clock for
  // a reset time twice, once to set it and once to expect it, and failed whenever a second ticked in between.
  const boundary = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  ctx.mock.timers.enable({ apis: ['Date'], now: boundary - 1 });
  const dir = slots();
  const busy = budgetFor('ghs_secret-token-busy', dir);
  const resetCore = at(1800);
  window(busy, 'core', 4000, resetCore);
  window(busy, 'graphql', 4990, at(2400));
  await takes(busy, 'pr-watch', 5);
  await takes(busy, 'backlog', 2);
  await takes(busy, 'backlog', 1, 'graphql');
  await takes(busy, 'updates', 1);
  const limited = budgetFor('ghp_secret-token-limited', dir);
  const resetLimited = at(600);
  window(limited, 'core', 10, resetLimited);
  await takes(limited, 'backlog', 4);
  ctx.mock.timers.tick(2); // the next second
  const before = Date.now();
  limited.pause('secondary_rate_limited', 120);

  const v = githubBudgetHealth(dir)!;
  assert.ok(v, 'a view when there is a budget');
  assert.equal(v.notShown, 0);
  assert.deepEqual(v.credentials.map((c) => c.id), ['credential 1', 'credential 2'], 'numbered in the order shown');
  const [first, second] = v.credentials;
  // A credential under a back-off comes first.
  assert.deepEqual(first!.backoff?.kind, 'secondary_rate_limited');
  const until = Date.parse(first!.backoff!.until);
  assert.ok(until >= before + 119_000 && until <= Date.now() + 121_000, `back-off until ${first!.backoff!.until}`);
  assert.deepEqual(first!.resources, [{ resource: 'core', limit: 5000, remaining: 6, resetAt: new Date(resetLimited * 1000).toISOString() }]);
  assert.deepEqual(first!.top, [{ consumer: 'backlog', calls: 4 }]);
  assert.equal(first!.calls, 4);
  // The other: each resource, and its consumers over every resource, most first.
  assert.equal(second!.backoff, null);
  assert.deepEqual(second!.resources, [
    { resource: 'core', limit: 5000, remaining: 3992, resetAt: new Date(resetCore * 1000).toISOString() },
    { resource: 'graphql', limit: 5000, remaining: 4989, resetAt: second!.resources[1]!.resetAt },
  ]);
  assert.deepEqual(second!.top, [
    { consumer: 'pr-watch', calls: 5 },
    { consumer: 'backlog', calls: 3 },
    { consumer: 'updates', calls: 1 },
  ]);
  assert.equal(second!.calls, 9);
  assert.ok(Number.isFinite(Date.parse(second!.updatedAt ?? '')));
  // Nothing derived from a token: not the token, not the file's key (a hash of it), not the file's name or path.
  const json = JSON.stringify(v);
  for (const t of ['ghs_secret-token-busy', 'ghp_secret-token-limited']) {
    assert.ok(!json.includes(t), 'no token');
    assert.ok(!json.includes(credentialKey(t)), 'no key derived from the token');
    assert.ok(!json.includes(credentialKey(t).slice(0, 6)), 'not even part of the key');
  }
  assert.doesNotMatch(json, /github-budget|[0-9a-f]{16}/, 'no file name, no hex key');
  assert.ok(!json.includes(dir), 'no path');
});

test('no budget yet (no file, an empty or missing slot directory): no view at all', () => {
  const dir = slots();
  assert.equal(githubBudgetHealth(dir), null);
  assert.equal(githubBudgetHealth(join(dir, 'no-such-dir')), null);
  writeFileSync(join(dir, 'agent-1.lock'), '{}'); // the slot directory's other files are not budgets
  assert.equal(githubBudgetHealth(dir), null);
});

test('reading never takes the budget lock nor waits for it: a held lock is left alone and the read is immediate', async () => {
  const dir = slots();
  const b = budgetFor('token-held', dir);
  window(b, 'core', 100, at(900));
  await takes(b, 'backlog', 1);
  const lockPath = join(dir, `github-budget-${credentialKey('token-held')}.lock`);
  const held = tryLock(lockPath, 'another process');
  assert.ok('lock' in held, 'the test holds the lock');
  const seen = readFileSync(lockPath, 'utf8');
  try {
    const t0 = performance.now();
    const v = githubBudgetHealth(dir);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `read in ${Math.round(ms)} ms with the lock held`);
    assert.equal(v?.credentials[0]?.resources[0]?.remaining, 99, 'the state is read without the lock: it is only ever replaced whole');
    assert.equal(readFileSync(lockPath, 'utf8'), seen, 'the lock is untouched');
  } finally {
    held.lock.release();
  }
});

test('bounded: a FIFO, a symlink, an oversized or malformed file is not shown, never waited on; at most a few credentials; implausible state bounded as the budget bounds it', { skip: !posix && 'FIFOs and symlinks are POSIX' }, async () => {
  const dir = slots();
  const good = budgetFor('token-good', dir);
  window(good, 'core', 50, at(900));
  await takes(good, 'backlog', 1);
  // A FIFO with a budget's name would block a plain read for ever.
  execFileSync('mkfifo', [join(dir, `github-budget-${'a'.repeat(16)}.json`)]);
  // A symlink to a valid state elsewhere is refused, not followed.
  const elsewhere = slots();
  const target = stateFile(elsewhere, 'b'.repeat(16), { resources: { core: { limit: 5000, remaining: 1, reset: at(900), used: { linked: 1 } } }, pausedUntil: 0 });
  symlinkSync(target, join(dir, `github-budget-${'b'.repeat(16)}.json`));
  // Oversized, and not JSON.
  stateFile(dir, 'c'.repeat(16), { resources: { core: { limit: 5000, remaining: 1, reset: at(900), used: { big: 1 } } }, pad: 'x'.repeat(BUDGET_HEALTH_LIMITS.fileBytes) });
  writeFileSync(join(dir, `github-budget-${'d'.repeat(16)}.json`), '{not json');
  const t0 = performance.now();
  const v = githubBudgetHealth(dir)!;
  assert.ok(performance.now() - t0 < 1000, 'the FIFO was not waited on');
  assert.equal(v.credentials.length, 1, 'only the good one');
  assert.deepEqual(v.credentials[0]!.top, [{ consumer: 'backlog', calls: 1 }]);
  assert.equal(v.notShown, 4, 'the FIFO, the symlink, the oversized and the malformed file');
  assert.doesNotMatch(JSON.stringify(v), /linked|big/);

  // A planted state: a pause ten years ahead, a far reset, an absurd consumer name and resource are bounded or dropped.
  const planted = slots();
  stateFile(planted, 'e'.repeat(16), {
    resources: { core: { limit: 5000, remaining: 0, reset: at(10 * 365 * 86400), used: {} }, graphql: { limit: 5000, remaining: 7, reset: at(600), used: { ['<b>x</b> '.repeat(20)]: 3, ok: 2 } }, 'not a resource!': { limit: 1, remaining: 1, reset: at(600), used: {} } },
    pausedUntil: Date.now() + 10 * 365 * 86400_000,
    pauseKind: 'secondary_rate_limited',
  });
  const p = githubBudgetHealth(planted)!.credentials[0]!;
  assert.equal(p.backoff, null, 'a pause past the budget\'s bound is no back-off (the budget ignores it too)');
  assert.deepEqual(p.resources.map((r) => [r.resource, r.remaining]), [['core', null], ['graphql', 7]], 'a reset too far is "not known"; a bad resource name is dropped');
  assert.deepEqual(p.top, [{ consumer: '(other)', calls: 3 }, { consumer: 'ok', calls: 2 }], 'a name that is not a plain identifier is shown as (other)');

  // Many credentials: the most recently changed few, the rest counted.
  const many = slots();
  const n = BUDGET_HEALTH_LIMITS.credentials + 3;
  for (let i = 0; i < n; i++) window(budgetFor(`token-${i}`, many), 'core', 100 + i, at(900));
  const m = githubBudgetHealth(many)!;
  assert.equal(m.credentials.length, BUDGET_HEALTH_LIMITS.credentials);
  assert.equal(m.notShown, 3);
});

test('round 1: a planted state never yields a number JSON cannot carry: counts are safe integers, sums stay finite, an implausible change time is unknown', () => {
  const dir = slots();
  const f = stateFile(dir, 'f'.repeat(16), {
    resources: {
      core: { limit: 1e308, remaining: 1e308, reset: at(600), used: { backlog: 1e308, 'pr-watch': 1.5, negative: -3, text: 'x', merge: 2 } },
      graphql: { limit: 5000, remaining: 9, reset: at(600), used: { backlog: 1e308, merge: 3 } },
    },
    pausedUntil: 0,
  });
  // A far-future change time (as a 64-bit-seconds file system could store one): not a time the view can trust.
  utimesSync(f, new Date(), new Date('2400-01-01T00:00:00Z'));
  const v = githubBudgetHealth(dir)!;
  const c = v.credentials[0]!;
  assert.deepEqual(c.top, [{ consumer: 'merge', calls: 5 }], 'only safe, positive whole counts are counted');
  assert.equal(c.calls, 5);
  assert.deepEqual(c.resources.map((r) => [r.resource, r.limit, r.remaining]), [['core', null, null], ['graphql', 5000, 9]], 'a limit or remaining past a safe integer is not known');
  assert.equal(c.updatedAt, null, 'a change time in the far future is not known');
  // Every number survives JSON as a number (Infinity and NaN would come back as null).
  const back = JSON.parse(JSON.stringify(v)) as typeof v;
  assert.deepEqual(back, v, 'nothing changes through JSON');

  // Two safe counts whose sum is past a safe integer: the sum is capped, never Infinity.
  const sums = slots();
  stateFile(sums, 'f'.repeat(16), { resources: { core: { limit: 5000, remaining: 1, reset: at(600), used: { backlog: Number.MAX_SAFE_INTEGER } }, graphql: { limit: 5000, remaining: 1, reset: at(600), used: { backlog: Number.MAX_SAFE_INTEGER } } }, pausedUntil: 0 });
  const s = githubBudgetHealth(sums)!.credentials[0]!;
  assert.deepEqual(s.top, [{ consumer: 'backlog', calls: Number.MAX_SAFE_INTEGER }]);
  assert.equal(s.calls, Number.MAX_SAFE_INTEGER);
});

test('round 1: a fault while reading the budgets gives a view that says so, never a throw that would take /api/health down', (t) => {
  const dir = slots();
  window(budgetFor('token-fault', dir), 'core', 10, at(600));
  // What an unbounded time did before (new Date(1e16).toISOString()): a RangeError while the view is built.
  t.mock.method(Date.prototype, 'toISOString', () => {
    throw new RangeError('Invalid time value');
  });
  let v: ReturnType<typeof githubBudgetHealth> = null;
  assert.doesNotThrow(() => (v = githubBudgetHealth(dir)));
  t.mock.restoreAll();
  assert.deepEqual(v, { credentials: [], notShown: 0, error: "the budget files couldn't be read (RangeError)" });
});

test('round 1: unreadable files never hide the readable ones: the newest readable budgets are shown', { skip: !posix && 'FIFOs are POSIX' }, () => {
  const dir = slots();
  const good = stateFile(dir, '0'.repeat(16), { resources: { core: { limit: 5000, remaining: 77, reset: at(600), used: { backlog: 1 } } }, pausedUntil: 0 });
  utimesSync(good, new Date(), new Date(Date.now() - 60_000)); // older than every FIFO below
  const fifos = BUDGET_HEALTH_LIMITS.credentials + 1;
  for (let i = 1; i <= fifos; i++) execFileSync('mkfifo', [join(dir, `github-budget-${String(i).padStart(16, '0')}.json`)]);
  const v = githubBudgetHealth(dir)!;
  assert.deepEqual(v.credentials.map((c) => c.resources[0]?.remaining), [77], 'the real budget is shown');
  assert.equal(v.notShown, fifos);
});

test('round 1: a consumer is shown by name only when it looks like the engine\'s own (lower-case words), never a repo, URL, token or hex run', () => {
  const dir = slots();
  const odd = { 'pr-watch': 1, backlog: 2, ['ghp_' + 'A1'.repeat(18)]: 4, 'pr-watch:owner/repo': 8, 'https://x/y': 16, deadbeefdeadbeefdead: 32 };
  stateFile(dir, '1'.repeat(16), { resources: { core: { limit: 5000, remaining: 1, reset: at(600), used: odd } }, pausedUntil: 0 });
  assert.deepEqual(githubBudgetHealth(dir)!.credentials[0]!.top, [
    { consumer: '(other)', calls: 60 },
    { consumer: 'backlog', calls: 2 },
    { consumer: 'pr-watch', calls: 1 },
  ]);
});

test('the health view carries the budget from the slot directory it is given; by default the isolated one, never the machine\'s', () => {
  const dir = slots();
  window(budgetFor('token-view', dir), 'core', 42, at(900));
  const v = healthView([], null, { network: null, updates: [], slotsDir: dir });
  assert.equal(v.githubRate?.credentials[0]?.resources[0]?.remaining, 42);
  assert.equal(healthView([], null, { network: null, updates: [], slotsDir: slots() }).githubRate, null, 'no budget: null');
  assert.equal(healthView([], null, { network: null, updates: [], slotsDir: dir, githubRate: null }).githubRate, null, 'given (the superfan wants only the suggestions): not read');
  // The default is AGENT_SLOTS_DIR, which the test isolation points inside the test's own machine (test/isolate.ts).
  const isolated = process.env.AGENT_SLOTS_DIR;
  assert.ok(isolated && !relative(testMachine, isolated).startsWith('..'), `the default slot directory ${isolated} is inside the test machine ${testMachine}`);
  mkdirSync(isolated, { recursive: true });
  window(budgetFor('token-default', isolated), 'core', 7, at(900));
  assert.equal(healthView([], null, { network: null, updates: [] }).githubRate?.credentials.find((c) => c.resources[0]?.remaining === 7)?.resources[0]?.limit, 5000);
});

test('GET /api/health: owners and writers get the GitHub budget; a viewer gets null, and nothing of it', async () => {
  const { dir: root } = exampleProject();
  const stateDir = mkdtempSync(join(tmpdir(), 'gh-budget-health-state-'));
  const slotDir = slots();
  const b = budgetFor('token-api', slotDir);
  window(b, 'core', 300, at(900));
  await takes(b, 'merge-flow', 2);
  b.pause('secondary_rate_limited', 60);
  const db = join(stateDir, 'events.db');
  new EventLog(db).close();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: slotDir, pollMs: 50 });
  try {
    const url = `${d.url.split('/?')[0]!}/api/health`;
    const get = async (who: string) => (await fetch(url, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(who) } })).json() as Promise<{ githubRate?: { credentials: { id: string; resources: { remaining: number | null }[]; backoff: { kind: string } | null; top: { consumer: string; calls: number }[] }[] } | null }>;
    for (const who of ['example-owner', 'example-collaborator']) {
      const g = (await get(who)).githubRate;
      assert.equal(g?.credentials[0]?.id, 'credential 1', who);
      assert.equal(g?.credentials[0]?.resources[0]?.remaining, 298, who);
      assert.equal(g?.credentials[0]?.backoff?.kind, 'secondary_rate_limited', who);
      assert.deepEqual(g?.credentials[0]?.top, [{ consumer: 'merge-flow', calls: 2 }], who);
    }
    const viewer = await get('someone-else');
    // The field isn't named "budget": the viewer check (test/viewer-events.test.ts) takes any budget-shaped key for money.
    assert.equal(viewer.githubRate, null, 'a viewer gets no budget');
    assert.doesNotMatch(JSON.stringify(viewer), /merge-flow|credential 1|secondary_rate_limited/, "nothing of it anywhere in a viewer's health");
    const all = JSON.stringify(await get('example-owner'));
    assert.ok(!all.includes(credentialKey('token-api')) && !all.includes('token-api'), 'no token or key, even for the owner');
  } finally {
    await d.close();
  }
});
