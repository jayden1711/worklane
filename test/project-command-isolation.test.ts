// Issue #713: project commands (checks, worktree setup, full runs, suite tuning, a browser flow's app, auto-config) run
// code agents wrote, as the agent user. They run inside a sandbox that hides the agent's credentials, and what they
// print reaches no event or prompt with a credential in it.
//
// No real sudo and no real state: the current user stands in for the agent user (the command's own `env -i ...`, run
// without the `sudo -n -u <agent> --` in front of it), and its "home" is a temp dir holding planted stand-in keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from './script-child-process.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Namespace imports: run against the code before #713 (the fail-without), a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';
import { sh } from '../src/coordinator/shared.js';
import { createWorktree, createWorktreeAsync } from '../src/worktrees.js';
import * as instance from '../src/instance.js';
import type { CredentialsFile } from '../src/instance.js';
import type { ProjectRunAs } from '../src/os/index.js';
import { AppConfig } from '../src/config/schema.js';
import { judgeFlow, type runBrowserCheck } from '../src/browser/check.js';
import type { FlowEvidence, runFlow } from '../src/browser/run.js';
import { baselineSource, browserChecks } from '../src/coordinator/browser.js';
import { repoRoot } from './helpers.js';
import { projectEnvProblem } from '../src/project-env.js';
import { readJob, runJob } from '../src/queue.js';

