// The machine helper's setup commands (onboarding): exact argument shapes, secrets on stdin only, and sudo for
// the one setup user, never a coordinator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRootStep } from '../src/console/root-steps.js';
import { SETUP_STEPS } from '../src/console/setup-steps.js';
import { HUB_PORT } from '../src/dashboard-hub.js';
import { MACHINE_HELPER, runSetupCommand } from '../src/machine.js';
import { repoRoot } from './helpers.js';

const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
type Parsed = { cmd: string; args: string[]; stdin: boolean; run: [string, string[]] | null } | null;
const helper = createRequire(import.meta.url)(helperSrc) as { parseSetup: (a: string[]) => Parsed; parse: (a: string[]) => unknown; SETUP_COMMANDS: string[]; HUB_PORT: number };
const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const sha = 'a'.repeat(40);

const good: string[][] = [
  ['setup-machine'],
  ['add-instance', 'shop'],
  ['install-engine', sha, 'shop', 'acme/shop'],
  ['install-app-key', 'shop', '12', '34', 'acme/shop', 'per-repo'],
  ['install-app-key', 'shop', '12', '34', 'acme/shop.web', 'shared'],
  ['checkout', 'shop', 'acme/shop'],
  ['install-service', 'shop'],
  ['install-dashboards', 'ada', 'shop', 'blog'],
  ['install-claude-key', 'shop'],
  ['install-discord-token', 'shop'],
  ['set-budget', 'shop', '20'],
  ['claude-status', 'shop'],
  ['instance-doctor', 'shop', 'acme/shop'],
  ['tailscale-serve'],
];
const bad: string[][] = [
  ['setup-machine', '--cap', '9'],
  ['add-instance'],
  ['add-instance', 'Shop'],
  ['add-instance', 'dash'],
  ['add-instance', 'shop-agent'],
  ['add-instance', 'shop;id'],
  ['add-instance', 'shop', 'extra'],
  ['install-engine', 'main', 'shop', 'acme/shop'],
  ['install-engine', sha, 'shop', 'acme/../etc'],
  ['install-engine', sha, 'shop', 'acme/shop/x'],
  ['install-engine', sha, 'shop', '-o/shop'],
  ['install-app-key', 'shop', '12', '34', 'acme/shop'],
  ['install-app-key', 'shop', '12', '34', 'acme/shop', 'all'],
  ['install-app-key', 'shop', '012', '34', 'acme/shop', 'per-repo'],
  ['install-app-key', 'shop', '12', '34', 'acme/shop', 'per-repo', '-----BEGIN RSA PRIVATE KEY-----'],
  ['install-dashboards', 'ada'],
  ['install-dashboards', 'ada', 'shop', 'shop'],
  ['install-dashboards', '-ada', 'shop'],
  ['install-claude-key', 'shop', 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx'],
  ['install-discord-token', 'shop', 'x'.repeat(60)],
  ['set-budget', 'shop', '0'],
  ['set-budget', 'shop', '1001'],
  ['set-budget', 'shop', '20.5'],
  ['tailscale-serve', '--https=80'],
  ['bash', '-c', 'id'],
  ['setup-machine;id'],
  ['__proto__'],
  ['toString'],
];

test('the helper takes each setup command in exactly its form, and the engine checks the same before sudo', () => {
  for (const a of good) {
    assert.ok(helper.parseSetup(a), `helper refuses ${a.join(' ')}`);
    assert.equal(checkRootStep(a[0]!, a.slice(1)).allowed, true, `engine refuses ${a.join(' ')}`);
  }
  for (const a of bad) {
    assert.equal(helper.parseSetup(a), null, `helper takes ${a.join(' ')}`);
    assert.equal(checkRootStep(a[0]!, a.slice(1)).allowed, false, `engine takes ${a.join(' ')}`);
    assert.equal(helper.parse(a), null);
  }
});

test('the setup commands are one list: the helper, lib.sh and the engine name the same ones', () => {
  const lib = readFileSync(join(setup, 'lib.sh'), 'utf8');
  const fromLib = /^SETUP_COMMANDS=\(([^)]*)\)$/m.exec(lib)![1]!.split(/\s+/);
  assert.deepEqual(fromLib, helper.SETUP_COMMANDS);
  assert.deepEqual(SETUP_STEPS.map((s) => s.command), helper.SETUP_COMMANDS);
  assert.deepEqual(good.map((a) => a[0]).filter((c, i, all) => all.indexOf(c) === i), helper.SETUP_COMMANDS, 'every command is exercised above');
  assert.equal(helper.HUB_PORT, HUB_PORT, 'tailscale serve exposes the hub');
});

