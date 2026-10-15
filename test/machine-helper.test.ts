import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_HELPER, machineChanges, setSlotCap, setUpdates } from '../src/machine.js';
import { repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

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
  const pending = join(root, 'var', 'pending-signers.json');
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
      .replace("const UPDATES = '/opt/worklane/current/scripts/setup/updates.sh';", `const UPDATES = ${JSON.stringify(updates)};`)
      .replace("const PENDING = '/var/lib/worklane/pending-signers.json';", `const PENDING = ${JSON.stringify(pending)};`),
  );
  const run = (...args: string[]) => spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'wl-alpha' } });
  return { etc, log, pending, copy, run };
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
/** A signer's arguments as the sudoers rule spells them, after the command: one anchored pattern, as sudo matches it (the arguments joined by spaces). */
const SIGNER_ARGS = '[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9.-]* ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$';
/** A new ed25519 public key as ssh writes it: the key type's name and the 32 bytes, in base64. */
function ed25519() {
  const raw = Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]).toString('base64');
}
/** Every argument list that must never stage a signer, for a real key `k`: sudo's rule and the helper both refuse each. */
const signerRefused = (k: string): string[][] => [
  ['stage-update-signer'],
  ['stage-update-signer', 'owner@example.com'],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519'],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k, 'extra'],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', `${k}A`],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k.slice(0, -1)],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', `${k.slice(0, -1)}=`],
  ['stage-update-signer', 'owner@example.com', 'ssh-rsa', k],
  ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', `AAAAB3NzaC1yc2E${k.slice(15)}`],
  // The principals that would widen who may sign, or how: a wildcard, a list, a negation, an option, a certificate authority.
  ['stage-update-signer', '*', 'ssh-ed25519', k],
  ['stage-update-signer', '*@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner@example.com,other@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', '!owner@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner@example.com cert-authority', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner@example.com', 'cert-authority', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner@example.com', 'namespaces="file"', 'ssh-ed25519', k],
  ['stage-update-signer', 'owner@example.com\nother@example.com', 'ssh-ed25519', k],
  ['stage-update-signer', `owner@example.com ssh-ed25519 ${k}`],
  ['stage-update-signer', '--file', '/tmp/x', k],
  // What only an admin at a root shell does (updates.sh), and what nobody does through this helper.
  ['add-update-signer', 'owner@example.com', 'ssh-ed25519', k],
  ['confirm-update-signer', 'owner@example.com', 'ssh-ed25519', k],
  ['confirm-update-signer', 'SHA256:x'],
  ['remove-update-signer', 'owner@example.com', 'ssh-ed25519', k],
  ['set-update-signers', '/tmp/allowed_signers'],
  ['set-update-verify', 'off'],
  ['set-update-checks', 'none'],
  ['set-update-channel', 'main'],
];

const sudoers = (...users: string[]) => spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', join(setup, 'lib.sh'), ...users], { encoding: 'utf8' });

/** The helper as root's sudoers rules name it (lib.sh), and the engine's, on a real machine. */
const HELPER_AS_ROOT = onRealMachine(MACHINE_HELPER);

