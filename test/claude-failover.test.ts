// Auto-failover between Claude account profiles on a usage limit (src/claude-failover.ts, issue #464 part 2): off by
// default; on a stand-in usage limit it asks the helper to `use` the next profile in the order (proven by a real call
// there, by the script), raises an info notice naming both accounts and the reset time once the move is done, tries
// the next one when a move is refused, waits when none is free, moves back after the reset when asked to, and never
// moves on an auth failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILOVER_INCIDENT, failoverStep } from '../src/claude-failover.js';
import { failoverFor, readProfiles, requestFailoverSetting } from '../src/claude-profiles.js';
import { checkRootStep, profileStepOk } from '../src/console/root-steps.js';
import { EventLog } from '../src/events/log.js';
import { MachineRequestError } from '../src/machine-requests.js';
import { healthStatus, KINDS } from '../src/watchdog/incidents.js';
import { postText } from '../src/watchdog/post.js';
import { machineOwnersFile, ownerRequester, repoRoot } from './helpers.js';

// Now, as the log's own times are: a step compares them with its clock.
const T0 = Date.now();
const RESET = new Date(T0 + 4 * 3600_000).toISOString();

function setup(o: { failover?: object | null; active?: string; reset?: string } = {}) {
  const reset = o.reset ?? RESET;
  const dir = mkdtempSync(join(tmpdir(), 'claude-failover-'));
  const write = (active?: string) =>
    writeFileSync(
      join(dir, 'profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: { work: { kind: 'setup-token', users: {} }, spare: { kind: 'setup-token', users: {} } },
        active: active ? { alpha: { profile: active, since: 'x' } } : {},
        ...(o.failover === null ? {} : { failover: o.failover ?? { machine: { order: ['default', 'work', 'spare'], back: true } } }),
      }),
    );
  write(o.active);
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'cf-log-')), 'e.db'));
  const calls: string[][] = [];
  const incidents: { op: 'raise' | 'resolve'; kind: string; key: string; detail?: string }[] = [];
  let now = T0;
  const step = () =>
    failoverStep({
      log,
      instance: 'alpha',
      dir,
      now: () => now,
      exec: (file, args) => (calls.push([file, ...args]), 'started'),
      incidents: { raiseIncident: (kind, key, detail) => incidents.push({ op: 'raise', kind, key, detail }), resolveIncident: (kind, key) => incidents.push({ op: 'resolve', kind, key }) },
    });
  const limit = () => log.append('usage.paused', { reset_at: reset, source: 'claude', kind: 'five_hour', issue: 7, role: 'worker', detail: 'usage limit' }, 'alpha', 'coordinator');
  const answer = (to: string, ok: boolean) => log.append('account.switched', { op: `op-${to}-${now}`, to, from: {}, instances: ['alpha'], by: 'failover', ok, detail: ok ? 'done' : 'refused: HTTP 401' }, 'alpha', 'coordinator');
  const stages = () => log.read(0, ['account.failover']).map((e) => { const p = e.payload as { stage: string; from: string; to: string }; return `${p.stage} ${p.from}>${p.to}`; });
  return { dir, log, calls, incidents, step, limit, answer, stages, write, tick: (ms: number) => (now += ms) };
}

test('off by default: a usage limit moves nothing', () => {
  const m = setup({ failover: null });
  m.limit();
  assert.equal(m.step(), null);
  assert.deepEqual(m.calls, []);
  assert.equal(failoverFor('alpha', readProfiles(m.dir)), null);
  // An order of one is off too: there is nowhere to move.
  writeFileSync(join(m.dir, 'profiles.json'), JSON.stringify({ failover: { machine: { order: ['work'], back: true } } }));
  assert.equal(failoverFor('alpha', readProfiles(m.dir)), null);
  m.log.close();
});

