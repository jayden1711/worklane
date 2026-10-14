import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_HELPER, machineChanges, setSlotCap, setUpdates } from '../src/machine.js';
import { repoRoot } from './helpers.js';

const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const { parse } = createRequire(import.meta.url)(helperSrc) as { parse: (a: string[]) => { what: string; value: unknown } | null };
const posix = process.platform !== 'win32';

test('the helper accepts exactly set-slots 1..16, set-updates on|off and set-test-slots 1..8', () => {
  for (let n = 1; n <= 16; n++) assert.deepEqual(parse(['set-slots', String(n)])?.value, n);
  for (let n = 1; n <= 8; n++) assert.deepEqual(parse(['set-test-slots', String(n)]), { what: 'slots.max_test_runs', file: 'slots.json', key: 'max_test_runs', value: n });
  for (const a of [['set-test-slots', '0'], ['set-test-slots', '9'], ['set-test-slots', '01'], ['set-test-slots', '2', 'x'], ['set-test-slots']]) assert.equal(parse(a), null, JSON.stringify(a));
  assert.equal(parse(['set-updates', 'on'])?.value, true);
  assert.equal(parse(['set-updates', 'off'])?.value, false);
  const bad = [[], ['set-slots'], ['set-slots', '0'], ['set-slots', '17'], ['set-slots', '01'], ['set-slots', '1.5'], ['set-slots', ' 1'], ['set-slots', '1 '], ['set-slots', '-1'], ['set-slots', '1e1'], ['set-slots', '1;id'], ['set-slots', '1', 'x'], ['set-updates'], ['set-updates', 'yes'], ['set-updates', 'ON'], ['set-updates', 'on', 'off'], ['set-max', '3'], ['rm', '-rf'], ['--help']];
  for (const a of bad) assert.equal(parse(a), null, JSON.stringify(a));
});

test('the installed helper takes its paths from nowhere but its own source', () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /^const ETC = '\/etc\/worklane';$/m);
  assert.match(src, /^const LOG = '\/var\/lib\/worklane\/machine-changes\.jsonl';$/m);
  const envUses = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envUses)], ['SUDO_USER'], 'only who asked, for the log');
});