test('the sudoers rule lists exactly the 34 commands, no patterns but add-project\'s, the staged signer\'s two and the six Claude account profile, sign-in and failover steps\', for the named coordinators only', { skip: !posix && 'bash' }, () => {
  const r = sudoers('wl-alpha', 'wl-beta');
  assert.equal(r.status, 0, r.stderr);
  const cmds = [...r.stdout.matchAll(new RegExp(`${HELPER_AS_ROOT.replace(/[/.]/g, '\\$&')} [^,\\\\\n]+`, 'g'))].map((m) => m[0].trim());
  const addProject = `${HELPER_AS_ROOT} ^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`;
  const stage = `${HELPER_AS_ROOT} ^stage-update-signer ${SIGNER_ARGS}`;
  const discard = `${HELPER_AS_ROOT} ^discard-update-signer ${SIGNER_ARGS}`;
  // The account profile steps (issue #464): each argument a profile's or an instance's name, nothing else.
  // One profile name each, and no instance: the helper takes the asking coordinator's from SUDO_USER.
  const profiles = ['^claude-account profile-add [a-z][a-z0-9-]*$', '^claude-account remove [a-z][a-z0-9-]*$', '^claude-account use [a-z][a-z0-9-]*$', '^claude-account login [a-z][a-z0-9-]*$', '^claude-account failover [a-z][a-z0-9+-]* back$', '^claude-account failover [a-z][a-z0-9+-]* stay$'].map((p) => `${HELPER_AS_ROOT} ${p}`);
  const want = [...Array.from({ length: 16 }, (_, i) => `${HELPER_AS_ROOT} set-slots ${i + 1}`), `${HELPER_AS_ROOT} set-updates on`, `${HELPER_AS_ROOT} set-updates off`, ...Array.from({ length: 8 }, (_, i) => `${HELPER_AS_ROOT} set-test-slots ${i + 1}`), `${HELPER_AS_ROOT} claude-account status`, `${HELPER_AS_ROOT} claude-account switch`, `${HELPER_AS_ROOT} install-updater`, `${HELPER_AS_ROOT} set-update-channel release`, ...['install', 'up', 'serve', 'public-url'].map((a) => `${HELPER_AS_ROOT} tailscale ${a}`), stage, discard, ...profiles, addProject];
  assert.equal(want.length - 9, 34);
  // No profile pattern takes a second word: never an instance, never every instance.
  for (const p of profiles) assert.doesNotMatch(p, /\* \[|(back|stay) /, p);
  // Never a comma inside a pattern: sudoers would read it as the end of the command.
  for (const p of profiles) assert.doesNotMatch(p, /,/, p);
  // Tailscale's four are whole commands: sudo matches a listed command's arguments exactly, so nothing may follow one.
  for (const a of ['install', 'up', 'serve', 'public-url']) assert.match(r.stdout, new RegExp(`${HELPER_AS_ROOT.replace(/[/.]/g, '\\$&')} tailscale ${a}(, \\\\)?$`, 'm'), a);
  // The rule names no funnel command, no flag and no target: sudo matches a listed command's arguments exactly, so `tailscale serve <anything>` is not `tailscale serve`.
  // WHY: checked on tailscale's own four lines (the staged signer's pattern names ssh-ed25519, digits and all); no rule anywhere names funnel.
  const tailscaleLines = r.stdout.split('\n').filter((l) => l.includes(' tailscale '));
  assert.equal(tailscaleLines.length, 4);
  assert.doesNotMatch(tailscaleLines.join('\n'), /funnel|--[a-z]|https?:|[0-9]{4}/i);
  assert.doesNotMatch(r.stdout, /funnel/i);
  assert.deepEqual([...r.stdout.matchAll(/ tailscale ([^,\\\n]*)/g)].map((m) => m[1]!.trim()), ['install', 'up', 'serve', 'public-url']);
  assert.deepEqual(cmds, want);
  // add-project's arguments are one anchored pattern (test/add-project.test.ts), the staged signer's two another (below); nothing else has any.
  assert.doesNotMatch(profiles.reduce((t, p) => t.replace(p, ''), r.stdout.replace(addProject, '').replace(stage, '').replace(discard, '')), /[*?[\]^$]|ALL\s*$|\bsh\b|bash/m, 'no wildcards, patterns or shells');
  // No rule names the signers file's own commands, or main: a coordinator can't add or confirm a signer, or leave the release channel.
  assert.doesNotMatch(r.stdout, /add-update-signer|confirm-update-signer|set-update-channel main|allowed_signers/);
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

test('the updater through the helper: exactly install-updater, set-update-channel release, and staging or discarding one signer; never main, never the signers file', () => {
  const { parseSigner } = createRequire(import.meta.url)(helperSrc) as { parseSigner: (c: string, a: string[]) => { principal: string; key: string } | null };
  const k = ed25519();
  for (const c of ['stage-update-signer', 'discard-update-signer']) assert.deepEqual(parseSigner(c, [c, 'owner@example.com', 'ssh-ed25519', k]), { principal: 'owner@example.com', key: k });
  assert.ok(parseSigner('stage-update-signer', ['stage-update-signer', 'release+signing@example.com', 'ssh-ed25519', k]));
  assert.deepEqual(parse(['set-update-channel', 'release'])?.value, 'release');
  // Following main is not something this helper does, whoever asks: that is updates.sh --channel main, at a root shell.
  for (const a of [['set-update-channel', 'main'], ['set-update-channel'], ['set-update-channel', 'beta'], ['set-update-channel', 'Release'], ['set-update-channel', 'release', 'x'], ['set-update-channel', '']]) assert.equal(parse(a), null, JSON.stringify(a));
  const sudo = new RegExp(`^stage-update-signer ${SIGNER_ARGS}`);
  const good = ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k].join(' ');
  assert.ok(sudo.test(good), 'the sudoers pattern takes a real key');
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  writeFileSync(join(h.etc, 'updates.json'), '{"enabled":false,"channel":"main"}\n');
  writeFileSync(join(h.etc, 'allowed_signers'), 'kept\n');
  for (const a of [...signerRefused(k), ['install-updater', 'x'], ['install-updater', '--check', 'none'], ['set-update-channel', 'beta'], ['set-update-channel', 'release', 'x']]) {
    assert.equal(parseSigner('stage-update-signer', a), null, JSON.stringify(a));
    const r = h.run(...a);
    assert.equal(r.status, 2, `${JSON.stringify(a)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: worklane-machine /);
    // sudo matches the arguments joined by spaces, so one argument holding the whole line reads the same to it: the helper is what counts them.
    if (a.join(' ') !== good) assert.ok(!sudo.test(a.join(' ')), `the sudoers pattern refuses ${JSON.stringify(a)}`);
  }
  assert.deepEqual(readdirSync(h.etc).sort(), ['allowed_signers', 'updates.json']);
  assert.equal(readFileSync(join(h.etc, 'updates.json'), 'utf8'), '{"enabled":false,"channel":"main"}\n');
  assert.equal(readFileSync(join(h.etc, 'allowed_signers'), 'utf8'), 'kept\n');
  assert.ok(!existsSync(h.pending) && !existsSync(h.log), 'nothing was staged or logged');
});

test('staging a signer writes the pending list and nothing else: the signers file is never created, changed or read as trusted', () => {
  const { fingerprint } = createRequire(import.meta.url)(helperSrc) as { fingerprint: (k: string) => string };
  const [a, b] = [ed25519(), ed25519()];
  // With no signers file: staging doesn't start one.
  const bare = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  assert.equal(bare.run('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  assert.deepEqual(readdirSync(bare.etc), [], 'nothing appeared in the config directory');
  // With one: every byte of it stays.
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const signers = join(h.etc, 'allowed_signers');
  const mine = `# release keys\nfirst@example.com ssh-ed25519 ${ed25519()}`;
  writeFileSync(signers, mine);
  const r = h.run('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^staged owner@example\\.com ssh-ed25519 .* \\(${fingerprint(a).replace(/[+/]/g, '\\$&')}\\): not a signer until an admin confirms it on this machine, within 24 hours, with: sudo bash /opt/worklane/current/scripts/setup/updates\\.sh --confirm-signer ${fingerprint(a).replace(/[+/]/g, '\\$&')}\n$`));
  assert.equal(h.run('stage-update-signer', 'second@example.com', 'ssh-ed25519', b).status, 0);
  assert.equal(readFileSync(signers, 'utf8'), mine, 'the signers file is as it was');
  assert.deepEqual(readdirSync(h.etc), ['allowed_signers']);
  const list = (JSON.parse(readFileSync(h.pending, 'utf8')) as { pending: Record<string, string>[] }).pending;
  assert.deepEqual(list.map(({ at: _at, ...rest }) => rest), [
    { principal: 'owner@example.com', key: a, fingerprint: fingerprint(a), by: 'wl-alpha', instance: 'alpha' },
    { principal: 'second@example.com', key: b, fingerprint: fingerprint(b), by: 'wl-alpha', instance: 'alpha' },
  ]);
  if (posix) assert.equal(statSync(h.pending).mode & 0o777, 0o644);
  // Staged again: nothing changes (its 24 hours don't start over).
  const before = readFileSync(h.pending, 'utf8');
  assert.match(h.run('stage-update-signer', 'owner@example.com', 'ssh-ed25519', a).stdout, /is already staged; nothing changed/);
  assert.equal(readFileSync(h.pending, 'utf8'), before);
  // Discarded: gone from the list; discarding what isn't there fails and changes nothing.
  assert.equal(h.run('discard-update-signer', 'owner@example.com', 'ssh-ed25519', a).status, 0);
  assert.deepEqual((JSON.parse(readFileSync(h.pending, 'utf8')) as { pending: { principal: string }[] }).pending.map((e) => e.principal), ['second@example.com']);
  const gone = h.run('discard-update-signer', 'owner@example.com', 'ssh-ed25519', a);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /isn't staged/);
  assert.equal(readFileSync(signers, 'utf8'), mine);
  const lines = readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map((l) => [l.by, l.what, l.to]), [['wl-alpha', 'updates.pending_signer', `staged owner@example.com ssh-ed25519 ${a} (${fingerprint(a)})`], ['wl-alpha', 'updates.pending_signer', `staged second@example.com ssh-ed25519 ${b} (${fingerprint(b)})`], ['wl-alpha', 'updates.pending_signer', 'discarded']]);
  // The helper's code has no way to the signers file at all: it never names it.
  assert.doesNotMatch(readFileSync(helperSrc, 'utf8'), /allowed_signers/);
});

test('the pending list is bounded and expires: at most 4 staged, each for 24 hours, and a list someone else wrote is trusted for nothing malformed', () => {
  const { readPending, PENDING_MAX, PENDING_TTL_MS } = createRequire(import.meta.url)(helperSrc) as { readPending: (file: string, now?: number) => { principal: string; key: string; at: string }[]; PENDING_MAX: number; PENDING_TTL_MS: number };
  assert.deepEqual([PENDING_MAX, PENDING_TTL_MS], [4, 24 * 60 * 60_000]);
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const keys = Array.from({ length: 6 }, () => ed25519());
  for (let i = 0; i < 4; i++) assert.equal(h.run('stage-update-signer', `s${i}@example.com`, 'ssh-ed25519', keys[i]!).status, 0);
  const full = h.run('stage-update-signer', 's4@example.com', 'ssh-ed25519', keys[4]!);
  assert.equal(full.status, 1);
  assert.match(full.stderr, /4 signers are already staged: confirm or discard one first/);
  assert.equal(readPending(h.pending).length, 4);
  // 24 hours on, none of them counts; and a new one can be staged, which drops the expired from the file.
  const staged = readPending(h.pending);
  assert.equal(readPending(h.pending, Date.parse(staged[0]!.at) + PENDING_TTL_MS - 1000).length, 4);
  assert.deepEqual(readPending(h.pending, Date.parse(staged[3]!.at) + PENDING_TTL_MS), []);
  const old = new Date(Date.now() - PENDING_TTL_MS - 1000).toISOString();
  writeFileSync(h.pending, JSON.stringify({ pending: staged.map((e) => ({ ...e, at: old })) }));
  assert.deepEqual(readPending(h.pending), [], 'expired');
  assert.equal(h.run('discard-update-signer', 's0@example.com', 'ssh-ed25519', keys[0]!).status, 1, 'an expired one is no longer there to discard');
  assert.equal(h.run('stage-update-signer', 's5@example.com', 'ssh-ed25519', keys[5]!).status, 0);
  assert.deepEqual((JSON.parse(readFileSync(h.pending, 'utf8')) as { pending: { principal: string }[] }).pending.map((e) => e.principal), ['s5@example.com']);
  // Entries that aren't one principal and one ed25519 key, or are dated in the future, don't count; more than 4 are cut.
  const now = new Date().toISOString();
  writeFileSync(h.pending, JSON.stringify({ pending: [{ principal: '*', key: keys[0], at: now }, { principal: 'a@example.com', key: 'AAAA', at: now }, { principal: 'a@example.com', key: keys[0], at: new Date(Date.now() + 3_600_000).toISOString() }, 'x', null, ...keys.map((k, i) => ({ principal: `ok${i}@example.com`, key: k, at: now }))] }));
  assert.deepEqual(readPending(h.pending).map((e) => e.principal), ['ok0@example.com', 'ok1@example.com', 'ok2@example.com', 'ok3@example.com']);
  writeFileSync(h.pending, 'not json');
  assert.deepEqual(readPending(h.pending), []);
});

test('set-update-channel release writes the channel and nothing else, and only for an updater that is installed', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const none = h.run('set-update-channel', 'release');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /updates\.json is missing: install the updater first \(install-updater\)/);
  assert.deepEqual(readdirSync(h.etc), [], 'no config appeared');
  assert.ok(!existsSync(h.log));
  const cfg = { enabled: false, channel: 'main', allowed_signers: '/etc/worklane/allowed_signers', repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test (ubuntu-latest, 22)', 'push-gate'] };
  writeFileSync(join(h.etc, 'updates.json'), `${JSON.stringify(cfg)}\n`);
  assert.equal(h.run('set-update-channel', 'release').status, 0);
  // The signers file's path, the required checks and the switch are as they were: only the channel moved.
  assert.deepEqual(JSON.parse(readFileSync(join(h.etc, 'updates.json'), 'utf8')), { ...cfg, channel: 'release' });
  // And there is no way back to main from here.
  assert.equal(h.run('set-update-channel', 'main').status, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(h.etc, 'updates.json'), 'utf8')), { ...cfg, channel: 'release' });
  const lines = readFileSync(h.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(lines.map(({ at: _at, ...rest }) => rest), [{ by: 'wl-alpha', what: 'updates.channel', from: 'main', to: 'release' }]);
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
    // Nothing that could turn on Funnel, choose what serve forwards or where, or change what `up` exposes.
    ['tailscale', 'funnel', '443'],
    ['tailscale', 'funnel', '--bg', '--https=443', 'http://127.0.0.1:4399'],
    ['tailscale', 'funnel', 'on'],
    ['tailscale', '--funnel'],
    ['tailscale', 'serve', '--funnel'],
    ['tailscale', 'serve', 'funnel'],
    ['tailscale', 'serve', 'funnel', 'on'],
    ['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:4399'],
    ['tailscale', 'serve', '--https=8443'],
    ['tailscale', 'serve', '--http=80'],
    ['tailscale', 'serve', '--tcp=22', 'tcp://127.0.0.1:22'],
    ['tailscale', 'serve', '--tls-terminated-tcp=443', 'tcp://127.0.0.1:4399'],
    ['tailscale', 'serve', '--set-path=/x', 'http://127.0.0.1:4398'],
    ['tailscale', 'serve', '--set-path', '/', 'http://203.0.113.5:80'],
    ['tailscale', 'serve', 'http://0.0.0.0:4399'],
    ['tailscale', 'serve', 'http://203.0.113.10:4399'],
    ['tailscale', 'serve', 'https+insecure://example.test'],
    ['tailscale', 'serve', '/etc'],
    ['tailscale', 'serve', '--yes'],
    ['tailscale', 'up', '--advertise-exit-node'],
    ['tailscale', 'up', '--advertise-routes=198.51.100.0/24'],
    ['tailscale', 'up', '--advertise-routes', '0.0.0.0/0'],
    ['tailscale', 'up', '--advertise-tags=tag:server'],
    ['tailscale', 'up', '--accept-routes'],
    ['tailscale', 'up', '--exit-node=203.0.113.1'],
    ['tailscale', 'up', '--shields-up=false'],
    ['tailscale', 'up', '--operator=wl-alpha'],
    ['tailscale', 'up', '--reset'],
    ['tailscale', 'up', '--force-reauth'],
    ['tailscale', 'up', '--hostname=other'],
    ['tailscale', 'up', '--timeout=600s'],
    ['tailscale', 'set', '--advertise-exit-node'],
    ['tailscale', 'cert', 'x'],
    ['tailscale', 'public-url', 'https://box.example.test'],
    ['tailscale', 'public-url', '--name', 'other'],
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

/** machine_sudoers with a stand-in sudo on PATH whose -V reports `version` (or nothing, for a sudo that won't say). */
function sudoersWithSudo(version: string | null) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-sudo-'));
  writeFileSync(join(bin, 'sudo'), `#!/bin/sh\n[ "$1" = -V ] && ${version ? `echo "Sudo version ${version}" && echo "Sudoers policy plugin version ${version}" &&` : ''} exit 0\nexit 1\n`, { mode: 0o755 });
  return spawnSync('bash', ['-c', 'source "$1"; shift; machine_sudoers "$@"', '_', join(setup, 'lib.sh'), 'wl-alpha'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
}

test('the pattern rules (add-project, stage-update-signer, discard-update-signer, the Claude account profile steps) are installed only for sudo 1.9.10 or later; below, they are left out, said so, and every other rule stays', { skip: !posix && 'bash' }, () => {
  const k = /\^(stage-update-signer|discard-update-signer|add-project|claude-account [a-z-]+) /g;
  // The command lines alone, each without its list punctuation: what differs is which commands, not where the list ends.
  const commands = (rule: string) => rule.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.replace(/,? \\$/, '').replace(/^Cmnd_Alias WORKLANE_MACHINE = /, '    ').trim()).filter(Boolean);
  for (const v of ['1.9.10', '1.9.10p1', '1.9.15p5', '1.9.17', '1.10.0', '2.0.0']) {
    const r = sudoersWithSudo(v);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual((r.stdout.match(k) ?? []).map((x) => x.trim()), ['^stage-update-signer', '^discard-update-signer', '^claude-account profile-add', '^claude-account remove', '^claude-account use', '^claude-account login', '^claude-account failover', '^claude-account failover', '^add-project'], `sudo ${v}: every pattern rule`);
    assert.doesNotMatch(r.stdout, /^# Not here/m);
  }
  const newer = commands(sudoersWithSudo('1.9.10').stdout).filter((l) => !/\^(stage-update-signer|discard-update-signer|add-project|claude-account [a-z-]+) /.test(l));
  for (const v of ['1.9.9', '1.9.9p2', '1.9.5p2', '1.8.31', '1.9.0', null]) {
    const r = sudoersWithSudo(v);
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(k) ?? []).length, 0, `sudo ${v}: no pattern rule`);
    assert.match(r.stdout, /^# Not here either, for the same reason: the claude-account profile commands \(profile-add, use, remove, login, failover\)\.$/m);
    assert.match(r.stdout, new RegExp(`^# Not here: add-project, stage-update-signer and discard-update-signer\\. This sudo \\(${(v ?? '').replace(/p\d+$/, '')}\\) is older than 1\\.9\\.10 and would read their patterns as literal text\\.$`, 'm'));
    // Every other rule is there as on a newer sudo.
    assert.deepEqual(commands(r.stdout), newer, `sudo ${v}: the rest unchanged`);
    if (spawnSync('visudo', ['--version']).status === 0) {
      const f = join(mkdtempSync(join(tmpdir(), 'sudoers-')), 'rule');
      writeFileSync(f, r.stdout);
      assert.equal(spawnSync('visudo', ['-cf', f]).status, 0, `sudo ${v}: visudo accepts the rule without them`);
    }
  }
  // machine-helper.sh says which it did, refuses (to stderr) to install them on an older sudo, and records it for the dashboard.
  const sh = readFileSync(join(setup, 'machine-helper.sh'), 'utf8');
  assert.match(sh, /^if sudo_regex_ok; then\n  echo "sudo \$\(sudo_version\): \$SUDO_REGEX_MIN or later, so the add-project, stage-update-signer, discard-update-signer and claude-account profile rules are installed"\n  left_out='\[\]'\nelse\n  echo "REFUSED: the add-project, stage-update-signer, discard-update-signer and claude-account profile rules are NOT installed\./m);
  assert.match(sh, /left_out='\["add-project","stage-update-signer","discard-update-signer","claude-account-profiles"\]'/);
  assert.match(sh, /^mv -f "\$\(dirname "\$HELPER_RULES"\)\/\.helper-rules\.json\.tmp" "\$HELPER_RULES"$/m);
  assert.match(readFileSync(join(setup, 'lib.sh'), 'utf8'), /^HELPER_RULES=\/etc\/worklane\/helper-rules\.json$/m);
});

test('every step that writes system paths runs in a transient unit of its own, started with the same arguments; nothing else does, and --in-unit is root\'s alone', () => {
  const h = createRequire(import.meta.url)(helperSrc) as { needsUnit: (a: string[]) => boolean; unitCommand: (a: string[], user?: string, self?: string, node?: string, pid?: number) => string[]; IN_UNIT: string };
  const k = ed25519();
  // The coordinator's own unit runs with ProtectSystem=full: /usr, /boot and /etc read-only for sudo and this helper.
  const writes = [['set-slots', '3'], ['set-test-slots', '2'], ['set-updates', 'on'], ['set-updates', 'off'], ['set-update-channel', 'release'], ['install-updater'], ['add-project', 'alpha', 'example/alpha'], ['stage-update-signer', 'owner@example.com', 'ssh-ed25519', k], ['discard-update-signer', 'owner@example.com', 'ssh-ed25519', k], ['claude-account', 'status']];
  for (const a of writes) assert.equal(h.needsUnit(a), true, JSON.stringify(a));
  // Already units of their own (systemd-run --no-block), and anything the helper refuses: never wrapped.
  for (const a of [['tailscale', 'up'], ['claude-account', 'switch'], ['set-slots', '17'], ['install-updater', 'x'], ['rm', '-rf', '/'], []]) assert.equal(h.needsUnit(a), false, JSON.stringify(a));
  assert.deepEqual(h.unitCommand(['install-updater'], 'wl-alpha', '/usr/local/libexec/worklane-machine', '/usr/bin/node', 42), [
    '--unit', 'worklane-machine-install-updater-42', '--wait', '--pipe', '--collect', '--quiet', '--service-type=exec', '--description', 'worklane-machine install-updater',
    '--property', 'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 HOME=/root SUDO_USER=wl-alpha',
    '/usr/bin/node', '/usr/local/libexec/worklane-machine', '--in-unit', 'install-updater',
  ]);
  // Who asked passes to the unit only when it is a user name: nothing of the caller's otherwise.
  assert.doesNotMatch(h.unitCommand(['set-slots', '3'], 'x y;id').join(' '), /SUDO_USER/);
  // --in-unit is never on sudo's list, and the helper refuses it from anyone but root.
  assert.doesNotMatch(sudoers('wl-alpha').stdout, /in-unit/);
  if (posix && process.getuid?.() !== 0) {
    const r = helperIn(mkdtempSync(join(tmpdir(), 'machine-'))).run('--in-unit', 'set-slots', '3');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--in-unit is the helper's own, as root/);
  }
  // As root it goes to systemd-run before anything is written: main checks root and needsUnit first.
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /if \(!inner && process\.getuid && process\.getuid\(\) === 0 && needsUnit\(args\)\) return inUnit\(args\);\n  const add = parseAddProject\(args\);/);
});

test('a step is recorded only once it has run: as done when it exited 0, as failed when it failed or never started; never as a change before it happened', () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'machine-')));
  const { runLogged } = createRequire(import.meta.url)(h.copy) as { runLogged: (what: string, to: string, run: () => number) => number };
  const records = () => (existsSync(h.log) ? readFileSync(h.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { what: string; to: string }) : []);
  let seen: number | null = null;
  assert.equal(
    runLogged('install-updater', 'updates.sh', () => {
      seen = records().length;
      return 1;
    }),
    1,
  );
  assert.equal(seen, 0, 'nothing is recorded while the step runs');
  assert.equal(
    runLogged('install-updater', 'updates.sh', () => {
      throw new Error('spawn bash ENOENT');
    }),
    1,
  );
  assert.deepEqual(records().map((c) => [c.what, c.to]), [['install-updater', 'failed: updates.sh: exit 1'], ['install-updater', 'failed: updates.sh: exit 1']], 'a failed step writes no success record');
  assert.equal(runLogged('install-updater', 'updates.sh', () => 0), 0);
  assert.deepEqual(records().at(-1)?.to, 'updates.sh');
  // Every step the helper runs inline goes through it; a unit started with --no-block is recorded only after systemd-run, by outcome.
  const src = readFileSync(helperSrc, 'utf8');
  for (const s of ["runLogged('install-updater', 'updates.sh',", "runLogged('add-project', `${p.name} ${p.repo}`,", "runLogged('claude-account', 'status',"]) assert.ok(src.includes(s), s);
  const units: [string, string, string][] = [
    ["spawnSync('systemd-run', ['--unit', CLAUDE_ACCOUNT_UNIT", "logLine('claude-account', null, `switch (token", "logLine('claude-account', null, `failed: switch"],
    ["spawnSync('systemd-run', ['--unit', TAILSCALE_UNIT", "logLine('tailscale', null, action);", "logLine('tailscale', null, `failed: ${action}: not started`);"],
  ];
  for (const [start, ok, failed] of units) {
    const at = src.indexOf(start);
    assert.ok(at > 0 && src.indexOf(ok) > at && src.indexOf(failed) > at, `${ok}: recorded after systemd-run, by outcome`);
    assert.equal(src.split(ok).length, 2, `${ok}: one success record`);
  }
});
