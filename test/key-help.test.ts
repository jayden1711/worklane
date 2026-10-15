// WHY (#467): the key's file on macOS is under ~/Library/Application Support (a space, a folder file pickers hide). The
// terminal and the key page show its path and a command that copies it, quoted so it works pasted as is; the key never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { KEY_HELP_PATH, loopbackHostHeader, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { copyFileCommand, loopbackPeerIsMe, lsofListsClient, shellQuote } from '../src/os/index.js';
import { exampleProject, exampleRoles } from './helpers.js';

const posix = process.platform !== 'win32';

test('the copy command for each clipboard tool, and none without one', () => {
  const bin = mkdtempSync(join(tmpdir(), 'clip-bin-'));
  const has = (...tools: string[]) => {
    const d = mkdtempSync(join(bin, 'p-'));
    for (const t of tools) writeFileSync(join(d, t), '', { mode: 0o755 });
    return d;
  };
  const f = '/h/Library/Application Support/x/dashboard-token';
  assert.equal(copyFileCommand(f, 'darwin', has()), `pbcopy < '${f}'`);
  assert.equal(copyFileCommand(f, 'linux', has('wl-copy', 'xclip')), `wl-copy < '${f}'`);
  assert.equal(copyFileCommand(f, 'linux', has('xclip')), `xclip -selection clipboard < '${f}'`);
  assert.equal(copyFileCommand(f, 'linux', has('clip.exe')), `clip.exe < '${f}'`, 'WSL');
  assert.equal(copyFileCommand(f, 'linux', has()), null, 'no tool: the path alone');
  assert.equal(copyFileCommand('C:\\Users\\example\\a b\\k', 'win32'), 'clip < "C:\\Users\\example\\a b\\k"');
  assert.equal(copyFileCommand('C:\\a"&b', 'win32'), null, "a path cmd can't quote");
  assert.equal(shellQuote("it's $HOME `x`"), `'it'\\''s $HOME \`x\`'`);
});

test('the printed command, pasted into a shell as is, copies exactly the file, with a space and a quote in its path', { skip: !posix && 'POSIX shell' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'clip-'));
  const home = join(dir, "Application Support", "it's here");
  mkdirSync(home, { recursive: true });
  const file = join(home, 'dashboard-token');
  const key = `k${'x'.repeat(31)}`;
  writeFileSync(file, key, { mode: 0o600 });
  // Stand-in clipboard tools: each writes what it is given on stdin to a file.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const got = join(dir, 'clipboard');
  for (const t of ['pbcopy', 'wl-copy', 'xclip', 'clip.exe']) {
    writeFileSync(join(bin, t), `#!/bin/sh\ncat > "${got}"\n`);
    chmodSync(join(bin, t), 0o755);
  }
  for (const [platform, path] of [['darwin', bin], ['linux', bin]] as const) {
    const cmd = copyFileCommand(file, platform, path)!;
    writeFileSync(got, '');
    const r = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(got, 'utf8'), key, `${platform}: ${cmd}`);
    assert.ok(!cmd.includes(key), 'the command holds the path, never the key');
  }
});

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    r.on('error', fail);
    r.end();
  });
}

test("the key page's help: on this machine, with no key, the file and its copy command; never the key; never through a proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'key-help-'));
  const { dir: root } = exampleProject();
  const db = join(dir, 'events.db');
  new EventLog(db).close();
  const stateDir = join(dir, 'state with space');
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: 'example-owner', roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots') });
  try {
    const port = Number(new URL(d.url).port);
    const r = await get(port, KEY_HELP_PATH);
    assert.equal(r.status, 200, r.body);
    const help = JSON.parse(r.body) as { file: string; copy: string | null };
    assert.equal(help.file, join(stateDir, 'dashboard-token'));
    assert.equal(readFileSync(help.file, 'utf8').trim(), d.token, 'the file the key is in');
    if (help.copy !== null) assert.ok(help.copy.includes(shellQuote(help.file)) || help.copy.includes(`"${help.file}"`), help.copy);
    assert.ok(!r.body.includes(d.token), 'never the key');
    // A page from another site whose name was pointed at 127.0.0.1 (DNS rebinding): its Host is that name. Nothing.
    for (const host of [`evil.example:${port}`, 'localhost', `127.0.0.1:${port + 1}`]) {
      const p = await get(port, KEY_HELP_PATH, { host });
      assert.equal(p.status, 404, host);
      assert.ok(!p.body.includes('dashboard-token'));
    }
    // Through a proxy (tailscale serve, the hub): nothing, not even where it is.
    for (const h of [{ 'x-forwarded-for': '192.0.2.9' }, { forwarded: 'for=192.0.2.9' }]) {
      const p = await get(port, KEY_HELP_PATH, h);
      assert.equal(p.status, 404, JSON.stringify(h));
      assert.ok(!p.body.includes('dashboard-token'));
    }
  } finally {
    await d.close();
  }
});

test('who may have the help: a loopback Host for this port; the connecting process is this OS user (Linux: the kernel; macOS: lsof)', () => {
  for (const h of ['127.0.0.1:4317', 'localhost:4317', 'LOCALHOST:4317', '[::1]:4317']) assert.equal(loopbackHostHeader(h, 4317), true, h);
  for (const h of [undefined, '', '127.0.0.1', '127.0.0.1:4318', 'evil.example:4317', '127.0.0.1.evil.example:4317', 'localhost.:4317']) assert.equal(loopbackHostHeader(h, 4317), false, String(h));
  assert.equal(loopbackHostHeader('127.0.0.1:4317', undefined), false);
  // lsof -Fn as a normal macOS user lists only that user's processes: the client end listed means the client is ours.
  const out = 'p84222\nf13\nn127.0.0.1:60440->127.0.0.1:4317\nf14\nn127.0.0.1:4317->127.0.0.1:60440\n';
  assert.equal(lsofListsClient(out, 60440, 4317), true);
  assert.equal(lsofListsClient('p1\nf14\nn127.0.0.1:4317->127.0.0.1:60440\n', 60440, 4317), false, 'only our own (server) end: the client is someone else\'s');
  assert.equal(lsofListsClient('', 60440, 4317), false);
  assert.equal(lsofListsClient('p1\nn[::1]:60440->[::1]:4317\n', 60440, 4317), true);
  assert.equal(lsofListsClient('p1\nn127.0.0.1:60441->127.0.0.1:4317\n', 60440, 4317), false, 'another connection');
  assert.equal(loopbackPeerIsMe(1, 2, 'win32'), null, 'no check there: loopback alone');
});
