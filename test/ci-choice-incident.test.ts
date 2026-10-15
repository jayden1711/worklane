// #469: an empty required_checks in PR mode still loads (an existing config keeps its coordinator running), but it is
// never silent: the coordinator's live-config check raises config_invalid naming it, with the fix, from its first
// tick; a config that names a check resolves it on the tick it lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { CONFIG_INCIDENT } from '../src/config/live.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture, git } from './repro-state-graph/harness.js';

test('the coordinator on a PR-mode config with no required check: config_invalid raised naming it and the fix, the config still running; resolved once a check is named on main', async () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.required_checks = [];
  const raised: { kind: string; detail: string; fix: string }[] = [];
  const resolved: string[] = [];
  const incidents = { raiseIncident: (kind: string, _k: string, detail: string, fix: string) => void raised.push({ kind, detail, fix }), resolveIncident: (kind: string) => void resolved.push(kind) };
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents });
  await c.tick();
  assert.equal(raised.length, 1, 'raised on the first tick (the start)');
  assert.equal(raised[0]!.kind, CONFIG_INCIDENT);
  assert.match(raised[0]!.detail, /^\.worklane\/ on main: required_checks is empty and no CI is chosen: no PR is ever marked ready, so nothing ever merges\.$/);
  assert.match(raised[0]!.fix, /^Fix: on the dashboard's First-run page, "Required checks named": add the starter CI/);
  assert.deepEqual(resolved, []);
  assert.equal(f.log.read(0, ['config.invalid']).length, 0, 'the config itself loads: nothing refused');
  // A person names the check on main.
  const person = join(mkdtempSync(join(tmpdir(), 'person-')), 'p');
  git(f.base, 'clone', '-q', f.remote, person);
  const file = join(person, BRAND.configDir, 'config.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}required_checks: [test]\n`);
  git(person, 'add', '--', file);
  git(person, '-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'name the check');
  git(person, 'push', '-q', 'origin', 'main');
  await c.tick();
  assert.equal(f.log.read(0, ['config.applied']).length, 1);
  assert.deepEqual(resolved, [CONFIG_INCIDENT]);
  assert.equal(raised.length, 1, 'not raised again');
});

test('a direct-land coordinator with no required checks raises nothing: it lands without PRs', async () => {
  const f = fixture();
  assert.equal(f.cfg.project.land_mode, 'direct');
  const raised: string[] = [];
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0, incidents: { raiseIncident: (k: string) => void raised.push(k), resolveIncident: () => {} } });
  await c.tick();
  assert.deepEqual(raised, []);
});
