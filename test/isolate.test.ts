// The suite runs clean on a machine that already runs the engine (issue #312): every test process has a temporary
// home, state dir and slot directory (test/isolate.ts), and a server a test stops keeps its port held by the test
// (test/held-port.ts). Checked here end to end, with a live machine's environment and its fixed ports taken. The
// isolation is preloaded by every runner, never imported per file: a new test file gets it without doing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { HUB_BREAK_GLASS_PORT, HUB_PORT } from '../src/dashboard-hub.js';
import { LOCAL_DASHBOARD_PORT } from '../src/dashboard.js';
import { machineInitDir } from '../src/init.js';
import { instancesDir } from '../src/instance.js';
import { childEnv, slotsDir, stateDir } from '../src/os/index.js';
import { toolPrefix } from '../src/tool-path.js';
import { CLAUDE_ACCOUNT_DIR } from '../src/claude-account.js';
import { TEST_RUN_BASE } from '../src/disk-guard.js';
import { HELPER_RULES, MACHINE_CHANGES, MACHINE_HELPER } from '../src/machine.js';
import { MACHINE_OWNERS_FILE } from '../src/machine-owners.js';
import { NETWORK_FILE } from '../src/network.js';
import { PROVIDER_HOSTS_FILE } from '../src/provider-hosts.js';
import { SYSTEM_SLOTS, UPDATE_DRAIN_FILE } from '../src/os/index.js';
import { gpuFilePath, gpuLockPath } from '../src/testrun/gpu.js';
import { devSlotsPath, serviceModeRefusal, SYSTEM_ROOT_VAR, systemRootRefusal, TEST_MARK_FILE, TEST_TOKEN_VAR } from '../src/os/system-paths.js';
import { LIMITS_PATH } from '../src/settings.js';
import { MACHINE_PATHS } from '../src/setup-steps.js';
import { TAILSCALE_DIR, TAILSCALE_SCRIPT } from '../src/tailscale-setup.js';
import { SANDBOX_HELPER } from '../src/testrun/host.js';
import { FULL_RUN_LOCK } from '../src/testrun/run.js';
import { CONSOLE_SHELL } from '../src/console/terminal.js';
import { ALLOWED_SIGNERS, PENDING_SIGNERS } from '../src/updater-setup.js';
import { ENGINE_CURRENT, UPDATES_CONFIG, UPDATES_LOG } from '../src/updates.js';
import { WATCHDOG_CONFIG } from '../src/watchdog/config.js';
import { ephemeralStart, refusedPort } from './held-port.js';
import { exampleProject, MARKS, repoRoot } from './helpers.js';
import { homeMoved, isolatedEnv, onRealMachine, TEST_PRELOAD, testMachine } from './isolate.js';

const testDir = join(repoRoot, 'test');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const testFiles = walk(testDir).filter((f) => f.endsWith('.test.ts'));
const inside = (p: string) => !relative(testMachine, p).startsWith('..');

/** Every file a runner of the suite can live in: the npm scripts, the workflows, the scripts, the project's checks. */
function runnerFiles(): string[] {
  const under = (d: string) => (existsSync(join(repoRoot, d)) ? walk(join(repoRoot, d)) : []);
  return [join(repoRoot, 'package.json'), ...under('.github/workflows'), ...under('scripts'), ...under('.worklane/checks')].filter((f) => /\.(json|ya?ml|mjs|cjs|js|sh)$/.test(f));
}

