// Issue #567: what each role learns of the agents' Claude account. The machine's owners see the accounts (the
// Machine page's panel); a writer gets the panel refused, and keeps what the design gives the people who fix a refused
// login (its name and Claude's words on the sign-in banner, the incident's detail); a viewer learns only whether an
// account is set: no email, org, plan or profile name anywhere the server sends them; someone signed out or with no
// role gets nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace imports: run against an engine without #567, each test fails on its own assertions, not the file on a
// missing export.
import * as profiles from '../src/claude-profiles.js';
import * as authFailure from '../src/claude-auth-failure.js';
import * as holds from '../src/governor-holds.js';
import { forViewer, stateForViewer, viewerMaySee } from '../src/viewer-events.js';
import type { StoredEvent } from '../src/events/types.js';
import { ACCOUNT, ACCOUNT_TEXT, accountDashboard, STRANGER } from './account-fixture.js';
import { asPerson } from './helpers.js';

const { accountSet } = profiles;
const { authHoldsOf, signinFailedView } = authFailure;
const { holdBanner, SIGN_IN_HOLD_REASON } = holds;

const posix = process.platform !== 'win32';
/** Every route that serves a viewer something about this instance's state, health or usage. */
const VIEWER_PATHS = ['/api/state', '/api/usage', '/api/events', '/api/health/incidents', '/api/health', '/api/claude-account'];

test('#567, viewer: whether an account is set, and nothing that names it, on every route a viewer reads', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    const as = asPerson('someone-else');
    for (const path of VIEWER_PATHS) {
      const r = await get(path, as);
      assert.doesNotMatch(r.text, ACCOUNT_TEXT, `${path} (${r.status}) names the account to a viewer`);
    }
    assert.equal((await get('/api/claude-account', as)).status, 403, 'the accounts panel stays the machine owners');
    const state = JSON.parse((await get('/api/state', as)).text) as { claudeAccount?: unknown; governor: { held: boolean; reason: string; banner: { kind: string; numbers: string | null } } };
    assert.deepEqual(state.claudeAccount, { set: true }, 'a viewer learns that an account is set');
    assert.equal(state.governor.reason, SIGN_IN_HOLD_REASON, "the older hold's reason, in words that name no account");
    assert.equal(state.governor.banner.numbers, SIGN_IN_HOLD_REASON);
    const usage = JSON.parse((await get('/api/usage', as)).text) as { signinFailed: Record<string, unknown>[] };
    assert.equal(usage.signinFailed.length, 1, 'that a login was refused is still shown (no new runs)');
    assert.deepEqual(Object.keys(usage.signinFailed[0]!).sort(), ['lastCheck', 'since']);
    assert.deepEqual(Object.keys(usage.signinFailed[0]!.lastCheck as object).sort(), ['at', 'ok']);
    // The red incident is there, by its fixed title only.
    assert.match((await get('/api/health/incidents', as)).text, /Claude sign-in is failing/);
  } finally {
    await d.close();
  }
});

test('#567, writer: the accounts panel refused; the sign-in banner keeps the login and Claude\'s words (to fix it); that an account is set', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    const as = asPerson('example-collaborator');
    const panel = await get('/api/claude-account', as);
    assert.equal(panel.status, 403);
    assert.doesNotMatch(panel.text, ACCOUNT_TEXT);
    const state = JSON.parse((await get('/api/state', as)).text) as { claudeAccount?: unknown };
    assert.deepEqual(state.claudeAccount, { set: true });
    const usage = JSON.parse((await get('/api/usage', as)).text) as { signinFailed: { login: string; detail: string; lastCheck: { detail: string } }[] };
    assert.equal(usage.signinFailed[0]!.login, ACCOUNT.email);
    assert.match(usage.signinFailed[0]!.detail, /OAuth token has expired/);
    assert.match(usage.signinFailed[0]!.lastCheck.detail, /still refused/);
    // The incident's detail names the login too, as the design gives a writer every incident's detail.
    assert.match((await get('/api/health/incidents', as)).text, new RegExp(ACCOUNT.email.replace(/[.]/g, '\\.')));
  } finally {
    await d.close();
  }
});

test('#567, owner who is a machine owner: the accounts panel with the email, plan and profile; the sign-in banner with the login', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    const as = asPerson('example-owner');
    const panel = await get('/api/claude-account', as);
    assert.equal(panel.status, 200);
    assert.match(panel.text, new RegExp(ACCOUNT.email.replace(/[.]/g, '\\.')));
    assert.match(panel.text, new RegExp(ACCOUNT.plan));
    assert.match(panel.text, new RegExp(ACCOUNT.profile));
    const state = JSON.parse((await get('/api/state', as)).text) as { claudeAccount?: unknown };
    assert.deepEqual(state.claudeAccount, { set: true });
    const usage = JSON.parse((await get('/api/usage', as)).text) as { signinFailed: { login: string }[]; canRecheckSignin: boolean };
    assert.equal(usage.signinFailed[0]!.login, ACCOUNT.email);
    assert.equal(usage.canRecheckSignin, true);
  } finally {
    await d.close();
  }
});