const { projectCommand } = osAdapter;
const posix = process.platform === 'linux';
const PROJECT_SANDBOX_TOOL = '/usr/bin/bwrap';
// The real sandbox: bubblewrap at its fixed path, allowed to make its namespaces here. ci-slow's real-users job sets
// PROJECT_SANDBOX_REQUIRED=1 after machine.sh installs it, so there a missing sandbox fails instead of skipping.
const sandboxRuns = posix && spawnSync(PROJECT_SANDBOX_TOOL,['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${PROJECT_SANDBOX_TOOL} here (ci-slow's real-users job runs this with it)`;

/** Run a project command as projectCommand builds it for the agent user, as this user: its argv after `sudo -n -u <agent> --`. */
function asStandIn(command: string, runAs: { user: string; home: string; hide?: readonly string[] }, cwd: string, o: { sandboxTool?: string } = {}) {
  const pc = projectCommand(command, { ...runAs, hide: runAs.hide ?? [] }, {}, o);
  assert.equal(pc.file, 'sudo');
  assert.deepEqual(pc.args.slice(0, 5), ['-n', '-u', runAs.user, '--', '/usr/bin/env']);
  // stdin /dev/null: never a socket (bash's rshd check would read this machine's ~/.bashrc in a wrapper without --norc).
  return spawnSync(pc.args[4]!, pc.args.slice(5), { cwd, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** An agent home with a stand-in key at every credential path, and one more key outside it (credentials.yaml's). */
function plantedHome() {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-'));
  const home = join(root, 'agent');
  const key = (p: string) => {
    const v = `PLANTED-${randomBytes(12).toString('hex')}`;
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, `${v}\n`, { mode: 0o600 });
    return v;
  };
  const keys = {
    login: key(join(home, '.claude', '.credentials.json')),
    state: key(join(home, '.claude.json')),
    profile: key(join(home, '.claude-profiles', 'p1', '.credentials.json')),
    apiKey: key(join(home, '.config', 'shop-claude-key', 'api_key')),
    provider: key(join(root, 'keys', 'provider')),
  };
  // A symlink to a credential is followed only from a directory the agent neither owns nor can write: no test user
  // can make one, so ci-slow's real-users job checks it with a root-owned directory (project-command-real-users.mjs).
  writeFileSync(join(home, 'notes.txt'), 'ordinary\n');
  const work = join(root, 'work');
  mkdirSync(work);
  return { root, home, keys, work, provider: join(root, 'keys', 'provider') };
}

test('a check run as the agent user reads nothing at its credential paths; its own work and files are as before', { skip: realSkip }, () => {
  const p = plantedHome();
  const runAs = { user: 'shop-agent', home: p.home, hide: [p.provider] };
  const paths = [join(p.home, '.claude', '.credentials.json'), join(p.home, '.claude.json'), join(p.home, '.claude-profiles', 'p1', '.credentials.json'), join(p.home, '.config', 'shop-claude-key', 'api_key'), p.provider];
  const r = asStandIn(`for f in ${paths.map((x) => JSON.stringify(x)).join(' ')}; do cat "$f"; done; grep -rh PLANTED "$HOME" 2>/dev/null; cat ~/notes.txt; echo built > out.txt`, runAs, p.work);
  const seen = `${r.stdout}\n${r.stderr}`;
  for (const [what, v] of Object.entries(p.keys)) assert.ok(!seen.includes(v), `the ${what} key was read: ${seen}`);
  assert.match(r.stdout, /ordinary/, 'files that hold no credential are still there');
  assert.ok(existsSync(join(p.work, 'out.txt')), 'the command still writes its own working directory');
});

test('a check run as the agent user sees no process outside its sandbox (no /proc/<pid> of a running claude)', { skip: realSkip }, () => {
  const p = plantedHome();
  const r = asStandIn(`ls /proc | grep -c '^[0-9]'; test -e /proc/${process.pid} && echo SEES-PARENT || echo hidden`, { user: 'shop-agent', home: p.home }, p.work);
  assert.match(r.stdout, /hidden/, r.stdout + r.stderr);
  assert.ok(Number(r.stdout.split('\n')[0]) < 10, `few processes in its own PID namespace: ${r.stdout}`);
});

test('the agent user\'s project command fails closed, naming the fix, when its sandbox can\'t start; nothing of it runs', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  const p = plantedHome();
  const r = asStandIn('echo ran > ran.txt; cat ~/.claude/.credentials.json', { user: 'shop-agent', home: p.home }, p.work, { sandboxTool: join(p.root, 'no-such-bwrap') });
  assert.ok(!existsSync(join(p.work, 'ran.txt')), 'the command did not run');
  assert.ok(!r.stdout.includes(p.keys.login));
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, r.stdout + r.stderr);
  assert.equal(osAdapter.PROJECT_SANDBOX_TOOL, PROJECT_SANDBOX_TOOL, 'bubblewrap at its fixed path, never from PATH');
  assert.match(r.stderr, /project command not run: its sandbox didn't start .*scripts\/setup\/machine\.sh.*check\.sh/);
});

test('the instance hides its home, a Claude dir set elsewhere and every credential file it names, never the checkout', () => {
  const c = { version: 1, github: { kind: 'app', app_id: 1, installation_id: 2, key_path: '/srv/i/app.pem' }, agent_api_key: '/home/user/.config/i-claude-key/api_key', eval_key: '/srv/eval/key', provider_keys: { open: '/home/user/.config/i-open-key/key' }, intake: { slack_bot_token: '/srv/i/slack' } } as CredentialsFile;
  const hides = instance.projectCommandHides('/var/lib/inst/i', '/srv/i/repo', c, '/opt/claude-a');
  assert.deepEqual(hides.sort(), ['/home/user/.config/i-claude-key/api_key', '/home/user/.config/i-open-key/key', '/srv/eval/key', '/opt/claude-a', '/srv/i/app.pem', '/srv/i/slack', '/var/lib/inst/i'].sort());
  // An instance home that holds the checkout stays: hiding it would hide the commands' own working directory.
  assert.ok(!instance.projectCommandHides('/var/lib/inst/i', '/var/lib/inst/i/repo', c).includes('/var/lib/inst/i'));
});

test('macOS: the sandbox profile denies the Claude logins, the API key and each hidden path; refuses a path it can\'t quote', () => {
  const s = osAdapter.seatbeltProfile('/var/agent.home', ['/srv/i/key']);
  assert.match(s, /\(allow default\)/);
  assert.ok(s.includes('(deny file-read* file-write* (regex #"^/var/agent\\.home/\\.claude")'), s);
  assert.ok(s.includes('(subpath "/srv/i/key")'), s);
  assert.throws(() => osAdapter.seatbeltProfile('/var/agent', ['/x"y']), /not a plain absolute path/);
});

// A stand-in Claude token, credential-shaped as the real ones are (never a real one).
const token = () => `sk-ant-oat01-${randomBytes(24).toString('base64url')}Ab1`;

test('a key a check prints reaches neither its output nor its tail (what events and fix prompts are built from)', { skip: !posix && 'POSIX shell' }, async () => {
  const t = token();
  const r = await sh(`echo "reading ${t}"; echo '{"accessToken":"${t}"}' >&2; exit 3`, tmpdir(), 60_000);
  assert.equal(r.code, 3);
  assert.ok(!r.out.includes(t) && !r.tail.includes(t), r.out);
  assert.match(r.tail, /\[REDACTED\]/);
});

test('a key a worktree setup step prints is not in its setup error', { skip: !posix && 'POSIX shell' }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'wl-713-repo-'));
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repo });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), 'a\n');
  git('add', 'a');
  git('-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const t = token();
  // Split in the step's text (its config), whole in what it prints.
  const o = { repo, root: 'wt', stateDir: join(repo, 'state'), setup: [`echo "auth failed for ${t.slice(0, 7)}""${t.slice(7)}" >&2; exit 1`] };
  const sync = createWorktree(o, 'x', 'x', 'main').setupErrors;
  const async = (await createWorktreeAsync(o, 'y', 'y', 'main')).setupErrors;
  for (const e of [...sync, ...async]) {
    assert.ok(!e.includes(t), e);
    assert.match(e, /auth failed for sk-\[REDACTED\]/);
  }
  assert.equal(sync.length + async.length, 2);
});

test('a browser flow\'s app gets the agent user\'s whole runAs, at base and at head: a provider key credentials.yaml names stays unread', { skip: !posix && 'POSIX users' }, async () => {
  const p = plantedHome();
  // Where credentials.sh <name> provider-key puts one: not a ~/.claude* path, so only runAs.hide covers it.
  const providerKey = join(p.home, '.config', 'shop-provider-keys', 'open');
  mkdirSync(join(providerKey, '..'), { recursive: true });
  const value = `PLANTED-${randomBytes(12).toString('hex')}`;
  writeFileSync(providerKey, `${value}\n`, { mode: 0o600 });
  const runAs: ProjectRunAs = { user: 'shop-agent', home: p.home, hide: [providerKey] };
  const app = AppConfig.parse({ version: 1, start: { command: `cat ${JSON.stringify(providerKey)}`, port: 5173 }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  const given: (ProjectRunAs | undefined)[] = [];
  const outs: string[] = [];
  // Each stand-in starts the app as runFlow does (projectCommand with the runAs it is given), as this user.
  const start = (ra: ProjectRunAs | undefined) => {
    given.push(ra);
    if (ra && !realSkip) outs.push(asStandIn(app.start.command, ra, p.work).stdout);
  };
  const runCheck = (async (o) => (start(o.runAs), { check: 'browser home', status: 'pass', kind: 'browser', exitCode: null, tail: 'passed', evidence: null, verdict: null })) as typeof runBrowserCheck;
  const runBase = (async (o) => (start(o.runAs), { flow: o.flow, skipped: 'stand-in' })) as typeof runFlow;
  const source = baselineSource({ base: 'b0b0b0b0b0b0', app, cache: new Map(), open: async () => ({ path: p.work, setupErrors: [] }), remove: () => {}, outDir: p.work, chrome: 'chrome', runAs, run: runBase });
  await browserChecks({ app, doneWhen: [{ browser: 'home' }], changed: [], cwd: p.work, outDir: p.work, chrome: 'chrome', runAs, run: runCheck, baseline: () => source });
  for (const out of outs) assert.ok(!out.includes(value), `the app read the provider key: ${out}`);
  assert.deepEqual(given, [runAs, runAs], 'the base run and the check each get the hide list');
});

test('a browser check\'s reasons (the page\'s console errors, a step\'s error) carry no credential into its tail or a prompt', () => {
  const t = token();
  const app = AppConfig.parse({ version: 1, start: { command: 'true', port: 5173 }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }] } });
  const ev: FlowEvidence = {
    flow: 'home',
    ok: false,
    steps: [{ step: 'goto /', ok: false, ms: 1, error: `401 for Bearer ${t}` }],
    consoleErrors: [{ kind: 'error', text: `fetch failed with key ${t}` }],
    failedRequests: [],
    slowRequests: [],
    blockedRequests: [],
    trace: null,
    screenshot: null,
    views: [],
    viewErrors: [],
    durationMs: 1,
  };
  const v = judgeFlow(ev, app.thresholds);
  assert.equal(v.pass, false);
  const text = [...v.reasons, ...v.notes].join('\n');
  assert.ok(!text.includes(t), text);
  assert.match(text, /new console error: fetch failed with key sk-\[REDACTED\]/);
});

test('check.sh runs the probe the engine runs before every project command, and the command\'s sandbox uses the same flags', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  const probe = osAdapter.PROJECT_SANDBOX_PROBE;
  assert.ok(probe, 'one shared probe argv (src/os/index.ts)');
  const check = readFileSync(join(repoRoot, 'scripts', 'setup', 'check.sh'), 'utf8');
  assert.ok(check.split('\n').includes(`label="$agent can start a project command's sandbox"; check sudo -u "$agent" ${probe.join(' ')}`), 'check.sh runs PROJECT_SANDBOX_PROBE as the agent user, a live line');
  // CI's test shards check the same probe as another user before the tests that need it.
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.split('\n').some((l) => l.trim() === `sudo -n -u nobody ${probe.join(' ')}`), 'ci.yml probes PROJECT_SANDBOX_PROBE as nobody');
  const pc = projectCommand('true', { user: 'shop-agent', home: '/var/agent', hide: [] });
  assert.ok(pc.args.some((a) => a.includes(`box=(${osAdapter.PROJECT_SANDBOX_ARGS.join(' ')})`)), 'the wrapper starts bubblewrap with those flags');
});

test('the project\'s environment never reaches the sandbox wrapper\'s own shell: only the command inside bubblewrap gets it', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  const pc = projectCommand('true', { user: 'shop-agent', home: '/var/agent', hide: ['/srv/i/key'] }, { WORKERS: '4' });
  // sudo -n -u <agent> -- /usr/bin/env -i <the wrapper's bash>: no variable at all before it.
  assert.deepEqual(pc.args.slice(0, 6), ['-n', '-u', 'shop-agent', '--', '/usr/bin/env', '-i']);
  assert.ok(!pc.args[6]!.includes('='), `the wrapper's shell gets no environment: ${pc.args[6]}`);
  assert.deepEqual(pc.args.slice(7, 10), ['--norc', '--noprofile', '-c'], 'and reads no startup file');
  const sep = pc.args.indexOf('--', 8);
  assert.ok(sep > 0, 'the wrapper\'s own words end at --');
  assert.deepEqual(pc.args.slice(sep + 1, sep + 3), ['/usr/bin/env', '-i'], 'the command\'s environment is set inside bubblewrap');
  for (const v of ['WORKERS=4', 'HOME=/var/agent', 'GIT_CONFIG_COUNT=2']) assert.ok(pc.args.indexOf(v) > sep, `${v} only after --`);
});

