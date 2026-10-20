// Issue #739, the server's first hour: after the coordinator runs, the checklist leads to a first task (a writer's
// issue with a done_when block and the ready label, as the coordinator judged it), and the engine updater stops
// blocking that path until the instance's first PR. The updater stays listed, counted by doctor, and required once a
// PR exists; it never changes because of this: its files are only read. And the https origin is a choice in setup
// mode (Tailscale, or an origin of your own with --public-url), not a Tailscale prerequisite.
// No host tool runs here: the probe answers every command with a failure and finds no tool on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionable, type Backlog, type Issue } from '../src/backlog/types.js';
import { EventLog } from '../src/events/log.js';
import { HTTPS_SCREEN, startSetupHub } from '../src/hub-setup.js';
import { checkSetup, GROUPS, SETUP_STEPS, type MachinePaths, type SetupContext, type SetupProbe, type SetupView } from '../src/setup-steps.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';

/** A probe that runs nothing: no tool on PATH, every command fails, no service manager. */
const nothing: SetupProbe = {
  which: () => null,
  run: () => ({ status: 1, stdout: '', stderr: 'no stand-in' }),
  serviceRunning: () => null,
  systemUnitActive: () => false,
  linger: () => null,
  // #819 (now on main): the user service manager's login variables; none here, as in test/setup-steps.test.ts.
  serviceManagerEnv: () => ({ env: {} }),
};

function server(o: { updater?: 'installed' | 'none' } = {}) {
  const { dir } = exampleProject();
  const base = mkdtempSync(join(tmpdir(), 'first-hour-'));
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const m = join(base, 'machine');
  mkdirSync(m);
  const machine: MachinePaths = {
    enginePackage: join(m, 'package.json'),
    engine: join(m, 'opt-current'),
    helper: join(m, 'helper'),
    machineOwners: join(m, 'machine-owners.json'),
    updatesConfig: join(m, 'updates.json'),
    allowedSigners: join(m, 'allowed_signers'),
    hubUnitFile: join(m, 'hub.service'),
    fullRunLock: join(m, 'full-run.lock'),
    claudeAccountDir: join(m, 'claude-account'),
  };
  if (o.updater === 'installed') {
    writeFileSync(machine.updatesConfig, '{"enabled":false,"channel":"release","repo_url":"https://example.test/engine.git"}\n');
    writeFileSync(machine.allowedSigners, 'release@example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExample\n');
  }
  const home = join(base, 'home');
  mkdirSync(home);
  const ctx: SetupContext = { mode: 'server', root: dir, repo: 'example-org/example-shop', instance: 'shop', stateDir, policyFile: join(home, 'policy.yaml'), openQuestions: 0, setupPr: null, machine, instanceFacts: () => ({ home, credentials: { github: { kind: 'app', key_path: join(home, 'app.pem') } } }) };
  const log = () => new EventLog(join(stateDir, 'events.db'));
  return { ctx, stateDir, machine, log, check: (over: Partial<SetupContext> = {}) => checkSetup({ ...ctx, ...over }, nothing) };
}

const stepIn = (v: SetupView, id: string) => v.groups.flatMap((g) => g.steps).find((s) => s.id === id);
/** What the first-run page offers next (web/src/pages/FirstRun.tsx nextStep): the first required step not done or skipped. */
const next = (v: SetupView) => v.groups.flatMap((g) => g.steps).find((s) => !s.optional && !s.done && !s.skipped) ?? null;
const seen = (issue: number, over: { author?: string; actionable?: boolean; why?: string; labels?: string[] } = {}) => ({ issue, title: `Task ${issue}`, labels: over.labels ?? ['ready'], author: over.author ?? 'ada', owner: null, actionable: over.actionable ?? true, why: over.why ?? `opened by writer ${over.author ?? 'ada'}` });

