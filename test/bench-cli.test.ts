// The bench command and its preflight (#748, slice 1): `node dist/scripts/bench/cli.js preflight` runs the bench's
// model-free checks as the bench user and prints a PASS/FAIL/SKIP line per check, with no secret in it. Stand-ins
// only: a recording claude and srt in a temp folder, a docker stand-in function, a temp home. Nothing here reaches a
// real login, daemon, sandbox or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV, requireBenchUser } from '../scripts/bench/auth.js';
import { benchLayout } from '../scripts/bench/paths.js';
import { LIMIT_ENV, type DockerCall } from '../scripts/bench/container.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so the root test below still runs on code from before cli.ts (the
// fail-without run).
const cli = () => import('../scripts/bench/cli.js');

/** Canaries: none of these may ever be printed. */
const CANARY = {
  apiKey: 'sk-ant-api03-CANARYKEY0123456789abcdef',
  token: 'CANARY_TOKEN_VALUE_5f3c9e',
  email: 'canary.person@example.com',
  org: 'Canary Org Name 77',
  oauth: 'sk-ant-oat01-CANARYOAUTH0123456789',
};

interface Machine {
  base: string;
  home: string;
  claude: string;
  srt: string;
  env: NodeJS.ProcessEnv;
  docker: { args: string[] }[];
  dockerCall: DockerCall;
  /** Every call the claude stand-in recorded: its argv. */
  claudeCalls: () => string[][];
  /** Every call the srt stand-in recorded: its argv. */
  srtCalls: () => string[][];
}

interface MachineOptions {
  version?: string;
  auth?: object;
  srtVersion?: string;
  rootless?: boolean;
  dockerStderr?: string;
  dockerFails?: boolean;
}

/** A recording stand-in at `bin` that runs `body` (node) after logging its argv to `log`. */
function standIn(bin: string, log: string, body: string[]): void {
  writeFileSync(bin, [`#!${process.execPath}`, "const fs = require('node:fs');", 'const args = process.argv.slice(2);', `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');`, ...body].join('\n') + '\n');
  chmodSync(bin, 0o755);
}

const readLog = (log: string): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

/** A set-up bench machine: the bench user's home, a claude.ai login, srt 0.0.79 that honors the lane, a rootless daemon. */
function machine(o: MachineOptions = {}): Machine {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-cli-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(base, 'bin'));
  const runtime = join(base, 'run-user');
  mkdirSync(runtime);
  const claude = join(base, 'bin', 'claude');
  const claudeLog = join(base, 'claude.log');
  const auth = o.auth ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', configDirectory: join(home, '.claude'), email: CANARY.email, orgId: 'org-canary', orgName: CANARY.org, subscriptionType: 'enterprise' };
  standIn(claude, claudeLog, [
    `if (args[0] === '--version') { console.log(${JSON.stringify(`${o.version ?? '2.1.303'} (Claude Code)`)}); process.exit(0); }`,
    `if (args[0] === 'auth') { console.log(${JSON.stringify(JSON.stringify(auth))}); process.exit(0); }`,
    // Anything else would be a model call: the preflight never makes one.
    "console.error('the stand-in claude was asked for a session'); process.exit(9);",
  ]);
  const srt = join(base, 'bin', 'srt');
  const srtLog = join(base, 'srt.log');
  standIn(srt, srtLog, [
    `if (args[0] === '--version') { console.log(${JSON.stringify(o.srtVersion ?? '0.0.79')}); process.exit(0); }`,
    "const cfg = JSON.parse(fs.readFileSync(args[1], 'utf8'));",
    "const denied = (p) => cfg.filesystem.denyRead.some((d) => p === d || p.startsWith(d + '/'));",
    // The lane honored: a denied read sees the /dev/null mask, a denied socket refuses; nothing is run.
    "console.log(JSON.stringify(JSON.parse(args.at(-1)).map((x) => denied(x.target) ? (x.kind === 'read' ? 'opened char-device' : 'ECONNREFUSED') : x.kind === 'read' ? 'opened file' : 'connected')));",
  ]);
  const docker: { args: string[] }[] = [];
  const dockerCall: DockerCall = (_bin, args) => {
    docker.push({ args: [...args] });
    if (o.dockerFails) return { status: 1, stdout: '', stderr: o.dockerStderr ?? 'Cannot connect to the Docker daemon' };
    if (args[0] === 'info') return { status: 0, stdout: JSON.stringify(['name=seccomp,profile=builtin', ...(o.rootless === false ? [] : ['name=rootless']), 'name=cgroupns']), stderr: '' };
    return { status: 1, stdout: '', stderr: 'the stand-in docker takes only info' };
  };
  // Nothing of this machine's own that could switch the login (the check would refuse it).
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|AWS_|AZURE_|GOOGLE_|CLOUD_ML_|DOCKER_)|_FILE_DESCRIPTOR$|_BASE_URL$|BEDROCK|VERTEX|FOUNDRY|MANTLE/i.test(k))),
    HOME: home,
    XDG_RUNTIME_DIR: runtime,
    DOCKER_HOST: `unix://${runtime}/docker.sock`,
    [BENCH_USER_ENV]: currentUser(),
  };
  return { base, home, claude, srt, env, docker, dockerCall, claudeCalls: () => readLog(claudeLog), srtCalls: () => readLog(srtLog) };
}