for (const [what, env] of [
  ['SHELLOPTS=noglob', { SHELLOPTS: 'noglob' }],
  ['BASHOPTS=failglob (no API key file)', { BASHOPTS: 'failglob' }],
] as const) {
  test(`a tests.yaml variable can't turn the masks off: ${what}`, { skip: realSkip }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-713-env-'));
    const home = join(root, 'agent');
    const login = `PLANTED-${randomBytes(12).toString('hex')}`;
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), `${login}\n`, { mode: 0o600 });
    const pc = projectCommand('cat ~/.claude/.credentials.json 2>&1; true', { user: 'shop-agent', home, hide: [] }, { ...env });
    const r = spawnSync(pc.args[4]!, pc.args.slice(5), { cwd: root, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!`${r.stdout}${r.stderr}`.includes(login), `the login was read: ${r.stdout}`);
    assert.equal(r.status, 0, r.stderr);
  });
}

test('bash\'s own expansion and startup variables are reserved: a project can\'t set them', () => {
  for (const name of ['SHELLOPTS', 'BASHOPTS', 'GLOBIGNORE', 'EXECIGNORE', 'BASH_ENV', 'ENV', 'BASH_FUNC_x%%', 'BASH_XTRACEFD', 'BASH_COMPAT', 'IFS']) {
    assert.match(projectEnvProblem(name) ?? 'accepted', /harness or the system|not a variable name/, name);
  }
});

