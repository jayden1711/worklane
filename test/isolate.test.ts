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
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { HUB_BREAK_GLASS_PORT, HUB_PORT } from '../src/dashboard-hub.js';
import { LOCAL_DASHBOARD_PORT } from '../src/dashboard.js';
import { machineInitDir } from '../src/init.js';
import { instancesDir } from '../src/instance.js';
import { childEnv, slotsDir, stateDir } from '../src/os/index.js';
import { slotFile, slotFileExists, type SlotPath } from '../src/slot-file.js';

/**
 * Whether slot path `p` names the directory `dir`: a marker made in `dir` with plain fs (a random name, so nothing
 * stale answers) is seen through `p`, read-only. A slot path has no identity or text to compare (#772, #806 round 6).
 * Nothing is written through `p`: if it pointed somewhere else (the machine's own slot dir, say), this writes nothing
 * there (rule A, #806 round 7).
 */
function names(p: SlotPath, dir: string): boolean {
  const marker = `.names-${randomBytes(6).toString('hex')}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, marker), '');
  try {
    return slotFileExists(slotFile(p, marker));
  } finally {
    rmSync(join(dir, marker), { force: true });
  }
}
import { toolPrefix } from '../src/tool-path.js';
import { CLAUDE_ACCOUNT_DIR } from '../src/claude-account.js';
import { TEST_RUN_BASE } from '../src/disk-guard.js';
import { HELPER_RULES, MACHINE_CHANGES, MACHINE_HELPER } from '../src/machine.js';
import { MACHINE_OWNERS_FILE } from '../src/machine-owners.js';
import { NETWORK_FILE } from '../src/network.js';
import { PROVIDER_HOSTS_FILE } from '../src/provider-hosts.js';
import { SYSTEM_SLOTS, UPDATE_DRAIN_FILE } from '../src/os/index.js';
import { gpuFilePath, gpuLockPath } from '../src/testrun/gpu.js';
import { devSlotsPath, markTestRun, serviceModeRefusal, SYSTEM_ROOT_VAR, systemRootRefusal, TEST_MACHINE_VAR, TEST_MARK_FILE, TEST_RUN_VAR, testRunSign, testSlotsRefusal, TestSlotsRefused, TEST_TOKEN_VAR } from '../src/os/system-paths.js';
import { budgetFor, GitHubBudget } from '../src/github/budget.js';
import { emergencyStop, stopAll } from '../src/slots.js';
import { LIMITS_PATH } from '../src/settings.js';
import { MACHINE_PATHS } from '../src/setup-steps.js';
import { TAILSCALE_DIR, TAILSCALE_SCRIPT } from '../src/tailscale-setup.js';
import { SANDBOX_HELPER } from '../src/testrun/host.js';
import { FULL_RUN_LOCK } from '../src/testrun/run.js';
import { CONSOLE_SHELL } from '../src/console/owner-terminal-removed.js';
import { ALLOWED_SIGNERS, PENDING_SIGNERS } from '../src/updater-setup.js';
import { ENGINE_CURRENT, UPDATES_CONFIG, UPDATES_LOG } from '../src/updates.js';
import { WATCHDOG_CONFIG } from '../src/watchdog/config.js';
import { ephemeralStart, refusedPort } from './held-port.js';
import { exampleProject, MARKS, repoRoot } from './helpers.js';
import { homeMoved, isolatedEnv, onRealMachine, restoreIsolated, TEST_PRELOAD, testMachine } from './isolate.js';

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

/** The shell of a machine that runs the engine, as a test file sees it without the preload: none of the test machine. */
function unisolatedEnv(live: { home: string; slots: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...childEnv(), HOME: live.home, AGENT_SLOTS_DIR: live.slots };
  for (const k of Object.keys(env)) if (k.startsWith(`${BRAND.envPrefix}_`)) delete env[k];
  return env;
}

test("regression (#669): a test that makes a GitHub call without the isolation fails before it touches any slot directory: the machine's budget stays as it was", async () => {
  // Stand-ins for the machine's own home and slot directory, so the check below can see what the test wrote there.
  const live = { home: mkdtempSync(join(tmpdir(), 'live-home-')), slots: mkdtempSync(join(tmpdir(), 'live-slots-')) };
  const github = pathToFileURL(join(repoRoot, 'dist', 'src', 'backlog', 'github.js')).href;
  const issue = JSON.stringify({ number: 1, title: 't', body: '', labels: [], state: 'open', html_url: 'https://example.invalid/1' });
  const file = fixtureTest(
    'github-call.test.js',
    [
      "import { test } from 'node:test';",
      `import { GitHubBacklog } from ${JSON.stringify(github)};`,
      `const fake = async () => new Response(${JSON.stringify(issue)}, { status: 200, headers: { 'content-type': 'application/json' } });`,
      "test('a GitHub call', async () => { await new GitHubBacklog('o/r', () => 'tok', fake).get(1); console.log('GITHUB CALL MADE'); });",
    ].join('\n'),
  );
  const bare = await runTests(['--test', '--test-reporter=tap', file], unisolatedEnv(live));
  assert.deepEqual(readdirSync(live.slots), [], `nothing written to the machine's slot directory:\n${bare.out}`);
  assert.deepEqual(readdirSync(live.home), [], `nor its home:\n${bare.out}`);
  assert.notEqual(bare.code, 0, bare.out);
  assert.match(bare.out, /isn't the test machine's/);
  assert.doesNotMatch(bare.out, /GITHUB CALL MADE/);
  // Preloaded, the same file runs, on the test machine's own slot directory.
  const preloaded = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', file], unisolatedEnv(live));
  assert.equal(preloaded.code, 0, preloaded.out);
  assert.match(preloaded.out, /GITHUB CALL MADE/);
  assert.deepEqual(readdirSync(live.slots), []);
});

