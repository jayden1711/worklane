import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubBacklog, GitHubError } from '../src/backlog/github.js';
import { budgetFor, BudgetPaused, credentialKey, GitHubBudget } from '../src/github/budget.js';

/** src/github/budget.ts MAX_PAUSE_S: the longest pause that counts. */
const MAX_PAUSE_S = 15 * 60;

const budgetModule = pathToFileURL(fileURLToPath(new URL('../src/github/budget.js', import.meta.url))).href;
const fresh = () => mkdtempSync(join(tmpdir(), 'gh-budget-'));
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

/** Seed a known window: `remaining` calls left until an hour from now, as GitHub's headers would say. */
function seed(b: GitHubBudget, remaining: number): void {
  b.observe('core', { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(inAnHour()) });
}

/** Run `n` processes that each take from one budget until it refuses; resolves with each one's count of granted calls. */
function racers(dir: string, key: string, n: number): Promise<number[]> {
  const one = (k: number) =>
    new Promise<number>((resolve, reject) => {
      const code = `const { GitHubBudget } = await import(${JSON.stringify(budgetModule)});
        const b = new GitHubBudget(${JSON.stringify(key)}, ${JSON.stringify(dir)}, { maxWaitMs: 0 });
        let got = 0;
        for (;;) { try { await b.take('racer-${k}'); got++; } catch { break; } }
        console.log(got);`;
      const p = spawn(process.execPath, ['--input-type=module', '-e', code]);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (c) => (c === 0 ? resolve(Number(out.trim())) : reject(new Error(`racer ${k} exited ${c}: ${err}`))));
    });
  return Promise.all(Array.from({ length: n }, (_, k) => one(k)));
}

test('two processes sharing a budget never exceed it, and use all of it', async () => {
  const dir = fresh();
  const key = credentialKey('token-a');
  seed(new GitHubBudget(key, dir), 60);
  const counts = await racers(dir, key, 2);
  assert.equal(counts[0]! + counts[1]!, 60, `granted ${counts.join(' + ')}`);
  const s = new GitHubBudget(key, dir).read();
  assert.equal(s.resources.core?.remaining, 0);
  assert.equal((s.resources.core?.used['racer-0'] ?? 0) + (s.resources.core?.used['racer-1'] ?? 0), 60, 'each grant is counted against its consumer');
});

test('a GitHub response lowers the budget, never raises it within a window; a new window replaces it', () => {
  const dir = fresh();
  const b = new GitHubBudget(credentialKey('token-b'), dir);
  const reset = Math.floor(Date.now() / 1000) + 600;
  b.observe('core', { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(reset) });
  b.observe('core', { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': String(reset) });
  assert.equal(b.read().resources.core?.remaining, 10, 'a late answer from before other calls does not hand them back');
  b.observe('core', { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(reset + 3000) });
  assert.equal(b.read().resources.core?.remaining, 4999);
  b.observe('graphql', { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'graphql' });
  assert.equal(b.read().resources.core?.remaining, 4999, 'GraphQL has its own limit');
  assert.equal(b.read().resources.graphql?.remaining, 3);
});

test('an exhausted budget refuses until its reset, then allows calls again', async () => {
  const dir = fresh();
  const b = new GitHubBudget(credentialKey('token-c'), dir, { maxWaitMs: 0 });
  const reset = Math.floor(Date.now() / 1000) + 2; // 1 to 2 s away
  b.observe('core', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) });
  await assert.rejects(b.take('x'), (e: BudgetPaused) => e.kind === 'rate_limited' && e.retryAfter >= 1);
  const waiting = new GitHubBudget(credentialKey('token-c'), dir, { maxWaitMs: 5000, pollMs: 50 });
  await waiting.take('x');
  assert.ok(Date.now() >= reset * 1000, `went ${reset * 1000 - Date.now()} ms before the reset`);
});

test('a secondary limit pauses every caller of that credential, in every process, until it lifts', async () => {
  const dir = fresh();
  const key = credentialKey('token-d');
  const a = new GitHubBudget(key, dir);
  seed(a, 4000);
  // 3 s: long enough that a child process started on a loaded machine still meets the pause.
  a.pause('secondary_rate_limited', 3);
  const until = a.read().pausedUntil;
  // Another process, same credential: refused while the pause stands, without a call reaching GitHub.
  const counts = await racers(dir, key, 1);
  assert.ok(Date.now() < until, 'the child ran inside the pause');
  assert.equal(counts[0], 0, 'no call while paused');
  // Same credential with room to wait: it waits the pause out, then goes.
  await new GitHubBudget(key, dir, { maxWaitMs: 5000, pollMs: 50 }).take('waiter');
  assert.ok(Date.now() >= until, `went ${until - Date.now()} ms before the pause lifted`);
  // Another credential is not paused.
  await new GitHubBudget(credentialKey('token-e'), dir, { maxWaitMs: 0 }).take('other');
});

