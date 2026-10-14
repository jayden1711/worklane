// The config follows the default branch (src/config/live.ts): a config change merged to main reaches the running
// coordinator on its next tick, read from git and never from its checkout's working tree; an invalid one is never
// applied (the last good one stays, and why is recorded); a restart-only setting keeps its running value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { CONFIG_INCIDENT, configTree, liveMerge, startConfig } from '../src/config/live.js';
import type { EventPayload } from '../src/events/types.js';
import { rolePrompt } from '../src/roles.js';
import { FakeRunner } from '../src/runner.js';
import { openIncidents, raiseIncident, readIncidents, resolveIncident } from '../src/watchdog/incidents.js';
import { coordinator, fixture, git, passing, type Fixture } from './repro-state-graph/harness.js';

const ident = ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false'];
const CONFIG = join(BRAND.configDir, 'config.yaml');
const WORKER = join(BRAND.configDir, 'roles', 'worker.md');

/** A person's clone of the remote: `push` edits config.yaml there and pushes it to main. */
function world() {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = ['ci'];
  const raised: string[] = [];
  const resolved: string[] = [];
  const incidents = { raiseIncident: (kind: string, _key: string, detail: string) => raised.push(`${kind}: ${detail}`), resolveIncident: (kind: string) => resolved.push(kind) };
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents });
  const person = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, person);
  const push = (edit: (text: string) => string, msg = 'config', file = CONFIG) => {
    const p = join(person, file);
    writeFileSync(p, edit(existsSync(p) ? readFileSync(p, 'utf8') : ''));
    git(person, 'add', '--', file);
    git(person, ...ident, 'commit', '-q', '-m', msg);
    git(person, 'push', '-q', 'origin', 'main');
    return git(person, 'rev-parse', 'HEAD');
  };
  const required = () => c.prReadiness(1, 'a'.repeat(40), passing).checks.map((x) => x.name);
  return { f, c, push, required, raised, resolved };
}

const of = <T>(f: Fixture, type: Parameters<Fixture['log']['read']>[1] extends (infer U)[] | undefined ? U : never) => f.log.read(0, [type]).map((e) => e.payload as T);
const requiredChecks = (list: string[]) => (text: string) => `${text.replace(/^required_checks:.*\n/m, '')}required_checks: [${list.join(', ')}]\n`;

test('live config: a commit to main that changes required_checks reaches PR readiness without a restart', async () => {
  const w = world();
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci']);
  const sha = w.push(requiredChecks(['ci', 'e2e']));
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci', 'e2e']);
  const applied = of<EventPayload<'config.applied'>>(w.f, 'config.applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.sha, sha);
  assert.ok(applied[0]!.changed.includes('project'));
  // Nothing new on main: nothing applied again.
  await w.c.tick();
  assert.equal(of(w.f, 'config.applied').length, 1);
});

test('live config: an invalid config pushed to main keeps the last good one and records why', async () => {
  const w = world();
  w.push(requiredChecks(['ci', 'e2e']));
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci', 'e2e']);
  const bad = w.push((t) => `${t}not_a_setting: true\n`, 'bad config');
  await w.c.tick();
  await w.c.tick();
  // The last good config runs on; the refusal is recorded once, with the file and the reason, and raised.
  assert.deepEqual(w.required(), ['ci', 'e2e']);
  const invalid = of<EventPayload<'config.invalid'>>(w.f, 'config.invalid');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]!.sha, bad);
  assert.match(invalid[0]!.errors.join('\n'), /config\.yaml.*not_a_setting/);
  assert.equal(w.raised.length, 1);
  assert.match(w.raised[0]!, /^config_invalid: .*invalid/);
  // Fixed on main: applied, and the incident resolved.
  w.push((t) => requiredChecks(['ci', 'lint'])(t.replace('not_a_setting: true\n', '')), 'fix config');
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci', 'lint']);
  assert.ok(w.resolved.includes('config_invalid'));
});

test("live config: the checkout's stale working tree is ignored once main has moved", async () => {
  const w = world();
  // The checkout's own copy says something else, and nothing ever updates it.
  const local = join(w.f.repo, CONFIG);
  writeFileSync(local, requiredChecks(['stale'])(readFileSync(local, 'utf8')));
  assert.deepEqual(loadConfig(w.f.repo).project.required_checks, ['stale']);
  writeFileSync(join(w.f.repo, WORKER), 'stale worker prompt\n');
  w.push(requiredChecks(['ci', 'e2e']));
  w.push(() => 'worker prompt from main\n', 'worker prompt', WORKER);
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci', 'e2e']);
  // The role prompts too: the ones committed with that config.
  assert.equal(rolePrompt((w.c as unknown as { d: { cfg: Fixture['cfg'] } }).d.cfg, 'worker'), 'worker prompt from main\n');
  // At start too: the default branch's config, not the checkout's.
  const start = startConfig({ repo: w.f.repo, remote: 'origin', fallback: loadConfig(w.f.repo) });
  assert.equal(start.note, null);
  assert.deepEqual(start.cfg.project.required_checks, ['ci', 'e2e']);
});