test('a runAs without its hide list is refused, never run with the default masks only', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  assert.throws(() => projectCommand('true', { user: 'shop-agent', home: '/var/agent' } as unknown as ProjectRunAs), /hide list/);
});

test('credentials.yaml refuses a relative path: the sandbox hides each by its absolute path', () => {
  const r = instance.CredentialsFile.safeParse({ version: 1, github: { kind: 'gh-config-dir', path: 'gh' }, agent_api_key: 'keys/api_key' });
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues.map((i) => [i.path.join('.'), i.message]), [['github.path', 'must be an absolute path'], ['agent_api_key', 'must be an absolute path']]);
  assert.equal(instance.CredentialsFile.safeParse({ version: 1, github: { kind: 'gh-config-dir', path: '/srv/i/gh' } }).success, true);
});

test('credentials.yaml refuses a path with `..`: resolved lexically, it could name a different file than the kernel reaches', () => {
  const r = instance.CredentialsFile.safeParse({ version: 1, github: { kind: 'gh-config-dir', path: '/srv/i/gh' }, agent_api_key: '/opt/link/../key' });
  assert.equal(r.success, false);
  assert.deepEqual(r.error!.issues.map((i) => [i.path.join('.'), i.message]), [['agent_api_key', `${osAdapter.NOT_NORMAL_ABSOLUTE}: name the real path`]]);
});

test('instance.yaml run_as paths are held to the same rule: absolute, in normal form, refused at load and never rewritten', () => {
  const base = { version: 1, name: 'shop', repos: [{ path: '/srv/shop/repo', repo: 'acme/shop' }] };
  const runAs = (extra: Record<string, string>) => instance.InstanceFile.safeParse({ ...base, run_as: { agent_user: 'shop-agent', agent_home: '/srv/agents/shop', ...extra } });
  assert.equal(runAs({}).success, true);
  assert.equal(runAs({ agent_home: '/' }).success, true, '`/` is a home some users have');
  for (const [key, value] of [
    ['agent_home', '/srv/link/../agent'],
    ['agent_home', '/srv/agents/shop/'],
    ['agent_home', 'agents/shop'],
    ['claude_config_dir', '/srv/link/../claude'],
    ['claude_config_dir', 'rel/claude'],
    ['claude_config_dir', '//srv/claude'],
    ['eval_home', '/srv/./eval'],
    ['eval_home', '/srv/a\nb'],
  ] as const) {
    const r = runAs({ [key]: value, ...(key === 'eval_home' ? { eval_user: 'shop-eval' } : {}) });
    assert.equal(r.success, false, `${key}: ${JSON.stringify(value)} was accepted`);
    assert.deepEqual(r.error!.issues.map((i) => i.path.join('.')), [`run_as.${key}`], JSON.stringify(value));
  }
});

test('an agent home with `..` after a symlink is refused, never rewritten: the masks would miss the home the kernel reaches', { skip: realSkip }, () => {
  // The reviewer's round-6 H: <root>/link -> <root>/deep/x, so <root>/link/../agent is <root>/deep/agent to the kernel.
  const root = mkdtempSync(join(tmpdir(), 'wl-713-home-'));
  mkdirSync(join(root, 'deep', 'x'), { recursive: true });
  symlinkSync(join(root, 'deep', 'x'), join(root, 'link'));
  const value = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(root, 'deep', 'agent', '.claude'), { recursive: true });
  writeFileSync(join(root, 'deep', 'agent', '.claude', '.credentials.json'), `${value}\n`, { mode: 0o600 });
  // `cat` by the home the kernel reaches, as `claude` itself would: masked only if the masks were set there.
  const r = refusedOrRun(`cat ~/.claude/.credentials.json ${root}/deep/agent/.claude/.credentials.json 2>&1; echo "HOME=$HOME"`, { user: 'shop-agent', home: `${root}/link/../agent`, hide: [] }, root);
  assert.ok(!r.out.includes(value), `the login was read: ${r.out}`);
  assert.ok(r.refused, `not refused: ${r.out}`);
});

