// Issue #902 round 12: under a name reserved since (machine, console), root's first takeover of a loose policy works.
// `policy own <n> --accept-loose` with no record yet makes the coordinator's file root's (its coordinator can no longer
// write it), after which root tightens it. Only `--retake` (a recorded file changed since root wrote it) stays refused,
// and only there do the messages name the instance's removal instead (src/policy-gate.ts retakeClause).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ownCommand, retakeClause, setPolicyRootUid } from '../src/policy-gate.js';
import { ownPolicy, setPolicy, type PolicyRootDeps } from '../src/policy-root.js';

const linux = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';

test('#902 round 12: a first takeover of a loose policy under console works with --accept-loose; root then tightens it', { skip: linux }, () => {
  const me = process.getuid!();
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-first-')));
  const dir = join(T, 'home', 'wl-console', '.local', 'state', BRAND.cli, 'instances', 'console');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'policy.yaml');
  // The coordinator's own file, looser than its coordinator could make it now, and no record of root's yet.
  writeFileSync(file, 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: direct\nauto_merge: true\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === 'wl-console' ? join(T, 'home', 'wl-console') : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  setPolicyRootUid(me);
  try {
    assert.throws(() => ownPolicy('console', deps), /looser than its coordinator could make it/, 'without the flag: left as it is');
    const r = ownPolicy('console', deps, { acceptLoose: true });
    assert.deepEqual(r.loose.length > 0, true, 'what an admin should check is named');
    assert.equal(statSync(file).mode & 0o777, 0o644, "root's now");
    assert.deepEqual(setPolicy('console', 'land_mode', 'pr', null, deps), { key: 'land_mode', from: 'direct', to: 'pr' });
    assert.deepEqual(setPolicy('console', 'budget.daily_usd', '30', null, deps), { key: 'budget.daily_usd', from: 80, to: 30 });
    assert.throws(() => setPolicy('console', 'budget.daily_usd', '80', null, deps), /only tightens/, 'and never looser again');
  } finally {
    setPolicyRootUid(0);
  }
});

test('#902 rounds 11, 12: for a name reserved since, the messages name the instance\'s removal only where --retake would be needed', () => {
  const remove = /^removes the instance with sudo bash \S*instance-remove\.sh console \(/;
  for (const flags of [[], ['--accept-loose']] as const) {
    assert.match(retakeClause('console', (c) => `runs ${c}`, ...flags), remove, flags.join(' '));
    assert.doesNotMatch(retakeClause('console', (c) => `runs ${c}`, ...flags), /policy own/, flags.join(' '));
  }
  assert.equal(ownCommand('console', '--accept-loose'), `sudo ${BRAND.cli} policy own console --accept-loose`);
  assert.equal(ownCommand('console'), `sudo ${BRAND.cli} policy own console`);
  assert.equal(retakeClause('alpha', (c) => `runs ${c}`, '--accept-loose'), `runs sudo ${BRAND.cli} policy own alpha --retake --accept-loose`);
});