test('the backlog client: a 403 secondary limit pauses every client on the token, and no call reaches GitHub until it lifts', async () => {
  const dir = fresh();
  let calls = 0;
  const limited = (async () => {
    calls++;
    return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(inAnHour()) } });
  }) as typeof fetch;
  const ok = (async () => {
    calls++;
    return new Response(JSON.stringify({ number: 1, title: '', body: '', labels: [], user: null, state: 'open' }), { status: 200 });
  }) as typeof fetch;
  const budget = (t: string) => budgetFor(t, dir, { maxWaitMs: 0 });
  await assert.rejects(new GitHubBacklog('o/r', () => 'tok', limited, undefined, budget).get(1), (e: GitHubError) => e.kind === 'secondary_rate_limited');
  assert.equal(calls, 1);
  // A second client on the same token (another loop, another coordinator): refused before calling GitHub.
  await assert.rejects(new GitHubBacklog('o/r2', () => 'tok', ok, undefined, budget).get(1), (e: GitHubError) => e.kind === 'secondary_rate_limited' && e.status === 429 && (e.retryAfter ?? 0) > 50);
  assert.equal(calls, 1, 'the paused call never reached GitHub');
  // Another token is its own budget.
  await new GitHubBacklog('o/r', () => 'other', ok, undefined, budget).get(1);
  assert.equal(calls, 2);
  // A 429 with calls left in the window is a secondary limit too: it pauses the token the same way.
  const tooMany = (async () => {
    calls++;
    return new Response(JSON.stringify({ message: 'Too many requests' }), { status: 429, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(inAnHour()) } });
  }) as typeof fetch;
  await assert.rejects(new GitHubBacklog('o/r', () => 'tok429', tooMany, undefined, budget).get(1), (e: GitHubError) => e.kind === 'secondary_rate_limited');
  await assert.rejects(new GitHubBacklog('o/r2', () => 'tok429', ok, undefined, budget).get(1), (e: GitHubError) => e.kind === 'secondary_rate_limited' && (e.retryAfter ?? 0) > 20);
  assert.equal(calls, 3, 'the call after the 429 never reached GitHub');
});

