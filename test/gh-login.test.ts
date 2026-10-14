// WHY: Connect GitHub (src/gh-login.ts) runs gh's device login for the person and relays its one-time code. It must
// show only that code and GitHub's device page, never anything token-shaped; count as done only once `gh auth status`
// agrees; and through the dashboard, run for the owners only, audited without the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard, type DashboardOptions } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { GH_DEVICE_URL, GH_LOGIN_ARGS, GhLogin, GhLoginError, safeLine, type GhLoginDeps, type LoginChild } from '../src/gh-login.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { SETUP_STEPS } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'gh-login-state-'));

const TOKEN = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';

/** A stand-in gh: its output written by the test, its exit chosen by the test. */
function fakeGh() {
  const children: (LoginChild & { emitter: EventEmitter; out: PassThrough; err: PassThrough; killed: boolean; exit: (code: number | null) => void })[] = [];
  let signedIn = false;
  let statusCalls = 0;
  const deps: Partial<GhLoginDeps> = {
    spawn: () => {
      const emitter = new EventEmitter();
      const out = new PassThrough();
      const err = new PassThrough();
      const c = {
        emitter,
        out,
        err,
        killed: false,
        stdout: out,
        stderr: err,
        on: (e: string, cb: (...a: never[]) => void) => emitter.on(e, cb as (...a: unknown[]) => void),
        kill: () => {
          c.killed = true;
        },
        exit: (code: number | null) => emitter.emit('close', code),
      };
      children.push(c as never);
      return c as unknown as LoginChild;
    },
    status: () => {
      statusCalls++;
      return signedIn ? 0 : 1;
    },
    installed: () => true,
  };
  return {
    deps,
    children,
    signIn: () => void (signedIn = true),
    get statusCalls() {
      return statusCalls;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('the relay: only the one-time code and the device URL reach the page; done once gh exits 0 and gh auth status agrees', async () => {
  const g = fakeGh();
  let t = 1_000;
  const l = new GhLogin({ ...g.deps, now: () => t, timeoutMs: 60_000 });
  assert.equal(l.view().state, 'idle');
  const v0 = l.start();
  assert.equal(v0.state, 'waiting');
  assert.equal(v0.code, null);
  // gh's real output (stderr, stdin closed), with a token-shaped string thrown in: it must never come back.
  g.children[0]!.err.write(`\n! First copy your one-time code: E286-95A6\nOpen this URL to continue in your web browser: ${GH_DEVICE_URL}\n${TOKEN}\n`);
  await tick();
  const v1 = l.view();
  assert.equal(v1.code, 'E286-95A6');
  assert.equal(v1.url, GH_DEVICE_URL);
  assert.doesNotMatch(JSON.stringify(v1), /gho_/);
  assert.throws(() => l.start(), (e: unknown) => e instanceof GhLoginError && e.status === 409, 'one at a time');
  // gh exits 0, but status disagrees: not done.
  g.children[0]!.exit(0);
  assert.equal(l.view().state, 'failed');
  assert.doesNotMatch(JSON.stringify(l.view()), /gho_|E286/, 'a failure line is masked and never the code');
  // Again, and this time GitHub has the code.
  t += 10_000;
  l.start();
  g.children[1]!.err.write('! First copy your one-time code: ABCD-1234\n');
  await tick();
  g.signIn();
  g.children[1]!.exit(0);
  const done = l.view();
  assert.equal(done.state, 'done');
  assert.equal(done.code, null, 'the code is gone once it is used');
  assert.deepEqual([...GH_LOGIN_ARGS], ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https']);
});

test('the relay: a login finished elsewhere counts (polled gh auth status, at most every 3 s), and stops the waiting gh; cancel; expiry', async () => {
  const g = fakeGh();
  let t = 0;
  const l = new GhLogin({ ...g.deps, now: () => t, timeoutMs: 50 });
  l.start();
  const calls = g.statusCalls;
  l.poll();
  assert.equal(g.statusCalls, calls, 'not asked again within 3 s');
  g.signIn();
  t = 3_000;
  assert.equal(l.poll().state, 'done');
  assert.equal(g.children[0]!.killed, true);
  // Signed in already: nothing to run.
  assert.equal(l.start().state, 'done');
  assert.equal(g.children.length, 1);

  const g2 = fakeGh();
  const l2 = new GhLogin({ ...g2.deps, now: () => 0, timeoutMs: 30 });
  l2.start();
  assert.equal(l2.cancel().state, 'cancelled');
  assert.equal(g2.children[0]!.killed, true);
  l2.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(l2.view().state, 'expired');
  assert.equal(g2.children[1]!.killed, true);

  const l3 = new GhLogin({ ...fakeGh().deps, installed: () => false });
  assert.throws(() => l3.start(), /gh isn't installed/);
});

test('safeLine masks anything token-shaped and never returns the code line', () => {
  assert.equal(safeLine(`error: ${TOKEN} rejected\n`), 'error: [hidden] rejected');
  assert.equal(safeLine('x github_pat_11AAAAAAAAAAAAAA y'), 'x [hidden] y');
  assert.equal(safeLine('! First copy your one-time code: ABCD-1234\n'), '');
});

test('the gh-login step is Connect GitHub, run by the page; the command shown is the terminal equivalent', () => {
  const s = SETUP_STEPS.find((x) => x.id === 'gh-login')!;
  assert.deepEqual(s.fix, { kind: 'gh-login', label: 'Connect GitHub', command: 'gh auth login --web' });
});

async function dashboard(over: Partial<DashboardOptions>) {
  const { dir } = exampleProject();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir, stdio: 'ignore' });
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'gh-login-slots-')), ...over });
  const base = d.url.split('/?')[0]!;
  const call = async (method: string, user = 'example-owner') => {
    const r = await fetch(`${base}/api/first-run/gh-login`, { method, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asPerson(user) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as unknown as { login: string; action: string; detail: Record<string, unknown> }).filter((a) => a.action.startsWith('first_run.gh_login'));
    } finally {
      log.close();
    }
  };
  return { d, call, audit };
}