/** A copy of the helper whose fixed paths point into a temp root, the way only a test can. */
function helperIn(root: string) {
  const etc = join(root, 'etc');
  const log = join(root, 'var', 'machine-changes.jsonl');
  mkdirSync(etc, { recursive: true });
  const copy = join(root, 'helper.cjs');
  writeFileSync(copy, readFileSync(helperSrc, 'utf8').replace("const ETC = '/etc/worklane';", `const ETC = ${JSON.stringify(etc)};`).replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(log)};`));
  const run = (...args: string[]) => spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'wl-alpha' } });
  return { etc, log, run };
}

test('a change is written atomically, keeps the file\'s other keys, and is logged with who, from and to', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  writeFileSync(join(h.etc, 'slots.json'), '{"max_agents":2}\n');
  writeFileSync(join(h.etc, 'updates.json'), '{"enabled":false,"required_checks":["test"]}\n');
  assert.equal(h.run('set-slots', '3').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(h.etc, 'slots.json'), 'utf8')), { max_agents: 3 });
  assert.equal(h.run('set-updates', 'on').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(h.etc, 'updates.json'), 'utf8')), { enabled: true, required_checks: ['test'] });
  if (posix) assert.equal(statSync(join(h.etc, 'slots.json')).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(h.etc).sort(), ['slots.json', 'updates.json'], 'no temp file left behind');
  const lines = readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [
    { by: 'wl-alpha', what: 'slots.max_agents', from: 2, to: 3 },
    { by: 'wl-alpha', what: 'updates.enabled', from: false, to: true },
  ]);
  assert.ok(lines.every((l) => typeof l.at === 'string'));
  assert.deepEqual(machineChanges(h.log).map((c) => c.what), ['slots.max_agents', 'updates.enabled'], 'the engine reads the same log');
});

test('a refused argument list writes and logs nothing', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  writeFileSync(join(h.etc, 'slots.json'), '{"max_agents":2}\n');
  for (const a of [['set-slots', '17'], ['set-slots', '2', 'extra'], ['set-updates', 'maybe'], []]) {
    const r = h.run(...a);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.match(r.stderr, /usage: worklane-machine set-slots <1\.\.16> \| set-updates on\|off \| set-test-slots <1\.\.8>/);
  }
  assert.equal(readFileSync(join(h.etc, 'slots.json'), 'utf8'), '{"max_agents":2}\n');
  assert.ok(!existsSync(h.log));
});

const setup = join(repoRoot, 'scripts', 'setup');
const sudoers = (...users: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', join(setup, 'lib.sh'), ...users], { encoding: 'utf8' });

test('the sudoers rule lists exactly the 32 commands, no patterns but add-project\'s one, for the named coordinators only', { skip: !posix && 'bash' }, () => {
  const r = sudoers('wl-alpha', 'wl-beta');
  assert.equal(r.status, 0, r.stderr);
  const cmds = [...r.stdout.matchAll(new RegExp(`${MACHINE_HELPER.replace(/[/.]/g, '\\$&')} [^,\\\\\n]+`, 'g'))].map((m) => m[0].trim());
  const addProject = `${MACHINE_HELPER} ^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`;
  const want = [...Array.from({ length: 16 }, (_, i) => `${MACHINE_HELPER} set-slots ${i + 1}`), `${MACHINE_HELPER} set-updates on`, `${MACHINE_HELPER} set-updates off`, ...Array.from({ length: 8 }, (_, i) => `${MACHINE_HELPER} set-test-slots ${i + 1}`), `${MACHINE_HELPER} claude-account status`, `${MACHINE_HELPER} claude-account switch`, ...['install', 'up', 'serve', 'public-url'].map((a) => `${MACHINE_HELPER} tailscale ${a}`), addProject];
  assert.equal(want.length - 1, 32);
  // Tailscale's four are whole commands: sudo matches a listed command's arguments exactly, so nothing may follow one.
  for (const a of ['install', 'up', 'serve', 'public-url']) assert.match(r.stdout, new RegExp(`${MACHINE_HELPER.replace(/[/.]/g, '\\$&')} tailscale ${a}(, \\\\)?$`, 'm'), a);
  assert.deepEqual(cmds, want);
  // add-project's arguments are one anchored pattern (test/add-project.test.ts); nothing else has any.
  assert.doesNotMatch(r.stdout.replace(addProject, ''), /[*?[\]^$]|ALL\s*$|\bsh\b|bash/m, 'no wildcards, patterns or shells');
  assert.match(r.stdout, /^wl-alpha, wl-beta ALL=\(root\) NOPASSWD: WORKLANE_MACHINE$/m);
  assert.doesNotMatch(r.stdout, /wl-dash/);
  for (const bad of [['wl-dash'], ['wl-alpha', 'wl-dash'], ['root'], ['wl-alpha ALL'], []]) assert.notEqual(sudoers(...bad).status, 0, JSON.stringify(bad));
  const visudo = spawnSync('visudo', ['--version']).status === 0;
  if (visudo) {
    const f = join(mkdtempSync(join(tmpdir(), 'sudoers-')), 'rule');
    writeFileSync(f, r.stdout);
    assert.equal(spawnSync('visudo', ['-cf', f]).status, 0, 'visudo accepts it');
  }
});

test('setup: the slot cap becomes root:root 0644, changed only through the helper; wl-dash is refused', () => {
  const machine = readFileSync(join(setup, 'machine.sh'), 'utf8');
  assert.match(machine, /^chown root:root \/etc\/worklane\/slots\.json$/m);
  assert.match(machine, /^chmod 0644 \/etc\/worklane\/slots\.json$/m);
  assert.doesNotMatch(machine, /0664/);
  const helper = readFileSync(join(setup, 'machine-helper.sh'), 'utf8');
  assert.match(helper, /install_sudoers worklane-machine "\$\(machine_sudoers "\$\{users\[@\]\}"\)"/);
  assert.match(helper, /\[ "\$name" != dash \]/);
  assert.match(helper, /^chmod 0644 \/etc\/worklane\/slots\.json$/m);
  assert.match(helper, /install -o root -g root -m 0755 "\$src" "\$tmp"/);
});

test('the engine checks the cap before asking sudo, and explains a missing sudo rule', () => {
  const calls: string[][] = [];
  const exec = (file: string, args: string[]) => (calls.push([file, ...args]), 'slots.max_agents: 2 -> 4');
  for (const n of [0, 17, 1.5, Number.NaN, -3]) assert.equal(setSlotCap(n, exec).ok, false, String(n));
  assert.equal(calls.length, 0, 'nothing ran for a bad value');
  assert.deepEqual(setSlotCap(4, exec), { ok: true, output: 'slots.max_agents: 2 -> 4' });
  assert.deepEqual(calls, [['sudo', '-n', MACHINE_HELPER, 'set-slots', '4']]);
  setUpdates(true, exec);
  assert.deepEqual(calls.at(-1), ['sudo', '-n', MACHINE_HELPER, 'set-updates', 'on']);
  const noRule = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'sudo: a password is required\n' });
  };
  const r = setSlotCap(4, noRule);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /may not run .*set-slots 4 \(sudo: a password is required\); an admin runs scripts\/setup\/machine-helper\.sh/);
});

test('the change log reader skips torn lines and keeps the newest', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'machine-')), 'log.jsonl');
  const line = (n: number) => JSON.stringify({ at: `2026-01-0${n}T00:00:00Z`, by: 'wl-alpha', what: 'slots.max_agents', from: n, to: n + 1 });
  writeFileSync(f, `${line(1)}\nnot json\n${line(2)}\n{"at":1}\n${line(3)}`);
  assert.deepEqual(machineChanges(f).map((c) => c.from), [1, 2, 3]);
  assert.deepEqual(machineChanges(f, 2).map((c) => c.from), [2, 3]);
  assert.deepEqual(machineChanges(join(tmpdir(), 'no-such-log.jsonl')), []);
});

test('the helper takes claude-account status|switch and nothing more; a switch only for a coordinator, its instance from sudo', () => {
  const { parseClaudeAccount, coordinatorInstance } = createRequire(import.meta.url)(helperSrc) as { parseClaudeAccount: (a: string[]) => string | null; coordinatorInstance: (u: string | undefined) => string | null };
  assert.equal(parseClaudeAccount(['claude-account', 'status']), 'status');
  assert.equal(parseClaudeAccount(['claude-account', 'switch']), 'switch');
  for (const a of [['claude-account'], ['claude-account', 'switch', '--token-from', 'x'], ['claude-account', 'Switch'], ['claude-account', 'status', 'x'], ['claude-accounts', 'status']]) assert.equal(parseClaudeAccount(a), null, JSON.stringify(a));
  assert.equal(coordinatorInstance('wl-alpha'), 'alpha');
  for (const u of [undefined, '', 'root', 'admin', 'wl-dash', 'wl-alpha-agent', 'wl-Alpha', 'wl-', 'wl-a;b']) assert.equal(coordinatorInstance(u), null, String(u));
  // The script it runs is a fixed path in the helper's own source, like add-project's.
  assert.match(readFileSync(helperSrc, 'utf8'), /^const CLAUDE_ACCOUNT = '\/opt\/worklane\/current\/scripts\/setup\/claude-account\.sh';$/m);
});

test('the helper takes tailscale install|up|serve|public-url and nothing more: no auth key, flag, URL or port', () => {
  const { parseTailscale, tailscaleCommand, parse, parseAddProject, parseClaudeAccount } = createRequire(import.meta.url)(helperSrc) as {
    parseTailscale: (a: unknown[]) => string | null;
    tailscaleCommand: (real: string, action: string, instance: string) => string[];
    parse: (a: string[]) => unknown;
    parseAddProject: (a: string[]) => unknown;
    parseClaudeAccount: (a: string[]) => unknown;
  };
  for (const a of ['install', 'up', 'serve', 'public-url']) assert.equal(parseTailscale(['tailscale', a]), a);
  const bad: unknown[][] = [
    ['tailscale'],
    ['tailscale', 'up', '--auth-key=tskey-auth-kExample-abcdef'],
    ['tailscale', 'up', '--authkey', 'tskey-auth-kExample-abcdef'],
    ['tailscale', 'up', '--auth-key', 'file:/etc/key'],
    ['tailscale', 'up', '--login-server=https://example.test'],
    ['tailscale', 'up', '--ssh'],
    ['tailscale', 'up', '--for', 'alpha'],
    ['tailscale', 'up', ''],
    ['tailscale', 'up --auth-key=tskey-auth-x'],
    ['tailscale', 'up\n'],
    ['tailscale', ' up'],
    ['tailscale', 'UP'],
    ['tailscale', '--auth-key=tskey-auth-x', 'up'],
    ['tailscale', 'serve', '4398'],
    ['tailscale', 'serve', '--https=443', 'http://127.0.0.1:4398'],
    ['tailscale', 'serve', 'reset'],
    ['tailscale', 'funnel'],
    ['tailscale', 'public-url', 'https://elsewhere.example.test'],
    ['tailscale', 'public-url', '--public-url', 'https://elsewhere.example.test'],
    ['tailscale', 'install', '1.0.0'],
    ['tailscale', 'install', '--allow-unauthenticated'],
    ['tailscale', 'status'],
    ['tailscale', 'logout'],
    ['tailscale', 'down'],
    ['tailscale', 'set', '--operator=wl-alpha'],
    ['tailscale', ['up']],
    ['tailscale', null],
    ['Tailscale', 'up'],
    ['tailscale-up'],
    ['up'],
    [],
  ];
  for (const a of bad) assert.equal(parseTailscale(a), null, JSON.stringify(a));
  // And none of them is some other command's: the helper refuses each outright.
  for (const a of bad.filter((x): x is string[] => x.every((s) => typeof s === 'string'))) assert.ok(!parse(a) && !parseAddProject(a) && !parseClaudeAccount(a), JSON.stringify(a));
  // What the unit runs is the script and that one word; only `up` is told whose dashboard gets the login link.
  assert.deepEqual(tailscaleCommand('/opt/x/tailscale.sh', 'install', 'alpha'), ['/bin/bash', '/opt/x/tailscale.sh', 'install']);
  assert.deepEqual(tailscaleCommand('/opt/x/tailscale.sh', 'up', 'alpha'), ['/bin/bash', '/opt/x/tailscale.sh', 'up', '--for', 'alpha']);
  assert.deepEqual(tailscaleCommand('/opt/x/tailscale.sh', 'serve', 'alpha'), ['/bin/bash', '/opt/x/tailscale.sh', 'serve']);
  assert.deepEqual(tailscaleCommand('/opt/x/tailscale.sh', 'public-url', 'alpha'), ['/bin/bash', '/opt/x/tailscale.sh', 'public-url']);
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /^const TAILSCALE = '\/opt\/worklane\/current\/scripts\/setup\/tailscale\.sh';$/m);
  assert.doesNotMatch(src, /auth-?key|tskey/i, 'the helper has no way to name a key, bar the comment saying so');
});

test('a refused tailscale argument list runs nothing and logs nothing; a caller who is no coordinator is refused too', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  for (const a of [['tailscale'], ['tailscale', 'up', '--auth-key=tskey-auth-x'], ['tailscale', 'serve', '4398'], ['tailscale', 'public-url', 'https://x.example.test'], ['tailscale', 'status']]) {
    const r = h.run(...a);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.match(r.stderr, /usage: worklane-machine .*\| tailscale install\|up\|serve\|public-url\n$/);
  }
  assert.ok(!existsSync(h.log), 'nothing logged');
});