test('#739 a server lists a first-task step after the coordinator: done only on a ready issue the coordinator took as a writer\'s, with its done_when block', () => {
  const s = server();
  const ids = s.check().groups.map((g) => g.id);
  assert.ok(ids.indexOf('coordinator') < ids.indexOf('first-task'), `first-task after the coordinator: ${ids.join(', ')}`);
  const step = () => stepIn(s.check(), 'server-first-task');
  assert.ok(step(), 'the server lists a first-task step');
  assert.equal(step()!.optional, false);
  assert.equal(step()!.group, 'first-task');
  // No form on a server: an issue filed from the page would be the App's.
  assert.equal(step()!.fix.kind, 'outside');
  assert.equal(step()!.done, false);
  assert.match(step()!.detail, /the coordinator hasn't written its event log yet/);

  const log = s.log();
  try {
    // Every way the coordinator takes an issue that isn't a writer's: the App's own (canary, a goal's child, an
    // automation's, an optimization pass), the fix-forward task, a writer's issue with no done_when block, and an
    // issue someone not a writer opened with no writer adding ready.
    log.append('issue.seen', seen(1, { author: 'example-app[bot]', why: "the machine's canary, opened by this instance's App example-app[bot]" }), 'c');
    log.append('issue.seen', seen(2, { author: 'example-app[bot]', why: 'a child of goal #9, filed by this instance' }), 'c');
    log.append('issue.seen', seen(3, { author: 'example-app[bot]', why: 'filed by automation nightly (automation.output)' }), 'c');
    log.append('issue.seen', seen(4, { author: 'example-app[bot]', why: 'an optimization task this instance filed (optimize.pass)' }), 'c');
    log.append('issue.seen', seen(5, { author: 'example-app[bot]', why: 'fix-forward: the fix task for a red default branch' }), 'c');
    log.append('issue.seen', seen(6, { actionable: false, why: 'no ```done_when block in the issue body' }), 'c');
    log.append('issue.seen', seen(7, { author: 'mallory', actionable: false, why: 'opened by mallory (not a writer) and no writer added ready' }), 'c');
    // A writer's issue the coordinator took, but without the ready label in what it saw: not counted either.
    log.append('issue.seen', seen(8, { labels: [] }), 'c');
    assert.equal(step()!.done, false, step()!.detail);
    assert.match(step()!.detail, /no writer's issue with the ready label and a done_when block yet/);

    log.append('issue.seen', seen(10, { author: 'mallory', why: 'ready added by writer ada' }), 'c');
    assert.equal(step()!.done, true, step()!.detail);
    assert.match(step()!.detail, /#10.*ready added by writer ada/);
  } finally {
    log.close();
  }
  const t = server();
  const l2 = t.log();
  l2.append('issue.seen', seen(12), 'c');
  l2.close();
  assert.equal(stepIn(t.check(), 'server-first-task')!.done, true);
  assert.match(stepIn(t.check(), 'server-first-task')!.detail, /#12.*opened by writer ada/);
});

test("#739 the first-task step trusts the coordinator's own words: a writer's issue is exactly what actionable() calls one", async () => {
  // The step reads the coordinator's `why`; if actionable() said it another way, no first task would ever count.
  const backlog = { labelAdders: async () => ['ada'] } as unknown as Backlog;
  const issue = (author: string): Issue => ({ number: 1, title: 't', body: '', labels: ['ready'], author, assignees: [], state: 'open' });
  for (const [author, want] of [['ada', /^opened by writer ada$/], ['someone', /^ready added by writer ada$/]] as const) {
    const a = await actionable(issue(author), ['ada'], backlog);
    assert.equal(a.actionable, true);
    assert.match(a.why, want);
    const s = server();
    const log = s.log();
    log.append('issue.seen', seen(1, { author, why: a.why }), 'c');
    log.close();
    assert.equal(stepIn(s.check(), 'server-first-task')!.done, true, a.why);
  }
});

test('#739 the first-task step fails closed: an event log it cannot read is not done, with why', { skip: !posix && 'POSIX' }, () => {
  const s = server();
  // A directory where the log should be: it exists, and can't be opened as a database.
  mkdirSync(join(s.stateDir, 'events.db'));
  const step = stepIn(s.check(), 'server-first-task')!;
  assert.equal(step.done, false);
  assert.match(step.detail, /couldn't read the coordinator's event log/);
});

test('#739 before the first PR the updater is listed but blocks nothing: the first task comes first; after it the updater is required again', () => {
  const s = server();
  const v = s.check();
  const ids = v.groups.map((g) => g.id);
  assert.ok(ids.indexOf('first-task') < ids.indexOf('updates'), `the updater after the first task: ${ids.join(', ')}`);
  const up = stepIn(v, 'updater')!;
  assert.ok(up, 'still listed');
  assert.equal(up.done, false);
  assert.equal(up.optional, true, 'not blocking before the first PR');
  assert.match(up.detail, /^after your first PR: /);
  assert.match(up.detail, /the updater isn't set up/);
  assert.ok(!v.groups.flatMap((g) => g.steps).some((x) => x.id === 'updater' && !x.optional && !x.done), 'not among the required steps left');
  assert.notEqual(next(v)?.id, 'updater');
  // The group is shown, as optional for now, after Your first task.
  assert.equal(v.groups.find((g) => g.id === 'updates')!.optional, true);

  // The instance's first PR: from here the updater is required, as before.
  const log = s.log();
  log.append('pr.opened', { issue: 10, number: 11, url: 'https://github.com/example-org/example-shop/pull/11', head: 'a'.repeat(40), draft: false }, 'c');
  log.close();
  const after = s.check();
  const up2 = stepIn(after, 'updater')!;
  assert.equal(up2.optional, false, up2.detail);
  assert.doesNotMatch(up2.detail, /after your first PR/);
  assert.equal(after.requiredLeft, v.requiredLeft + 1, 'counted as required again');
});

test('#739 a direct landing counts as the first change too; a refused one does not', () => {
  for (const [outcome, required] of [['landed', true], ['pr_opened', true], ['rejected', false], ['red', false]] as const) {
    const s = server();
    const log = s.log();
    log.append('land.result', { issue: 10, outcome, landed: outcome === 'landed' ? 'b'.repeat(40) : null, detail: 'x' }, 'c');
    log.close();
    assert.equal(stepIn(s.check(), 'updater')!.optional, !required, outcome);
  }
});

test('#739 the updater deferral fails closed: an event log that exists but cannot be read keeps the updater required', { skip: !posix && 'POSIX' }, () => {
  const s = server();
  mkdirSync(join(s.stateDir, 'events.db'));
  const up = stepIn(s.check(), 'updater')!;
  assert.equal(up.optional, false, up.detail);
  assert.match(up.detail, /couldn't tell whether the first PR exists/);
  // A state directory this user can't look into: the same (not as "no log yet").
  if (process.getuid?.() !== 0) {
    const t = server();
    chmodSync(t.stateDir, 0o000);
    try {
      const u = stepIn(t.check(), 'updater')!;
      assert.equal(u.optional, false, u.detail);
    } finally {
      chmodSync(t.stateDir, 0o700);
    }
  }
});

test('#739 round 2: a dangling symlink at the event log is not "no log yet": the updater stays required, the first task not done', { skip: !posix && 'POSIX' }, () => {
  const s = server();
  // The engine never makes a link there: one is tampering or corruption, an unsure state.
  symlinkSync(join(s.stateDir, 'gone.db'), join(s.stateDir, 'events.db'));
  const v = s.check();
  const up = stepIn(v, 'updater')!;
  assert.equal(up.optional, false, up.detail);
  assert.match(up.detail, /couldn't tell whether the first PR exists/);
  const task = stepIn(v, 'server-first-task')!;
  assert.equal(task.done, false);
  assert.match(task.detail, /couldn't read the coordinator's event log/);
});

test('#739 round 2: a state directory that is missing is not "no log yet": the updater stays required', () => {
  const s = server();
  // As doctor's fallback state dir after loadInstance throws: an instance's own state dir always exists.
  const v = s.check({ stateDir: join(s.stateDir, 'missing') });
  const up = stepIn(v, 'updater')!;
  assert.equal(up.optional, false, up.detail);
  assert.match(up.detail, /couldn't tell whether the first PR exists/);
  const task = stepIn(v, 'server-first-task')!;
  assert.equal(task.done, false);
  assert.match(task.detail, /couldn't read the coordinator's event log/);
});

test("#739 an installed updater: still done and required, and its files byte-identical after the checks run again", () => {
  const s = server({ updater: 'installed' });
  const before = [readFileSync(s.machine.updatesConfig), readFileSync(s.machine.allowedSigners)];
  for (let i = 0; i < 3; i++) {
    const up = stepIn(s.check(), 'updater')!;
    assert.equal(up.done, true, up.detail);
    assert.doesNotMatch(up.detail, /after your first PR/, 'a done step reads as before');
  }
  assert.deepEqual([readFileSync(s.machine.updatesConfig), readFileSync(s.machine.allowedSigners)], before);
  // Only the registry's own flag defers a step, and only the updater has it: nothing else of a server moves.
  assert.deepEqual(SETUP_STEPS.filter((x) => (x as { after?: unknown }).after).map((x) => x.id), ['updater']);
  assert.equal(GROUPS.find((g) => g.id === 'updates')!.optional, false, 'the group itself stays required');
});

test('#739 local mode is unchanged: no server first-task step, no updater', () => {
  const s = server();
  const v = s.check({ mode: 'local', instance: null });
  assert.equal(stepIn(v, 'server-first-task'), undefined);
  assert.equal(stepIn(v, 'updater'), undefined);
  assert.ok(stepIn(v, 'first-task'));
});

/** GET a page from the setup hub, with its session once unlocked. */
function call(port: number, method: string, path: string, o: { body?: string; cookie?: string } = {}) {
  return new Promise<{ status: number; body: string; cookie: string | null }>((done, fail) => {
    const headers: Record<string, string> = { origin: `http://127.0.0.1:${port}` };
    if (o.body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (o.cookie) headers.cookie = o.cookie;
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => done({ status: res.statusCode ?? 0, body, cookie: ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? null }));
    });
    r.on('error', fail);
    r.end(o.body);
  });
}

test('#739 with no https origin, setup mode offers a choice: an origin of your own (--public-url), or Tailscale (screen 7)', { skip: !posix && 'POSIX modes' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'first-hour-hub-'));
  const h = await startSetupHub({ stateDir: join(base, 'state'), signinDir: join(base, 'signin'), publicUrl: null, appPrefix: 'box', checkMs: 30, tailscaleScript: '/opt/e/scripts/setup/tailscale.sh', rerunCommand: 'sudo bash /opt/e/scripts/bootstrap.sh --hardened <name> <owner/repo>' });
  try {
    const port = Number(new URL(h.url).port);
    const gate = await call(port, 'GET', '/');
    assert.match(gate.body, new RegExp(`waits for an https origin: your own \\(--public-url\\), or screen ${HTTPS_SCREEN}, Tailscale and HTTPS`));
    const token = readFileSync(h.tokenFile, 'utf8').trim();
    const unlocked = await call(port, 'POST', '/setup/unlock', { body: `token=${encodeURIComponent(token)}` });
    assert.equal(unlocked.status, 303);
    const page = await call(port, 'GET', '/', { cookie: unlocked.cookie! });
    assert.equal(page.status, 200);
    assert.match(page.body, /An https address first: one of your own, or Tailscale \(screen 7\)/);
    assert.doesNotMatch(page.body, /Screen 7 first/, 'Tailscale is one choice, not the prerequisite');
    // Your own origin: what it must do, and the install command again with it.
    const own = page.body.match(/data-testid="https-choice-own"[\s\S]*?<\/pre>/)?.[0] ?? '';
    assert.match(own, new RegExp(`forwards to http://127\\.0\\.0\\.1:${port}/ on this machine`));
    assert.match(own, /sudo bash \/opt\/e\/scripts\/bootstrap\.sh --hardened --public-url https:\/\/&lt;your host&gt; &lt;name&gt; &lt;owner\/repo&gt;/);
    // Tailscale: the same three root steps as before, then the install command again.
    const ts = page.body.match(/data-testid="https-choice-tailscale"[\s\S]*?<\/div>/)?.[0] ?? '';
    for (const step of ['install', 'up', 'serve']) assert.match(ts, new RegExp(`sudo bash /opt/e/scripts/setup/tailscale\\.sh ${step}[\n<]`));
    assert.match(ts, /sudo bash \/opt\/e\/scripts\/bootstrap\.sh --hardened &lt;name&gt; &lt;owner\/repo&gt;/);
    // Own origin listed first: the choice reads as a choice, Tailscale the other one.
    assert.ok(page.body.indexOf('https-choice-own') < page.body.indexOf('https-choice-tailscale'));
    assert.doesNotMatch(page.body, /name="owner"|Continue to GitHub/, 'still no App form');
  } finally {
    await h.close();
  }
});