test('through the dashboard: the owners start it and see the code; a writer is refused and nothing runs; audited without the code', async () => {
  const g = fakeGh();
  const s = await dashboard({ ghLogin: g.deps });
  try {
    const writer = await s.call('POST', 'example-collaborator');
    assert.equal(writer.status, 403);
    assert.match(String(writer.body.error), /only the instance's owners/);
    assert.equal((await s.call('GET', 'example-collaborator')).status, 403, 'nor may a writer read the code');
    assert.equal(g.children.length, 0, 'a refusal runs nothing');
    const started = await s.call('POST');
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.state, 'waiting');
    g.children[0]!.err.write('! First copy your one-time code: WXYZ-9876\n');
    await tick();
    const seen = await s.call('GET');
    assert.equal(seen.body.code, 'WXYZ-9876');
    assert.equal(seen.body.url, GH_DEVICE_URL);
    assert.equal((await s.call('POST')).status, 409, 'one login at a time');
    assert.equal((await s.call('DELETE')).body.state, 'cancelled');
    const rows = s.audit();
    assert.deepEqual(
      rows.map((a) => [a.login, a.action, a.detail.state ?? null]),
      [
        ['example-collaborator', 'first_run.gh_login_refused', null],
        ['example-owner', 'first_run.gh_login', 'started'],
        ['example-owner', 'first_run.gh_login_refused', null],
        ['example-owner', 'first_run.gh_login', 'cancelled'],
      ],
    );
    assert.doesNotMatch(JSON.stringify(rows), /WXYZ-9876/, 'the code is never audited');
  } finally {
    await s.d.close();
  }
});

test('through the dashboard: a server instance never runs a gh login', async () => {
  const g = fakeGh();
  const s = await dashboard({ ghLogin: g.deps, instance: 'shop' });
  try {
    const r = await s.call('POST');
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /GitHub App, not a gh login/);
    assert.equal(g.children.length, 0);
  } finally {
    await s.d.close();
  }
});