test('regression (#669): a test that stops every agent without the isolation fails before it writes STOP into the machine\'s slot directory', async () => {
  const live = { home: mkdtempSync(join(tmpdir(), 'live-home-')), slots: mkdtempSync(join(tmpdir(), 'live-slots-')) };
  const slots = pathToFileURL(join(repoRoot, 'dist', 'src', 'slots.js')).href;
  const file = fixtureTest('stop-all.test.js', ["import { test } from 'node:test';", `import { stopAll } from ${JSON.stringify(slots)};`, "test('stop all', () => { stopAll('t', 'a test'); console.log('STOP WRITTEN'); });"].join('\n'));
  const bare = await runTests(['--test', '--test-reporter=tap', file], unisolatedEnv(live));
  assert.deepEqual(readdirSync(live.slots), [], `no STOP in the machine's slot directory:\n${bare.out}`);
  assert.notEqual(bare.code, 0, bare.out);
  assert.match(bare.out, /TestSlotsRefused/);
  assert.match(bare.out, /isn't the test machine's/);
  assert.doesNotMatch(bare.out, /STOP WRITTEN/);
});

test('regression (#669): a process an unisolated test starts, with its environment or the engine\'s childEnv(), is a test run too: it never reaches the machine\'s slot directory', async () => {
  const live = { home: mkdtempSync(join(tmpdir(), 'live-home-')), slots: mkdtempSync(join(tmpdir(), 'live-slots-')) };
  const dist = (p: string) => JSON.stringify(pathToFileURL(join(repoRoot, 'dist', 'src', p)).href);
  const file = fixtureTest(
    'starts-engine.test.js',
    [
      "import { test } from 'node:test';",
      "import { spawnSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `import { childEnv } from ${dist('os/index.js')};`,
      // An engine-shaped child: not a test file, not started by node's runner; it stops every agent.
      "const child = new URL('./engine.mjs', import.meta.url).pathname;",
      `writeFileSync(child, ${JSON.stringify(`import { stopAll } from ${dist('slots.js')}; stopAll('t', 'a child'); console.log('STOP WRITTEN');`)});`,
      "test('start the engine', () => {",
      "  for (const [how, env] of [['childEnv', childEnv()], ['inherited', undefined]]) {",
      "    const r = spawnSync(process.execPath, [child], { env, encoding: 'utf8' });",
      '    console.log(`CHILD ${how} status=${r.status}`, r.stdout, r.stderr);',
      '  }',
      '});',
    ].join('\n'),
  );
  // node --test: the file's process has NODE_TEST_CONTEXT (childEnv drops it); run directly, no child inherits a sign.
  for (const args of [['--test', '--test-reporter=tap', file], [file]]) {
    const r = await runTests(args, unisolatedEnv(live));
    assert.deepEqual(readdirSync(live.slots), [], `no STOP in the machine's slot directory (${args.join(' ')}):\n${r.out}`);
    for (const how of ['childEnv', 'inherited']) assert.match(r.out, new RegExp(`CHILD ${how} status=1`), r.out);
    assert.match(r.out, new RegExp(`TestSlotsRefused: this is a test run \\(${TEST_RUN_VAR} is set\\)`), r.out);
    assert.doesNotMatch(r.out, /STOP WRITTEN/);
  }
});

