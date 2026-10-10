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

test('the helper accepts exactly set-slots 1..16 and set-updates on|off', () => {
  for (let n = 1; n <= 16; n++) assert.deepEqual(parse(['set-slots', String(n)])?.value, n);
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
    assert.match(r.stderr, /usage: worklane-machine set-slots <1\.\.16> \| set-updates on\|off/);
  }
  assert.equal(readFileSync(join(h.etc, 'slots.json'), 'utf8'), '{"max_agents":2}\n');
  assert.ok(!existsSync(h.log));
});

const setup = join(repoRoot, 'scripts', 'setup');
const sudoers = (...users: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', join(setup, 'lib.sh'), ...users], { encoding: 'utf8' });

test('the sudoers rule lists exactly the 18 commands, no patterns, for the named coordinators only', { skip: !posix && 'bash' }, () => {
  const r = sudoers('wl-alpha', 'wl-beta');
  assert.equal(r.status, 0, r.stderr);
  const cmds = [...r.stdout.matchAll(new RegExp(`${MACHINE_HELPER.replace(/[/.]/g, '\\$&')} [^,\\\\\n]+`, 'g'))].map((m) => m[0].trim());
  const want = [...Array.from({ length: 16 }, (_, i) => `${MACHINE_HELPER} set-slots ${i + 1}`), `${MACHINE_HELPER} set-updates on`, `${MACHINE_HELPER} set-updates off`];
  assert.deepEqual(cmds, want);
  assert.doesNotMatch(r.stdout, /[*?[\]^$]|ALL\s*$|\bsh\b|bash/m, 'no wildcards, patterns or shells');
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