test('a stand-in usage limit moves to the next account through the helper; done, an info notice names both and the reset; the pause then ends as for any switch', () => {
  const m = setup();
  m.limit();
  assert.equal(m.step(), 'asked');
  assert.equal(m.calls.length, 1);
  assert.deepEqual(m.calls[0]!.slice(0, 2), ['sudo', '-n']);
  assert.deepEqual(m.calls[0]!.slice(3), ['claude-account', 'use', 'work', 'alpha']);
  // Waiting for the step's answer: nothing more is asked.
  assert.equal(m.step(), null);
  assert.equal(m.calls.length, 1);
  m.answer('work', true);
  m.write('work');
  assert.equal(m.step(), 'switched');
  const raised = m.incidents.find((i) => i.op === 'raise')!;
  assert.equal(raised.kind, FAILOVER_INCIDENT);
  assert.match(raised.detail!, new RegExp(`usage limit on account default: this instance moved to account work .*default's limit resets ${RESET.slice(0, 16).replace('T', ' ')} UTC`));
  // Moved for this pause: nothing more until the next.
  assert.equal(m.step(), null);
  assert.deepEqual(m.stages(), ['asked default>work', 'switched default>work']);
  m.log.close();
});

test('a move the real call refuses is not made: the next account in the order is tried; none free, it waits for the reset', () => {
  const m = setup();
  m.limit();
  assert.equal(m.step(), 'asked');
  m.answer('work', false);
  assert.equal(m.step(), 'refused');
  assert.equal(m.step(), 'asked');
  assert.deepEqual(m.calls.at(-1)!.slice(3), ['claude-account', 'use', 'spare', 'alpha']);
  m.answer('spare', false);
  assert.equal(m.step(), 'refused');
  assert.equal(m.step(), 'none');
  assert.equal(m.step(), null, 'said once');
  assert.deepEqual(m.stages(), ['asked default>work', 'refused default>work', 'asked default>spare', 'refused default>spare', 'none default>default']);
  assert.equal(m.incidents.length, 0, 'no notice: nothing moved');
  m.log.close();
});

test('a step whose unit never answers is given up after 30 minutes, then the next is tried', () => {
  const m = setup();
  m.limit();
  m.step();
  m.tick(29 * 60_000);
  assert.equal(m.step(), null);
  m.tick(2 * 60_000);
  assert.equal(m.step(), 'refused');
  assert.equal(m.step(), 'asked');
  m.log.close();
});

test('back after the reset: once it has passed and the instance is still on the account it moved to, back to where it began, proven the same way', () => {
  // A limit that resets in a minute (the log's times are the real clock's, so the step's clock moves only a little).
  const m = setup({ reset: new Date(T0 + 60_000).toISOString() });
  m.limit();
  m.step();
  m.answer('work', true);
  m.write('work');
  m.step();
  m.log.append('usage.resumed', { reset_at: RESET, paused_ms: 1000, reason: 'account switched' }, 'alpha', 'coordinator');
  assert.equal(m.step(), null, 'not before the reset');
  m.tick(2 * 60_000);
  assert.equal(m.step(), 'back-asked');
  assert.deepEqual(m.calls.at(-1)!.slice(3), ['claude-account', 'use', 'default', 'alpha']);
  m.answer('default', false);
  assert.equal(m.step(), 'back-refused');
  assert.equal(m.step(), null, 'asked again only after a while');
  m.tick(16 * 60_000);
  assert.equal(m.step(), 'back-asked');
  m.answer('default', true);
  m.write();
  assert.equal(m.step(), 'back');
  assert.deepEqual(m.incidents.at(-1), { op: 'resolve', kind: FAILOVER_INCIDENT, key: 'alpha' });
  assert.equal(m.step(), null);
  m.log.close();
});

test('with move-back off, it stays on the account it moved to', () => {
  const m = setup({ failover: { machine: { order: ['default', 'work'], back: false } } });
  m.limit();
  m.step();
  m.answer('work', true);
  m.write('work');
  m.step();
  m.log.append('usage.resumed', { reset_at: RESET, paused_ms: 1000, reason: 'account switched' }, 'alpha', 'coordinator');
  m.tick(6 * 3600_000);
  assert.equal(m.step(), null);
  m.log.close();
});

