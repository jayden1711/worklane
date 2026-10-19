// Tailscale and HTTPS for the hub, the engine's half (src/tailscale-setup.ts; the first-run wizard's screen for a
// server): the engine's allowlist is exactly the helper's four commands; a step is a machine request of two fixed
// words, with the same gate as any machine change, one at a time, only when the machine is ready for it; the
// coordinator runs it through the helper; the login link is served to a machine owner only, only while `up` waits, only
// when it is Tailscale's own login page, and is in no event or audit entry; a machine without tailscale, or a screen
// nobody confirms, changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRootStep } from '../src/console/root-steps.js';
import { runMachineRequests } from '../src/coordinator/machine-requests.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { DEVICE_VIEWS, isDeviceView } from '../src/dashboard-auth.js';
import { EventLog } from '../src/events/log.js';
import { MACHINE_HELPER } from '../src/machine.js';
import { MachineRequestError, machineRefusal, machineRequests } from '../src/machine-requests.js';
import { SETUP_STEPS } from '../src/setup-steps.js';
import { parseTailscaleStatus, readLoginUrl, readStepLines, requestTailscale, stepRun, TAILSCALE_ACTIONS, TAILSCALE_LOGIN_URL, tailscaleSteps, tailscaleView, type StepLine, type TailscaleStatus } from '../src/tailscale-setup.js';
import { asDevicePerson, asPerson, exampleProject, exampleRoles, machineOwnersFile, ownerRequester, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
// Put together here so the repo holds no tailnet name, even a made-up one (the denylist's rule).
const NAME = ['box', 'tail0example', 'ts', 'net'].join('.');
const LINK = 'https://login.tailscale.com/a/0123456789abcdef';

const status = (over: Partial<TailscaleStatus> = {}): TailscaleStatus => ({ installed: true, version: '1.104.1', pinnedVersion: '1.104.1', state: 'Running', name: NAME, https: true, serve: true, other443: false, breakGlassForwarded: false, funnel: false, hubUrl: 'https://hub.example.test', ...over });
const NONE = status({ installed: false, version: null, state: null, name: null, https: false, serve: false });
const INSTALLED = status({ state: 'NeedsLogin', name: null, https: false, serve: false });
const UP = status({ serve: false });

/** A step's progress file as tailscale.sh writes it, and optionally the login link's file. */
function stepsDir(lines: Partial<StepLine>[], link?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-dir-'));
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  if (lines.length) writeFileSync(join(dir, 'steps.jsonl'), lines.map((l) => JSON.stringify({ at, ...l })).join('\n') + '\n');
  if (link !== undefined) writeFileSync(join(dir, 'login-url'), `${link}\n`, { mode: 0o400 });
  return dir;
}
const UP_WAITING: Partial<StepLine>[] = [
  { step: 'up', state: 'started', detail: '' },
  { step: 'up', state: 'running', detail: 'tailscale up (no auth key): it prints a login link and waits' },
  { step: 'up', state: 'waiting', detail: "log this machine in to your tailnet: the login link is in alpha's dashboard, shown to machine owners only; waiting up to 10 min" },
];

function eventLog() {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-log-'));
  return { log: new EventLog(join(dir, 'events.db')), file: join(dir, 'events.db') };
}

test("the engine's allowlist is exactly the helper's four tailscale commands: one fixed word, nothing after it", () => {
  const { parseTailscale } = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parseTailscale: (a: string[]) => string | null };
  const lists: string[][] = [
    ...TAILSCALE_ACTIONS.map((a) => [a]),
    [],
    ['up', '--auth-key=tskey-auth-kExample-abcdef'],
    ['up', '--auth-key', 'tskey-auth-kExample-abcdef'],
    ['up', '--authkey=tskey-auth-kExample-abcdef'],
    ['up', '--login-server=https://example.test'],
    ['up', '--for', 'alpha'],
    ['up', '--advertise-exit-node'],
    ['up', '--advertise-routes=198.51.100.0/24'],
    ['up', '--ssh'],
    ['up', '--accept-routes'],
    ['funnel', '443'],
    ['--funnel'],
    ['serve', '--funnel'],
    ['serve', 'funnel', 'on'],
    ['serve', '--bg', '--https=443', 'http://127.0.0.1:4399'],
    ['serve', '--set-path=/x', 'http://127.0.0.1:4398'],
    ['serve', 'http://0.0.0.0:4399'],
    ['serve', '--https=8443'],
    ['public-url', '--name', 'other'],
    ['up --auth-key=tskey-auth-kExample-abcdef'],
    ['--auth-key=tskey-auth-kExample-abcdef'],
    ['UP'],
    ['serve', '4398'],
    ['serve', '--https=443', 'http://127.0.0.1:4398'],
    ['serve', 'reset'],
    ['funnel'],
    ['public-url', 'https://elsewhere.example.test'],
    ['install', '1.0.0'],
    ['install', '--allow-unauthenticated'],
    ['status'],
    ['logout'],
    ['down'],
  ];
  for (const a of lists) {
    const engine = checkRootStep('tailscale', a).allowed;
    assert.equal(engine, parseTailscale(['tailscale', ...a]) !== null, `the engine and the helper agree on: tailscale ${a.join(' ')}`);
    assert.equal(engine, a.length === 1 && (TAILSCALE_ACTIONS as readonly string[]).includes(a[0]!), JSON.stringify(a));
    assert.equal(machineRefusal(['tailscale', ...a]) === null, engine);
  }
  assert.deepEqual([...TAILSCALE_ACTIONS], ['install', 'up', 'serve', 'public-url']);
  const refused = checkRootStep('tailscale', ['up', '--auth-key=tskey-auth-kExample-abcdef']);
  assert.ok(!refused.allowed && /isn't on its allowlist \(tailscale install\|up\|serve\|public-url\)/.test(refused.why));
  // The hub asks Tailscale for the device on this view's read, as on a write.
  assert.equal(DEVICE_VIEWS.tailscale, 'tailscale');
  assert.ok(isDeviceView('tailscale'));
});

test("the script's status is read strictly: a name is a ts.net name or nothing, a URL an https origin or nothing", () => {
  assert.deepEqual(parseTailscaleStatus(JSON.stringify({ installed: true, version: '1.104.1', pinned_version: '1.104.1', state: 'Running', name: NAME, https: true, serve: true, other_443: false, break_glass_forwarded: false, funnel: false, hub_url: `https://${NAME}` })), status({ hubUrl: `https://${NAME}` }));
  assert.equal(parseTailscaleStatus(JSON.stringify({ installed: true, funnel: true }))!.funnel, true);
  assert.equal(parseTailscaleStatus(JSON.stringify({ installed: true, funnel: 'no' }))!.funnel, false);
  const odd = parseTailscaleStatus(JSON.stringify({ installed: true, version: '1; rm -rf /', pinned_version: 7, state: 'Running now', name: 'box.example.test', https: true, serve: true, hub_url: 'https://x.example.test/path?t=1' }))!;
  assert.deepEqual([odd.version, odd.pinnedVersion, odd.state, odd.name, odd.https, odd.serve, odd.hubUrl], [null, null, null, null, false, false, null]);
  assert.equal(parseTailscaleStatus(JSON.stringify({ installed: true, name: `x --client-id evil.${NAME}` }))!.name, null);
  for (const t of ['', 'not json', '[]', '{"installed":"yes"}', 'null']) assert.equal(parseTailscaleStatus(t), null, t);
});

test('the four steps follow the machine: which is next, which wait, and what each would change', () => {
  const ids = (s: TailscaleStatus | null) => tailscaleSteps(s).map((x) => `${x.id}:${x.done ? 'done' : x.blocked ? 'blocked' : 'ready'}`);
  assert.deepEqual(ids(NONE), ['install:ready', 'up:blocked', 'serve:blocked', 'public-url:blocked']);
  assert.deepEqual(ids(null), ['install:ready', 'up:blocked', 'serve:blocked', 'public-url:blocked']);
  assert.deepEqual(ids(INSTALLED), ['install:done', 'up:ready', 'serve:blocked', 'public-url:blocked']);
  assert.deepEqual(ids(UP), ['install:done', 'up:done', 'serve:ready', 'public-url:blocked']);
  assert.deepEqual(ids(status()), ['install:done', 'up:done', 'serve:done', 'public-url:ready']);
  assert.deepEqual(ids(status({ hubUrl: `https://${NAME}` })), ['install:done', 'up:done', 'serve:done', 'public-url:done']);
  // HTTPS not on for the tailnet: serve waits, with Tailscale's own page to turn it on.
  const noCert = tailscaleSteps(status({ https: false, serve: false })).find((s) => s.id === 'serve')!;
  assert.match(noCert.blocked!, /doesn't issue an HTTPS certificate .* turn on MagicDNS and HTTPS certificates/);
  assert.deepEqual(noCert.link, { url: 'https://login.tailscale.com/admin/dns', label: "Tailscale's DNS settings" });
  assert.match(tailscaleSteps(status({ serve: false, other443: true })).find((s) => s.id === 'serve')!.blocked!, /already forwards https 443 somewhere else/);
  assert.match(tailscaleSteps(status({ breakGlassForwarded: true, serve: false })).find((s) => s.id === 'serve')!.blocked!, /break-glass port, which must never be forwarded/);
  assert.match(tailscaleSteps(status({ hubUrl: null })).find((s) => s.id === 'public-url')!.blocked!, /no dashboard hub yet/);
  // Funnel already on: shown, never changed; neither the HTTPS step nor the URL step can be asked for.
  for (const s of [status({ funnel: true, serve: false }), status({ funnel: true })]) {
    for (const id of ['serve', 'public-url'] as const) {
      const step = tailscaleSteps(s).find((x) => x.id === id)!;
      if (!step.done) assert.match(step.blocked!, /Tailscale Funnel is on for this machine, which publishes to the public internet; nothing here turns it on or off/, `${id}`);
    }
    assert.match(tailscaleSteps(s).find((x) => x.id === 'public-url')!.blocked!, /Funnel is on/);
  }
  // Each says what it changes and the command that does the same without the dashboard.
  const all = tailscaleSteps(status());
  assert.deepEqual(all.map((s) => s.command.split('   ')[0]), TAILSCALE_ACTIONS.map((a) => `sudo bash scripts/setup/tailscale.sh ${a}`));
  assert.match(all[3]!.command, new RegExp(`dashboards\\.sh --client-id .* --public-url https://${NAME.replace(/\./g, '\\.')} <instance>`));
  assert.ok(all.every((s) => s.changes.length >= 2));
  assert.match(all[0]!.changes.join(' '), /signing key.*fingerprint the script pins.*version 1\.104\.1 \(pinned\).*no install script/);
  assert.match(all[1]!.changes.join(' '), /no auth key.*machine owners only.*never written to a log/);
  assert.match(all[3]!.changes.join(' '), new RegExp(`callback URL to exactly https://${NAME.replace(/\./g, '\\.')}/auth/callback`));
});

test('the login link is read only when it is exactly Tailscale\'s login page, and a progress line never shows one', () => {
  assert.equal(readLoginUrl(stepsDir([], LINK)), LINK);
  for (const bad of ['https://login.tailscale.com.evil.example.test/a/0123456789abcdef', 'http://login.tailscale.com/a/0123456789abcdef', `${LINK}?key=tskey-auth-kOdd-0123456789`, 'https://login.tailscale.com/admin/settings/keys', 'tskey-auth-kOdd-0123456789abcdef', `${LINK}\nhttps://example.test/`, '']) {
    assert.equal(readLoginUrl(stepsDir([], bad)), null, bad);
    assert.ok(!TAILSCALE_LOGIN_URL.test(bad));
  }
  assert.equal(readLoginUrl(stepsDir([])), null, 'no file');
  // A line that somehow carried a link or a key is shown without it; a foreign or torn line is skipped.
  const dir = stepsDir([{ step: 'up', state: 'started', detail: '' }, { step: 'up', state: 'waiting', detail: `open ${LINK} with tskey-auth-kOdd-0123456789abcdef` }]);
  writeFileSync(join(dir, 'steps.jsonl'), `${readFileSync(join(dir, 'steps.jsonl'), 'utf8')}{"at":"2026-10-13T00:00:00Z","step":"logout","state":"done","detail":"x"}\n{"at":"2026-10-13T0`);
  const lines = readStepLines(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[1]!.detail, 'open [the login link] with [a key]');
  const run = stepRun(lines)!;
  assert.deepEqual([run.step, run.status], ['up', 'waiting']);
  assert.equal(stepRun(lines, Date.now() + 3600_000)!.status, 'stalled');
  assert.equal(stepRun([]), null);
  assert.equal(stepRun(readStepLines(stepsDir([...UP_WAITING, { step: 'up', state: 'done', detail: `on the tailnet as ${NAME}` }])))!.status, 'done');
});

test('the view: a machine owner gets the link while up waits; an instance owner who is not one gets no link and nothing to act on', () => {
  const owners = machineOwnersFile('ada');
  const dir = stepsDir(UP_WAITING, LINK);
  const view = (login: string, o: { role?: 'owner' | 'writer'; deviceOk?: boolean; breakGlass?: boolean; dir?: string; status?: TailscaleStatus | null } = {}) =>
    tailscaleView({ status: o.status === undefined ? INSTALLED : o.status, dir: o.dir ?? dir, events: [], who: { role: o.role ?? 'owner', requester: { login, deviceOk: o.deviceOk ?? true, breakGlass: !!o.breakGlass } }, instance: 'alpha', ownersFile: owners });
  const ada = view('ada');
  assert.deepEqual([ada.machineOwner, ada.allowed, ada.next, ada.run?.status, ada.loginUrl, ada.busy], [true, true, 'up', 'waiting', LINK, 'tailscale up is running']);
  // Off an allowed device: still the owner (sees the link), but may not run a step.
  const away = view('ada', { deviceOk: false });
  assert.deepEqual([away.machineOwner, away.allowed, away.loginUrl], [true, false, LINK]);
  // An owner of the instance who isn't a machine owner, and a writer: no link.
  for (const v of [view('ivy'), view('ivy', { role: 'writer' }), view('ada-other')]) assert.deepEqual([v.machineOwner, v.allowed, v.loginUrl], [false, false, null]);
  assert.equal(view('anyone', { breakGlass: true }).loginUrl, LINK, 'the break-glass is the owner');
  // The file is there but no `up` is waiting (it ended, or another step runs): no link.
  assert.equal(view('ada', { dir: stepsDir([...UP_WAITING, { step: 'up', state: 'failed', detail: 'tailscale up ended without a login' }], LINK) }).loginUrl, null);
  assert.equal(view('ada', { dir: stepsDir([{ step: 'serve', state: 'started', detail: '' }], LINK) }).loginUrl, null);
  assert.equal(view('ada', { dir: stepsDir(UP_WAITING, 'https://example.test/a/0123456789abcdef') }).loginUrl, null, 'a link that is not the login page');
  // No tailscale, nothing run: the screen offers the install and nothing is going on.
  const fresh = view('ada', { status: NONE, dir: stepsDir([]) });
  assert.deepEqual([fresh.next, fresh.run, fresh.busy, fresh.loginUrl, fresh.requests.length], ['install', null, null, null, 0]);
  assert.deepEqual(fresh.script, { status: 'bash scripts/setup/tailscale.sh status', steps: TAILSCALE_ACTIONS.map((a) => `sudo bash scripts/setup/tailscale.sh ${a}`) });
  assert.equal(view('ada', { status: null, dir: stepsDir([]) }).status, null);
});

test('a step is a machine request of two fixed words: gated, one at a time, only when the machine is ready; the coordinator runs it through the helper', () => {
  const owners = machineOwnersFile('ada');
  const { log } = eventLog();
  const empty = stepsDir([]);
  const ask = (action: unknown, o: { login?: string; deviceOk?: boolean; status?: TailscaleStatus | null; dir?: string } = {}) =>
    requestTailscale(log, { action, status: o.status === undefined ? INSTALLED : o.status, requester: { login: o.login ?? 'ada', deviceOk: o.deviceOk ?? true, breakGlass: false }, dir: o.dir ?? empty, ownersFile: owners });
  const refused = (f: () => unknown, status: number, re: RegExp) => assert.throws(f, (e: Error) => e instanceof MachineRequestError && e.status === status && re.test(e.message), re.source);
  try {
    for (const bad of ['status', 'logout', 'up --auth-key=tskey-auth-kExample-abcdef', '', null, ['up'], { action: 'up' }, 'UP']) refused(() => ask(bad), 400, /action is one of install, up, serve, public-url/);
    refused(() => ask('up', { login: 'ivy' }), 403, /@ivy isn't one/);
    refused(() => ask('up', { deviceOk: false }), 403, /needs one of the machine's allowed devices/);
    refused(() => ask('up', { status: null }), 409, /no tailscale setup script/);
    // Only a step the machine is ready for.
    refused(() => ask('up', { status: NONE }), 409, /not yet: install Tailscale first/);
    refused(() => ask('serve', { status: INSTALLED }), 409, /not yet: log this machine in to your tailnet first/);
    refused(() => ask('public-url', { status: UP }), 409, /not yet: put the hub on HTTPS first/);
    refused(() => ask('serve', { status: status({ funnel: true, serve: false }) }), 409, /not yet: Tailscale Funnel is on/);
    refused(() => ask('public-url', { status: status({ funnel: true }) }), 409, /not yet: Tailscale Funnel is on/);
    // A step is already running on the machine (from any dashboard, or a terminal).
    refused(() => ask('up', { dir: stepsDir(UP_WAITING) }), 409, /tailscale up is running; wait for it to end/);
    assert.deepEqual(machineRequests(log.read(0)), [], 'nothing was recorded by any refusal');

    const r = ask('up');
    assert.deepEqual([r.args, r.via, r.by, r.status], [['tailscale', 'up'], 'tailscale', 'ada', 'pending']);
    refused(() => ask('up'), 409, /tailscale up is waiting for the coordinator; wait for it to end/);
    refused(() => ask('install', { status: NONE }), 409, /tailscale up is waiting for the coordinator/);
    // The coordinator: sudo -n, the helper, those two words.
    const calls: string[][] = [];
    assert.equal(runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), 'started tailscale up as its own unit') }), 1);
    assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'tailscale', 'up']]);
    assert.deepEqual(machineRequests(log.read(0)).map((x) => [x.status, x.detail]), [['done', 'started tailscale up as its own unit']]);
    // Done steps may be run again (the script finds them done and changes nothing).
    assert.deepEqual(ask('install').args, ['tailscale', 'install']);
    runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), 'started') });

    // A request written to the log some other way, with an auth key after the word: the coordinator refuses it, and runs nothing.
    log.append('machine.requested', { id: 'mr-forged000001', args: ['tailscale', 'up', '--auth-key=tskey-auth-kExample-abcdef'], by: 'ada', via: 'tailscale', ask: null }, 'ada', 'human');
    const before = calls.length;
    runMachineRequests({ log, instance: 'alpha', ownersFile: owners, exec: (file, args) => (calls.push([file, ...args]), 'ran') });
    assert.equal(calls.length, before, 'nothing ran');
    const forged = machineRequests(log.read(0)).find((x) => x.id === 'mr-forged000001')!;
    assert.equal(forged.status, 'refused');
    assert.match(forged.detail, /isn't on its allowlist \(tailscale install\|up\|serve\|public-url\)/);
  } finally {
    log.close();
  }
});

