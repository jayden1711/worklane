import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CONSOLE_SHELL, CommandRecorder, openTerminal, type AuditEntry, type Pty, type SpawnPty, type TerminalConfig } from '../src/console/terminal.js';
import type { ConsoleSession } from '../src/console/session.js';
import { startHub } from '../src/dashboard-hub.js';

const NET = ['tail1234', 'ts', 'net'].join('.');
const ip = (n: number) => [100, 101, 102, 100 + n].join('.');
const NOW = Date.parse('2026-10-12T20:00:00Z');
const ADMIN = 'adminx';
const cfg: TerminalConfig = { consoleUser: ADMIN, hubUser: 'wl-dash' };
const owner = (over: Partial<ConsoleSession> = {}): ConsoleSession => ({ login: 'olive', role: 'owner', authenticatedAt: NOW - 60_000, csrfOk: true, ...over });
const passwordRequired = () => 'password-required\n';

/** A fake PTY: echoes input (when echo is on, as a shell does), records what it was spawned with. */
function fakePty() {
  const listeners: ((d: string) => void)[] = [];
  const exits: ((c: number | null) => void)[] = [];
  const st = { echo: true, written: '', killed: false, spawned: null as null | { argv: string[]; user: string } };
  const pty: Pty = {
    write(d) {
      st.written += d;
      const out = st.echo ? d.replace(/\r/g, '\r\n') : d.includes('\r') ? '\r\n' : '';
      if (out) for (const l of listeners) l(out);
    },
    onData: (fn) => void listeners.push(fn),
    onExit: (fn) => void exits.push(fn),
    kill: () => void (st.killed = true),
  };
  const spawn: SpawnPty = (o) => {
    st.spawned = { argv: o.argv, user: o.user };
    return pty;
  };
  return { st, spawn, out: (s: string) => listeners.forEach((l) => l(s)), exit: (c: number) => exits.forEach((e) => e(c)) };
}

function open(over: Partial<Parameters<typeof openTerminal>[0]> = {}) {
  const audit: AuditEntry[] = [];
  const p = fakePty();
  const closed: string[] = [];
  const execCalls: string[][] = [];
  const t = openTerminal({
    session: owner(),
    instance: 'demo',
    config: cfg,
    audit: { record: (e) => void audit.push(e) },
    send: () => {},
    closed: (why) => void closed.push(why),
    device: () => ({ why: null, device: { name: `laptop.${NET}`, tags: ['tag:owner'] } }),
    spawnPty: p.spawn,
    exec: (file, args) => {
      execCalls.push([file, ...args]);
      return passwordRequired();
    },
    now: () => NOW,
    ...over,
  });
  return { t, audit, p, closed, execCalls };
}

test('the terminal refuses without a fresh GitHub sign-in (none, or older than 5 minutes), and runs nothing', () => {
  for (const [s, re] of [
    [null, /not signed in/],
    [owner({ authenticatedAt: null }), /fresh GitHub sign-in/],
    [owner({ authenticatedAt: NOW - 5 * 60_000 - 1 }), /within the last 5 minutes/],
    [owner({ csrfOk: false }), /CSRF/],
  ] as const) {
    const o = open({ session: s });
    assert.ok('refused' in o.t && re.test(o.t.refused), JSON.stringify(o.t));
    assert.equal(o.p.st.spawned, null);
    assert.deepEqual(o.execCalls, [], 'not even the sudo check');
    assert.equal(o.audit.at(-1)!.kind, 'refused');
  }
  assert.ok(!('refused' in open({ session: owner({ authenticatedAt: NOW - 5 * 60_000 + 1000 }) }).t), 'within 5 minutes it opens');
});

