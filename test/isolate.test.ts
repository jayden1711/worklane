// The suite runs clean on a machine that already runs the engine (issue #312): every test process has a temporary
// home, state dir and slot directory (test/isolate.ts), and a server a test stops keeps its port held by the test
// (test/held-port.ts). Checked here end to end, with a live machine's environment and its fixed ports taken. The
// isolation is preloaded by every runner, never imported per file: a new test file gets it without doing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
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
import { repoRoot } from './helpers.js';
import { homeMoved, isolatedEnv, TEST_PRELOAD, testMachine } from './isolate.js';

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
  const leaked = Object.keys(process.env).filter((k) => k.startsWith(`${BRAND.envPrefix}_`) && !(k in isolatedEnv) && k !== `${BRAND.envPrefix}_BROWSER_TIMEOUT_SCALE`);
  assert.deepEqual(leaked, [], 'no engine setting from the shell');
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
  "regression (#312): with a live machine's environment and its dashboard ports taken, the hub and hook tests give the same results and write nothing of the machine's",
  { timeout: 180_000 },
  async () => {
    // The machine: the owner's home and state dir, its slot directory with an emergency stop in force, and the
    // engine settings a coordinator's shell has.
    const live = mkdtempSync(join(tmpdir(), 'live-machine-'));
    const dirs = { home: join(live, 'home'), state: join(live, 'state'), slots: join(live, 'agent-slots') };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(join(dirs.slots, 'STOP'), JSON.stringify({ by: 'owner', at: new Date().toISOString(), reason: 'the live machine is stopped' }));
    writeFileSync(join(dirs.slots, 'config.json'), JSON.stringify({ max_agents: 1 }));
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
    };
    // Its fixed ports: a checkout's dashboard, the hub's two, every instance's.
    const servers = await holdPorts([LOCAL_DASHBOARD_PORT, HUB_PORT, HUB_BREAK_GLASS_PORT, ...Array.from({ length: 500 }, (_, i) => 4400 + i)]);
    try {
      const files = ['dashboard-hub', 'push-hook-guard', 'frozen-guard'].map((n) => join(repoRoot, 'dist', 'test', `${n}.test.js`));
      // As npm test and CI run them: with the preload.
      const { code, out } = await runTests([...TEST_PRELOAD, '--test', '--test-reporter=tap', ...files], env);
      const failed = out.split('\n').filter((l) => /^\s*not ok\b/.test(l));
      assert.equal(code, 0, `${failed.join('\n')}\n${out.slice(-4000)}`);
      assert.match(out, /^# fail 0$/m);
      assert.match(out, /^# pass [1-9]\d*$/m);
    } finally {
      await Promise.all(servers.map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
    }
    assert.deepEqual(filesUnder(live), before, "nothing written to the machine's home, state or slots");
  },
);
