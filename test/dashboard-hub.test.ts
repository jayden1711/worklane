import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { parseHubArg, startHub, type HubInstance } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { childEnv } from '../src/os/index.js';
import { exampleProject, repoRoot } from './helpers.js';

const seen = (issue: number, title: string) => ({ issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' });
const asked = (id: string) => ({ id, kind: 'land' as const, issue: 1, owner: 'example-owner', question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [] });

/** One instance's own dashboard server, with its own log and state dir. */
async function instance(title: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-inst-'));
  const { dir: root } = exampleProject();
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  log.append('issue.seen', seen(1, title), 'c');
  log.append('decision.asked', asked('d-1'), 'c');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: dir, user: 'example-owner', slotsDir: join(dir, 'slots'), pollMs: 50 });
  const port = Number(new URL(d.url).port);
  return { d, log, dir, port };
}

async function setup() {
  const a = await instance('In A');
  const b = await instance('In B');
  const web = mkdtempSync(join(tmpdir(), 'hub-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  const instances: HubInstance[] = [
    { name: 'a', port: a.port, tokenFile: join(a.dir, 'dashboard-token') },
    { name: 'b', port: b.port, tokenFile: join(b.dir, 'dashboard-token') },
  ];
  const h = await startHub({ instances, stateDir: mkdtempSync(join(tmpdir(), 'hub-state-')), webDir: web });
  const base = h.url.split('/?')[0]!;
  const hh = { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' };
  const close = async () => {
    await h.close();
    await a.d.close();
    await b.d.close();
  };
  return { a, b, h, base, hh, close };
}

test('the hub shows each instance through that instance\'s own dashboard, behind its own token', async () => {
  const s = await setup();
  try {
    assert.equal((await fetch(`${s.base}/api/hub`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/i/a/state`, { headers: { authorization: `Bearer ${s.a.d.token}` } })).status, 401, 'an instance\'s token is not the hub\'s');
    const hub = (await (await fetch(`${s.base}/api/hub`, { headers: s.hh })).json()) as { instances: { name: string; up: boolean }[] };
    assert.deepEqual(hub.instances.map((i) => [i.name, i.up]), [['a', true], ['b', true]]);
    const title = async (n: string) => ((await (await fetch(`${s.base}/api/i/${n}/state`, { headers: s.hh })).json()) as { tasks: { title: string }[] }).tasks[0]!.title;
    assert.equal(await title('a'), 'In A');
    assert.equal(await title('b'), 'In B');
    assert.equal((await fetch(`${s.base}/api/i/c/state`, { headers: s.hh })).status, 404, 'only the instances it was given');
    assert.equal((await fetch(`${s.base}/api/state`, { headers: s.hh })).status, 404, 'the hub has no state of its own');
    for (const p of ['/api/hub', '/api/i/a/state', '/api/i/a/settings']) {
      const body = await (await fetch(`${s.base}${p}`, { headers: s.hh })).text();
      for (const t of [s.a.d.token, s.b.d.token]) assert.ok(!body.includes(t), `${p} must not hand an instance token to the browser`);
    }
    const page = await (await fetch(`${s.base}/issues/1`)).text();
    assert.match(page, /<title>hub/, 'serves the UI');
    assert.ok(page.includes('<meta name="dashboard-hub" content="1">'), 'marked as served by a hub, so the UI asks for its instances');
    const own = await (await fetch(`${s.a.d.url.split('/?')[0]}/issues/1`)).text();
    assert.ok(!own.includes('dashboard-hub'), 'an instance\'s own dashboard is not marked (its UI never asks for /api/hub)');
  } finally {
    await s.close();
  }
});

test('an answer through the hub is recorded by that instance\'s own server, in its log only', async () => {
  const s = await setup();
  try {
    const r = await fetch(`${s.base}/api/i/a/decide`, { method: 'POST', headers: s.hh, body: JSON.stringify({ id: 'd-1', answer: 'approve' }) });
    assert.equal(r.status, 200);
    assert.equal(s.a.log.read(0, ['decision.answered']).length, 1);
    assert.equal(s.b.log.read(0, ['decision.answered']).length, 0, 'the other instance\'s log is untouched');
    const again = await fetch(`${s.base}/api/i/a/decide`, { method: 'POST', headers: s.hh, body: JSON.stringify({ id: 'd-1', answer: 'reject' }) });
    assert.equal(again.status, 409, 'the instance\'s own checks apply');
  } finally {
    await s.close();
  }
});

test('the hub streams an instance\'s changes, and says when an instance isn\'t answering', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.base}/api/i/b/stream?t=${s.h.token}`);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = '';
    const read = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += dec.decode(value);
        if (got.includes('event: change')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    s.b.log.append('issue.seen', seen(2, 'More in B'), 'c');
    await Promise.race([read, new Promise((_, rej) => setTimeout(() => rej(new Error('no change event within 5s')), 5000))]);
    assert.match(got, /event: hello[\s\S]*event: change/);
    await reader.cancel();
    await s.a.d.close();
    const hub = (await (await fetch(`${s.base}/api/hub`, { headers: s.hh })).json()) as { instances: { name: string; up: boolean }[] };
    assert.deepEqual(hub.instances.map((i) => [i.name, i.up]), [['a', false], ['b', true]]);
    const down = await fetch(`${s.base}/api/i/a/state`, { headers: s.hh });
    assert.equal(down.status, 502);
    assert.match(((await down.json()) as { error: string }).error, /isn't answering/);
  } finally {
    await s.h.close();
    await s.b.d.close();
  }
});

test('--hub names each instance once, with its state dir; the CLI refuses a malformed one', () => {
  const port = (n: string) => (n === 'a' ? 4401 : 4402);
  assert.deepEqual(parseHubArg('a=/s/a/state/,b=/s/b/state', port), [
    { name: 'a', port: 4401, tokenFile: '/s/a/state/dashboard-token' },
    { name: 'b', port: 4402, tokenFile: '/s/b/state/dashboard-token' },
  ]);
  for (const bad of ['', 'a', '=/x', 'A=/x', 'a=/x,a=/y']) assert.throws(() => parseHubArg(bad, port), /--hub/);
  const r = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'dashboard', '--hub', 'Bad', '--service'], { encoding: 'utf8', env: childEnv(), timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--hub takes name=/);
});

test('the dashboards setup gives the viewer read of each token and traverse on the way, nothing more', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'dashboards.sh'), 'utf8');
  const acls = [...sh.matchAll(/setfacl -m "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(acls, ['g:$viewer:--x', 'g:$viewer:r--'], 'traverse on directories, read on the token file');
  assert.match(sh, /setfacl -m "g:\$viewer:r--" "\$state\/dashboard-token"/);
  assert.doesNotMatch(sh, /setfacl[^\n]*-d\b|setfacl[^\n]*:rw|setfacl[^\n]*-R\b/, 'no default, recursive or write ACLs');
  assert.doesNotMatch(sh, /usermod|gpasswd|ensure_member/, 'no instance user joins a new group');
  assert.match(sh, /User=wl-\$1\n/, 'each instance\'s dashboard runs as that instance\'s coordinator');
  assert.match(sh, /User=\$viewer\n/, 'the hub runs as the viewer');
  assert.match(sh, /ExecStart=\/usr\/local\/bin\/worklane dashboard --hub \$hub_arg --service/);
  assert.match(sh, /ProtectHome=read-only\nReadWritePaths=\/home\/\$viewer/, 'the hub can write only its own home');
  assert.ok(sh.indexOf('"$@" > "$tmp"') < sh.indexOf('systemd-analyze verify') && sh.indexOf('systemd-analyze verify') < sh.indexOf('mv -f "$tmp"'), 'units: temp name, validate, move');
  assert.match(sh, /FAIL: \$viewer can write/, 'it checks the viewer can\'t write');
});
