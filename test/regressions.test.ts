// Day-one regression tests for bugs seen in another harness (docs/design.md §17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGitHubCheck, gate, tally } from '../src/checks/outcome.js';
import { classifyGitHubError } from '../src/github/errors.js';

test('regression: cancelled or skipped CI checks are never counted as green', () => {
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out', 'stale', 'startup_failure', 'failure', null, 'something-new']) {
    assert.equal(classifyGitHubCheck({ name: 'ci', status: 'completed', conclusion }), 'fail', `conclusion ${conclusion}`);
  }
  assert.equal(classifyGitHubCheck({ name: 'ci', status: 'completed', conclusion: 'success' }), 'pass');
  for (const state of ['failure', 'error']) assert.equal(classifyGitHubCheck({ name: 's', state }), 'fail');

  assert.equal(gate(['ci'], [{ name: 'ci', status: 'completed', conclusion: 'skipped' }]).outcome, 'fail');
  assert.equal(gate(['ci'], [{ name: 'ci', status: 'completed', conclusion: 'cancelled' }]).outcome, 'fail');
  // A required check that never reported is missing, which fails the gate.
  const missing = gate(['ci', 'lint'], [{ name: 'ci', status: 'completed', conclusion: 'success' }]);
  assert.equal(missing.outcome, 'fail');
  assert.deepEqual(missing.missing, ['lint']);
  // A re-run that passed doesn't hide an earlier cancelled run of the same check.
  assert.equal(
    gate(['ci'], [
      { name: 'ci', status: 'completed', conclusion: 'cancelled' },
      { name: 'ci', status: 'completed', conclusion: 'success' },
    ]).outcome,
    'fail',
  );
  assert.equal(gate(['ci'], [{ name: 'ci', status: 'completed', conclusion: 'success' }]).outcome, 'pass');
});

test('regression: a hold is not counted as a failure', () => {
  assert.equal(classifyGitHubCheck({ name: 'ci', status: 'in_progress' }), 'hold');
  assert.equal(classifyGitHubCheck({ name: 'ci', status: 'queued' }), 'hold');
  assert.equal(classifyGitHubCheck({ name: 'deploy', status: 'completed', conclusion: 'action_required' }), 'hold');
  assert.equal(classifyGitHubCheck({ name: 's', state: 'pending' }), 'hold');
  const g = gate(['ci'], [{ name: 'ci', status: 'waiting' }]);
  assert.equal(g.outcome, 'hold');
  assert.deepEqual(g.failed, []);
  assert.deepEqual(tally(['pass', 'hold', 'hold', 'fail']), { pass: 1, fail: 1, hold: 2 });
});

test('regression: a 403 is classified by cause, not reported as a missing permission', () => {
  const now = Math.floor(Date.now() / 1000);
  const cases: [Parameters<typeof classifyGitHubError>, string][] = [
    [[403, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(now + 120) }, { message: 'API rate limit exceeded for user ID 1.' }], 'rate_limited'],
    [[403, { 'Retry-After': '60' }, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }], 'secondary_rate_limited'],
    [[429, { 'Retry-After': '30', 'X-RateLimit-Remaining': '4000' }, { message: 'Too many requests' }], 'secondary_rate_limited'],
    [[403, { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso?authorization_request=x' }, { message: 'Resource protected by organization SAML enforcement.' }], 'sso_required'],
    [[403, {}, { message: 'Repository access blocked' }], 'repo_blocked'],
    [[403, { 'X-Accepted-OAuth-Scopes': 'repo', 'X-OAuth-Scopes': 'read:org' }, { message: 'Forbidden' }], 'insufficient_scope'],
    [[403, {}, { message: 'Resource not accessible by integration' }], 'insufficient_role'],
    [[403, {}, { message: 'Must have admin rights to Repository.' }], 'insufficient_role'],
    [[403, {}, { message: 'Forbidden' }], 'forbidden'],
    [[404, {}, { message: 'Not Found' }], 'not_found'],
    [[401, {}, { message: 'Bad credentials' }], 'unauthenticated'],
  ];
  for (const [args, kind] of cases) assert.equal(classifyGitHubError(...args).kind, kind, JSON.stringify(args[2]));

  const rl = classifyGitHubError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 120) }, { message: 'API rate limit exceeded' });
  assert.equal(rl.retryable, true);
  assert.ok(rl.retryAfter! > 100 && rl.retryAfter! <= 120);
  // Rate limits are retryable; permission problems are not, and neither is labeled the other.
  assert.equal(classifyGitHubError(403, {}, { message: 'Resource not accessible by integration' }).retryable, false);
});