test('#567, signed out or with no role: every route refused, nothing of the account (nor that one is set)', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    for (const path of VIEWER_PATHS) {
      const out = await get(path, null);
      assert.equal(out.status, 401, `${path} with no key`);
      assert.doesNotMatch(out.text, ACCOUNT_TEXT);
      const none = await get(path, asPerson(STRANGER));
      assert.equal(none.status, 403, `${path} for a person with no role`);
      assert.doesNotMatch(none.text, ACCOUNT_TEXT);
      assert.doesNotMatch(none.text, /claudeAccount/);
    }
  } finally {
    await d.close();
  }
});

const ev = (id: number, type: string, payload: Record<string, unknown>): StoredEvent => ({ id, ts: `2026-10-18T09:0${id}:00.000Z`, type, actor: 'coordinator', payload }) as unknown as StoredEvent;

test('#567, the projections: a viewer state keeps whether an account is set and a refused login\'s hold in fixed words; the account events never reach a viewer', () => {
  const older = `Claude sign-in failed (${ACCOUNT.email}): no new runs until a call on that login succeeds`;
  const banner = holdBanner({ kind: 'sign_in', reason: older }, '2026-10-18T09:00:00Z');
  const full = { role: 'viewer', claudeAccount: { set: true }, governor: { held: true, reason: older, load: null, freeDiskPct: null, at: '2026-10-18T09:00:00Z', banner } };
  const v = stateForViewer(full) as typeof full;
  assert.deepEqual(v.claudeAccount, { set: true });
  assert.equal(v.governor.reason, SIGN_IN_HOLD_REASON);
  assert.equal(v.governor.banner.numbers, SIGN_IN_HOLD_REASON);
  assert.equal(v.governor.banner.title, 'Claude sign-in failed: no new runs');
  assert.doesNotMatch(JSON.stringify(v), ACCOUNT_TEXT);
  // Another hold keeps its reason and numbers (only a refused login's name the account).
  const disk = stateForViewer({ governor: { held: true, reason: 'paused: disk 97% full', banner: holdBanner({ kind: 'disk_full', reason: 'paused: disk 97% full' }, 'x') } }) as { governor: { reason: string; banner: { numbers: string } } };
  assert.equal(disk.governor.reason, 'paused: disk 97% full');
  assert.equal(disk.governor.banner.numbers, 'disk 97% full');
  // The account's events (who switched to which profile, failover, a refused login) are never a viewer's, nor the
  // live stream's change notice to a viewer (it names only the types viewerMaySee allows).
  for (const type of ['account.switched', 'account.failover', 'claude_auth.failed', 'claude_auth.checked', 'claude_auth.recovered', 'claude_account.refused', 'governor.hold', 'machine.claude_account', 'usage.paused']) {
    assert.equal(viewerMaySee(type), false, type);
    assert.equal(forViewer(ev(1, type, { to: ACCOUNT.profile, login: ACCOUNT.email })), null, type);
  }
  // The sign-in banner's data: everything for the owners and writers, only that it happened for a viewer.
  const [hold] = authHoldsOf([
    ev(1, 'claude_auth.failed', { key: 'k', login: ACCOUNT.email, lane: 'default', issue: null, role: 'worker', detail: `refused for ${ACCOUNT.email}` }),
    ev(2, 'claude_auth.checked', { key: 'k', login: ACCOUNT.email, ok: false, by: 'timer', detail: `still refused for ${ACCOUNT.email}`, cost_usd: 0 }),
  ]);
  assert.deepEqual(signinFailedView(hold!, false), { since: hold!.since, lastCheck: { at: hold!.lastCheck!.at, ok: false } });
  assert.deepEqual(signinFailedView(hold!, true), { login: ACCOUNT.email, detail: `refused for ${ACCOUNT.email}`, since: hold!.since, lastCheck: hold!.lastCheck });
});

test('#567: an account is set on a confirmed profile, or when the default login was last found signed in; not known with no record', () => {
  const dir = (profiles: unknown, users: unknown[] | null) => {
    const d = mkdtempSync(join(tmpdir(), 'account-set-'));
    writeFileSync(join(d, 'profiles.json'), JSON.stringify(profiles));
    if (users) writeFileSync(join(d, 'status.json'), JSON.stringify({ at: '2026-10-18T00:00:00Z', users }));
    return d;
  };
  const agent = (logged_in: boolean, instance = 'shop') => ({ instance, kind: 'agent', user: `wl-${instance}-agent`, logged_in });
  assert.equal(accountSet('shop', dir({}, [agent(true)])), true, 'default, signed in');
  assert.equal(accountSet('shop', dir({}, [agent(false)])), false, 'default, signed out');
  assert.equal(accountSet('shop', dir({}, [agent(true, 'other'), { ...agent(true), kind: 'eval' }])), null, "no record of this instance's agent user");
  assert.equal(accountSet('shop', dir({}, null)), null, 'no status yet');
  const work = { profiles: { work: { kind: 'setup-token', users: {} } }, active: { shop: { profile: 'work', since: 'x' } } };
  assert.equal(accountSet('shop', dir(work, null)), true, 'on a confirmed profile');
  const staged = { profiles: { work: { kind: 'setup-token', users: {}, staged: true } }, active: { shop: { profile: 'work', since: 'x' } } };
  assert.equal(accountSet('shop', dir(staged, [agent(false)])), false, 'a staged profile is never in use: the default login is');
});