test('never on an auth failure: a refused login (#463) moves nothing, failover on or not', () => {
  const m = setup();
  m.log.append('claude_auth.failed', { key: '/home/example/wl-alpha-agent/.claude', login: 'a@example.com', lane: 'default', issue: 7, role: 'worker', detail: "claude's login was refused (HTTP 401)" }, 'alpha', 'coordinator');
  assert.equal(m.step(), null);
  assert.deepEqual(m.calls, []);
  m.log.close();
});

test("an instance's own setting wins over the machine's; off for it is off", () => {
  const m = setup({ failover: { machine: { order: ['default', 'work'], back: true }, instances: { alpha: { order: [], back: false } } } });
  m.limit();
  assert.equal(m.step(), null);
  m.log.close();
});

test('the notice is info: it never colours an instance status, and its post says Notice', () => {
  assert.equal(KINDS[FAILOVER_INCIDENT as keyof typeof KINDS].severity, 'info');
  const x = { id: 'x', kind: FAILOVER_INCIDENT, key: 'alpha', instance: 'alpha', severity: 'info' as const, title: 't', detail: 'd', fix: 'f', tried: [], since: 'a', lastSeen: 'a', resolvedAt: null, posted: {} };
  assert.equal(healthStatus([x], 'alpha'), 'green');
  assert.match(postText(x, 'raised'), /^\*\*Notice\*\* on instance alpha/);
});

test('the setting is a machine request with exactly its arguments, gated like any profile step; allowlist and helper agree', () => {
  const owners = machineOwnersFile('ada');
  const who = { role: 'owner' as const, requester: ownerRequester('ada') };
  const log = new EventLog(join(mkdtempSync(join(tmpdir(), 'cf-req-')), 'e.db'));
  try {
    for (const bad of [{ order: ['work'], back: true }, { order: ['work', 'work'], back: true }, { order: ['Work', 'x'], back: true }, { order: ['a', 'b'], back: 'yes' }, { order: ['a', 'b'], back: true, instance: 'Alpha' }]) assert.throws(() => requestFailoverSetting(log, { ...bad, who, ownersFile: owners }), MachineRequestError, JSON.stringify(bad));
    assert.throws(() => requestFailoverSetting(log, { order: ['a', 'b'], back: true, who: { role: 'writer', requester: ownerRequester('ada') }, ownersFile: owners }), (e: unknown) => e instanceof MachineRequestError && e.status === 403);
    assert.throws(() => requestFailoverSetting(log, { order: ['a', 'b'], back: true, who: { role: 'owner', requester: { login: 'ada', breakGlass: false, deviceOk: false } }, ownersFile: owners }), (e: unknown) => e instanceof MachineRequestError && e.status === 403);
    assert.deepEqual(requestFailoverSetting(log, { order: ['default', 'work'], back: true, instance: 'beta', who, ownersFile: owners }).args, ['claude-account', 'failover', 'default+work', 'back', 'beta']);
  } finally {
    log.close();
  }
  const helper = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs')) as { parseClaudeFailover: (a: string[]) => unknown };
  for (const a of [['failover', 'default+work', 'back'], ['failover', 'off', 'stay'], ['failover', 'a+b+c', 'stay', 'alpha']]) {
    assert.ok(profileStepOk(a) && checkRootStep('claude-account', a).allowed, JSON.stringify(a));
    assert.ok(helper.parseClaudeFailover(['claude-account', ...a]), JSON.stringify(a));
  }
  for (const a of [['failover', 'work', 'back'], ['failover', 'a+b', 'maybe'], ['failover', 'a+b', 'back', 'x', 'y'], ['failover', 'a++b', 'back'], ['failover', 'a+b', 'back', 'dash'], ['failover', 'a+b+c+d+e+f+g+h+i', 'back'], ['failover', 'a,b', 'back']]) {
    assert.ok(!profileStepOk(a) && !checkRootStep('claude-account', a).allowed, JSON.stringify(a));
    assert.equal(helper.parseClaudeFailover(['claude-account', ...a]), null, JSON.stringify(a));
  }
});