test('the engine started outside a test run is never one: no sign, no mark on what it starts, its slot directory as given (#669)', () => {
  const live = { home: mkdtempSync(join(tmpdir(), 'live-home-')), slots: mkdtempSync(join(tmpdir(), 'live-slots-')) };
  // A service's environment: built from scratch, nothing of a test run in it (as `up` writes one).
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: live.home, AGENT_SLOTS_DIR: live.slots };
  const dist = (p: string) => JSON.stringify(pathToFileURL(join(repoRoot, 'dist', 'src', p)).href);
  // slotsDir() is a slot path (#772) with no identity or text to compare. A marker made here in the expected dir, under a
  // random name, is looked for through it, read-only: the child (outside a test run, with nothing to refuse it) writes
  // nothing where its slotsDir() points (rule A, #806 round 7).
  const marker = `.where-${randomBytes(6).toString('hex')}`;
  writeFileSync(join(live.slots, marker), '');
  const probe = fixtureTest(
    'engine.mjs',
    [
      `import { childEnv, slotsDir } from ${dist('os/index.js')};`,
      `import { slotFile, slotFileExists } from ${dist('slot-file.js')};`,
      `import { testRunSign, TEST_RUN_VAR } from ${dist('os/system-paths.js')};`,
      `console.log(JSON.stringify({ sign: testRunSign(), own: process.env[TEST_RUN_VAR] ?? null, child: childEnv()[TEST_RUN_VAR] ?? null, slots: slotFileExists(slotFile(slotsDir(), ${JSON.stringify(marker)})) ? ${JSON.stringify(live.slots)} : 'another' }));`,
    ].join('\n'),
  );
  const r = spawnSync(process.execPath, [probe], { cwd: live.home, env, encoding: 'utf8' });
  rmSync(join(live.slots, marker), { force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { sign: null, own: null, child: null, slots: live.slots });
  // The CLI itself, on a command that reads the slot directory.
  const cli = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), 'slots'], { cwd: live.home, env, encoding: 'utf8' });
  assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
  assert.match(cli.stdout, /agents running on this machine: 0 of \d+/);
  assert.doesNotMatch(cli.stderr, /TestSlotsRefused/);
});

test("in a test process every slot-directory default is the test machine's slot directory, and nothing outside it (#669)", () => {
  assert.equal(process.env[TEST_MACHINE_VAR], testMachine);
  // The slot dir is a slot path (#772): a marker made in the expected dir is seen through it, read-only (`names`).
  assert.ok(names(slotsDir(), isolatedEnv.AGENT_SLOTS_DIR!), 'slotsDir() is the isolated AGENT_SLOTS_DIR');
  assert.ok(names(budgetFor('tok').dir as SlotPath, isolatedEnv.AGENT_SLOTS_DIR!), "budgetFor's dir is it");
  assert.ok(names(new GitHubBudget('0123456789abcdef').dir as SlotPath, isolatedEnv.AGENT_SLOTS_DIR!), "GitHubBudget's default dir is it");
  assert.equal(emergencyStop(), null);
  const elsewhere = join(dirname(testMachine), `not-the-test-machine-${randomBytes(4).toString('hex')}`);
  try {
    process.env.AGENT_SLOTS_DIR = elsewhere;
    assert.throws(() => slotsDir(), (e: Error) => e instanceof TestSlotsRefused && e.message.includes(`${elsewhere} is outside ${testMachine}`));
    assert.throws(() => stopAll('t', 'a test'), TestSlotsRefused);
    assert.throws(() => emergencyStop(), TestSlotsRefused);
    assert.throws(() => budgetFor('tok'), TestSlotsRefused);
    assert.throws(() => new GitHubBudget('0123456789abcdef'), TestSlotsRefused);
    process.env.AGENT_SLOTS_DIR = testMachine;
    assert.throws(() => slotsDir(), TestSlotsRefused, 'the machine directory itself is not a slot directory inside it');
  } finally {
    restoreIsolated('AGENT_SLOTS_DIR');
  }
  assert.equal(existsSync(elsewhere), false, 'refused before anything was made there');
  // A directory given outright is the caller's: the tests' own.
  assert.equal(budgetFor('tok', elsewhere).dir, elsewhere);
  // What this process starts is a test run too, however it is started.
  assert.equal(childEnv()[TEST_RUN_VAR], '1');
});