const HOST = { cpus: 16, memoryBytes: 64 * 1024 ** 3 };

/** The preflight on `m`, as the bench user; what it printed and its exit code. */
async function run(m: Machine, over: Record<string, unknown> = {}, argv = ['preflight']) {
  const { main } = await cli();
  const out: string[] = [];
  const code = main(argv, { env: m.env, user: currentUser(), uid: process.getuid?.() ?? 1000, passwdHome: () => m.home, claude: m.claude, srt: m.srt, docker: { docker: 'docker', call: m.dockerCall }, host: HOST, out: (l: string) => out.push(l), ...over });
  return { code, out, text: out.join('\n') };
}

/** The status the preflight printed for the check named `name`. */
const statusOf = (text: string, name: string): string | undefined => new RegExp(`^\\s*(PASS|FAIL|SKIP)\\s+${name.replace(/[()]/g, '\\$&')}\\b`, 'm').exec(text)?.[1];

const CHECKS = ['bench user', 'home', 'bench root', 'held-out store', 'research-on-demand', 'claude pin', 'claude login', 'sandbox probe', 'docker', 'container limits'];

test('bench preflight: every check passes on a set-up bench machine, with no model call, no container and no write', linux, async () => {
  const m = machine();
  const r = await run(m);
  assert.equal(r.code, 0, r.text);
  for (const c of CHECKS) assert.equal(statusOf(r.text, c), 'PASS', `${c}\n${r.text}`);
  assert.deepEqual(m.claudeCalls().map((a) => a[0]), ['--version', 'auth'], 'claude: the pin and the login status, nothing else');
  assert.deepEqual(m.docker.map((d) => d.args[0]), ['info'], 'docker: info only, no container');
  assert.equal(m.srtCalls().length, 2, 'srt: its version, then the probe');
  assert.match(r.text, /\$40 per smoke round/);
  assert.match(r.text, /\$15 per task/);
  assert.match(r.text, /over \$8 per task.*owner/);
  assert.match(r.text, /sandbox confirmation.*first model call/, 'it says what it leaves to the run');
  assert.ok(!existsSync(join(m.home, 'bench')), 'nothing written: no bench root made');
  assert.match(r.text, /plan enterprise/, 'the plan is shown');
});

test('bench preflight: as any other user nothing else runs, not even the login status', linux, async () => {
  const m = machine();
  const r = await run(m, { user: 'someone-else' });
  assert.equal(r.code, 1);
  assert.equal(statusOf(r.text, 'bench user'), 'FAIL', r.text);
  for (const c of CHECKS.slice(1)) assert.equal(statusOf(r.text, c), 'SKIP', `${c}\n${r.text}`);
  assert.equal(m.claudeCalls().length, 0, 'claude never asked');
  assert.equal(m.srtCalls().length, 0, 'srt never run');
  assert.equal(m.docker.length, 0, 'docker never asked');
});