test('a secret goes on stdin only: the commands that take one, and none takes it as an argument', () => {
  assert.deepEqual(
    SETUP_STEPS.filter((s) => s.secret).map((s) => s.command),
    good.map((a) => helper.parseSetup(a)!).filter((p) => p.stdin).map((p) => p.cmd).filter((c, i, all) => all.indexOf(c) === i),
  );
  const calls: { file: string; args: string[]; input: string | undefined }[] = [];
  const exec = (file: string, args: string[], input?: string) => (calls.push({ file, args, input }), 'ok');
  const r = runSetupCommand('install-claude-key', ['shop'], 'sk-ant-secret-value-000000000000', exec);
  assert.deepEqual(r, { ok: true, output: 'ok' });
  assert.deepEqual(calls, [{ file: 'sudo', args: ['-n', MACHINE_HELPER, 'install-claude-key', 'shop'], input: 'sk-ant-secret-value-000000000000' }]);
});

test('each setup command runs its one script from the root-owned copy, never a path from the caller', () => {
  for (const a of good) {
    const p = helper.parseSetup(a)!;
    if (!p.run) continue;
    const [file, args] = p.run;
    assert.ok(file === 'bash' || file === 'runuser', `${a[0]} runs ${file}`);
    if (file === 'bash') assert.match(args[0]!, /^\/usr\/local\/libexec\/worklane-setup\/[a-z-]+\.sh$/);
    else assert.match(args.join(' '), /^-u wl-shop(-agent)? -- \/usr\/local\/bin\/(worklane|claude) /);
  }
});

/** A copy of the helper whose fixed paths point into a temp root, with fake setup scripts that record what they got. */
function helperIn(root: string) {
  const setupDir = join(root, 'setup');
  mkdirSync(setupDir, { recursive: true });
  const record = join(root, 'record');
  for (const f of ['machine.sh', 'instance.sh', 'credentials.sh']) {
    writeFileSync(join(setupDir, f), `printf '%s\\n' "${f}" "$@" > ${JSON.stringify(record)}; if [ ! -t 0 ]; then cat >> ${JSON.stringify(record)}; fi\n`);
  }
  const log = join(root, 'machine-changes.jsonl');
  const copy = join(root, 'helper.cjs');
  writeFileSync(
    copy,
    readFileSync(helperSrc, 'utf8')
      .replace("const SETUP = '/usr/local/libexec/worklane-setup';", `const SETUP = ${JSON.stringify(setupDir)};`)
      .replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(log)};`),
  );
  chmodSync(copy, 0o755);
  const run = (args: string[], input?: string) => spawnSync(process.execPath, [copy, ...args], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'ada' }, ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }) });
  return { run, record, log };
}

test('the helper runs a setup script with its checked arguments, passes a secret on stdin, and logs the arguments but never the secret', { skip: !posix && 'bash' }, () => {
  const h = helperIn(mkdtempSync(join(tmpdir(), 'setup-helper-')));
  assert.equal(h.run(['add-instance', 'shop']).status, 0);
  assert.equal(readFileSync(h.record, 'utf8'), 'instance.sh\nshop\n');
  const secret = 'sk-ant-api03-' + 'z'.repeat(30);
  const r = h.run(['install-claude-key', 'shop'], `${secret}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(h.record, 'utf8'), `credentials.sh\nshop\nclaude-key\n${secret}\n`);
  const log = readFileSync(h.log, 'utf8');
  assert.match(log, /"by":"ada","what":"setup.add-instance","from":null,"to":"shop"/);
  assert.match(log, /"what":"setup.install-claude-key"/);
  assert.ok(!log.includes(secret), 'the secret is never logged');
  assert.equal(h.run(['install-claude-key', 'shop'], '').status, 2, 'a secret command refuses an empty stdin');
  assert.equal(h.run(['add-instance', 'shop;id']).status, 2);
});