test('every way the suite runs preloads the isolation: npm test, the CI shards, the touched-tests check', () => {
  // `node [flags] --test` in a shell line or an npm script: the flags must hold the preload.
  const shell = /\bnode((?:\s+--?[\w-]+(?:=\S+|\s+\.\/\S+)?)*)\s+--test(?=[\s"'\\]|$)/g;
  const preload = TEST_PRELOAD.join(' ');
  const seen: string[] = [];
  const bad: string[] = [];
  for (const f of runnerFiles()) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(repoRoot, f).split(sep).join('/');
    // Not in a comment (`// … node --test runs`, `# …`, ` * …`): only what runs.
    for (const line of text.split('\n').filter((l) => !/^\s*(\/\/|\/?\*|#)/.test(l))) {
      for (const m of line.matchAll(shell)) {
        seen.push(rel);
        if (!m[1]!.includes(preload)) bad.push(`${rel}: ${m[0]}`);
      }
    }
    // A runner in JavaScript: node's argv with '--test' in it, right after the preload.
    for (const line of text.split('\n').filter((l) => /['"]--test['"]/.test(l))) {
      seen.push(rel);
      const declared = text.includes(`const PRELOAD = ['--import', './dist/test/isolate.js'];`);
      if (!(declared && /\.\.\.PRELOAD,\s*['"]--test['"]/.test(line))) bad.push(`${rel}: ${line.trim()}`);
    }
  }
  for (const want of ['package.json', '.github/workflows/ci.yml', '.worklane/checks/touched-tests.mjs']) assert.ok(seen.includes(want), `found the runner in ${want}`);
  assert.deepEqual(bad, [], `run the suite as node ${preload} --test (test/isolate.ts)`);
});

/** A test file of its own, in a directory of its own, as a new test file would be. */
function fixtureTest(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'isolate-fixture-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, name), body);
  return join(dir, name);
}

async function runTests(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  const p = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d: Buffer) => (out += d.toString()));
  p.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((ok) => p.on('close', (c) => ok(c)));
  return { code, out };
}

test('a new test file that imports nothing of ours still runs on a temporary home, state and slots', async () => {
  const live = { home: mkdtempSync(join(tmpdir(), 'live-home-')), state: mkdtempSync(join(tmpdir(), 'live-state-')), slots: mkdtempSync(join(tmpdir(), 'live-slots-')) };
  const file = fixtureTest(
    'new.test.js',
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { homedir } from 'node:os';",
      "test('isolated', () => {",
      `  assert.notEqual(process.env[${JSON.stringify(`${BRAND.envPrefix}_STATE_DIR`)}], ${JSON.stringify(live.state)}, 'state dir');`,
      `  assert.notEqual(process.env.AGENT_SLOTS_DIR, ${JSON.stringify(live.slots)}, 'slots');`,
      `  assert.equal(process.env[${JSON.stringify(`${BRAND.envPrefix}_INSTANCE`)}], undefined, 'instance');`,
      ...(homeMoved ? [`  assert.notEqual(homedir(), ${JSON.stringify(live.home)}, 'home');`] : []),
      '});',
    ].join('\n'),
  );
  const env = { ...childEnv(), HOME: live.home, AGENT_SLOTS_DIR: live.slots, [`${BRAND.envPrefix}_STATE_DIR`]: live.state, [`${BRAND.envPrefix}_INSTANCE`]: 'shop' };
  const preloaded = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', file], env);
  assert.equal(preloaded.code, 0, preloaded.out);
  const bare = await runTests(['--test', '--test-reporter=tap', file], env);
  assert.notEqual(bare.code, 0, `the same file without the preload sees the machine (so the check above means something):\n${bare.out}`);
});

test('a test file run without the isolation stops at once, before any test', async () => {
  const helpers = pathToFileURL(join(repoRoot, 'dist', 'test', 'helpers.js')).href;
  const file = fixtureTest('forgot.test.js', [`import { repoRoot } from ${JSON.stringify(helpers)};`, "import { test } from 'node:test';", "test('ran', () => { console.log('TEST BODY RAN', repoRoot.length); });"].join('\n'));
  const bare = await runTests(['--test', '--test-reporter=tap', file], childEnv());
  assert.notEqual(bare.code, 0);
  assert.match(bare.out, /ran without the test isolation: run it as node --import \.\/dist\/test\/isolate\.js --test/);
  assert.doesNotMatch(bare.out, /TEST BODY RAN/);
  const preloaded = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', file], childEnv());
  assert.equal(preloaded.code, 0, preloaded.out);
});

/** The bodies of a file's finally blocks: where a test puts things back. */
function finallyBlocks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bfinally\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

test('no test cleans up by unsetting an isolated variable (unset, it falls back to the machine\'s own directory)', () => {
  const keys = Object.keys(isolatedEnv).map((k) => k.replace(`${BRAND.envPrefix}_`, ''));
  const bad = new RegExp(`^\\s*delete process\\.env(\\.|\\[\`\\$\\{BRAND\\.envPrefix\\}_|\\[')(${keys.join('|')})\\b`, 'm');
  assert.ok(bad.test('  delete process.env.AGENT_SLOTS_DIR;') && bad.test('    delete process.env[`${BRAND.envPrefix}_STATE_DIR`];'), 'the check sees both spellings');
  const offenders = testFiles.filter((f) => finallyBlocks(readFileSync(f, 'utf8')).some((b) => bad.test(b)));
  assert.deepEqual(offenders.map((f) => relative(repoRoot, f)), [], 'put it back with restoreIsolated() from test/isolate.ts');
});

test('in a test process, home, state, instances, slots, tool prefix and machine init are temporary, whatever the shell said', () => {
  for (const [k, v] of Object.entries(isolatedEnv)) {
    assert.equal(process.env[k], v, k);
    assert.ok(inside(v), `${k} is inside ${testMachine}`);
  }
  const derived: [string, string][] = [['stateDir()', stateDir()], ['instancesDir()', instancesDir()], ['slotsDir()', slotsDir()], ['toolPrefix()', toolPrefix()], ['machineInitDir()', machineInitDir()]];
  // macOS keeps the real HOME (test/isolate.ts homeMoved); everything above, derived from it, is still temporary.
  if (homeMoved) derived.push(['homedir()', homedir()], ["a child's HOME", childEnv().HOME!]);
  for (const [what, p] of derived) assert.ok(inside(p), `${what} is ${p}, outside ${testMachine}`);
  const leaked = Object.keys(process.env).filter((k) => k.startsWith(`${BRAND.envPrefix}_`) && !(k in isolatedEnv) && k !== `${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE` && k !== TEST_TOKEN_VAR);
  assert.deepEqual(leaked, [], 'no engine setting from the shell');
});

/** Every machine location the engine opens or runs, by name (src/os/system-paths.ts builds each). */
const machineLocations = (): [string, string][] => [
  ['MACHINE_OWNERS_FILE', MACHINE_OWNERS_FILE],
  ['NETWORK_FILE', NETWORK_FILE],
  ['PROVIDER_HOSTS_FILE', PROVIDER_HOSTS_FILE],
  ['UPDATES_CONFIG', UPDATES_CONFIG],
  ['UPDATES_LOG', UPDATES_LOG],
  ['ENGINE_CURRENT', ENGINE_CURRENT],
  ['LIMITS_PATH', LIMITS_PATH],
  ['WATCHDOG_CONFIG', WATCHDOG_CONFIG],
  ['MACHINE_HELPER', MACHINE_HELPER],
  ['MACHINE_CHANGES', MACHINE_CHANGES],
  ['HELPER_RULES', HELPER_RULES],
  ['CLAUDE_ACCOUNT_DIR', CLAUDE_ACCOUNT_DIR],
  ['TEST_RUN_BASE', TEST_RUN_BASE],
  ['TAILSCALE_DIR', TAILSCALE_DIR],
  ['TAILSCALE_SCRIPT', TAILSCALE_SCRIPT],
  ['SANDBOX_HELPER', SANDBOX_HELPER],
  ['CONSOLE_SHELL', CONSOLE_SHELL],
  ['FULL_RUN_LOCK', FULL_RUN_LOCK],
  ['SYSTEM_SLOTS.dir', SYSTEM_SLOTS.dir],
  ['SYSTEM_SLOTS.config', SYSTEM_SLOTS.config],
  ['UPDATE_DRAIN_FILE', UPDATE_DRAIN_FILE],
  ['ALLOWED_SIGNERS', ALLOWED_SIGNERS],
  ['PENDING_SIGNERS', PENDING_SIGNERS],
  ['machineInitDir()', machineInitDir()],
  ['devSlotsPath()', devSlotsPath()],
  ['gpuFilePath()', gpuFilePath()],
  ['gpuLockPath(0)', gpuLockPath(0)],
  ...Object.entries(MACHINE_PATHS)
    .filter(([k]) => k !== 'enginePackage')
    .map(([k, v]): [string, string] => [`MACHINE_PATHS.${k}`, v]),
];

test("in a test process, every machine location the engine reads or runs is inside the test's own root: /etc/<cli>, /var/lib/<cli>, the root helpers, /opt/<cli>, /run/lock", () => {
  const root = isolatedEnv[SYSTEM_ROOT_VAR]!;
  assert.ok(inside(root), `${SYSTEM_ROOT_VAR} is inside ${testMachine}`);
  const outside = machineLocations().filter(([k, p]) => !inside(p) || (k !== 'machineInitDir()' && relative(root, p).startsWith('..')));
  assert.deepEqual(outside, [], "under the preload, a test never reads or runs the machine's own");
  // Each is still the machine's path, one root down: what a real machine reads (the scripts check the same names).
  const real = machineLocations()
    .filter(([k]) => k !== 'machineInitDir()')
    .filter(([, p]) => !new RegExp(`^/(etc|var/lib|var/tmp|usr/local/libexec|opt|run/lock|run/${BRAND.cli})/`).test(onRealMachine(p)));
  assert.deepEqual(real, [], 'each is a machine path under the root');
  assert.equal(onRealMachine(MACHINE_OWNERS_FILE), `/etc/${BRAND.cli}/machine-owners.json`);
  assert.equal(onRealMachine(MACHINE_HELPER), `/usr/local/libexec/${BRAND.cli}-machine`);
  assert.equal(onRealMachine(UPDATES_LOG), `/var/lib/${BRAND.cli}/updates.jsonl`);
});

test("src/ names a machine location only in src/os/system-paths.ts: nothing can read the machine's own around the test root", () => {
  // A system root as code would spell it: /etc/<cli>, /var/lib/<cli>, /opt/<cli>, a root helper, /run/lock, a unit, /var/tmp.
  const machine = /\/(?:etc|var\/lib|opt)\/\$\{BRAND\.cli\}|\/usr\/local\/libexec|\/run\/lock\/|\/etc\/systemd\/|\/var\/tmp\/|['"`]\/(?:etc|var|run|opt)['"`]/;
  assert.ok(machine.test("`/etc/${BRAND.cli}/x.json`") && machine.test("join('/etc', BRAND.cli)") && machine.test("'/usr/local/libexec/helper'"), 'the check sees each spelling');
  const src = join(repoRoot, 'src');
  const bad: string[] = [];
  for (const f of walk(src).filter((x) => x.endsWith('.ts') && relative(src, x) !== join('os', 'system-paths.ts'))) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (!/^\s*(\/\/|\/?\*)/.test(l) && machine.test(l)) bad.push(`${relative(repoRoot, f)}:${i + 1}: ${l.trim()}`);
      });
  }
  assert.deepEqual(bad, [], 'build it with src/os/system-paths.ts (etcPath, varLibPath, libexecPath, ...), or asRoot for a command shown for a root shell');
});

/** A system root marked as the test preload marks one: a directory and mark file of this user's alone, and its token. */
function markedRoot(): { root: string; token: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'marked-root-'));
  chmodSync(root, 0o700);
  const token = randomBytes(32).toString('hex');
  writeFileSync(join(root, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
  return { root, token, env: { [SYSTEM_ROOT_VAR]: root, [TEST_TOKEN_VAR]: token } };
}

test(`${SYSTEM_ROOT_VAR} is honoured only in a process the test preload marked: never as root, never under systemd, never without the mark`, { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const uid = process.getuid!();
  const ok = markedRoot();
  assert.equal(systemRootRefusal({}, uid), null, 'unset: nothing to refuse');
  assert.equal(systemRootRefusal(ok.env, uid), null, 'the preload marked it');
  assert.equal(systemRootRefusal({ ...process.env }, uid), null, 'this test process is marked');
  const refused: [string, NodeJS.ProcessEnv, number, RegExp][] = [
    ['as root', ok.env, 0, /runs as root/],
    ['started by systemd (INVOCATION_ID)', { ...ok.env, INVOCATION_ID: 'a'.repeat(32) }, uid, /systemd started this process \(INVOCATION_ID/],
    ['started by systemd (JOURNAL_STREAM)', { ...ok.env, JOURNAL_STREAM: '8:12345' }, uid, /systemd started this process \(JOURNAL_STREAM/],
    ['no token (a drop-in or a sudo that sets the root alone)', { [SYSTEM_ROOT_VAR]: ok.root }, uid, /doesn't carry the test preload's token/],
    ['a token that is not the mark', { ...ok.env, [TEST_TOKEN_VAR]: 'b'.repeat(64) }, uid, /doesn't match its test mark/],
    ['a relative root', { ...ok.env, [SYSTEM_ROOT_VAR]: 'root' }, uid, /not an absolute path/],
  ];
  // A root with no mark at all (another machine's files dropped in a directory): refused.
  const bare = mkdtempSync(join(tmpdir(), 'bare-root-'));
  chmodSync(bare, 0o700);
  refused.push(['no mark', { [SYSTEM_ROOT_VAR]: bare, [TEST_TOKEN_VAR]: ok.token }, uid, /holds no test mark/]);
  // A mark others may read or write, or a root others may write: anyone else could have put it there.
  const open = markedRoot();
  chmodSync(join(open.root, TEST_MARK_FILE), 0o644);
  refused.push(['a mark others can read', open.env, uid, /test mark isn't this user's alone/]);
  const shared = markedRoot();
  chmodSync(shared.root, 0o777);
  refused.push(['a root others can write', shared.env, uid, /directory isn't this user's alone/]);
  // A symlinked mark: refused, not followed.
  const linked = markedRoot();
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'mark-')), 'mark');
  writeFileSync(elsewhere, `${linked.token}\n`, { mode: 0o600 });
  rmSync(join(linked.root, TEST_MARK_FILE));
  symlinkSync(elsewhere, join(linked.root, TEST_MARK_FILE));
  refused.push(['a symlinked mark', linked.env, uid, /test mark isn't this user's alone/]);
  for (const [what, env, u, re] of refused) {
    const why = systemRootRefusal(env, u);
    assert.match(why ?? '', re, what);
    assert.match(why ?? '', new RegExp(`^${SYSTEM_ROOT_VAR} is set`), `${what}: names the variable`);
  }
});

test('the service modes never run with the system root, marked or not; a command that ends does', () => {
  const env = { [SYSTEM_ROOT_VAR]: '/x' };
  for (const argv of [['coordinator', 'run'], ['coordinator', 'run', '--instance', 'shop'], ['--root', '/r', 'coordinator', 'run'], ['dashboard', '--instance', 'shop', '--service'], ['dashboard', '--service', '--instance', 'shop'], ['dashboard', '--hub', 'a=/s'], ['dashboard', '--hub-setup', '--public-url', 'https://h']]) {
    assert.match(serviceModeRefusal(argv, env) ?? '', new RegExp(`^${SYSTEM_ROOT_VAR} is set, and .* is a service mode`), argv.join(' '));
  }
  for (const argv of [['coordinator', 'run', '--once'], ['dashboard', '--detach'], ['dashboard', '--service', '--root', '/r', '--port', '0'], ['dashboard'], ['doctor'], ['--version']]) assert.equal(serviceModeRefusal(argv, env), null, argv.join(' '));
  assert.equal(serviceModeRefusal(['coordinator', 'run'], {}), null, 'unset: nothing to refuse');
});

test(`the CLI refuses ${SYSTEM_ROOT_VAR} where it isn't honoured: a non-zero exit naming it, before anything starts; marked, it runs`, { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const cli = join(repoRoot, 'dist', 'src', 'cli.js');
  const { dir } = exampleProject();
  const cliRun = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const ok = markedRoot();
  const base = { ...childEnv(), ...ok.env };
  const marked = cliRun(['--version'], base);
  assert.equal(marked.status, 0, `marked, as the preload marks a test's children: ${marked.stderr}`);
  const cases: [string, string[], NodeJS.ProcessEnv, RegExp][] = [
    ['no mark (a drop-in setting the root alone)', ['--version'], { ...childEnv(), [SYSTEM_ROOT_VAR]: ok.root, [TEST_TOKEN_VAR]: '' }, /doesn't carry the test preload's token/],
    ['started by systemd', ['--version'], { ...base, INVOCATION_ID: 'c'.repeat(32) }, /systemd started this process/],
    ['started by systemd (journal)', ['doctor', '--root', dir], { ...base, JOURNAL_STREAM: '8:1' }, /systemd started this process/],
    ['coordinator run', ['coordinator', 'run', '--root', dir], base, /`coordinator run` is a service mode/],
    ["an instance's dashboard", ['dashboard', '--instance', 'shop', '--service', '--port', '0'], base, /`dashboard --instance --service` is a service mode/],
    ['dashboard --hub', ['dashboard', '--hub', `a=${ok.root}`, '--port', '0', '--break-glass-port', '0'], base, /`dashboard --hub` is a service mode/],
    ['dashboard --hub-setup', ['dashboard', '--hub-setup', '--public-url', 'https://hub.example.test', '--signin-dir', ok.root, '--port', '0'], base, /`dashboard --hub-setup` is a service mode/],
  ];
  for (const [what, args, env, re] of cases) {
    const before = filesUnder(dir);
    const r = cliRun(args, env);
    assert.equal(r.status, 78, `${what}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`refused: ${SYSTEM_ROOT_VAR} is set`), what);
    assert.match(r.stderr, re, what);
    assert.equal(r.stdout, '', `${what}: nothing ran`);
    assert.deepEqual(filesUnder(dir), before, `${what}: nothing written`);
  }
  // Any other way in (the updater imports engine modules): the first machine path a module builds throws.
  const mod = pathToFileURL(join(repoRoot, 'dist', 'src', 'machine-owners.js')).href;
  const imported = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(mod)}).then(() => console.log('LOADED'), (e) => { console.log(e.name, e.message); process.exit(3); })`], { encoding: 'utf8', env: { ...childEnv(), [SYSTEM_ROOT_VAR]: ok.root, [TEST_TOKEN_VAR]: '' } });
  assert.equal(imported.status, 3, imported.stdout + imported.stderr);
  assert.match(imported.stdout, new RegExp(`^SystemRootRefused ${SYSTEM_ROOT_VAR} is set`));
  assert.doesNotMatch(imported.stdout, /LOADED/);
});

/** How a connection to `port` ends: its error code, or 'connected' (something answered), and how long it took. */
function connectOutcome(port: number): Promise<{ code: string; message: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((done) => {
    const c = netConnect(port, '127.0.0.1');
    c.once('connect', () => (c.destroy(), done({ code: 'connected', message: `connected from local port ${c.localPort}`, ms: Date.now() - t0 })));
    c.once('error', (e: NodeJS.ErrnoException) => done({ code: e.code ?? e.name, message: e.message, ms: Date.now() - t0 }));
  });
}

test("why the refused port isn't ephemeral: on Linux a connect whose source port is its destination connects to itself, with nothing listening", { skip: process.platform !== 'linux' && 'Linux TCP simultaneous open' }, async () => {
  // What a held ephemeral port risked on a busy machine: the kernel may give a connect() to it that same port as
  // its source (only the 4-tuple must be unique), and the connect then "succeeds" against itself.
  let got = '';
  for (let i = 0; i < 20 && !got; i++) {
    const port = 10_000 + randomInt(ephemeralStart() - 10_000);
    got = await new Promise<string>((done) => {
      const c = netConnect({ port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort: port });
      c.once('connect', () => (c.destroy(), done('connected to itself')));
      c.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'EADDRINUSE' ? '' : `error ${e.code}`));
    });
  }
  assert.equal(got, 'connected to itself');
});

test('the ephemeral range start: Linux reads ip_local_port_range; anything unreadable is the kernel default', () => {
  if (process.platform === 'linux') {
    assert.equal(ephemeralStart(() => '32768\t60999\n'), 32_768);
    assert.equal(ephemeralStart(() => '40000 60999'), 40_000);
    assert.equal(ephemeralStart(() => 'garbage'), 32_768);
    assert.equal(ephemeralStart(() => {
      throw new Error('EACCES');
    }), 32_768);
  } else assert.equal(ephemeralStart(), 49_152);
});

test('a refused port is held: a connection there is refused at once, every time, and the OS hands it to no listen(0) or connect() until it is closed', async () => {
  const p = await refusedPort();
  const other = createServer();
  const others: Server[] = [];
  try {
    // Never in the range the OS gives connect() its source ports from, so no connect there can connect to itself.
    assert.ok(p.port < ephemeralStart(), `${p.port} is below the ephemeral range (${ephemeralStart()})`);
    const t0 = Date.now();
    const err = await fetch(p.url).then(
      (r) => ({ code: `answered ${r.status}`, message: '' }),
      (e: Error & { cause?: { code?: string; message?: string } }) => ({ code: e.cause?.code ?? `no code (${e.message})`, message: e.cause?.message ?? '' }),
    );
    assert.equal(err.code, 'ECONNREFUSED', `fetch: ${err.code}: ${err.message}`);
    assert.ok(Date.now() - t0 < 2_000, `refused at once, not after ${Date.now() - t0} ms`);
    // Many connects in a row, as a busy machine makes them: each refused, none answered, each fast.
    const outcomes = await Promise.all(Array.from({ length: 200 }, () => connectOutcome(p.port)));
    const odd = outcomes.filter((x) => x.code !== 'ECONNREFUSED' || x.ms > 2_000);
    assert.deepEqual(odd, [], 'every connect refused, at once');
    // What took the old port: a listen(0) handed it (the stand-in's own, or another process's). Below the range, no
    // listen(0) is: 300 of them, all held at once, none get it. (A program that listens on this exact port on purpose
    // could; the old one, held ephemeral, could be both handed out and connected to itself.)
    const handed = await Promise.all(
      Array.from(
        { length: 300 },
        () =>
          new Promise<Server>((ok) => {
            const s = createServer();
            s.listen(0, '127.0.0.1', () => ok(s));
          }),
      ),
    );
    others.push(...handed);
    assert.deepEqual(handed.map((s) => (s.address() as { port: number }).port).filter((x) => x === p.port), [], 'no listen(0) is handed the held port');
  } finally {
    await Promise.all([other, ...others].map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
    await p.close();
  }
});

/** Hold each port as a live dashboard would (401 to a token not its own); one already taken is taken already. */
async function holdPorts(ports: number[]): Promise<Server[]> {
  return Promise.all(
    ports.map(
      (p) =>
        new Promise<Server>((ok) => {
          const s = createServer((_q, r) => {
            r.writeHead(401, { 'content-type': 'application/json' });
            r.end('{"error":"a live dashboard"}');
          });
          s.once('error', () => ok(s));
          s.listen(p, '127.0.0.1', () => ok(s));
        }),
    ),
  );
}

const filesUnder = (d: string): string[] => walk(d).map((f) => relative(d, f).split(sep).join('/')).sort();

test(
  "regression (#312): with a live machine's environment, its own /etc, /var/lib and root helpers, and its dashboard ports taken, the tests that failed on one give the same results and write nothing of the machine's",
  { timeout: 300_000 },
  async () => {
    // The machine: the owner's home and state dir, its slot directory with an emergency stop in force, and the
    // engine settings a coordinator's shell has.
    const live = mkdtempSync(join(tmpdir(), 'live-machine-'));
    const dirs = { home: join(live, 'home'), state: join(live, 'state'), slots: join(live, 'agent-slots') };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(join(dirs.slots, 'STOP'), JSON.stringify({ by: 'owner', at: new Date().toISOString(), reason: 'the live machine is stopped' }));
    writeFileSync(join(dirs.slots, 'config.json'), JSON.stringify({ max_agents: 1 }));
    // Its own machine locations, as a live server has them (src/os/system-paths.ts), under a root of its own: another
    // machine owner, the root helper, an outbound proxy, engine updates on with a log naming another project's items,
    // a change log, a slot cap, a hub unit. On the release machine a test read these and failed (#312): the machine
    // view carried that machine's owners, helper and update log.
    const sys = join(live, 'system');
    const put = (p: string, text: string, mode = 0o644) => {
      mkdirSync(join(sys, p, '..'), { recursive: true });
      writeFileSync(join(sys, p), text, { mode });
    };
    const cli = BRAND.cli;
    put(`etc/${cli}/machine-owners.json`, JSON.stringify({ owners: ['live-owner'] }));
    put(`etc/${cli}/network.json`, JSON.stringify({ proxy: 'http://127.0.0.1:9', no_proxy: 'localhost' }));
    put(`etc/${cli}/updates.json`, JSON.stringify({ enabled: true, channel: 'main', branch: 'main', required_checks: ['live-check'] }));
    put(`etc/${cli}/slots.json`, JSON.stringify({ max_agents: 1 }));
    put(`etc/${cli}/watchdog.json`, JSON.stringify({ stall_hours: 1 }));
    put(`etc/${cli}/allowed_signers`, 'live@example.com ssh-ed25519 AAAA\n');
    put(`etc/systemd/system/${cli}-dashboard-hub.service`, '[Service]\n');
    put(`var/lib/${cli}/updates.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), event: 'waiting', to: String(MARKS.b.issue), reason: `beta-proj #${MARKS.b.issue} wl-beta@host tr-beta-1 Beta-only` })}\n`);
    put(`var/lib/${cli}/machine-changes.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), by: 'wl-beta@host', what: 'slots.max_agents', from: MARKS.b.issue, to: MARKS.b.pr })}\n`);
    put(`usr/local/libexec/${cli}-machine`, `#!/bin/sh\necho ran >> "${join(live, 'helper-ran')}"\n`, 0o755);
    const before = filesUnder(live);
    const env: NodeJS.ProcessEnv = {
      ...childEnv(),
      HOME: dirs.home,
      XDG_CONFIG_HOME: join(dirs.home, '.config'),
      XDG_STATE_HOME: join(dirs.home, '.local', 'state'),
      AGENT_SLOTS_DIR: dirs.slots,
      [`${BRAND.envPrefix}_STATE_DIR`]: dirs.state,
      [`${BRAND.envPrefix}_INSTANCE`]: 'shop',
      [`${BRAND.envPrefix}_USER`]: 'live-owner',
      [`${BRAND.envPrefix}_ROLE`]: 'coordinator',
      // What the engine takes as the machine's own root: the live one above, unless the isolation moves it.
      [SYSTEM_ROOT_VAR]: sys,
    };
    // Its fixed ports: a checkout's dashboard, the hub's two, every instance's.
    const servers = await holdPorts([LOCAL_DASHBOARD_PORT, HUB_PORT, HUB_BREAK_GLASS_PORT, ...Array.from({ length: 500 }, (_, i) => 4400 + i)]);
    try {
      const files = ['dashboard-hub', 'push-hook-guard', 'frozen-guard', 'dashboard-auth', 'dashboard-detach', 'watchdog', 'bootstrap'].map((n) => join(repoRoot, 'dist', 'test', `${n}.test.js`));
      // As npm test and CI run them: with the preload.
      const { code, out } = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', ...files], env);
      const failed = out.split('\n').filter((l) => /^\s*not ok\b/.test(l));
      assert.equal(code, 0, `${failed.join('\n')}\n${out.slice(-4000)}`);
      assert.match(out, /^# fail 0$/m);
      assert.match(out, /^# pass [1-9]\d*$/m);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
    }
    assert.deepEqual(filesUnder(live), before, "nothing written to the machine's home, state, slots or system files, and its helper never ran");
  },
);
