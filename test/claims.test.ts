import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claim, readClaim, release, renew, type Lease } from '../src/claims.js';

/** A bare "GitHub" remote and two independent clones: two humans' coordinators. */
function twoInstances() {
  const base = mkdtempSync(join(tmpdir(), 'claims-'));
  const remote = join(base, 'remote.git');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(base, 'init', '-q', '--bare', remote);
  const clones = ['alice', 'bob'].map((who) => {
    const dir = join(base, who);
    g(base, 'clone', '-q', remote, dir);
    return dir;
  });
  return { a: { repo: clones[0]! }, b: { repo: clones[1]! } };
}

const lease = (instance: string, issue = 7, expiresInMs = 600_000): Lease => ({
  instance,
  run_id: `${instance}-run`,
  issue,
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  base: 'abc1234',
});

test('two coordinators race for an issue: exactly one wins, the loser sees the holder', () => {
  const { a, b } = twoInstances();
  const ra = claim(lease('alice'), a);
  const rb = claim(lease('bob'), b);
  assert.equal(ra.won, true);
  assert.equal(rb.won, false);
  assert.equal(!rb.won && rb.holder?.instance, 'alice');
  assert.equal(readClaim(7, b)?.lease.instance, 'alice');
});

test('renew needs the current lease; a stale renew is rejected', () => {
  const { a, b } = twoInstances();
  const r = claim(lease('alice'), a);
  assert.ok(r.won);
  const next = renew(lease('alice'), r.sha, a);
  assert.ok(next);
  assert.equal(renew(lease('alice'), r.sha, a), null, 'renewing from an old lease fails');
  assert.equal(renew(lease('bob'), r.sha, b), null);
});

test('an expired lease is taken over by exactly one stealer; a live one never is', () => {
  const { a, b } = twoInstances();
  const r = claim(lease('alice', 7, -10 * 60_000), a); // already expired
  assert.ok(r.won);
  const stolen = claim(lease('bob'), b);
  assert.equal(stolen.won, true);
  assert.equal(readClaim(7, a)?.lease.instance, 'bob');
  // Alice's old lease is gone, so she can't renew or release with it.
  assert.equal(renew(lease('alice'), r.sha, a), null);
  assert.equal(release(7, r.sha, a), false);
  // Bob's lease is live: nobody can take it.
  assert.equal(claim(lease('alice'), a).won, false);
});

test('release needs the current lease, then the issue is claimable again', () => {
  const { a, b } = twoInstances();
  const r = claim(lease('alice'), a);
  assert.ok(r.won);
  assert.equal(release(7, 'f'.repeat(40), b), false, 'wrong lease cannot release');
  assert.equal(release(7, r.sha, a), true);
  assert.equal(readClaim(7, a), null);
  assert.equal(claim(lease('bob'), b).won, true);
});
