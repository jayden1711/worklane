// Issue #567: what each role learns of the agents' Claude account. The machine's owners see the accounts (the
// Machine page's panel); a writer gets the panel refused, and keeps what the design gives the people who fix a refused
// login (its name and Claude's words on the sign-in banner, the incident's detail); a viewer learns only whether an
// account is set: no email, org, plan or profile name on any route the engine names; someone signed out or with no
// role gets nothing. A refused login's hold names no account for anyone, the report posted on the repo included.
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
import { project } from '../src/projection.js';
import { buildReport } from '../src/reports.js';
import { ignoredIssues } from '../src/first-task.js';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { ACCOUNT, ACCOUNT_LOCAL, ACCOUNT_TEXT, accountDashboard, apiPaths, STRANGER } from './account-fixture.js';
import { asPerson, exampleProject } from './helpers.js';

const { accountSet } = profiles;
const { authHoldsOf, signinFailedView } = authFailure;
const { holdReason, SIGN_IN_HOLD_REASON } = holds;

const posix = process.platform !== 'win32';
/** The routes a viewer must get an answer with content from, here: each is read for the account like every other. */
const MUST_ANSWER = ['/api/state', '/api/usage', '/api/board', '/api/issues/ignored', '/api/events', '/api/health', '/api/health/incidents'];

test('#567: the routes read below are the engine\'s own, the ones this test names among them', () => {
  const paths = apiPaths();
  assert.ok(paths.length > 60, `${paths.length} literal /api/ paths found in src/`);
  for (const p of [...MUST_ANSWER, '/api/claude-account', '/api/report']) assert.ok(paths.includes(p), p);
});

test('#567, viewer: whether an account is set, and nothing that names it, on every /api/ path the engine names', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    const as = asPerson('someone-else');
    const answered: string[] = [];
    for (const path of apiPaths()) {
      const r = await get(path, as);
      if (r.status === 200) answered.push(path);
      assert.doesNotMatch(r.text, ACCOUNT_TEXT, `${path} (${r.status}) names the account to a viewer`);
    }
    for (const p of MUST_ANSWER) assert.ok(answered.includes(p), `${p} answered the viewer (${answered.length} did)`);
    assert.equal((await get('/api/claude-account', as)).status, 403, 'the accounts panel stays the machine owners');
    const state = JSON.parse((await get('/api/state', as)).text) as { claudeAccount?: unknown; governor: { held: boolean; reason: string; banner: { kind: string; numbers: string | null } } };
    assert.deepEqual(state.claudeAccount, { set: true }, 'a viewer learns that an account is set');
    assert.equal(state.governor.reason, SIGN_IN_HOLD_REASON, "the older hold's reason, in words that name no account");
    assert.equal(state.governor.banner.numbers, SIGN_IN_HOLD_REASON);
    // The Board and the ignored-issues list say why work is held, in the same words.
    const board = JSON.parse((await get('/api/board', as)).text) as { hold: { numbers: string } | null };
    assert.equal(board.hold?.numbers, SIGN_IN_HOLD_REASON);
    assert.match((await get('/api/issues/ignored', as)).text, new RegExp(`held: ${SIGN_IN_HOLD_REASON}`));
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
    const state = JSON.parse((await get('/api/state', as)).text) as { claudeAccount?: unknown; governor: { reason: string } };
    assert.deepEqual(state.claudeAccount, { set: true });
    assert.equal(state.governor.reason, SIGN_IN_HOLD_REASON, 'the hold names no account for anyone');
    const usage = JSON.parse((await get('/api/usage', as)).text) as { signinFailed: { login: string; detail: string; lastCheck: { detail: string } }[] };
    assert.equal(usage.signinFailed[0]!.login, ACCOUNT.email);
    assert.match(usage.signinFailed[0]!.detail, /OAuth token has expired/);
    assert.match(usage.signinFailed[0]!.lastCheck.detail, /still refused/);
    // #680: the incident's detail, which the ops channel is posted too, names no account for a writer: the account
    // is the machine owners' (the same check as the accounts panel). Its detail, tried and fix are still there.
    const incidents = await get('/api/health/incidents', as);
    assert.doesNotMatch(incidents.text, ACCOUNT_TEXT, incidents.text);
    assert.doesNotMatch(incidents.text, ACCOUNT_LOCAL, 'nor the email\'s local part');
    const red = (JSON.parse(incidents.text) as { open: { kind: string; detail?: string; ownerDetail?: string }[] }).open.find((x) => x.kind === 'claude_auth')!;
    assert.match(red.detail ?? '', /the default lane's login/, 'a writer still reads what broke');
    assert.equal(red.ownerDetail, undefined);
    // The report preview is the scheduled report, which is posted on the repo: it names no account.
    const report = await get('/api/report', as);
    assert.equal(report.status, 200);
    assert.match(report.text, /dispatch held 1 time\(s\): Claude sign-in failed: no new runs/);
    assert.doesNotMatch(report.text, ACCOUNT_TEXT);
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
    // #680: the Health page keeps the account for the machine owners: the red incident's detail names the login and
    // quotes Claude's words.
    const incidents = JSON.parse((await get('/api/health/incidents', as)).text) as { open: { kind: string; detail?: string; ownerDetail?: string }[] };
    const red = incidents.open.find((x) => x.kind === 'claude_auth')!;
    assert.match(red.detail ?? '', new RegExp(`${ACCOUNT.email.replace(/[.]/g, '\\.')}.*OAuth token has expired`));
    assert.equal(red.ownerDetail, undefined, 'one detail field, the owners\' in its place');
  } finally {
    await d.close();
  }
});

