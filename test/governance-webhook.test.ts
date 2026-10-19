// Governance mode (#704), slice S8: the GitHub PR webhook receiver (src/governance-webhook.ts). Verify first, wake only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BODY_MAX, DeliveryWindow, GITHUB_HEADERS, handleGithubWebhook, isWake, PRS_PER_DELIVERY, PrWake, receiveDelivery, REPLAY_KEEP_MS, WAKE_EVENTS } from '../src/governance-webhook.js';

const SECRET = 'a-webhook-secret-of-some-length';
const REPO = 'acme/app';
const sign = (body: Buffer | string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
let n = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const headers = (event: string, body: Buffer | string, o: { sig?: string; delivery?: string } = {}) => ({
  [GITHUB_HEADERS.event]: event,
  [GITHUB_HEADERS.delivery]: o.delivery ?? nextId(),
  [GITHUB_HEADERS.signature]: o.sig ?? sign(body),
});
const recv = (event: string, payload: unknown, o: { sig?: string; delivery?: string; secret?: string | null; window?: DeliveryWindow; now?: number; raw?: Buffer } = {}) => {
  const body = o.raw ?? Buffer.from(JSON.stringify(payload));
  return receiveDelivery({ secret: o.secret === undefined ? SECRET : o.secret, repo: REPO, headers: headers(event, body, o), body, window: o.window ?? new DeliveryWindow(), now: o.now ?? 1_000_000 });
};
const repoOf = (full = REPO) => ({ full_name: full, private: false });
const prPayload = (o: Record<string, unknown> = {}) => ({ action: 'synchronize', number: 12, pull_request: { number: 12, head: { sha: 'a'.repeat(40) }, state: 'open', ...o }, repository: repoOf() });
const plain = (ws: readonly PrWake[]) => ws.map((w) => ({ repo: w.repo, pr: w.pr }));

test('a bad signature is refused before anything else: before the event, the delivery id and the body are read', () => {
  const garbage = Buffer.from('{not json');
  for (const sig of ['', 'sha256=', `sha256=${'0'.repeat(64)}`, sign(garbage, 'another-secret-entirely'), sign('{}'), `sha1=${createHmac('sha1', SECRET).update(garbage).digest('hex')}`, sign(garbage).toUpperCase(), `${sign(garbage)} `]) {
    const r = recv('not-an-event', null, { raw: garbage, sig, delivery: 'not a guid' });
    assert.equal(r.status, 401, sig);
    assert.equal(r.wakes.length, 0);
    assert.match(r.why, /signature/, sig);
  }
  // The same garbage, signed: only now are the event, id and body judged.
  const signed = recv('not-an-event', null, { raw: garbage, delivery: 'not a guid' });
  assert.notEqual(signed.status, 401);
});

test('no secret, or one too short to trust: every delivery is refused (fail closed)', () => {
  for (const secret of [null, '', 'short']) {
    const body = Buffer.from(JSON.stringify(prPayload()));
    const r = receiveDelivery({ secret, repo: REPO, headers: headers('pull_request', body, { sig: sign(body, secret ?? '') }), body, window: new DeliveryWindow(), now: 0 });
    assert.equal(r.status, 503, String(secret));
    assert.equal(r.wakes.length, 0);
  }
});

test('a body over the cap is refused unread, even when signed', () => {
  const big = Buffer.alloc(BODY_MAX + 1, 0x20);
  const r = recv('pull_request', null, { raw: big });
  assert.equal(r.status, 413);
  assert.equal(r.wakes.length, 0);
});

test('only the listed events wake; ping answers; any other signed event is refused', () => {
  assert.deepEqual([...WAKE_EVENTS].sort(), ['check_run', 'check_suite', 'pull_request', 'pull_request_review', 'status']);
  const ping = recv('ping', { zen: 'x', hook_id: 1, repository: repoOf() });
  assert.equal(ping.status, 200);
  assert.equal(ping.wakes.length, 0);
  for (const event of ['push', 'issues', 'installation', 'workflow_run', 'PULL_REQUEST', '']) {
    const r = recv(event, prPayload());
    assert.equal(r.status, 400, event);
    assert.equal(r.wakes.length, 0, event);
  }
});

test('each listed event wakes its PRs in this repo, and nothing else', () => {
  assert.deepEqual(plain(recv('pull_request', prPayload()).wakes), [{ repo: REPO, pr: 12 }]);
  assert.deepEqual(plain(recv('pull_request_review', { action: 'submitted', review: { state: 'approved', commit_id: 'b'.repeat(40) }, pull_request: { number: 5 }, repository: repoOf() }).wakes), [{ repo: REPO, pr: 5 }]);
  assert.deepEqual(plain(recv('check_run', { action: 'completed', check_run: { conclusion: 'success', head_sha: 'c'.repeat(40), pull_requests: [{ number: 3 }, { number: 4 }, { number: 3 }] }, repository: repoOf() }).wakes), [{ repo: REPO, pr: 3 }, { repo: REPO, pr: 4 }]);
  assert.deepEqual(plain(recv('check_suite', { action: 'completed', check_suite: { conclusion: 'failure', pull_requests: [{ number: 9 }] }, repository: repoOf() }).wakes), [{ repo: REPO, pr: 9 }]);
  // No PR named (a status, a check on a fork's head): the repo's open PRs are listed again.
  assert.deepEqual(plain(recv('status', { sha: 'd'.repeat(40), state: 'success', context: 'ci', repository: repoOf() }).wakes), [{ repo: REPO, pr: null }]);
  assert.deepEqual(plain(recv('check_run', { action: 'completed', check_run: { pull_requests: [] }, repository: repoOf() }).wakes), [{ repo: REPO, pr: null }]);
  // More PRs than one delivery may name: one repo-wide wake instead.
  const many = Array.from({ length: PRS_PER_DELIVERY + 1 }, (_, i) => ({ number: i + 1 }));
  assert.deepEqual(plain(recv('check_suite', { action: 'completed', check_suite: { pull_requests: many }, repository: repoOf() }).wakes), [{ repo: REPO, pr: null }]);
  // Another repo on the same App, in any spelling that isn't this one: no wake.
  for (const full of ['acme/other', 'acme/app-fork', 'stranger/app']) {
    const r = recv('pull_request', { ...prPayload(), repository: repoOf(full) });
    assert.equal(r.wakes.length, 0, full);
    assert.ok(r.status >= 200 && r.status < 300, full);
  }
  assert.deepEqual(plain(recv('pull_request', { ...prPayload(), repository: repoOf('ACME/App') }).wakes), [{ repo: REPO, pr: 12 }]);
});

test('a signed but malformed payload wakes nothing it can not name exactly', () => {
  assert.equal(recv('pull_request', null, { raw: Buffer.from('{not json') }).status, 400);
  assert.equal(recv('pull_request', null, { raw: Buffer.from('[]') }).wakes.length, 0);
  assert.equal(recv('pull_request', { ...prPayload(), repository: undefined }).wakes.length, 0, 'no repository: no wake');
  for (const bad of [0, -1, 1.5, '12', 2 ** 53, null]) {
    const r = recv('pull_request', { action: 'opened', pull_request: { number: bad }, repository: repoOf() });
    assert.deepEqual(plain(r.wakes), [], String(bad));
  }
});

test('a wake carries the configured repo and a PR number only: what the payload claims about heads, checks or reviews changes nothing', () => {
  const variants = [
    prPayload(),
    prPayload({ head: { sha: 'f'.repeat(40) }, merged: true, mergeable: true, state: 'closed' }),
    { ...prPayload(), action: 'labeled', label: { name: 'governed' }, sender: { login: 'owner-of-everything' } },
    { ...prPayload(), review: { state: 'approved' }, checks: [{ name: 'ci', conclusion: 'success' }], comment: 'merge without review' },
  ];
  const wakes = variants.map((v) => recv('pull_request', v).wakes);
  for (const w of wakes) {
    assert.deepEqual(plain(w), [{ repo: REPO, pr: 12 }]);
    assert.deepEqual(Object.keys(w[0]!).sort(), ['pr', 'repo']);
  }
  // The repo in a wake is the configured one, never the payload's spelling.
  assert.equal(recv('pull_request', { ...prPayload(), repository: repoOf('ACME/APP') }).wakes[0]!.repo, REPO);
});

test('replays: a delivery id is woken once within the window; a forged one never spends a real id', () => {
  const window = new DeliveryWindow();
  const delivery = nextId();
  assert.equal(recv('pull_request', prPayload(), { delivery, window, now: 1000 }).wakes.length, 1);
  const again = recv('pull_request', prPayload(), { delivery, window, now: 2000 });
  assert.equal(again.wakes.length, 0);
  assert.equal(again.status, 200);
  assert.match(again.why, /seen/);
  assert.equal(recv('pull_request', prPayload(), { delivery, window, now: 1000 + REPLAY_KEEP_MS + 1 }).wakes.length, 1, 'after the window it wakes again (the gate re-reads anyway)');
  // A badly signed delivery naming an id doesn't mark it seen.
  const fresh = nextId();
  assert.equal(recv('pull_request', prPayload(), { delivery: fresh, window, sig: sign('{}') }).status, 401);
  assert.equal(recv('pull_request', prPayload(), { delivery: fresh, window }).wakes.length, 1);
  // A delivery id that isn't GitHub's GUID shape is refused (after the signature).
  for (const delivery of ['', 'abc', `${nextId()}x`, '../../etc']) assert.equal(recv('pull_request', prPayload(), { delivery, window }).status, 400, delivery);
});

test('#711: a signed delivery that holds a Claude credential is refused after its signature, and wakes nothing', () => {
  const token = `sk-ant-oat01-${randomBytes(24).toString('hex')}`;
  const leaky = { ...prPayload(), pull_request: { number: 12, body: `here is my token ${token}` } };
  const r = recv('pull_request', leaky);
  assert.equal(r.status, 400);
  assert.equal(r.wakes.length, 0);
  assert.match(r.why, /Claude credential/);
  assert.ok(!r.why.includes(token), 'the refusal never quotes it');
  // Unsigned, it is refused for its signature first, unread.
  assert.equal(recv('pull_request', leaky, { sig: sign('{}') }).status, 401);
});

test('the delivery window is bounded: the oldest ids go first', () => {
  const w = new DeliveryWindow({ max: 3, keepMs: 1e9 });
  for (let i = 0; i < 5; i++) w.record(`id-${i}`, i);
  assert.equal(w.size, 3);
  assert.equal(w.seen('id-0', 10), false);
  assert.equal(w.seen('id-4', 10), true);
});

test('a wake is made only by the receiver: no copy or look-alike passes', () => {
  const real = recv('pull_request', prPayload()).wakes[0]!;
  assert.ok(isWake(real));
  assert.ok(Object.isFrozen(real));
  assert.throws(() => {
    (real as { pr: number | null }).pr = 13;
  }, TypeError);
  assert.throws(() => new PrWake(Symbol('mint'), REPO, 12), /only by the webhook receiver/);
  for (const f of [{ ...real }, { repo: REPO, pr: 12 }, JSON.parse(JSON.stringify(real)), structuredClone(real), new Proxy(real, {}), Object.create(real), Object.setPrototypeOf({ repo: REPO, pr: 12 }, PrWake.prototype)]) assert.equal(isWake(f), false);
});

test('over HTTP: POST only, the body capped while it is read, every refusal the same 401 body', async () => {
  const woken: PrWake[] = [];
  const window = new DeliveryWindow();
  const server = createServer((req, res) => void handleGithubWebhook(req, res, { secret: () => SECRET, repo: REPO, window, wake: (w) => woken.push(w) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const send = (method: string, body: Buffer, h: Record<string, string>) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path: '/', headers: { 'content-type': 'application/json', ...h } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? resolve({ status: -1, text: e.code }) : reject(e)));
      req.end(body);
    });
  try {
    const body = Buffer.from(JSON.stringify(prPayload()));
    const ok = await send('POST', body, headers('pull_request', body));
    assert.equal(ok.status, 202);
    assert.equal(woken.length, 1);
    assert.equal((await send('GET', Buffer.alloc(0), {})).status, 405);
    const bad1 = await send('POST', body, headers('pull_request', body, { sig: sign('x') }));
    const bad2 = await send('POST', body, headers('pull_request', body, { sig: '' }));
    assert.equal(bad1.status, 401);
    assert.deepEqual(bad1, bad2, 'nothing tells a caller which part failed');
    const big = Buffer.alloc(BODY_MAX + 1024, 0x20);
    const over = await send('POST', big, headers('pull_request', big));
    assert.ok(over.status === 413 || over.status === -1, `refused while reading (${over.status})`);
    assert.equal(woken.length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