test('a test run is told apart from the engine by how node started it, never by the shell alone; outside one the slot directory is never refused (#669)', { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const engine: { argv: string[]; execArgv: string[] } = { argv: [process.execPath, join(repoRoot, 'dist', 'src', 'cli.js'), 'coordinator', 'run'], execArgv: [] };
  const clean: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/example', AGENT_SLOTS_DIR: '/var/lib/agent-slots' };
  assert.equal(testRunSign(clean, engine), null);
  assert.equal(testSlotsRefusal('/var/lib/agent-slots', clean, engine), null, "the engine's own slot directory, as before");
  assert.equal(testSlotsRefusal(undefined, clean, engine), null);
  const runs: [string, NodeJS.ProcessEnv, typeof engine][] = [
    ["a test file's process under node --test", { ...clean, NODE_TEST_CONTEXT: 'child-v8' }, engine],
    ['node --test without isolation between files', clean, { ...engine, execArgv: ['--test'] }],
    ['a test file run directly', clean, { ...engine, argv: [process.execPath, '/x/dist/test/backlog.test.js'] }],
    ['the preload mark alone', { ...clean, [TEST_TOKEN_VAR]: 'a'.repeat(64) }, engine],
  ];
  for (const [what, env, proc] of runs) {
    assert.notEqual(testRunSign(env, proc), null, what);
    assert.match(testSlotsRefusal('/var/lib/agent-slots', env, proc) ?? '', new RegExp(`${TEST_MACHINE_VAR} is unset`), what);
  }
  // Only a test run marks what it starts (childEnv, and its own environment on load).
  assert.deepEqual(markTestRun({ ...clean }, testRunSign(clean, engine)), clean);
  assert.equal(markTestRun({ ...clean }, testRunSign(runs[0]![1], engine))[TEST_RUN_VAR], '1');
  assert.notEqual(testRunSign({ ...clean, [TEST_RUN_VAR]: '1' }, engine), null, 'a child a test run started');
  const uid = process.getuid!();
  const inTest = { ...clean, NODE_TEST_CONTEXT: 'child-v8' };
  // The machine counts only with the preload's system root inside it and its mark for this run's token.
  const marked = { ...inTest, [TEST_MACHINE_VAR]: testMachine, [SYSTEM_ROOT_VAR]: isolatedEnv[SYSTEM_ROOT_VAR], [TEST_TOKEN_VAR]: process.env[TEST_TOKEN_VAR] };
  const slots = join(testMachine, 'u', 'agent-slots');
  assert.equal(testSlotsRefusal(slots, marked, engine, uid), null);
  assert.match(testSlotsRefusal(undefined, marked, engine, uid) ?? '', /AGENT_SLOTS_DIR is unset/);
  assert.match(testSlotsRefusal(join(testMachine, '..', 'x'), marked, engine, uid) ?? '', /is outside/);
  assert.match(testSlotsRefusal(slots, { ...marked, [TEST_TOKEN_VAR]: 'b'.repeat(64) }, engine, uid) ?? '', /isn't this run's test machine: .*doesn't match its test mark/);
  assert.match(testSlotsRefusal(slots, { ...marked, [SYSTEM_ROOT_VAR]: undefined }, engine, uid) ?? '', /doesn't hold the test preload's system root/);
  // A stray value naming a directory of this user's alone (as a home is) without the preload's mark is no machine.
  const stray = mkdtempSync(join(tmpdir(), 'stray-machine-'));
  chmodSync(stray, 0o700);
  assert.match(testSlotsRefusal(join(stray, 'slots'), { ...inTest, [TEST_MACHINE_VAR]: stray }, engine, uid) ?? '', /doesn't hold the test preload's system root/);
  assert.match(testSlotsRefusal(join(stray, 'slots'), { ...marked, [TEST_MACHINE_VAR]: stray }, engine, uid) ?? '', /doesn't hold the test preload's system root/);
  assert.match(testSlotsRefusal(slots, { ...inTest, [TEST_MACHINE_VAR]: 'relative/dir' }, engine, uid) ?? '', /not an absolute path/);
  assert.match(testSlotsRefusal(slots, { ...inTest, [TEST_MACHINE_VAR]: join(testMachine, 'missing') }, engine, uid) ?? '', /doesn't exist/);
  // A machine that isn't this user's alone (the filesystem root, another user's, a shared one) is no test machine.
  assert.match(testSlotsRefusal('/var/lib/agent-slots', { ...inTest, [TEST_MACHINE_VAR]: '/' }, engine, uid + 1) ?? '', /isn't a directory of this user's alone/);
  const shared = mkdtempSync(join(tmpdir(), 'shared-machine-'));
  chmodSync(shared, 0o777);
  assert.match(testSlotsRefusal(join(shared, 'slots'), { ...inTest, [TEST_MACHINE_VAR]: shared }, engine, uid) ?? '', /isn't a directory of this user's alone/);
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
  // slotsDir() is a slot path (#772), the same value as the isolated AGENT_SLOTS_DIR's, which is checked above.
  assert.ok(names(slotsDir(), isolatedEnv.AGENT_SLOTS_DIR!), 'slotsDir() is the isolated AGENT_SLOTS_DIR');
  const derived: [string, string][] = [['stateDir()', stateDir()], ['instancesDir()', instancesDir()], ['toolPrefix()', toolPrefix()], ['machineInitDir()', machineInitDir()]];
  // macOS keeps the real HOME (test/isolate.ts homeMoved); everything above, derived from it, is still temporary.
  if (homeMoved) derived.push(['homedir()', homedir()], ["a child's HOME", childEnv().HOME!]);
  for (const [what, p] of derived) assert.ok(inside(p), `${what} is ${p}, outside ${testMachine}`);
  const leaked = Object.keys(process.env).filter((k) => k.startsWith(`${BRAND.envPrefix}_`) && !(k in isolatedEnv) && k !== `${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE` && k !== TEST_TOKEN_VAR && k !== TEST_MACHINE_VAR);
  assert.deepEqual(leaked, [], 'no engine setting from the shell');
});

/** Where headless Chrome binds its SingletonSocket under TMPDIR, and the longest Unix socket path (sun_path, its NUL included). */
const CHROME_SOCKET = '/org.chromium.Chromium.XXXXXX/SingletonSocket';
const SUN_PATH_MAX = 108;

test('in a test process, the temporary directory is inside the test machine: os.tmpdir(), TMPDIR, TMP, TEMP and a child\'s (#604)', () => {
  const made = mkdtempSync(join(tmpdir(), 'made-'));
  const seen: [string, string | undefined][] = [['tmpdir()', tmpdir()], ['TMPDIR', process.env.TMPDIR], ['TMP', process.env.TMP], ['TEMP', process.env.TEMP], ["a child's TMPDIR", childEnv().TMPDIR], ['a mkdtemp under tmpdir()', made]];
  for (const [what, p] of seen) assert.ok(p !== undefined && inside(p), `${what} is ${p}, outside ${testMachine}`);
  // Short enough for a Unix socket under it: Chrome's, the deepest one a test binds there.
  assert.ok(Buffer.byteLength(tmpdir() + CHROME_SOCKET) < SUN_PATH_MAX, `${tmpdir()}${CHROME_SOCKET} is ${Buffer.byteLength(tmpdir() + CHROME_SOCKET)} bytes`);
});

test("another user reaches what a test makes under tmpdir(), as under /tmp, but never this test's home, state, slots or system root (#604)", { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  // The separate-users tests (test/frozen-guard.test.ts) have the agent user read a task file a test made under
  // tmpdir(): every directory from the test machine down to tmpdir() lets others through (o+x).
  const others = (p: string) => (statSync(p).mode & 0o001) !== 0;
  const toTmp: string[] = [];
  for (let d = tmpdir(); d !== dirname(testMachine); d = dirname(d)) toTmp.push(d);
  assert.deepEqual(toTmp.filter((d) => !others(d)), [], `others can pass through each of ${toTmp.join(', ')}`);
  // What the whole machine kept to this user before (mkdtemp's 0700), a directory inside it still does.
  const closed = (p: string) => {
    for (let d = p; d !== testMachine; d = dirname(d)) if (!others(d)) return true;
    return false;
  };
  const open = Object.entries(isolatedEnv).filter(([k, p]) => !['TMPDIR', 'TMP', 'TEMP'].includes(k) && !closed(p));
  assert.deepEqual(open, [], 'each is behind a directory of this user\'s alone');
});

test("a test run a test starts (a preloaded runner and its file, two levels down) gets its temporary directory inside this test's, still short enough for a socket (#604)", async () => {
  const file = fixtureTest('where.test.js', ["import { test } from 'node:test';", "import { tmpdir } from 'node:os';", "test('where', () => { console.log(`TMPDIR_IS=${tmpdir()}`); });"].join('\n'));
  const r = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', file], childEnv());
  assert.equal(r.code, 0, r.out);
  const theirs = /TMPDIR_IS=(\S+)/.exec(r.out)?.[1] ?? '';
  assert.ok(theirs && inside(theirs), `the nested file's tmpdir() is ${theirs}, outside ${testMachine}`);
  assert.ok(Buffer.byteLength(theirs + CHROME_SOCKET) < SUN_PATH_MAX, `${theirs}${CHROME_SOCKET} is ${Buffer.byteLength(theirs + CHROME_SOCKET)} bytes`);
});

test('regression (#604): running test/pr-batch.test.ts leaves no prbatch-* directory, nor anything else, in the system temp directory', { timeout: 300_000 }, async () => {
  // A system temp directory of its own (the run's processes see it as theirs through TMPDIR, TMP and TEMP), so the
  // count is this run's alone: on a shared /tmp other runs come and go.
  const system = mkdtempSync(join(tmpdir(), 'system-tmp-'));
  const env = { ...childEnv(), TMPDIR: system, TMP: system, TEMP: system };
  const prbatch = () => readdirSync(system).filter((f) => f.startsWith('prbatch-'));
  const before = prbatch();
  const r = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', join(repoRoot, 'dist', 'test', 'pr-batch.test.js')], env);
  assert.equal(r.code, 0, r.out.slice(-4000));
  assert.match(r.out, /^# pass [1-9]\d*$/m, 'its tests ran');
  assert.deepEqual(prbatch(), before, 'no new prbatch-* directory in the system temp directory');
  assert.deepEqual(readdirSync(system), [], 'nothing left there at all: the test machines are gone too');
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

// ---------------------------------------------------------------------------------------------------------------
// #786: a variable that isn't set reads as unset, whatever is on Object.prototype (src/os/own-env.ts).

import { desktopBinary } from '../src/desktop.js';
import { heldOutDir } from '../src/held-out.js';
import { HELD_OUT_ENV } from '../src/held-out-paths.js';
import { readManagedApps } from '../src/managed-apps.js';
import { slotsConfigPath, which } from '../src/os/index.js';
import { etcPath, SYSTEM_ROOTS, varLibPath } from '../src/os/system-paths.js';
import { heldOutAllowed } from '../src/spend-gate.js';
import { verifyWithScript } from '../src/setup/app-manifest.js';
import { currentUser } from '../src/os/index.js';
import { EventEmitter } from 'node:events';
import { CliAgentRunner, cliAgentCommand } from '../src/cli-agents.js';
import { authStatusCommand, CliRunner } from '../src/runner.js';

/** Runs `f` with `vars` on Object.prototype, as a polluting dependency would set them, and takes them off after. */
function polluted<T>(vars: Record<string, string>, f: () => T): T {
  const proto = Object.prototype as Record<string, unknown>;
  for (const k of Object.keys(vars)) assert.ok(!Object.hasOwn(proto, k), `${k} isn't on Object.prototype already`);
  try {
    for (const [k, v] of Object.entries(vars)) proto[k] = v;
    return f();
  } finally {
    for (const k of Object.keys(vars)) delete proto[k];
  }
}

/** Runs `f` with `keys` unset in this process's environment, then puts each back (an isolated one with restoreIsolated). */
function unsetWhile<T>(keys: string[], f: () => T): T {
  const saved = new Map(keys.map((k) => [k, Object.hasOwn(process.env, k) ? process.env[k] : undefined] as const));
  try {
    for (const k of keys) delete process.env[k];
    return f();
  } finally {
    for (const [k, v] of saved) {
      if (Object.hasOwn(isolatedEnv, k)) restoreIsolated(k);
      else if (v !== undefined) process.env[k] = v;
    }
  }
}

/** polluted() and unsetWhile() across awaits: for a run whose environment is built after its first await. */
async function pollutedUnset<T>(vars: Record<string, string>, f: () => Promise<T>): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>;
  const keys = Object.keys(vars);
  for (const k of keys) assert.ok(!Object.hasOwn(proto, k), `${k} isn't on Object.prototype already`);
  const saved = new Map(keys.map((k) => [k, Object.hasOwn(process.env, k) ? process.env[k] : undefined] as const));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) proto[k] = v;
    return await f();
  } finally {
    for (const k of keys) delete proto[k];
    for (const [k, v] of saved) {
      if (Object.hasOwn(isolatedEnv, k)) restoreIsolated(k);
      else if (v !== undefined) process.env[k] = v;
    }
  }
}

test('regression (#786): with Object.prototype polluted, an unset variable reads as unset: the system root, the test-run marks, the service modes, the held-out store, the tool prefix, the desktop binary', { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const uid = process.getuid!();
  const engine = { argv: [process.execPath, join(repoRoot, 'dist', 'src', 'cli.js'), 'coordinator', 'run'], execArgv: [] as string[] };
  const clean: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/example' };
  const canary = mkdtempSync(join(tmpdir(), 'canary-786-'));
  const desktop = join(canary, 'desktop');
  writeFileSync(desktop, '');
  const vars = {
    [SYSTEM_ROOT_VAR]: join(canary, 'root'),
    NODE_TEST_CONTEXT: 'child-v8',
    [TEST_RUN_VAR]: '1',
    [HELD_OUT_ENV]: join(canary, 'held-out'),
    [`${BRAND.envPrefix}_PREFIX`]: join(canary, 'prefix'),
    [`${BRAND.envPrefix}_DESKTOP`]: desktop,
  };
  polluted(vars, () => {
    // The pollution reaches a plain read (measured on Node 22, #786): what these read before.
    assert.equal({ ...clean }[SYSTEM_ROOT_VAR], vars[SYSTEM_ROOT_VAR], 'a plain object inherits it');
    assert.equal(systemRootRefusal({ ...clean }, uid), null, 'the system root: unset, nothing to refuse');
    assert.equal(testRunSign({ ...clean }, engine), null, 'the test-run marks: the engine is no test run');
    assert.equal(serviceModeRefusal(['coordinator', 'run'], { ...clean }), null, 'a service mode: no system root to refuse');
    assert.equal(heldOutDir('/state', { ...clean }), join('/state', 'evals', 'held-out'), "the held-out store: the state's");
    assert.equal(heldOutAllowed([], { ...clean }), false, 'held-out cases: not asked for');
    assert.equal(toolPrefix({ ...clean }), join(homedir(), '.local'), 'the tool prefix: the default');
    assert.equal(desktopBinary({ ...clean }, canary), null, 'the desktop binary: none given, none built');
  });
});

test("regression (#786): with Object.prototype polluted, the process's own locations ignore it: the slot dir and its config, the instances and init dirs, the tool prefix and PATH", { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  const canary = mkdtempSync(join(tmpdir(), 'canary-786-'));
  const bin = join(canary, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'wl786-canary-tool'), '#!/bin/sh\n', { mode: 0o755 });
  const vars: Record<string, string> = {
    // Inside the test machine, so the slot dir's own guard (testSlotsRefusal) would take it: only the read decides.
    AGENT_SLOTS_DIR: join(canary, 'slots'),
    AGENT_SLOTS_CONFIG: join(canary, 'slots-config.json'),
    [`${BRAND.envPrefix}_INSTANCES_DIR`]: join(canary, 'instances'),
    [`${BRAND.envPrefix}_MACHINE_INIT_DIR`]: join(canary, 'machine-init'),
    [`${BRAND.envPrefix}_PREFIX`]: join(canary, 'prefix'),
    PATH: bin,
  };
  unsetWhile(Object.keys(vars), () =>
    polluted(vars, () => {
      assert.equal(process.env.AGENT_SLOTS_DIR, vars.AGENT_SLOTS_DIR, 'process.env inherits it (measured on Node 22, #786)');
      assert.equal(names(slotsDir(), vars.AGENT_SLOTS_DIR!), false, 'the slot dir is not the canary');
      assert.equal(slotsConfigPath('/nowhere'), join('/nowhere', 'config.json'), "the slot config: the slot dir's");
      assert.equal(instancesDir(), join(stateDir(), 'instances'), "the instances dir: the state dir's");
      assert.equal(machineInitDir(), varLibPath('init'), "the machine's init dir: its own");
      assert.equal(toolPrefix(), join(homedir(), '.local'), 'the tool prefix: the default');
      assert.equal(which('wl786-canary-tool'), null, 'PATH: unset, nothing on it');
    }),
  );
});

test("regression (#786): a forged system root on Object.prototype, with a mark for this run's token, moves no machine path, and makes no file of this user's root's", { skip: process.platform === 'win32' && 'POSIX owners and modes' }, () => {
  const uid = process.getuid!();
  const token = process.env[TEST_TOKEN_VAR]!;
  // What a polluter would make: a root of this user's alone, holding a mark for this run's token.
  const forged = mkdtempSync(join(tmpdir(), 'forged-root-'));
  chmodSync(forged, 0o700);
  writeFileSync(join(forged, TEST_MARK_FILE), `${token}\n`, { mode: 0o600 });
  assert.equal(systemRootRefusal({ [SYSTEM_ROOT_VAR]: forged, [TEST_TOKEN_VAR]: token }, uid), null, 'given as a real variable, the forgery is honoured: the test means something');
  // A managed-apps file of this user's: in a marked test process this user stands in for root (src/managed-apps.ts rootUid).
  const apps = join(mkdtempSync(join(tmpdir(), 'apps-')), 'managed-apps.json');
  writeFileSync(apps, JSON.stringify({ version: 1, apps: { shop: 'acme/shop' } }), { mode: 0o644 });
  assert.deepEqual(readManagedApps(apps), { apps: { shop: 'acme/shop' }, problem: null }, "with the preload's own root, this user's file is root's");
  unsetWhile([SYSTEM_ROOT_VAR], () =>
    polluted({ [SYSTEM_ROOT_VAR]: forged }, () => {
      assert.equal(process.env[SYSTEM_ROOT_VAR], forged, 'process.env inherits it (measured on Node 22, #786)');
      assert.equal(etcPath('x'), `${SYSTEM_ROOTS.etc}/x`, 'no machine path moves into the forged root');
      assert.match(readManagedApps(apps).problem ?? '', /isn't root's alone/, "unset, root's files are uid 0's again: this user's file is refused");
    }),
  );
  assert.equal(readManagedApps(apps).problem, null, "the preload's own root back: as before");
});

test("regression (#786): a NODE_OPTIONS on Object.prototype is not handed to the App check's node (it runs as the coordinator user)", async () => {
  const canary = `--require ${join(mkdtempSync(join(tmpdir(), 'canary-786-')), 'never.cjs')}`;
  const script = join(mkdtempSync(join(tmpdir(), 'script-')), 'check.mjs');
  writeFileSync(script, '');
  const seen: NodeJS.ProcessEnv[] = [];
  // A stand-in spawn: records the environment it is given, and ends at once. Nothing runs.
  const standIn = ((_file: string, _args: string[], o: { env: NodeJS.ProcessEnv }) => {
    seen.push(o.env);
    const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end: () => setImmediate(() => p.emit('close', 0)) } });
    return p;
  }) as unknown as typeof spawn;
  const own = Object.hasOwn(process.env, 'NODE_OPTIONS') ? process.env.NODE_OPTIONS : undefined;
  const verify = polluted({ NODE_OPTIONS: canary }, () => verifyWithScript({ script, spawn: standIn }));
  await verify({ user: currentUser(), key: '/k', appId: 1, installationId: 2, repo: 'acme/shop' } as Parameters<typeof verify>[0]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.NODE_OPTIONS, own, "only this process's own NODE_OPTIONS, if it has one");
});