test('the backlog client reads the rate headers of every response into the shared budget', async () => {
  const dir = fresh();
  const reset = inAnHour();
  let calls = 0;
  const f = (async () => (calls++, new Response('[]', { status: 200, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' } }))) as typeof fetch;
  const gh = new GitHubBacklog('o/r', () => 'tok', f, undefined, (t) => budgetFor(t, dir, { maxWaitMs: 0 }));
  await gh.openIssues();
  // Remaining 1 at GitHub: one more call goes, the one after is refused here.
  await gh.openIssues();
  await assert.rejects(gh.openIssues(), (e: GitHubError) => e.kind === 'rate_limited' && e.status === 429);
  assert.equal(calls, 2, 'the refused call never reached GitHub');
  const s = budgetFor('tok', dir).read();
  assert.equal(s.resources.core?.reset, reset);
  assert.equal(s.resources.core?.used.backlog, 2);
});

test('the state file is replaced, never written in place, and group-writable: a coordinator of another user can update it', async () => {
  if (process.platform === 'win32') return;
  const dir = fresh();
  const b = new GitHubBudget(credentialKey('token-f'), dir);
  seed(b, 10);
  const file = readdirSync(dir).find((f) => f.endsWith('.json'))!;
  assert.match(file, /^github-budget-[0-9a-f]{16}\.json$/, 'named by a hash of the token, never the token');
  assert.equal(statSync(join(dir, file)).mode & 0o777, 0o660);
  chmodSync(join(dir, file), 0o440); // as if another user's file: we can't write it, only replace it
  await b.take('x');
  assert.equal(b.read().resources.core?.remaining, 9);
});

test('an unreadable or corrupt state file starts afresh instead of stopping every GitHub call', async () => {
  const dir = fresh();
  const key = credentialKey('token-g');
  writeFileSync(join(dir, `github-budget-${key}.json`), '{not json');
  await new GitHubBudget(key, dir, { maxWaitMs: 0 }).take('x');
});

test('a state no real limit could produce never stops calls: each is taken as "not known" and the call goes', async () => {
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const tenYears = 10 * 365 * 86400;
  const hostile: [string, object][] = [
    ['a pause 10 years ahead', { resources: {}, pausedUntil: now + tenYears * 1000, pauseKind: 'secondary_rate_limited' }],
    ['none left, reset 10 years ahead', { resources: { core: { limit: 5000, remaining: 0, reset: nowS + tenYears, used: {} } }, pausedUntil: 0 }],
    ['none left, no reset', { resources: { core: { limit: 5000, remaining: 0, reset: null, used: {} } }, pausedUntil: 0 }],
    ['a pause at 1e300', { resources: {}, pausedUntil: 1e300 }],
    ['remaining not a number', { resources: { core: { limit: 5000, remaining: 'x', reset: nowS + 600, used: {} } }, pausedUntil: 0 }],
    ['remaining negative', { resources: { core: { limit: 5000, remaining: -5, reset: nowS + 600, used: {} } }, pausedUntil: 0 }],
  ];
  for (const [what, state] of hostile) {
    const dir = fresh();
    const key = credentialKey('token-h');
    writeFileSync(join(dir, `github-budget-${key}.json`), JSON.stringify(state));
    const t0 = Date.now();
    await new GitHubBudget(key, dir, { maxWaitMs: 0 }).take('x').catch((e: Error) => assert.fail(`${what}: ${e.message}`));
    assert.ok(Date.now() - t0 < 1000, `${what}: no spin`);
  }
  // A real pause still counts.
  const dir = fresh();
  const key = credentialKey('token-h');
  writeFileSync(join(dir, `github-budget-${key}.json`), JSON.stringify({ resources: {}, pausedUntil: now + 60_000 }));
  await assert.rejects(new GitHubBudget(key, dir, { maxWaitMs: 0 }).take('x'), BudgetPaused);
});

test('GitHub itself cannot set an endless pause or window: Retry-After is capped at 15 min, a far reset is ignored', async () => {
  const dir = fresh();
  const b = new GitHubBudget(credentialKey('token-i'), dir, { maxWaitMs: 0 });
  b.pause('secondary_rate_limited', 1e9);
  await assert.rejects(b.take('x'), (e: BudgetPaused) => e.retryAfter <= MAX_PAUSE_S && e.retryAfter > MAX_PAUSE_S - 5);
  const c = new GitHubBudget(credentialKey('token-j'), dir, { maxWaitMs: 0 });
  c.observe('core', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 10 * 3600) });
  await c.take('x');
});

test('a held budget lock never blocks the event loop; one stuck past a few seconds is broken', async () => {
  const dir = fresh();
  const key = credentialKey('token-k');
  const b = new GitHubBudget(key, dir, { maxWaitMs: 0 });
  const lock = join(dir, `github-budget-${key}.lock`);
  // Held now by a live process (this one's pid: alive everywhere): observe and pause give up at once.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'held', acquiredAt: new Date().toISOString() }));
  let t0 = Date.now();
  b.observe('core', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(inAnHour()) });
  b.pause('secondary_rate_limited', 60);
  assert.ok(Date.now() - t0 < 100, `observe and pause took ${Date.now() - t0} ms synchronously`);
  t0 = Date.now();
  await b.take('x'); // waits LOCK_WAIT_MS at most, then lets the call go
  assert.ok(Date.now() - t0 < 2000, `take waited ${Date.now() - t0} ms`);
  // Held for a minute by a "live" pid: stuck or planted. It is broken, and the budget works again.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'stuck', acquiredAt: new Date(Date.now() - 60_000).toISOString() }));
  seed(b, 10);
  assert.equal(b.read().resources.core?.remaining, 10);
  t0 = Date.now();
  await b.take('x');
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  assert.equal(b.read().resources.core?.remaining, 9);
  // Dated in the future: no real holder writes that, so it is broken too (else it would hold for good).
  writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'planted', acquiredAt: '3000-01-01T00:00:00.000Z' }));
  t0 = Date.now();
  await b.take('x');
  assert.ok(Date.now() - t0 < 200, `a future-dated lock cost ${Date.now() - t0} ms`);
  assert.equal(b.read().resources.core?.remaining, 8);
  assert.equal(existsSync(lock), false, 'the planted lock is gone');
});

test('state files of tokens no longer used are removed (App tokens rotate hourly); live ones are kept', async () => {
  const dir = fresh();
  const old = join(dir, `github-budget-${credentialKey('rotated-away')}.json`);
  const recent = join(dir, `github-budget-${credentialKey('still-used')}.json`);
  writeFileSync(old, JSON.stringify({ resources: {}, pausedUntil: 0 }));
  writeFileSync(recent, JSON.stringify({ resources: {}, pausedUntil: 0 }));
  const threeHoursAgo = (Date.now() - 3 * 3600_000) / 1000;
  utimesSync(old, threeHoursAgo, threeHoursAgo);
  await new GitHubBudget(credentialKey('current'), dir).take('x');
  assert.equal(existsSync(old), false, 'unchanged for 3 h: removed');
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(join(dir, `github-budget-${credentialKey('current')}.json`)), true);
});