test('the bench never runs as root, even when the bench user variable names root', async () => {
  assert.throws(() => requireBenchUser({ [BENCH_USER_ENV]: 'root' }, 'root', 0), /never runs as root/);
  assert.throws(() => requireBenchUser({ [BENCH_USER_ENV]: 'toor' }, 'toor', 0), /never runs as root/, 'uid 0 under another name');
  assert.throws(() => requireBenchUser({ [BENCH_USER_ENV]: 'root' }, 'root', 1001), /never runs as root/, 'the name root');
  assert.equal(requireBenchUser({ [BENCH_USER_ENV]: 'bench-two' }, 'bench-two', 1001), 'bench-two');
  assert.equal(requireBenchUser({}, 'wl-bench', 1001), 'wl-bench');
});

test('bench preflight: as root nothing runs', linux, async () => {
  const m = machine();
  const r = await run(m, { user: 'root', uid: 0, env: { ...m.env, [BENCH_USER_ENV]: 'root' } });
  assert.equal(r.code, 1);
  assert.equal(statusOf(r.text, 'bench user'), 'FAIL', r.text);
  assert.match(r.text, /never runs as root/);
  assert.equal(m.claudeCalls().length + m.srtCalls().length + m.docker.length, 0, 'nothing ran');
});

test("bench preflight: a HOME that isn't the user database's stops everything after it", linux, async () => {
  const m = machine();
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'other-home-')));
  const r = await run(m, { passwdHome: () => other });
  assert.equal(r.code, 1);
  assert.equal(statusOf(r.text, 'bench user'), 'PASS', r.text);
  assert.equal(statusOf(r.text, 'home'), 'FAIL', r.text);
  for (const c of CHECKS.slice(2)) assert.equal(statusOf(r.text, c), 'SKIP', `${c}\n${r.text}`);
  assert.equal(m.claudeCalls().length + m.srtCalls().length + m.docker.length, 0, 'nothing ran');
});