test('live config: a restart-only setting keeps its running value and says a restart is needed', async () => {
  const w = world();
  w.push((t) => requiredChecks(['ci', 'e2e'])(t.replace('name: example-shop', 'name: renamed-shop')));
  await w.c.tick();
  assert.deepEqual(w.required(), ['ci', 'e2e']);
  const applied = of<EventPayload<'config.applied'>>(w.f, 'config.applied').at(-1)!;
  assert.deepEqual(applied.restart_needed, [{ path: 'project.project.name', running: 'example-shop', wanted: 'renamed-shop' }]);
  assert.equal((w.c as unknown as { d: { cfg: Fixture['cfg'] } }).d.cfg.project.project.name, 'example-shop');
});

test('live config: turning direct landing on needs a restart; turning it off applies live', () => {
  const base = fixture().cfg;
  const pr = structuredClone(base);
  pr.project.land_mode = 'pr';
  const direct = structuredClone(base);
  direct.project.land_mode = 'direct';
  const on = liveMerge(pr, direct);
  assert.equal(on.cfg.project.land_mode, 'pr');
  assert.deepEqual(on.restart.map((r) => r.path), ['project.land_mode']);
  const off = liveMerge(direct, pr);
  assert.equal(off.cfg.project.land_mode, 'pr');
  assert.deepEqual(off.restart, []);
});

/** The persistent incident store (incidents.json) in a fresh dir, already holding an open config_invalid for `key`. */
function staleIncident(key: string) {
  const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
  raiseIncident(CONFIG_INCIDENT, key, 'invalid under an older engine', 'fix it', { dir, instance: key });
  const sink = { raiseIncident: (kind: string, k: string, detail: string, fix: string) => void raiseIncident(kind, k, detail, fix, { dir, instance: k }), resolveIncident: (kind: string, k: string) => void resolveIncident(kind, k, { dir }) };
  const open = () => openIncidents(readIncidents(dir)).filter((x) => x.kind === CONFIG_INCIDENT && x.key === key);
  return { sink, open };
}

test('live config: a config_invalid left open by an earlier process is resolved when the coordinator starts on a valid config', async () => {
  // Both start paths: the service's (the tree startConfig read) and a coordinator built without one (the checkout's HEAD).
  for (const fromStart of [true, false]) {
    const f = fixture();
    const s = staleIncident('alice');
    assert.equal(s.open().length, 1);
    const start = startConfig({ repo: f.repo, remote: 'origin', fallback: f.cfg });
    assert.equal(start.note, null);
    const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents: s.sink, ...(fromStart ? { liveConfig: { tree: start.tree } } : {}) });
    await c.tick();
    assert.deepEqual(s.open(), [], `still open after the first tick (fromStart=${fromStart})`);
    // Nothing applied: the running config was already the branch's.
    assert.equal(f.log.read(0, ['config.applied']).length, 0);
  }
});

test("live config: starting while the default branch's config is invalid keeps the incident open, and raises it when none was", async () => {
  const w = world();
  const bad = w.push((t) => `${t}not_a_setting: true\n`, 'bad config');
  const start = startConfig({ repo: w.f.repo, remote: 'origin', fallback: w.f.cfg });
  assert.match(start.note ?? '', /invalid/);
  const s = staleIncident('alice');
  const c = coordinator(w.f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents: s.sink, liveConfig: { tree: start.tree } });
  await c.tick();
  await c.tick();
  assert.equal(s.open().length, 1);
  assert.match(s.open()[0]!.detail, new RegExp(`at ${bad.slice(0, 8)} is invalid`));
  // The branch's tree is the running one, but fails the instance's checks: never trusted as valid, raised on the first tick.
  const f = fixture();
  const fresh = { raised: [] as string[], resolved: [] as string[] };
  const sink = { raiseIncident: (kind: string) => void fresh.raised.push(kind), resolveIncident: (kind: string) => void fresh.resolved.push(kind) };
  const check = () => [{ file: 'config.yaml', path: 'project', message: 'loosens the policy' }];
  const c2 = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents: sink, liveConfig: { tree: configTree(f.repo, 'refs/remotes/origin/main'), check } });
  await c2.tick();
  await c2.tick();
  assert.deepEqual(fresh.raised, [CONFIG_INCIDENT]);
  assert.deepEqual(fresh.resolved, []);
});
