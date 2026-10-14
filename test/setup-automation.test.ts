// WHY: the owner's rules for every first-run screen: it can be skipped, run again later (from Settings), and done
// without the page by a command or config key that the screen and docs/dashboard.md both name.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { setupChecks } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install } from '../src/install.js';
import { SETUP_STEPS, type SetupProbe, type SetupView } from '../src/setup-steps.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'setup-automation-state-'));

const SCREEN_KINDS = ['action', 'form', 'start', 'screen', 'signin', 'gh-login', 'discord'];

test('every step with a screen names how to do it without the page, and docs/dashboard.md lists exactly those', () => {
  const screens = SETUP_STEPS.filter((s) => SCREEN_KINDS.includes(s.fix.kind));
  assert.ok(screens.length >= 10);
  for (const s of screens) assert.ok(s.automation && s.automation.length > 5, `${s.id}: names a command or config key`);
  const doc = readFileSync(join(repoRoot, 'docs', 'dashboard.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## First-run screens: skip, run again, or automate'), doc.indexOf('\n## ', doc.indexOf('## First-run screens') + 5));
  const rows = [...section.matchAll(/^\| (.+?) \| (.+?) \| `(.+)` \|$/gm)].map((m) => [m[1], m[3]]);
  assert.deepEqual(rows, screens.map((s) => [s.title, s.automation]), 'one row per screen, in registry order, with its automation verbatim');
});

function fixture() {
  const { dir } = exampleProject();
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  install({ root: dir });
  return dir;
}

const probe: SetupProbe = {
  which: (c) => `/stand-in/${c}`,
  run: (cmd, args, o = {}) => {
    if (cmd === 'git') {
      const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (cmd === 'claude') return { status: 0, stdout: '{"loggedIn": true}', stderr: '' };
    if (cmd === 'gh' && args.join(' ').endsWith('--jq .permissions.push')) return { status: 0, stdout: 'true\n', stderr: '' };
    if (cmd === 'gh' && args.join(' ') === 'auth status') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
  },
  serviceRunning: () => false,
  systemUnitActive: () => false,
  linger: () => null,
};

async function dashboard(dir: string) {
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'sa-slots-')), setupProbe: probe });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async () => (await (await fetch(`${base}/api/first-run?fresh=1`, { headers: h('example-owner') })).json()) as { setup: SetupView; actions: Record<string, { available: boolean }> };
  const skip = async (step: string, skip: boolean, user = 'example-owner') => {
    const r = await fetch(`${base}/api/first-run/skip`, { method: 'POST', headers: h(user), body: JSON.stringify({ step, skip }) });
    return { status: r.status, body: (await r.json()) as { skipped?: string[]; error?: string } };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => (e.payload as { action: string; detail: Record<string, unknown> })).filter((a) => a.action === 'first_run.skip');
    } finally {
      log.close();
    }
  };
  return { d, get, skip, audit };
}

const step = (v: SetupView, id: string) => v.groups.flatMap((g) => g.steps).find((s) => s.id === id)!;

test('Skip: an owner skips a step; it shows as skipped and is no longer counted as left, while doctor still checks it; Undo brings it back; audited; a writer may not', async () => {
  const dir = fixture();
  const s = await dashboard(dir);
  try {
    const before = await s.get();
    assert.equal(step(before.setup, 'required-checks').done, false);
    assert.equal((await s.skip('required-checks', true, 'example-collaborator')).status, 403);
    assert.equal((await s.skip('no-such-step', true)).status, 404);
    assert.deepEqual((await s.skip('required-checks', true)).body.skipped, ['required-checks']);
    const after = await s.get();
    assert.equal(step(after.setup, 'required-checks').skipped, true);
    assert.equal(after.setup.requiredLeft, before.setup.requiredLeft - 1);
    const doc = setupChecks(dir, { probe, mode: 'local' });
    assert.equal(doc.find((c) => c.name === 'setup step required-checks')!.level, 'warn', 'doctor still checks a skipped step');
    assert.deepEqual((await s.skip('required-checks', false)).body.skipped, []);
    assert.equal(step((await s.get()).setup, 'required-checks').skipped, false);
    assert.deepEqual(s.audit().map((a) => [a.detail.step, a.detail.skip]), [['required-checks', true], ['required-checks', false]]);
  } finally {
    await s.d.close();
  }
});

test("Run again: a done step's action still has its plan, so Settings' Setup list can open it and run it again", async () => {
  const dir = fixture();
  install({ root: dir, gitHooks: true });
  const s = await dashboard(dir);
  try {
    const v = await s.get();
    assert.equal(step(v.setup, 'pre-commit').done, true);
    assert.equal(v.actions['git-hooks']?.available, true);
    assert.equal(step(v.setup, 'pre-commit').automation, `${BRAND.cli} install --git-hooks`);
  } finally {
    await s.d.close();
  }
});