test("regression (#786 round 2): an agent user's run gets none of Object.prototype's variables across the user switch, and sudo gets no PATH from it", { skip: process.platform === 'win32' && 'agent users: POSIX' }, async () => {
  const canary = mkdtempSync(join(tmpdir(), 'canary-786-'));
  const vars = { TZ: 'Canary/786', LC_ALL: 'canary-786', XDG_RUNTIME_DIR: join(canary, 'run'), CLAUDE_CONFIG_DIR: join(canary, 'claude'), PATH: join(canary, 'path') };
  const home = mkdtempSync(join(tmpdir(), 'agent-home-'));
  // What the runner hands sudo (the env -i list is built from it): recorded, then a node that exits at once runs instead.
  const wrapped: NodeJS.ProcessEnv[] = [];
  const exec = {
    wrap: (_u: string, _f: string, _a: string[], e: NodeJS.ProcessEnv): [string, string[], NodeJS.ProcessEnv] => (wrapped.push({ ...e }), [process.execPath, ['-e', ''], { PATH: '/usr/bin:/bin' }]),
    kill: () => {},
  };
  const runner = new CliAgentRunner('codex', { runAs: () => ({ user: 'agent', home }), exec });
  const req = { role: 'worker', prompt: 'p', appendSystemPrompt: 's', cwd: canary, model: 'codex-model-x', allowedTools: [], maxTurns: 1, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, route: { kind: 'build' as const, fallback: 'sonnet' }, provider: { name: 'cli:codex', kind: 'cli' as const, agent: 'codex' as const, usdPerMtok: { in: 1, out: 1 } } };
  const out = await pollutedUnset(vars, async () => ({
    run: await runner.run(req as Parameters<typeof runner.run>[0]),
    sudo: cliAgentCommand('agent', '/bin/true', [], {})[2],
    probe: authStatusCommand({}, { user: 'agent', home }).env,
    login: new CliRunner('cli', process.env).loginOf({}),
  }));
  assert.equal(wrapped.length, 1, `the run reached its CLI: ${out.run.detail}`);
  // Every route at once, so a failure names each one that leaks.
  const leaks = [
    ...Object.entries(vars).filter(([k, v]) => wrapped[0]![k] === v).map(([k]) => `the agent run's environment has ${k} from Object.prototype`),
    ...(out.sudo.PATH === '' ? [] : [`cliAgentCommand gives sudo PATH=${out.sudo.PATH}`]),
    ...(out.probe.PATH === '' ? [] : [`authStatusCommand gives sudo PATH=${out.probe.PATH}`]),
    ...(out.login === join(homedir(), '.claude') ? [] : [`loginOf is ${out.login}`]),
  ];
  assert.deepEqual(leaks, []);
});
