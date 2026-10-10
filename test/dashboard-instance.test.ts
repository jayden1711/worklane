import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { dashboardSite, instancePort, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { initInstance } from '../src/instance.js';
import { childEnv } from '../src/os/index.js';
import { logPath } from '../src/service.js';
import { agentIsSelf, exampleProject, repoRoot } from './helpers.js';

function instance(name = 'shop') {
  const dir = mkdtempSync(join(tmpdir(), 'dash-instances-'));
  const { dir: repo } = exampleProject();
  const home = initInstance(name, repo, 'example-org/example-shop', dir);
  agentIsSelf(home);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 40 }\nagents: { max_workers: 4 }\nland_mode: pr\n');
  return { dir, repo, home };
}

test('with --instance the dashboard reads and writes that instance\'s log and state, not the checkout\'s', async () => {
  const { dir, repo, home } = instance();
  const site = dashboardSite(repo, 'shop', dir);
  assert.equal(site.eventsDb, join(home, 'state', 'events.db'));
  assert.equal(site.stateDir, join(home, 'state'));
  assert.notEqual(site.eventsDb, logPath(repo), 'not the checkout\'s own project log');
  assert.equal(site.cfg.project.project.repo, 'example-org/example-shop');
  assert.equal(site.port, instancePort('shop'));
  assert.equal(dashboardSite(repo).port, 4317, 'a checkout keeps the usual port');

  const log = new EventLog(site.eventsDb);
  log.append('issue.seen', { issue: 3, title: 'In the instance', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
  log.append('decision.asked', { id: 'd-1', kind: 'land', issue: 3, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] }, 'c');
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>ok</title>');
  const d = await startDashboard({ root: site.root, cfg: site.cfg, eventsDb: site.eventsDb, stateDir: site.stateDir, user: 'example-owner', webDir: web });
  try {
    const base = d.url.split('/?')[0]!;
    const h = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
    const st = (await (await fetch(`${base}/api/state`, { headers: h })).json()) as { tasks: { title: string }[] };
    assert.equal(st.tasks[0]!.title, 'In the instance');
    assert.equal((await fetch(`${base}/api/decide`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'd-1', answer: 'approve' }) })).status, 200);
    assert.equal(log.read(0, ['decision.answered']).length, 1, 'the answer is in the instance\'s log');
    assert.equal(readFileSync(join(home, 'state', 'dashboard-token'), 'utf8').trim(), d.token, 'the token lives with the instance');
  } finally {
    await d.close();
    log.close();
  }
});

test('an instance\'s dashboard port is fixed by its name, in its own range', () => {
  for (const n of ['shop', 'site', 'code', 'a', 'a-much-longer-instance-name']) {
    const p = instancePort(n);
    assert.equal(p, instancePort(n), 'the same every time');
    assert.ok(p >= 4400 && p < 4900 && p !== 4317, `${n}: ${p}`);
  }
  assert.notEqual(instancePort('shop'), instancePort('site'));
});

test('dashboard --instance refuses an unknown instance instead of showing another log', () => {
  const { dir } = instance();
  const r = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'dashboard', '--instance', 'nope', '--no-open'], { encoding: 'utf8', env: { ...childEnv(), [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir }, timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /no instance "nope"/);
});

test('the dashboard setup script runs it as the instance\'s coordinator, on loopback, without opening a browser', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'dashboard.sh'), 'utf8');
  assert.match(sh, /run_as "\$coord" '/);
  assert.match(sh, /args=\(dashboard --instance "\$1" --no-open\)/);
  assert.match(sh, /ssh -N -L <port>:127\.0\.0\.1:<port>/, 'the tunnel binds the same port on 127.0.0.1');
});
