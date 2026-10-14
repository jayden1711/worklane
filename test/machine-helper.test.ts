import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // The updater's setup script stands in as a file of this test's own (never root's): the helper must refuse to run it.
  const updates = join(root, 'updates.sh');
  writeFileSync(updates, `#!/usr/bin/env bash\ntouch ${JSON.stringify(join(root, 'updates-ran'))}\n`, { mode: 0o755 });
  writeFileSync(
    copy,
    readFileSync(helperSrc, 'utf8')
      .replace("const ETC = '/etc/worklane';", `const ETC = ${JSON.stringify(etc)};`)
      .replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(log)};`)
      .replace("const UPDATES = '/opt/worklane/current/scripts/setup/updates.sh';", `const UPDATES = ${JSON.stringify(updates)};`),
  );
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
/** add-update-signer's arguments as the sudoers rule spells them: one anchored pattern, as sudo matches it (the arguments joined by spaces). */
const SIGNER_PATTERN = '^add-update-signer [A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$';
/** A new ed25519 public key as ssh writes it: the key type's name and the 32 bytes, in base64. */
function ed25519() {
  const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64');
}
/** Every argument list that must never add a signer, for a real key `k`: sudo's rule and the helper both refuse each. */
const signerRefused = (k: string): string[][] => [
  ['add-update-signer'],
  ['add-update-signer', 'owner@example.com'],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519'],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k, 'extra'],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', `${k}A`],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k.slice(0, -1)],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', `${k.slice(0, -1)}=`],
  ['add-update-signer', 'owner@example.com', 'ssh-rsa', k],
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', `AAAAB3NzaC1yc2E${k.slice(15)}`],
  // The principals that would widen who may sign, or how: a wildcard, a list, a negation, an option, a certificate authority.
  ['add-update-signer', '*', 'ssh-ed25519', k],
  ['add-update-signer', '*@example.com', 'ssh-ed25519', k],
  ['add-update-signer', 'owner@example.com,other@example.com', 'ssh-ed25519', k],
  ['add-update-signer', '!owner@example.com', 'ssh-ed25519', k],
  ['add-update-signer', 'owner', 'ssh-ed25519', k],
  ['add-update-signer', 'owner@example.com cert-authority', 'ssh-ed25519', k],
  ['add-update-signer', 'owner@example.com', 'cert-authority', 'ssh-ed25519', k],
  ['add-update-signer', 'owner@example.com', 'namespaces="file"', 'ssh-ed25519', k],
  ['add-update-signer', 'owner@example.com\nother@example.com', 'ssh-ed25519', k],
  ['add-update-signer', `owner@example.com ssh-ed25519 ${k}`],
  ['add-update-signer', '--file', '/tmp/x', k],
  // And the things this helper has no command for at all.
  ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', k],
  ['set-update-signer', 'owner@example.com', 'ssh-ed25519', k],
  ['set-update-signers', '/tmp/allowed_signers'],
  ['set-update-verify', 'off'],
  ['set-update-checks', 'none'],
];
const sudoers = (...users: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', join(setup, 'lib.sh'), ...users], { encoding: 'utf8' });

test('the sudoers rule lists exactly the 31 commands, no patterns but add-project\'s and add-update-signer\'s, for the named coordinators only', { skip: !posix && 'bash' }, () => {
  const r = sudoers('wl-alpha', 'wl-beta');
  assert.equal(r.status, 0, r.stderr);
  const cmds = [...r.stdout.matchAll(new RegExp(`${MACHINE_HELPER.replace(/[/.]/g, '\\$&')} [^,\\\\\n]+`, 'g'))].map((m) => m[0].trim());
  const addProject = `${MACHINE_HELPER} ^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`;
  const addSigner = `${MACHINE_HELPER} ${SIGNER_PATTERN}`;
  const want = [...Array.from({ length: 16 }, (_, i) => `${MACHINE_HELPER} set-slots ${i + 1}`), `${MACHINE_HELPER} set-updates on`, `${MACHINE_HELPER} set-updates off`, ...Array.from({ length: 8 }, (_, i) => `${MACHINE_HELPER} set-test-slots ${i + 1}`), `${MACHINE_HELPER} claude-account status`, `${MACHINE_HELPER} claude-account switch`, `${MACHINE_HELPER} install-updater`, `${MACHINE_HELPER} set-update-channel release`, `${MACHINE_HELPER} set-update-channel main`, addSigner, addProject];
  assert.deepEqual(cmds, want);
  // add-project's arguments are one anchored pattern (test/add-project.test.ts), add-update-signer's another (below); nothing else has any.
  assert.doesNotMatch(r.stdout.replace(addProject, '').replace(addSigner, ''), /[*?[\]^$]|ALL\s*$|\bsh\b|bash/m, 'no wildcards, patterns or shells');
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

test('the updater through the helper: exactly install-updater, set-update-channel release|main and add-update-signer <principal> ssh-ed25519 <key>', () => {
  const { parseAddSigner } = createRequire(import.meta.url)(helperSrc) as { parseAddSigner: (a: string[]) => { principal: string; key: string } | null };
  const k = ed25519();
  assert.deepEqual(parseAddSigner(['add-update-signer', 'owner@example.com', 'ssh-ed25519', k]), { principal: 'owner@example.com', key: k });
  assert.ok(parseAddSigner(['add-update-signer', 'release+signing@example.com', 'ssh-ed25519', k]));
  assert.deepEqual(parse(['set-update-channel', 'release'])?.value, 'release');
  assert.deepEqual(parse(['set-update-channel', 'main'])?.value, 'main');
  for (const a of [['set-update-channel'], ['set-update-channel', 'beta'], ['set-update-channel', 'Main'], ['set-update-channel', 'main', 'x'], ['set-update-channel', '']]) assert.equal(parse(a), null, JSON.stringify(a));
  const sudo = new RegExp(SIGNER_PATTERN);
  assert.ok(sudo.test(['add-update-signer', 'owner@example.com', 'ssh-ed25519', k].join(' ')), 'the sudoers pattern takes a real key');
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  writeFileSync(join(h.etc, 'updates.json'), '{"enabled":false,"channel":"release"}\n');
  for (const a of [...signerRefused(k), ['install-updater', 'x'], ['install-updater', '--check', 'none'], ['set-update-channel', 'beta'], ['set-update-channel', 'main', 'x']]) {
    assert.equal(parseAddSigner(a), null, JSON.stringify(a));
    const r = h.run(...a);
    assert.equal(r.status, 2, `${JSON.stringify(a)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: worklane-machine /);
    // sudo matches the arguments joined by spaces, so one argument holding the whole line reads the same to it: the helper is what counts them.
    if (a.join(' ') !== ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k].join(' ')) assert.ok(!sudo.test(a.join(' ')), `the sudoers pattern refuses ${JSON.stringify(a)}`);
  }
  assert.deepEqual(readdirSync(h.etc), ['updates.json'], 'no signers file was written');
  assert.equal(readFileSync(join(h.etc, 'updates.json'), 'utf8'), '{"enabled":false,"channel":"release"}\n');
  assert.ok(!existsSync(h.log), 'and nothing was logged');
});