test('a hide path in a directory the agent owns but made unsearchable is refused, never taken for absent', { skip: realSkip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-acc-'));
  const home = join(root, 'agent');
  const value = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, 'keys'), { recursive: true });
  writeFileSync(join(home, 'keys', 'open'), `${value}\n`, { mode: 0o600 });
  const runAs = { user: 'shop-agent', home, hide: [join(home, 'keys', 'open')] };
  // The agent user makes the directory unsearchable (it owns it; the mask can't stop a chmod), the next command would
  // find the path "absent", get no mask, make it searchable again and read the key. Since #798 a sandboxed command
  // can't (its home is read-only there); the agent user outside the sandbox still can, so the walk still refuses.
  const tried = asStandIn(`chmod 000 ${join(home, 'keys')} 2>&1`, runAs, root);
  assert.match(tried.stdout, /Read-only file system/, 'a sandboxed command chmods nothing in its home');
  chmodSync(join(home, 'keys'), 0o000);
  const next = asStandIn(`chmod 700 ${join(home, 'keys')}; cat ${join(home, 'keys', 'open')} 2>&1; true`, runAs, root);
  chmodSync(join(home, 'keys'), 0o700);
  assert.ok(!next.stdout.includes(value), `the key was read: ${next.stdout}`);
  assert.equal(next.status, osAdapter.SANDBOX_UNAVAILABLE, next.stderr);
  assert.match(next.stderr, /owns or can write but cannot search now/);
});

// The reviewer's round-7 E2: a home or ~/.config made searchable but unreadable. A glob there said nothing, so the
// default masks were skipped, while a command needs only search permission to open ~/.claude/.credentials.json.
for (const [where, mode] of [['~', 0o311], ['~', 0o100], ['~/.config', 0o311], ['~/.config', 0o100]] as const) {
  test(`a ${where} made searchable but unreadable (${mode.toString(8)}) can't unmask the default credential paths for the next command`, { skip: realSkip }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-713-e2-'));
    const home = join(root, 'agent');
    const login = `PLANTED-${randomBytes(12).toString('hex')}`;
    const key = `PLANTED-${randomBytes(12).toString('hex')}`;
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), `${login}\n`, { mode: 0o600 });
    mkdirSync(join(home, '.config', 'shop-claude-key'), { recursive: true });
    writeFileSync(join(home, '.config', 'shop-claude-key', 'api_key'), `${key}\n`, { mode: 0o600 });
    const dir = where === '~' ? home : join(home, '.config');
    const runAs = { user: 'shop-agent', home, hide: [] };
    try {
      // Since #798 a sandboxed command can't chmod its home (read-only there); the agent user outside it still can.
      const tried = asStandIn(`chmod ${mode.toString(8)} ${JSON.stringify(dir)} 2>&1`, runAs, root);
      assert.match(tried.stdout, /Read-only file system/, 'a sandboxed command chmods nothing in its home');
      chmodSync(dir, mode);
      const next = asStandIn(`cat ${join(home, '.claude', '.credentials.json')} ${join(home, '.config', 'shop-claude-key', 'api_key')} 2>&1; true`, runAs, root);
      for (const v of [login, key]) assert.ok(!next.stdout.includes(v), `read: ${next.stdout}`);
      assert.equal(next.status, osAdapter.SANDBOX_UNAVAILABLE, next.stderr);
      assert.match(next.stderr, /cannot be listed for its credential files|cannot search now/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
}

// The reviewer's round-7 E3: a command still running flips a directory of its own between 000 and 700 while the next
// command's walk looks. Every decision now rests on one lstat's own result, and EACCES under the agent's own
// directory refuses whatever the mode is a moment later: refused or masked, never read.
test('a command flipping its own directory\'s mode while the next starts never unmasks a credential', { skip: realSkip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-race-'));
  const home = join(root, 'agent');
  const key = `PLANTED-${randomBytes(12).toString('hex')}`;
  const login = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, 'keys', 'provider'), { recursive: true });
  writeFileSync(join(home, 'keys', 'provider', 'open'), `${key}\n`, { mode: 0o600 });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), `${login}\n`, { mode: 0o600 });
  const runAs = { user: 'shop-agent', home, hide: [join(home, 'keys', 'provider', 'open')] };
  const flip = (dir: string) => {
    const pc = projectCommand(`end=$((SECONDS + 4)); while [ "$SECONDS" -lt "$end" ]; do chmod 000 ${JSON.stringify(dir)}; chmod 700 ${JSON.stringify(dir)}; done`, runAs);
    return new Promise<void>((res) => spawn(pc.args[4]!, pc.args.slice(5), { cwd: root, env: {}, stdio: 'ignore' }).on('close', () => res()));
  };
  let runs = 0;
  let leaks = 0;
  for (const dir of [join(home, 'keys', 'provider'), home]) {
    const a = flip(dir);
    const t0 = performance.now();
    while (performance.now() - t0 < 3_000) {
      const b = asStandIn(`for i in $(seq 200); do cat ${join(home, 'keys', 'provider', 'open')} ${join(home, '.claude', '.credentials.json')} 2>/dev/null && break; done; true`, runAs, root);
      runs++;
      if (b.stdout.includes(key) || b.stdout.includes(login)) leaks++;
    }
    await a;
    chmodSync(dir, 0o700);
  }
  assert.equal(leaks, 0, `${leaks} of ${runs} runs read a credential`);
  assert.ok(runs >= 4, `the race ran (${runs} runs)`);
});