test('bench preflight: each failing check is its own FAIL line, and the rest still run; still no container or model call', linux, async () => {
  const m = machine({ version: '2.1.302', auth: { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, srtVersion: '0.0.80', rootless: false });
  const r = await run(m, { env: { ...m.env, [LIMIT_ENV.cpus]: '64' } });
  assert.equal(r.code, 1);
  for (const [c, why] of [['claude pin', /2\.1\.302, not the pinned 2\.1\.303/], ['claude login', /not a claude\.ai login/], ['sandbox probe', /0\.0\.80, not 0\.0\.79/], ['docker', /not rootless/], ['container limits', /over this machine's 16 CPUs/]] as const) {
    assert.equal(statusOf(r.text, c), 'FAIL', `${c}\n${r.text}`);
    assert.match(r.text, why, c);
  }
  for (const c of ['bench user', 'home', 'bench root', 'held-out store', 'research-on-demand']) assert.equal(statusOf(r.text, c), 'PASS', c);
  assert.ok(m.claudeCalls().every((a) => a[0] === '--version' || a[0] === 'auth'), 'no session');
  assert.deepEqual(m.docker.map((d) => d.args[0]), ['info']);
  assert.match(r.text, /5 of 10 checks failed$/m);
  // A docker context could name a socket the lane doesn't deny: refused before docker is asked.
  const ctx = machine();
  const c = await run(ctx, { env: { ...ctx.env, DOCKER_CONTEXT: 'elsewhere' } });
  assert.equal(statusOf(c.text, 'docker'), 'FAIL', c.text);
  assert.match(c.text, /DOCKER_CONTEXT elsewhere refused/);
  assert.equal(ctx.docker.length, 0, 'docker never asked');
});

test('bench preflight: the held-out store must be a 0700 folder of this user, not a link', linux, async () => {
  const m = machine();
  const held = benchLayout(join(m.home, 'bench')).heldOut;
  assert.equal(statusOf((await run(m)).text, 'held-out store'), 'PASS', 'not made yet: the download makes it 0700');
  mkdirSync(held, { recursive: true, mode: 0o700 });
  chmodSync(held, 0o700);
  assert.equal(statusOf((await run(m)).text, 'held-out store'), 'PASS', '0700');
  chmodSync(held, 0o750);
  const open = await run(m);
  assert.equal(statusOf(open.text, 'held-out store'), 'FAIL', open.text);
  assert.match(open.text, /0750.*0700/);
  assert.equal(open.code, 1);
  const linked = machine();
  const lheld = benchLayout(join(linked.home, 'bench')).heldOut;
  const elsewhere = join(linked.base, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  mkdirSync(join(lheld, '..'), { recursive: true });
  symlinkSync(elsewhere, lheld);
  const l = await run(linked);
  assert.equal(statusOf(l.text, 'held-out store'), 'FAIL', l.text);
  assert.match(l.text, /link/);
});

test('bench preflight: no secret is ever printed: no variable value, no token, no account detail, no control character', linux, async () => {
  // A login switch set to a key (refused, by name only), a token variable, and a CLI whose answers carry an account's
  // email and organisation, and a token where its auth method should be.
  const m = machine({ auth: { loggedIn: true, authMethod: CANARY.oauth, apiProvider: 'firstParty', email: CANARY.email, orgName: CANARY.org }, dockerFails: true, dockerStderr: `\u001b[31mdenied for ${CANARY.token} ${CANARY.apiKey}\u001b[0m\u0007` });
  const r = await run(m, { env: { ...m.env, ANTHROPIC_API_KEY: CANARY.apiKey, SOME_SERVICE_TOKEN: CANARY.token } });
  assert.equal(r.code, 1);
  assert.match(r.text, /ANTHROPIC_API_KEY/, 'the variable is named');
  for (const [what, v] of Object.entries(CANARY)) assert.ok(!r.text.includes(v), `${what} printed:\n${r.text}`);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.text), 'no control character');
  // With the key gone, the login check asks claude, whose answer carries a token-shaped method and account details.
  const k = await run(m, { env: { ...m.env, SOME_SERVICE_TOKEN: CANARY.token } });
  assert.equal(statusOf(k.text, 'claude login'), 'FAIL', k.text);
  for (const [what, v] of Object.entries(CANARY)) assert.ok(!k.text.includes(v), `${what} printed:\n${k.text}`);
  // On a passing login, only the method and the plan.
  const ok = await run(machine());
  for (const v of [CANARY.email, CANARY.org, 'org-canary']) assert.ok(!ok.text.includes(v), `${v} printed`);
});

test('the bench command: help, an unknown command, and the compiled script refusing another user before any tool runs', linux, async () => {
  const { main } = await cli();
  const out: string[] = [];
  assert.equal(main(['help'], { out: (l: string) => out.push(l) }), 0);
  assert.match(out.join('\n'), /preflight/);
  const bad: string[] = [];
  assert.equal(main(['launch-everything'], { out: (l: string) => bad.push(l) }), 2);
  assert.match(bad.join('\n'), /unknown command/);
  assert.equal(main([], { out: () => {} }), 2, 'no command: usage');
  if (currentUser() === 'wl-bench') return;
  // The real script, as a process: PATH holds only recording stand-ins (exit 1) for every tool it could call.
  const m = machine();
  const fake = join(m.base, 'fake-bin');
  mkdirSync(fake);
  const log = join(m.base, 'tools.log');
  for (const tool of ['claude', 'srt', 'docker', 'sudo', 'id', 'systemctl', 'git']) standIn(join(fake, tool), log, ['process.exit(1);']);
  const script = fileURLToPath(new URL('../scripts/bench/cli.js', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...m.env, PATH: fake };
  delete env[BENCH_USER_ENV];
  const r = spawnSync(process.execPath, [script, 'preflight'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL\s+bench user.*runs as wl-bench only/);
  assert.equal(readLog(log).length, 0, 'no tool ran');
});