test('add-update-signer only ever adds: what the file held stays byte for byte, a signer already there changes nothing', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const file = join(h.etc, 'allowed_signers');
  const [a, b, c] = [ed25519(), ed25519(), ed25519()];
  // An owner's own file: a comment, an option, another key type, no newline at the end.
  const mine = `# release keys\nfirst@example.com namespaces="git" ssh-ed25519 ${a}\nrsa@example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 old key`;
  writeFileSync(file, mine);
  const r = h.run('add-update-signer', 'second@example.com', 'ssh-ed25519', b);
  assert.equal(r.status, 0, r.stderr);
  const { fingerprint } = createRequire(import.meta.url)(helperSrc) as { fingerprint: (k: string) => string };
  assert.match(r.stdout, new RegExp(`added second@example\\.com ssh-ed25519 ${b.replace(/[+/]/g, '\\$&')} \\(${fingerprint(b).replace(/[+/]/g, '\\$&')}\\)`));
  assert.equal(readFileSync(file, 'utf8'), `${mine}\nsecond@example.com ssh-ed25519 ${b}\n`, 'the old lines first, untouched; the new line last');
  if (posix) assert.equal(statSync(file).mode & 0o777, 0o644);
  // The same signer again, and one already there under an option: nothing changes, nothing more is logged.
  const after = readFileSync(file, 'utf8');
  for (const [p, k] of [['second@example.com', b], ['first@example.com', a]] as const) {
    const again = h.run('add-update-signer', p, 'ssh-ed25519', k);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /is already listed; nothing changed/);
  }
  assert.equal(readFileSync(file, 'utf8'), after);
  // The same key for another principal is another signer: added, with every earlier line still there.
  assert.equal(h.run('add-update-signer', 'third@example.com', 'ssh-ed25519', a).status, 0);
  assert.equal(h.run('add-update-signer', 'fourth@example.com', 'ssh-ed25519', c).status, 0);
  assert.equal(readFileSync(file, 'utf8'), `${after}third@example.com ssh-ed25519 ${a}\nfourth@example.com ssh-ed25519 ${c}\n`);
  assert.deepEqual(readdirSync(h.etc), ['allowed_signers'], 'no temp file left behind');
  const lines = readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [b, a, c].map((k, i) => ({ by: 'wl-alpha', what: 'updates.allowed_signers', from: null, to: `added ${['second', 'third', 'fourth'][i]}@example.com ssh-ed25519 ${k} (${fingerprint(k)})` })));
  // The fingerprint is ssh-keygen's own, so what the screen shows is what an owner can check against their key.
  if (posix && spawnSync('ssh-keygen', ['-?']).error === undefined) {
    const pub = join(h.etc, '..', 'k.pub');
    writeFileSync(pub, `ssh-ed25519 ${b}\n`);
    assert.equal(execFileSync('ssh-keygen', ['-l', '-f', pub], { encoding: 'utf8' }).split(' ')[1], fingerprint(b));
  }
});