test('a refusal names every symlink to fix, where each points, and how to remove it as the agent user', { skip: realSkip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-r8-'));
  const home = join(root, 'agent');
  mkdirSync(join(home, '.config'), { recursive: true });
  // The reviewer's R8: two links one command planted.
  symlinkSync('/', join(home, '.claude-x'));
  symlinkSync('/etc', join(home, '.config', 'z-claude-key'));
  const r = asStandIn('echo ran', { user: 'shop-agent', home, hide: [] }, root);
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE);
  assert.equal(r.stdout, '');
  for (const [link, target] of [[join(home, '.claude-x'), '/'], [join(home, '.config', 'z-claude-key'), '/etc']] as const) {
    // Quoted (round 8): the agent names the link and its target, so neither can start a line of its own.
    assert.ok(r.stderr.includes(`'${link}' is a symlink (to '${target}')`), `${link} not named: ${r.stderr}`);
    assert.ok(r.stderr.includes(`sudo -u shop-agent rm -- '${link}'`), r.stderr);
  }
  assert.equal(r.stderr.trim().split('\n').length, 2, `one line per link: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /replace it with the directory it points to/);
});

test('the wrapper\'s bash runs no ~/.bashrc a sandboxed command planted, even with a socket on stdin (bash\'s rshd check)', { skip: realSkip }, () => {
  // The wrapper's bash takes HOME from passwd (its environment is empty): this user's real home. An outer bubblewrap
  // binds a stand-in over it in a private mount namespace, so the real home is never read or written.
  const root = mkdtempSync(join(tmpdir(), 'wl-713-rc-'));
  const fake = join(root, 'home');
  const login = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(fake, '.claude'), { recursive: true });
  writeFileSync(join(fake, '.claude', '.credentials.json'), `${login}\n`, { mode: 0o600 });
  const loot = join(root, 'loot');
  // What one sandboxed command can write (~/.bashrc isn't masked); the next command's wrapper must not run it.
  writeFileSync(join(fake, '.bashrc'), `cat ~/.claude/.credentials.json >> ${JSON.stringify(loot)} 2>/dev/null\n`);
  writeFileSync(join(fake, '.bash_profile'), `cat ~/.claude/.credentials.json >> ${JSON.stringify(loot)} 2>/dev/null\n`);
  const passwdHome = userInfo().homedir;
  const pc = projectCommand('true', { user: 'shop-agent', home: passwdHome, hide: [] });
  const outer = [PROJECT_SANDBOX_TOOL, '--dev-bind', '/', '/', '--unshare-user', '--bind', fake, passwdHome, '--', ...pc.args.slice(4)];
  // stdin 'pipe': a socketpair, as a node spawn's default is.
  const r = spawnSync(outer[0]!, outer.slice(1), { cwd: root, env: {}, encoding: 'utf8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!(existsSync(loot) && readFileSync(loot, 'utf8').includes(login)), 'the wrapper ran the planted ~/.bashrc outside the sandbox and read the login');
});

test('a sandboxed command can\'t rename a directory above a hidden path to unmask it for the next command', { skip: realSkip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-mv-'));
  const home = join(root, 'agent');
  const key = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, '.config', 'shop-claude-key'), { recursive: true });
  writeFileSync(join(home, '.config', 'shop-claude-key', 'api_key'), `${key}\n`, { mode: 0o600 });
  const prov = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, 'keys', 'provider'), { recursive: true });
  writeFileSync(join(home, 'keys', 'provider', 'open'), `${prov}\n`, { mode: 0o600 });
  // And one outside the home (credentials.yaml may name any path), where the directories above it are bound onto
  // themselves: a rename there is refused as busy.
  const srv = join(root, 'srv');
  const out = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(srv, 'keys', 'provider'), { recursive: true });
  writeFileSync(join(srv, 'keys', 'provider', 'open'), `${out}\n`, { mode: 0o600 });
  const runAs = { user: 'shop-agent', home, hide: [join(home, 'keys', 'provider', 'open'), join(srv, 'keys', 'provider', 'open')] };
  const mv = asStandIn(`mv ~/.config ~/cfg2; mv ~/keys ~/k2; mv ~/keys/provider ~/p2; echo touched > ~/.config/still-writable; mv ${srv}/keys ${srv}/k2; mv ${srv}/keys/provider ${srv}/p2; echo touched > ${srv}/keys/still-writable`, runAs, root);
  const r = asStandIn(`cat ~/cfg2/shop-claude-key/api_key ~/k2/provider/open ~/p2/open ~/.config/shop-claude-key/api_key ~/keys/provider/open ${srv}/k2/provider/open ${srv}/p2/open ${srv}/keys/provider/open 2>&1; true`, runAs, root);
  for (const v of [key, prov, out]) assert.ok(!r.stdout.includes(v), `a renamed parent unmasked a secret: ${r.stdout}`);
  // Under the home: refused, the home being read-only inside the sandbox (#798); outside it: busy, as before.
  const lines = mv.stderr.trim().split('\n');
  for (const what of ['.config', 'keys', join('keys', 'provider')]) assert.ok(lines.some((l) => l.includes(`'${join(home, what)}'`) && /Read-only file system/.test(l)), `~ rename of ${what} not refused: ${mv.stderr}`);
  assert.ok(lines.some((l) => l.includes(`'${join(srv, 'keys')}'`) && /busy/i.test(l)), `rename outside the home not refused: ${mv.stderr}`);
  assert.ok(!existsSync(join(home, '.config', 'still-writable')), 'the home stays read-only (#798)');
  assert.equal(readFileSync(join(srv, 'keys', 'still-writable'), 'utf8'), 'touched\n', 'the directory\'s contents stay writable outside the home');
});

test('a symlink on the way to a hidden path, in a directory the agent can write, is refused: a command could swap it', { skip: !posix && 'bubblewrap is Linux only' }, () => {
  // An admin's layout: ~/.config a symlink to ~/realcfg, where credentials.sh's key dir is. Refused before anything
  // runs (no bubblewrap needed), naming the symlink and the fix.
  const root = mkdtempSync(join(tmpdir(), 'wl-713-ln-'));
  const home = join(root, 'agent');
  mkdirSync(join(home, 'realcfg', 'shop-claude-key'), { recursive: true });
  writeFileSync(join(home, 'realcfg', 'shop-claude-key', 'api_key'), 'PLANTED\n');
  symlinkSync(join(home, 'realcfg'), join(home, '.config'));
  const r = asStandIn('echo ran > ran.txt', { user: 'shop-agent', home, hide: [] }, root);
  assert.equal(r.status, osAdapter.SANDBOX_UNAVAILABLE, r.stderr);
  assert.ok(!existsSync(join(root, 'ran.txt')), 'nothing of the command ran');
  const esc = (s: string) => s.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&');
  assert.match(r.stderr, new RegExp(`'${esc(join(home, '.config'))}' is a symlink \\(to '${esc(join(home, 'realcfg'))}'\\) the agent user could change.*remove it as the agent user: sudo -u shop-agent rm -- '${esc(join(home, '.config'))}'.*replace it with a real directory the agent may read`));
  assert.equal(r.stderr.trim().split('\n').length, 1, `named once: ${r.stderr}`);
});

test('a hide path under /proc (another name for a file, per process) is refused, never skipped as unreadable', { skip: realSkip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-proc-'));
  const home = join(root, 'agent');
  const value = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(home, 'keys'), { recursive: true });
  writeFileSync(join(home, 'keys', 'open'), `${value}\n`, { mode: 0o600 });
  // /proc/1/root: this user can't stat it (it isn't pid 1's), so the hidden file looked absent and nothing was hidden.
  // `//proc/...` and `/./proc/...` (round 5): the same path, spelled so the wrapper's /proc check didn't match it.
  for (const p of [`/proc/1/root${home}/keys/open`, `/proc/self/root${home}/keys/open`, `//proc/1/root${home}/keys/open`, `/./proc/1/root${home}/keys/open`]) {
    const r = refusedOrRun(`cat ${join(home, 'keys', 'open')} 2>&1; true`, { user: 'shop-agent', home, hide: [p] }, root);
    assert.ok(!r.out.includes(value), `${p}: the secret was read`);
    assert.ok(r.refused, `${p}: not refused (${r.out})`);
  }
});