test("the terminal refuses non-owners: writers, viewers and people with no role", () => {
  for (const role of ['writer', 'viewer', null] as const) {
    const o = open({ session: owner({ login: 'wendy', role }) });
    assert.ok('refused' in o.t && /owner's alone/.test(o.t.refused), String(role));
    assert.equal(o.p.st.spawned, null);
  }
});

test('the terminal refuses when sudo -n true succeeds as the console user (it would be root without a password)', () => {
  const ok = (out: string) => () => out;
  const fails = (stdout: string) => () => {
    throw Object.assign(new Error('Command failed'), { stdout });
  };
  for (const [exec, re] of [
    [ok('passwordless\n'), /sudo -n true succeeds/],
    [fails('passwordless\n'), /sudo -n true succeeds/],
    [fails(''), /couldn't check sudo/],
    [ok('something else'), /unexpected answer/],
  ] as const) {
    const o = open({ exec });
    assert.ok('refused' in o.t && re.test(o.t.refused), JSON.stringify(o.t));
    assert.equal(o.p.st.spawned, null, 'no PTY');
  }
});

test('the terminal refuses an unset console user, root, or the user the hub itself runs as', () => {
  for (const c of [{ consoleUser: null, hubUser: 'wl-dash' }, { consoleUser: 'root', hubUser: 'wl-dash' }, { consoleUser: 'wl-dash', hubUser: 'wl-dash' }, { consoleUser: 'bad user;id', hubUser: 'wl-dash' }]) {
    const o = open({ config: c });
    assert.ok('refused' in o.t, JSON.stringify(c));
    assert.equal(o.p.st.spawned, null);
  }
});

test('it runs as the configured admin user, through the console shell after its sudo -n true check', () => {
  const o = open();
  assert.ok(!('refused' in o.t));
  assert.deepEqual(o.execCalls, [['sudo', '-n', '-u', ADMIN, CONSOLE_SHELL, 'check']]);
  assert.deepEqual(o.p.st.spawned, { argv: ['sudo', '-n', '-u', ADMIN, CONSOLE_SHELL, 'shell'], user: ADMIN });
  assert.deepEqual(o.audit.map((e) => [e.kind, e.login, e.user]), [['opened', 'olive', ADMIN]]);
});

test('every command is recorded with who and when; input typed with echo off (a password) is not', () => {
  const o = open();
  const t = o.t as Exclude<typeof o.t, { refused: string }>;
  t.input('ls -la\r');
  t.input('sudo apt update\r');
  o.p.out('[sudo] password for adminx: ');
  o.p.st.echo = false;
  t.input('hunter2-pass');
  t.input('\r');
  o.p.st.echo = true;
  t.input('whoami\r');
  // Pasted, several lines at once.
  t.input('\x1b[200~echo one\recho two\x1b[201~\r');
  t.close('done');
  const kinds = o.audit.map((e) => (e.kind === 'command' ? `command:${e.line}` : e.kind));
  assert.deepEqual(kinds, ['opened', 'command:ls -la', 'command:sudo apt update', 'hidden_input', 'command:whoami', 'command:echo one', 'command:echo two', 'closed']);
  for (const e of o.audit) {
    assert.equal(e.login, 'olive');
    assert.equal(e.instance, 'demo');
    assert.equal(e.at, new Date(NOW).toISOString());
  }
  assert.ok(!JSON.stringify(o.audit).includes('hunter2'), 'the password is in no audit entry');
  assert.ok(o.p.st.killed);
});

test('a line recalled from history is recorded as the terminal showed it', () => {
  const got: unknown[] = [];
  const r = new CommandRecorder((e) => void got.push(e));
  r.input('\x1b[A');
  r.output('\x1b[K$ git status');
  r.input('\r');
  r.output('\r\nOn branch main\r\n');
  assert.deepEqual(got, [{ kind: 'command', line: '', edited: true, shown: '$ git status' }]);
});

test('the terminal closes after 10 minutes idle (no input), and when the shell exits', async () => {
  const o = open({ idleMs: 40 });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(o.closed, ['idle for 10 minutes']);
  assert.ok(o.p.st.killed);
  assert.equal(o.audit.at(-1)!.kind, 'closed');

  const busy = open({ idleMs: 80 });
  const t = busy.t as Exclude<typeof busy.t, { refused: string }>;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 40));
    t.input('x');
  }
  assert.deepEqual(busy.closed, [], 'input keeps it open');
  busy.p.exit(0);
  assert.deepEqual(busy.closed, ['the shell exited (0)']);
});

test('the hub serves the terminal over a WebSocket: same origin only, refused without a session, open for a fresh owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-term-'));
  const p = fakePty();
  const audit: AuditEntry[] = [];
  let session: ConsoleSession | null = null;
  const h = await startHub({
    instances: [{ name: 'demo', port: 1, tokenFile: join(dir, 'none') }],
    stateDir: dir,
    terminal: { consoleUser: ADMIN, hubUser: 'wl-dash', devices: ['tag:owner'], peerUid: () => 0, whois: () => JSON.stringify({ Node: { Name: `laptop.${NET}.`, Tags: ['tag:owner'] } }), session: () => session, audit: { record: (e) => void audit.push(e) }, spawnPty: p.spawn, exec: passwordRequired, now: () => NOW },
  });
  const base = h.url.split('/?')[0]!.replace('http', 'ws');
  const origin = h.url.split('/?')[0]!;
  const connect = (o: string, instance = 'demo') =>
    new Promise<{ msgs: { type: string; why?: string; data?: string }[]; ws: WebSocket; error?: string }>((done) => {
      const ws = new WebSocket(`${base}/api/terminal?instance=${instance}`, { origin: o, headers: { 'x-forwarded-for': ip(3) } });
      const msgs: { type: string; why?: string; data?: string }[] = [];
      ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
      ws.on('unexpected-response', (_req, res) => done({ msgs, ws, error: String(res.statusCode) }));
      ws.on('error', (e) => done({ msgs, ws, error: e.message }));
      ws.on('close', () => done({ msgs, ws }));
      ws.on('open', () => setTimeout(() => done({ msgs, ws }), 100));
    });
  try {
    const cross = await connect('https://evil.example');
    assert.equal(cross.error, '403');
    const none = await connect(origin);
    assert.ok(none.msgs.some((m) => m.type === 'refused' && /not signed in/.test(m.why!)), JSON.stringify(none.msgs));
    session = owner();
    const other = await connect(origin, 'elsewhere');
    assert.ok(other.msgs.some((m) => m.type === 'refused'));
    const ok = await connect(origin);
    assert.ok(!ok.msgs.some((m) => m.type === 'refused'), JSON.stringify(ok.msgs));
    assert.deepEqual(p.st.spawned, { argv: ['sudo', '-n', '-u', ADMIN, CONSOLE_SHELL, 'shell'], user: ADMIN });
    ok.ws.send(JSON.stringify({ type: 'input', data: 'id\r' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(p.st.written, 'id\r');
    assert.ok(ok.msgs.some((m) => m.type === 'output' && m.data!.includes('id')));
    assert.ok(audit.some((e) => e.kind === 'command' && e.line === 'id'));
    ok.ws.close();
  } finally {
    await h.close();
  }
});