const lib = (fn: string, ...a: string[]) => spawnSync('bash', ['-c', `source "$1"; shift; ${fn} "$@"`, '_', join(setup, 'lib.sh'), ...a], { encoding: 'utf8' });

test('sudoers: the setup user alone gets the setup commands; coordinators keep exactly their 18', { skip: !posix && 'bash' }, () => {
  const r = lib('setup_sudoers', 'ada');
  assert.equal(r.status, 0, r.stderr);
  const cmds = [...r.stdout.matchAll(new RegExp(`${MACHINE_HELPER.replace(/[/.]/g, '\\$&')} ([a-z-]+) ([^,\\\\\n]+)`, 'g'))].map((m) => [m[1], m[2]!.trim()]);
  assert.deepEqual(cmds.map((c) => c[0]), helper.SETUP_COMMANDS);
  for (const [c, args] of cmds) assert.equal(args, ['setup-machine', 'tailscale-serve'].includes(c!) ? '""' : '*', `${c}: no arguments at all, or arguments the helper checks`);
  assert.match(r.stdout, /^ada ALL=\(root\) NOPASSWD: WORKLANE_SETUP$/m);
  assert.doesNotMatch(r.stdout, /\bbash\b|\bsh\b|ALL\s*$/m);
  for (const u of ['root', 'wl-shop', 'wl-dash', 'ada ALL', '']) assert.notEqual(lib('setup_sudoers', u).status, 0, JSON.stringify(u));
  const coord = lib('machine_sudoers', 'wl-shop');
  for (const c of helper.SETUP_COMMANDS) assert.ok(!coord.stdout.includes(` ${c}`), `a coordinator gets ${c}`);
  if (spawnSync('visudo', ['--version']).status === 0) {
    const f = join(mkdtempSync(join(tmpdir(), 'sudoers-')), 'rule');
    writeFileSync(f, r.stdout);
    assert.equal(spawnSync('visudo', ['-cf', f]).status, 0, 'visudo accepts it');
  }
});

test('machine-helper.sh installs the setup scripts root-owned for the helper, and the setup rule only with --setup-user', () => {
  const s = readFileSync(join(setup, 'machine-helper.sh'), 'utf8');
  assert.match(s, /setup_dir="\$\(dirname "\$MACHINE_HELPER"\)\/worklane-setup"/);
  assert.match(s, /install -o root -g root -m 0644 "\$f" "\$setup_dir\.new\/"/);
  assert.match(s, /if \[ -n "\$setup_user" \]; then\n  say "sudoers: \$setup_user may run the helper's setup commands, nothing else"\n  install_sudoers worklane-setup "\$\(setup_sudoers "\$setup_user"\)"/);
  assert.match(s, /FAIL: coordinator \$u may run a setup command/);
  assert.match(readFileSync(join(setup, 'engine.sh'), 'utf8'), /engine-origin/);
});

test('app-permissions: per project the installation reaches exactly the repo; shared, a token limited to the repo does', async () => {
  const { scopeProblem } = (await import(pathToFileURL(join(setup, 'app-permissions.mjs')).href)) as { scopeProblem: (r: string[], repo: string, shared?: boolean) => string | null };
  assert.equal(scopeProblem(['Acme/Shop'], 'acme/shop'), null);
  assert.match(scopeProblem(['acme/shop', 'acme/blog'], 'acme/shop')!, /installation must reach exactly acme\/shop/);
  assert.equal(scopeProblem(['acme/shop'], 'acme/shop', true), null);
  assert.match(scopeProblem(['acme/shop', 'acme/blog'], 'acme/shop', true)!, /limited to acme\/shop must reach exactly/);
  assert.match(scopeProblem([], 'acme/shop', true)!, /reaches 0 repo/);
  const cred = readFileSync(join(setup, 'credentials.sh'), 'utf8');
  assert.match(cred, /verify_app "\$key" "\$app_id" "\$inst_id" "\$repo" \$shared/);
  assert.match(cred, /read -rp "Delete the copy[^\n]*\|\| yn=/, 'no prompt can fail the script on a closed stdin');
});