/** A command refused before it runs (projectCommand throws, or the wrapper exits 125), or what it printed. */
function refusedOrRun(command: string, runAs: { user: string; home: string; hide: readonly string[] }, cwd: string): { refused: boolean; out: string } {
  try {
    const r = asStandIn(command, runAs, cwd);
    return { refused: r.status === osAdapter.SANDBOX_UNAVAILABLE, out: `${r.stdout}${r.stderr}` };
  } catch (e) {
    return { refused: /normal form/.test((e as Error).message), out: '' };
  }
}

test('a hide path not in normal form is refused; a `..` can\'t be emptied by one command to unmask the secret for the next', { skip: realSkip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-713-dd-'));
  const home = join(root, 'agent');
  mkdirSync(home);
  const value = `PLANTED-${randomBytes(12).toString('hex')}`;
  mkdirSync(join(root, 'keys', 'sub', 'x'), { recursive: true });
  writeFileSync(join(root, 'keys', 'sub', 'key'), `${value}\n`, { mode: 0o600 });
  // The reviewer's R4b: one command removes the directory a `..` leaves, and the next skipped the path as absent.
  const runAs = { user: 'shop-agent', home, hide: [`${root}/keys/sub/x/../key`] };
  const control = refusedOrRun(`cat ${root}/keys/sub/key 2>&1; true`, runAs, root);
  refusedOrRun(`rmdir ${root}/keys/sub/x; true`, runAs, root);
  const next = refusedOrRun(`cat ${root}/keys/sub/key 2>&1; true`, runAs, root);
  for (const r of [control, next]) assert.ok(!r.out.includes(value), `the secret was read: ${r.out}`);
  assert.ok(control.refused && next.refused, 'refused, never run with a path the wrapper might resolve differently');
  // Round 7: a path the kernel can't stat in one go ("name too long") was taken for absent: PATH_MAX and NAME_MAX.
  const long = `${root}/${Array(25).fill('a'.repeat(200)).join('/')}/key`;
  for (const p of [`${root}/keys/./sub/key`, `${root}//keys/sub/key`, `${root}/keys/sub/`, '/', long, `${root}/${'b'.repeat(256)}`, `${root}/keys/a\nb`]) {
    assert.ok(refusedOrRun('true', { ...runAs, hide: [p] }, root).refused, p.slice(0, 120));
  }
  // The agent's home too (round 7): refused, never rewritten. A trailing slash included.
  for (const h of [`${home}/`, `${home}/../agent`, `${root}//agent`]) assert.ok(refusedOrRun('echo "$HOME"', { user: 'shop-agent', home: h, hide: [] }, root).refused, h);
  // `/` is a home some users have (separate-users' git regression runs as nobody with it): accepted as a home, never as
  // a path to hide.
  assert.doesNotThrow(() => projectCommand('true', { user: 'nobody', home: '/', hide: [] }));
  assert.throws(() => projectCommand('true', { user: 'nobody', home: '/', hide: ['/'] }), /normal form/);
});

