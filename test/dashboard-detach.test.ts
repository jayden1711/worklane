// WHY: the one-command install ends with `dashboard --detach` (scripts/bootstrap.sh): one wizard URL, the same on a
// rerun that starts nothing, and never the dashboard's key in the URL or the output.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DetachError, detachDashboard, detachedLines, probeDashboard, wizardUrl, type Probe } from '../src/dashboard-detach.js';
import { LOCAL_DASHBOARD_PORT } from '../src/dashboard.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { engineCli, exampleProject } from './helpers.js';

const KEY = 'k'.repeat(32);

function keyFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'detach-')), 'dashboard-token');
  writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
  return f;
}

/** A server that answers like a dashboard: 200 with this key in a bearer header, 401 otherwise. */
async function fakeDashboard(): Promise<{ port: number; seen: IncomingMessage[]; close: () => void }> {
  const seen: IncomingMessage[] = [];
  const s = createServer((req, res) => {
    seen.push(req);
    res.writeHead(req.headers.authorization === `Bearer ${KEY}` ? 200 : 401).end('{}');
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { port: (s.address() as { port: number }).port, seen, close: () => s.close() };
}

test('detach: the probe sends the key in a header, never the URL; ours, another, or nothing on the port', async () => {
  const f = keyFile();
  const d = await fakeDashboard();
  try {
    assert.equal(await probeDashboard(d.port, f), 'ours');
    assert.ok(d.seen.every((r) => !(r.url ?? '').includes(KEY)), 'the key is not in any request URL');
    assert.equal(await probeDashboard(d.port, join(f, '..', 'missing')), 'other', 'without the key: something answers, not ours');
    const wrong = join(mkdtempSync(join(tmpdir(), 'detach-')), 'dashboard-token');
    writeFileSync(wrong, 'x'.repeat(32));
    assert.equal(await probeDashboard(d.port, wrong), 'other', "another checkout's dashboard (a different key)");
  } finally {
    d.close();
  }
  assert.equal(await probeDashboard(d.port, f), 'none', 'nothing on the port');
});

test('detach: already answering with this key: the same URL, nothing started', async () => {
  let starts = 0;
  const d = await detachDashboard({ root: '/r', port: 4317, tokenFile: '/k', logFile: join(tmpdir(), 'x.log'), command: ['x'], probe: async () => 'ours', start: () => (starts++, { pid: 1, exited: () => null }) });
  assert.deepEqual(d, { url: 'http://127.0.0.1:4317/first-run', started: false });
  assert.equal(starts, 0);
});

test('detach: nothing on the port: starts it, and returns once it answers with the key', async () => {
  const answers: Probe[] = ['none', 'none', 'none', 'ours'];
  const started: string[][] = [];
  const log = join(mkdtempSync(join(tmpdir(), 'detach-')), 'state', 'dashboard.log');
  const d = await detachDashboard({ root: '/r', port: 4400, tokenFile: '/k', logFile: log, command: ['node', 'cli.js', 'dashboard', '--service'], probe: async () => answers.shift()!, start: (c) => (started.push(c), { pid: 42, exited: () => null }), sleep: async () => {} });
  assert.deepEqual(d, { url: wizardUrl(4400), started: true, pid: 42 });
  assert.deepEqual(started, [['node', 'cli.js', 'dashboard', '--service']]);
});

test("detach: refuses a port another program (or checkout) answers on, and says why when the dashboard can't start", async () => {
  const base = { root: '/r', port: 4317, tokenFile: '/k', logFile: join(mkdtempSync(join(tmpdir(), 'detach-')), 'd.log'), command: ['x'], sleep: async () => {} };
  let starts = 0;
  await assert.rejects(detachDashboard({ ...base, probe: async () => 'other', start: () => (starts++, { pid: 1, exited: () => null }) }), (e: Error) => e instanceof DetachError && /port 4317 answers, but not as this checkout's dashboard/.test(e.message));
  assert.equal(starts, 0, 'never starts a second one over it');
  await assert.rejects(detachDashboard({ ...base, probe: async () => 'none', start: () => ({ pid: 1, exited: () => 1 }) }), /the dashboard stopped \(exit 1\) before it answered: see .*d\.log/);
  await assert.rejects(detachDashboard({ ...base, waitMs: 1000, probe: async () => 'none', start: () => ({ pid: 1, exited: () => null }) }), /didn't answer on port 4317 within 1 s/);
});

test('detach: the lines it prints end with the one URL; the key file is named, the key never', () => {
  const lines = detachedLines({ url: wizardUrl(4317), started: true, pid: 7 }, { root: '/r', tokenFile: '/s/dashboard-token', logFile: '/s/dashboard.log' });
  assert.equal(lines.at(-1), 'http://127.0.0.1:4317/first-run');
  assert.equal(lines.filter((l) => /https?:\/\//.test(l)).length, 1, 'one URL');
  assert.match(lines.join('\n'), /started in the background \(pid 7; its log: \/s\/dashboard\.log\)/);
  assert.match(lines.join('\n'), /dashboard key: it is in \/s\/dashboard-token \(only you can read it\)/);
  assert.match(detachedLines({ url: wizardUrl(4317), started: false }, { root: '/r', tokenFile: '/t', logFile: '/l' })[0]!, /already running; nothing changed/);
});

const skip = process.platform === 'win32' && 'a detached dashboard is stopped here with a POSIX signal';

test('dashboard --detach, for real: started once, the same URL again with nothing started, no key in it or the output', { skip }, async () => {
  const { dir, stateDir } = exampleProject();
  const free = createServer();
  await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
  const port = (free.address() as { port: number }).port;
  await new Promise<void>((r) => free.close(() => r()));
  const env = { ...process.env, WORKLANE_STATE_DIR: stateDir, WORKLANE_USER: 'example-owner' };
  const run = () => spawnSync(process.execPath, [engineCli, 'dashboard', '--detach', '--no-open', '--root', dir, '--port', String(port)], { encoding: 'utf8', env, timeout: 60_000 });
  const first = run();
  const pid = Number(/pid (\d+);/.exec(first.stdout)?.[1]);
  try {
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const second = run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const url = `http://127.0.0.1:${port}/first-run`;
    for (const r of [first, second]) assert.equal(r.stdout.trim().split('\n').at(-1), url, 'the URL is the last line, the same both times');
    assert.match(second.stdout, /already running; nothing changed/);
    const tokenFile = join(stateDir, 'projects', basename(projectStateDir(dir)), 'dashboard-token');
    const key = readFileSync(tokenFile, 'utf8').trim();
    assert.ok(key.length >= 16);
    for (const r of [first, second]) assert.ok(!(r.stdout + r.stderr).includes(key), 'the key is never printed');
    assert.match(first.stdout, new RegExp(`dashboard key: it is in ${tokenFile.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'only the owner reads the key');
    const page = await fetch(url);
    assert.equal(page.status === 200 || page.status === 503, true, 'the page is served (503 only when this build has no web UI)');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/first-run`)).status, 401, 'no key, no data');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/role`, { headers: { authorization: `Bearer ${key}` } })).status, 200, 'the key in a header opens it (the CI job asks /api/first-run itself)');
  } finally {
    if (pid) process.kill(pid);
  }
});

test('dashboard --detach is a checkout\'s: refused for an instance, and a bad port', () => {
  const r = spawnSync(process.execPath, [engineCli, 'dashboard', '--detach', '--instance', 'shop'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dashboard --detach is a checkout's \(local mode\)/);
  const p = spawnSync(process.execPath, [engineCli, 'dashboard', '--detach', '--port', 'x'], { encoding: 'utf8' });
  assert.equal(p.status, 2);
  assert.equal(LOCAL_DASHBOARD_PORT, 4317, 'the port a checkout dashboard has always had');
});