test("#680, an instance owner who isn't a machine owner: the Health page's incident names no account, as a writer's doesn't", { skip: !posix }, async () => {
  const { d, get } = await accountDashboard({ machineOwners: ['example-machine-admin'] });
  try {
    const as = asPerson('example-owner');
    assert.equal((await get('/api/claude-account', as)).status, 403, 'not a machine owner: the accounts panel is refused (#567)');
    const incidents = await get('/api/health/incidents', as);
    assert.match(incidents.text, /Claude sign-in is failing/);
    assert.doesNotMatch(incidents.text, ACCOUNT_TEXT, incidents.text);
    assert.doesNotMatch(incidents.text, ACCOUNT_LOCAL);
    const red = (JSON.parse(incidents.text) as { open: { kind: string; detail?: string }[] }).open.find((x) => x.kind === 'claude_auth')!;
    assert.match(red.detail ?? '', /the default lane's login/, 'what broke, as a writer reads it');
  } finally {
    await d.close();
  }
});

test('#567, signed out or with no role: every /api/ path refused, nothing of the account (nor that one is set)', { skip: !posix }, async () => {
  const { d, get } = await accountDashboard();
  try {
    for (const path of apiPaths()) {
      // Answered before anyone is asked who they are: /api/key-help tells someone on this machine where the key's file
      // is (never the key), and /api/role tells a person with no role that they have none (the hub leaves it out).
      const open = path === '/api/key-help' || path === '/api/role';
      const out = await get(path, null);
      if (!open) assert.notEqual(out.status, 200, `${path} with no key`);
      assert.doesNotMatch(out.text, ACCOUNT_TEXT);
      const none = await get(path, asPerson(STRANGER));
      if (!open) assert.notEqual(none.status, 200, `${path} for a person with no role`);
      assert.doesNotMatch(none.text, ACCOUNT_TEXT, path);
      assert.doesNotMatch(none.text, /claudeAccount/, path);
    }
  } finally {
    await d.close();
  }
});

const ev = (id: number, type: string, payload: Record<string, unknown>): StoredEvent => ({ id, ts: `2026-10-18T09:0${id}:00.000Z`, type, actor: 'coordinator', payload }) as unknown as StoredEvent;
const older = () => `Claude sign-in failed (${ACCOUNT.email}): no new runs until a call on that login succeeds`;

test('#567: every reader of a hold says a refused login\'s in fixed words: the state, Activity, the ignored list, the report', () => {
  // Recorded before #567 (its reason named the account), and before holds had kinds (#463 before #470).
  for (const hold of [{ reason: older(), load: null, free_disk_pct: null, kind: 'sign_in' }, { reason: older(), load: null, free_disk_pct: null }]) {
    const events = [ev(1, 'issue.seen', { issue: 1, title: 'Add price.js', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }), ev(2, 'governor.hold', hold)];
    // The report the coordinator posts on the repo (and the preview, /api/report).
    const { dir } = exampleProject();
    const report = buildReport(events, loadConfig(dir), { since: new Date('2026-10-18T00:00:00Z'), now: new Date('2026-10-18T12:00:00Z') }).markdown;
    assert.doesNotMatch(report, ACCOUNT_TEXT, 'the report posted on the repo');
    assert.match(report, /dispatch held 1 time\(s\): Claude sign-in failed: no new runs/);
    const ignored = ignoredIssues([{ number: 1, title: 'Add price.js', body: 'Add price.js.\n\n```done_when\n- test: test/price.test.js\n```\n', author: 'example-owner', labels: ['ready'] } as never], events, { repo: 'example-org/example-shop' });
    assert.doesNotMatch(JSON.stringify(ignored), ACCOUNT_TEXT, 'the ignored-issues list');
    assert.equal(ignored[0]?.reasons[0]?.text, 'held: Claude sign-in failed: no new runs until a call on the refused login succeeds');
    const p = project(events, '2026-10-18');
    assert.doesNotMatch(JSON.stringify(p), ACCOUNT_TEXT, 'the state and its Activity, for every role');
    assert.equal(p.governor?.reason, SIGN_IN_HOLD_REASON);
    assert.equal(holdReason(hold), SIGN_IN_HOLD_REASON);
  }
  // Every other hold keeps its own words.
  assert.equal(holdReason({ kind: 'disk_full', reason: 'paused: disk 97% full' }), 'paused: disk 97% full');
});

test('#567, the projections: a viewer state keeps only whether an account is set; the account events never reach a viewer', () => {
  const v = stateForViewer({ role: 'viewer', claudeAccount: { set: true, later: ACCOUNT.email } }) as { claudeAccount: unknown };
  assert.deepEqual(v.claudeAccount, { set: true }, 'a field added to it later stays the owners and writers');
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