// The reviewer's round-4 layouts (#787): a symlink the agent could still change by another route. Each is followed and
// masked once, then swapped by one command so the next command's masks miss the secret, unless it is refused.
const swaps: [string, (root: string, home: string) => { secret: string; hide: string[]; attack: string; read: string }][] = [
  ['G1: a symlink in an agent-owned 0555 directory (chmod, swap, chmod back)', (root) => {
    mkdirSync(join(root, 'ro'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'ro', 'profiles'));
    chmodSync(join(root, 'ro'), 0o555);
    return { secret: join(root, 'elsewhere', 'p2', '.credentials.json'), hide: [join(root, 'ro', 'profiles', 'p2', '.credentials.json')], attack: `chmod u+w ${root}/ro && ln -sfn ${root}/decoy ${root}/ro/profiles && chmod 555 ${root}/ro`, read: join(root, 'elsewhere', 'p2', '.credentials.json') };
  }],
  ['G2: a symlink in a 0555 directory whose parent the agent can write (rename it, rebuild it)', (root) => {
    mkdirSync(join(root, 'ro'));
    symlinkSync(join(root, 'elsewhere'), join(root, 'ro', 'profiles'));
    chmodSync(join(root, 'ro'), 0o555);
    return { secret: join(root, 'elsewhere', 'p2', '.credentials.json'), hide: [join(root, 'ro', 'profiles', 'p2', '.credentials.json')], attack: `mv ${root}/ro ${root}/ro-old && mkdir ${root}/ro && ln -s ${root}/decoy ${root}/ro/profiles && chmod 555 ${root}/ro`, read: join(root, 'elsewhere', 'p2', '.credentials.json') };
  }],
  ['G3: a chain, fixed link -> a link in the agent\'s home -> the secret (swap the second hop)', (root, home) => {
    symlinkSync(join(home, 'real'), join(home, 'hop'));
    mkdirSync(join(root, 'fixed'));
    symlinkSync(join(home, 'hop'), join(root, 'fixed', 'cfg'));
    chmodSync(join(root, 'fixed'), 0o555);
    return { secret: join(home, 'real', 'p', '.credentials.json'), hide: [join(root, 'fixed', 'cfg', 'p', '.credentials.json')], attack: `ln -sfn ${home}/decoy ${home}/hop`, read: join(home, 'real', 'p', '.credentials.json') };
  }],
];
for (const [what, build] of swaps) {
  test(`a symlink the agent could still change is refused, never followed and swapped: ${what}`, { skip: realSkip }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wl-713-sw-'));
    const home = join(root, 'agent');
    mkdirSync(home);
    for (const d of [join(root, 'decoy', 'p2'), join(home, 'decoy', 'p')]) mkdirSync(d, { recursive: true });
    const s = build(root, home);
    const value = `PLANTED-${randomBytes(12).toString('hex')}`;
    mkdirSync(join(s.secret, '..'), { recursive: true });
    writeFileSync(s.secret, `${value}\n`, { mode: 0o600 });
    const runAs = { user: 'shop-agent', home, hide: s.hide };
    const control = asStandIn(`cat ${JSON.stringify(s.read)} 2>&1; true`, runAs, root);
    asStandIn(`${s.attack}; true`, runAs, root);
    const next = asStandIn(`cat ${JSON.stringify(s.read)} 2>&1; true`, runAs, root);
    for (const r of [control, next]) assert.ok(!`${r.stdout}${r.stderr}`.includes(value), `the secret was read: ${r.stdout}`);
    assert.equal(control.status, osAdapter.SANDBOX_UNAVAILABLE, 'refused from the first command on');
    assert.match(control.stderr, /is a symlink \(to [^)]*\) the agent user could change/);
  });
}

test('a full run queued before this version (no hide list) ends with a named reason, not "runner died"', async () => {
  const state = mkdtempSync(join(tmpdir(), 'wl-713-q-'));
  mkdirSync(join(state, 'jobs'));
  const job = { id: 'old-1', kind: 'full-run', cwd: state, command: 'true', createdAt: new Date().toISOString(), status: 'queued', log: join(state, 'jobs', 'old-1.log'), runAs: { user: 'shop-agent', home: '/var/agent' } };
  writeFileSync(join(state, 'jobs', 'old-1.json'), JSON.stringify(job));
  const done = await runJob(state, 'old-1');
  assert.equal(done.status, 'error');
  assert.match(done.error ?? '', /no sandbox hide list .*queue it again/);
  assert.equal(readJob(state, 'old-1').status, 'error');
});