test('the dashboard: the screen is a machine owner\'s only, on a server instance; a step needs a confirmation; the link is in no event', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-dash-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  const owners = machineOwnersFile('example-owner');
  let now: TailscaleStatus | null = INSTALLED;
  let asked = 0;
  const tsDir = stepsDir([]);
  const common = { root, cfg, eventsDb, user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: owners, tailscaleDir: tsDir, tailscaleStatus: async () => (asked++, now), slotsDir: join(dir, 'slots') };
  const d = await startDashboard({ ...common, stateDir: join(dir, 'state'), instance: 'alpha' });
  const local = await startDashboard({ ...common, stateDir: join(dir, 'state-local') });
  const callOn = (srv: typeof d) => async (path: string, headers: Record<string, string>, body?: unknown) => {
    const r = await fetch(`${srv.url.split('/?')[0]!}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${srv.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, text: await r.text() };
  };
  const call = callOn(d);
  try {
    // A local checkout has no such screen.
    const hidden = async (srv: typeof d, login: string) => {
      const r = await callOn(srv)('/api/tailscale', asDevicePerson(login));
      assert.equal(r.status, 200, r.text);
      const v = JSON.parse(r.text) as { machineOwner: boolean; status: unknown; steps: unknown[]; loginUrl: unknown; run: unknown };
      assert.deepEqual([v.machineOwner, v.status, v.steps, v.loginUrl, v.run], [false, null, [], null, null], `${login}: told only that there is nothing here`);
      assert.ok(!r.text.includes('login.tailscale.com'));
    };
    await hidden(local, 'example-owner');
    assert.equal((await callOn(local)('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'up', confirm: true })).status, 404);
    // Hidden from a writer, and from an instance owner who isn't a machine owner.
    await hidden(d, 'example-collaborator');
    writeFileSync(owners, `${JSON.stringify({ owners: ['olu'] })}\n`);
    await hidden(d, 'example-owner');
    writeFileSync(owners, `${JSON.stringify({ owners: ['example-owner'] })}\n`);

    const view = await call('/api/tailscale', asDevicePerson('example-owner'));
    assert.equal(view.status, 200, view.text);
    const v = JSON.parse(view.text) as { machineOwner: boolean; allowed: boolean; next: string; loginUrl: string | null; status: TailscaleStatus };
    assert.deepEqual([v.machineOwner, v.allowed, v.next, v.loginUrl, v.status.installed], [true, true, 'up', null, true]);
    // Looking changes nothing: no request, no event.
    const events = () => {
      const log = new EventLog(eventsDb);
      try {
        return log.read(0);
      } finally {
        log.close();
      }
    };
    assert.deepEqual(machineRequests(events()), []);

    // A step: refused for a writer, without a confirmation, for a word that isn't one of the four, and when not ready.
    assert.equal((await call('/api/machine/tailscale', asDevicePerson('example-collaborator'), { action: 'up', confirm: true })).status, 403);
    const unconfirmed = await call('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'up' });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.text, /review what it shows, then confirm it/);
    const key = await call('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'up --auth-key=tskey-auth-kExample-abcdef', confirm: true });
    assert.equal(key.status, 400);
    assert.ok(!key.text.includes('tskey'));
    assert.equal((await call('/api/machine/tailscale', asPerson('example-owner'), { action: 'up', confirm: true })).status, 403, 'not from an allowed device');
    assert.equal((await call('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'serve', confirm: true })).status, 409);
    assert.deepEqual(machineRequests(events()), [], 'no refusal recorded a request');

    // Confirmed: recorded for the coordinator, as two words; the machine is asked afresh first.
    const before = asked;
    const ok = await call('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'up', confirm: true });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(asked > before);
    assert.deepEqual(machineRequests(events()).map((r) => [r.args, r.via, r.by]), [[['tailscale', 'up'], 'tailscale', 'example-owner']]);

    // `up` now waits with its link: the owner gets it, a non-owner still gets nothing, and it is in no event.
    writeFileSync(join(tsDir, 'steps.jsonl'), UP_WAITING.map((l) => JSON.stringify({ at: new Date().toISOString(), ...l })).join('\n') + '\n');
    writeFileSync(join(tsDir, 'login-url'), `${LINK}\n`);
    const waiting = await call('/api/tailscale', asDevicePerson('example-owner'));
    assert.equal((JSON.parse(waiting.text) as { loginUrl: string }).loginUrl, LINK);
    await hidden(d, 'example-collaborator');
    const all = JSON.stringify(events());
    assert.ok(!all.includes('login.tailscale.com') && !all.includes('0123456789abcdef') && !all.includes('tskey'), 'the link and the key text are in no event, the audit included');
    const audits = events().filter((e) => e.type === 'dashboard.audit').map((e) => (e.payload as { action: string; detail: { action?: string } }));
    assert.deepEqual(audits.filter((a) => a.action === 'machine.tailscale').map((a) => a.detail.action), ['up']);
    // Every refusal above is audited (the local checkout's too: this test gives both servers one log), none naming what was typed.
    const refusals = audits.filter((a) => a.action === 'machine.tailscale_refused');
    assert.equal(refusals.length, 6);
    assert.deepEqual([...new Set(refusals.map((a) => a.detail.action))].sort(), ['not a step', 'serve', 'up']);

    // No setup script on this engine (or it didn't answer): nothing can be asked for.
    now = null;
    const none = await call('/api/machine/tailscale', asDevicePerson('example-owner'), { action: 'install', confirm: true });
    assert.equal(none.status, 409);
  } finally {
    await d.close();
    await local.close();
  }
});

test('the first-run step opens the screen, and names the script that does the same', () => {
  const step = SETUP_STEPS.find((s) => s.id === 'tailscale')!;
  assert.deepEqual(step.fix, { kind: 'screen', path: '/machine#tailscale', label: "the Machine page's Tailscale and HTTPS panel" });
  assert.ok(step.optional && step.modes.length === 1 && step.modes[0] === 'server');
  assert.match(step.today, /scripts\/setup\/tailscale\.sh install.*dashboards\.sh --public-url.*Skipping it changes nothing: the hub keeps its URL/);
});