test('add-update-signer starts the file when there is none, and refuses a signers file that is a link', { skip: !posix && 'symlinks' }, () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const file = join(h.etc, 'allowed_signers');
  const k = ed25519();
  assert.equal(h.run('add-update-signer', 'owner@example.com', 'ssh-ed25519', k).status, 0);
  assert.equal(readFileSync(file, 'utf8'), `owner@example.com ssh-ed25519 ${k}\n`);
  const h2 = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const elsewhere = join(h2.etc, '..', 'elsewhere');
  writeFileSync(elsewhere, 'kept\n');
  symlinkSync(elsewhere, join(h2.etc, 'allowed_signers'));
  const r = h2.run('add-update-signer', 'owner@example.com', 'ssh-ed25519', k);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /allowed_signers isn't a regular file; not writing it/);
  assert.equal(readFileSync(elsewhere, 'utf8'), 'kept\n');
  assert.ok(!existsSync(h2.log));
});

test('set-update-channel writes the channel and nothing else, and only for an updater that is installed', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const none = h.run('set-update-channel', 'main');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /updates\.json is missing: install the updater first \(install-updater\)/);
  assert.deepEqual(readdirSync(h.etc), [], 'no config appeared');
  assert.ok(!existsSync(h.log));
  const cfg = { enabled: false, channel: 'release', allowed_signers: '/etc/worklane/allowed_signers', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test (ubuntu-latest, 22)', 'push-gate'] };
  writeFileSync(join(h.etc, 'updates.json'), `${JSON.stringify(cfg)}\n`);
  writeFileSync(join(h.etc, 'allowed_signers'), 'owner@example.com ssh-ed25519 kept\n');
  for (const to of ['main', 'release'] as const) {
    assert.equal(h.run('set-update-channel', to).status, 0);
    // The signers file's path, the required checks and the switch are as they were: only the channel moved.
    assert.deepEqual(JSON.parse(readFileSync(join(h.etc, 'updates.json'), 'utf8')), { ...cfg, channel: to });
  }
  assert.equal(readFileSync(join(h.etc, 'allowed_signers'), 'utf8'), 'owner@example.com ssh-ed25519 kept\n');
  const lines = readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [{ by: 'wl-alpha', what: 'updates.channel', from: 'release', to: 'main' }, { by: 'wl-alpha', what: 'updates.channel', from: 'main', to: 'release' }]);
});

test('install-updater runs one fixed script, with no arguments, and only when it and every directory above it are root\'s alone', { skip: (!posix || process.getuid?.() === 0) && 'needs a POSIX user who is not root' }, () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /^const UPDATES = '\/opt\/worklane\/current\/scripts\/setup\/updates\.sh';$/m);
  assert.match(src, /spawnSync\('bash', \[real\], \{ cwd: '\/', env: \{ PATH: PATH_ENV, HOME: '\/root', LANG: 'C\.UTF-8' \}, stdio: 'inherit' \}\)/, 'the script alone: no argument reaches it');
  const root = mkdtempSync(join(tmpdir(), 'machine-'));
  const h = helperIn(root);
  const r = h.run('install-updater');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not running .*updates\.sh: .* isn't root's alone/);
  assert.ok(!existsSync(join(root, 'updates-ran')), 'a script that isn\'t root\'s never ran');
  assert.ok(!existsSync(h.log));
});

// The guard this exists for: a release tag verifies only against a key an owner added, and adding one never makes
// another key's signature pass. The updater's own verifyRelease, real ssh signatures, the file the helper wrote.
test('a release tag verifies against a signer the helper added, and one signed by any other key is still refused', { skip: (!posix || spawnSync('ssh-keygen', ['-?']).error !== undefined) && 'needs ssh-keygen' }, () => {
  const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as { verifyRelease(repoUrl: string, tag: string, signers: string, exec: (f: string, a: string[]) => string, gitDir?: string): { ok: boolean; reason?: string } };
  const root = mkdtempSync(join(tmpdir(), 'machine-'));
  const h = helperIn(root);
  const signers = join(h.etc, 'allowed_signers');
  const dir = join(root, 'origin');
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const key = (name: string) => {
    const f = join(root, name);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', f]);
    return { file: f, pub: readFileSync(`${f}.pub`, 'utf8').trim().split(' ')[1]! };
  };
  const [owner, other] = [key('owner'), key('other')];
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Owner'], ['user.email', 'owner@example.com'], ['commit.gpgsign', 'false'], ['gpg.format', 'ssh']]) git('config', k!, v!);
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0"}\n');
  git('add', 'package.json');
  git('commit', '-q', '-m', 'main');
  const main = git('rev-parse', 'HEAD');
  const release = (tag: string, signedBy: string) => {
    git('checkout', '-q', '--detach', main);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), `// ${tag}\n`);
    git('add', '-f', 'dist');
    git('commit', '-q', '-m', `Release ${tag}`);
    git('-c', `user.signingkey=${signedBy}`, 'tag', '-s', tag, '-m', tag);
    git('checkout', '-q', 'main');
  };
  release('v1.0.1', owner.file);
  release('v1.0.2', other.file);
  const exec = (file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const verify = (tag: string) => u.verifyRelease(dir, tag, signers, exec, join(mkdtempSync(join(tmpdir(), 'verify-')), 'v.git'));
  assert.match(verify('v1.0.1').reason ?? '', /no allowed signers file/, 'before any signer: nothing verifies');
  assert.equal(h.run('add-update-signer', 'owner@example.com', 'ssh-ed25519', owner.pub).status, 0);
  assert.deepEqual(verify('v1.0.1'), { ok: true, base: main });
  const refused = verify('v1.0.2');
  assert.equal(refused.ok, false, 'a tag signed by a key nobody added');
  assert.match(refused.reason ?? '', /v1\.0\.2's signature doesn't verify against/);
  // Every refused argument list, tried for the other key: none of them lets its tag through.
  for (const a of signerRefused(other.pub)) h.run(...a);
  assert.equal(readFileSync(signers, 'utf8'), `owner@example.com ssh-ed25519 ${owner.pub}\n`);
  assert.equal(verify('v1.0.2').ok, false);
  // Only adding that key, as itself, does; and the first signer's tag still verifies.
  assert.equal(h.run('add-update-signer', 'second@example.com', 'ssh-ed25519', other.pub).status, 0);
  assert.equal(verify('v1.0.2').ok, true);
  assert.equal(verify('v1.0.1').ok, true);
});
