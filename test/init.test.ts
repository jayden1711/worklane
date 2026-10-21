// `init`: the guided first setup (src/init.ts). The checklist in order, each step checked before the next; resumable
// from its state file; missing tools installed from pinned, checked downloads (refused on a mismatch); local and
// server mode; doctor's copy of the checklist with what the mode can't do; the dashboard's first-run view. Against a
// world of stand-ins (InitIo), except the end-to-end run at the bottom, which runs the CLI with stand-in claude and
// gh on its PATH (scripts/ci/stand-ins, as the CI jobs do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from './script-child-process.js';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { doctor as engineDoctor } from '../src/doctor.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { CI_CHOICE_EXIT, firstRunView, initCommand, localInitFile, readInitState, serverInitFile, stepsFor, unavailableIn, type InitArgs, type InitIo } from '../src/init.js';
import { checksumOf, installPlan, PINS, type InstallableTool, type ToolInstall } from '../src/tool-install.js';
import { launchdUnload, shareReadWithGroup, toolPlatform, which } from '../src/os/index.js';
import { srvCheckoutPath } from '../src/os/system-paths.js';
import { asPerson, engineCli, exampleProject, exampleRoles, repoRoot } from './helpers.js';
import { HOST_TOOLS, hostToolStandIns, onStandIns, testPath } from './host-tools.js';
import { onRealMachine } from './isolate.js';

const posix = process.platform === 'win32' && 'POSIX tools (tar, sh)';

// #738, rule A: doctor's own checks run host tools (gitleaks, claude, gh, loginctl, systemctl) from PATH, so every
// in-process doctor here runs with only recording stand-ins for them on PATH, never this machine's own.
const hostBin = mkdtempSync(join(tmpdir(), 'init-host-tools-'));
const hostTools = hostToolStandIns(hostBin, { tools: [...HOST_TOOLS, 'claude'], answers: { gitleaks: { version: '8.30.1\n' }, claude: { '--version': '2.1.296 (Claude Code)\n' } } });
const doctor = (...a: Parameters<typeof engineDoctor>) => onStandIns(hostBin, () => engineDoctor(...a));
process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'init-state-'));
// Server mode's records: the machine's (/var/lib/... on a server), here a scratch directory.
process.env[`${BRAND.envPrefix}_MACHINE_INIT_DIR`] = mkdtempSync(join(tmpdir(), 'init-machine-'));

/** The example project with a GitHub origin; `named`: its CI's check named (init finishes only with a CI chosen, #469). */
function repo(named = true): string {
  const { dir } = exampleProject();
  if (named) nameCheck(dir);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  return dir;
}

/** config.yaml names the check `test`, committed. */
function nameCheck(dir: string) {
  const f = join(dir, BRAND.configDir, 'config.yaml');
  writeFileSync(f, `${readFileSync(f, 'utf8')}\nrequired_checks: [test]\n`);
  execFileSync('git', ['-c', 'user.email=ada@example.com', '-c', 'user.name=Ada', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'name the CI check'], { cwd: dir });
}

interface World {
  tools: Set<string>;
  claudeIn: boolean;
  ghIn: boolean;
  push: boolean;
  prefix: string;
}

/** A world of stand-ins, recording what init did in it. */
function world(over: Partial<World> & { download?: InitIo['download']; plan?: InitIo['plan']; addProject?: InitIo['addProject']; ask?: (q: string) => string | null; onLogin?: (cmd: string) => void } = {}) {
  const w: World = { tools: new Set(['git', 'gitleaks', 'claude', 'gh']), claudeIn: true, ghIn: true, push: true, prefix: mkdtempSync(join(tmpdir(), 'init-prefix-')), ...over };
  const said: string[] = [];
  const downloads: string[] = [];
  const logins: string[] = [];
  const asked: string[] = [];
  let addProjects = 0;
  const io: InitIo = {
    which: (c) => (w.tools.has(c) || existsSync(join(w.prefix, 'bin', c)) ? `/stand-in/${c}` : null),
    serviceManagerEnv: () => ({ env: {} }),
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude' && args[0] === '-p') return { status: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '' }; // the login's proof: a minimal real call, answered
      if (cmd === 'claude' && a === 'auth status') return w.claudeIn ? { status: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' } : { status: 1, stdout: '{"loggedIn": false}', stderr: '' };
      if (cmd === 'gh' && a === 'auth status') return { status: w.ghIn ? 0 : 1, stdout: '', stderr: '' };
      if (cmd === 'gh' && /^api repos\/[^/]+\/[^/]+ --jq \.permissions\.push$/.test(a)) return { status: 0, stdout: `${w.push}\n`, stderr: '' };
      if (cmd === 'gh' && /\/protection --silent$/.test(a)) return { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      return { status: 1, stdout: '', stderr: `no stand-in for ${cmd} ${a}` };
    },
    interactive: async (cmd, args) => {
      logins.push(`${cmd} ${args.join(' ')}`);
      over.onLogin?.(cmd);
      return 0;
    },
    ask: async (q) => {
      asked.push(q);
      return over.ask ? over.ask(q) : null;
    },
    say: (l) => said.push(l),
    download: async (url, file) => {
      downloads.push(url);
      if (over.download) return over.download(url, file);
      writeFileSync(file, 'tampered');
    },
    plan: over.plan ?? ((t, p) => installPlan(t, p)),
    addProject: async (name, r) => {
      addProjects++;
      return over.addProject ? over.addProject(name, r) : { code: 1, steps: {}, last: 'no add-project here' };
    },
  };
  const args = (a: Partial<InitArgs> = {}): InitArgs => ({ target: undefined, mode: 'local', instance: undefined, yes: false, reset: false, cwd: process.cwd(), prefix: w.prefix, interactive: false, ...a });
  return { w, io, said, downloads, logins, asked, args, addProjects: () => addProjects, out: () => said.join('\n') };
}

test('init, local mode: the checklist in order; stopped at the Claude login, a rerun picks up there and keeps what was done', async () => {
  const root = repo();
  const t = world({ claudeIn: false });
  assert.equal(await initCommand(t.args({ target: root }), t.io), 1);
  const s1 = readInitState(localInitFile(root))!;
  assert.equal(s1.mode, 'local');
  assert.equal(s1.repo, 'example-org/example-shop', 'the repo, from its origin');
  assert.deepEqual(Object.entries(s1.steps).map(([k, v]) => [k, v.status]), [['tools', 'done'], ['claude', 'failed']], 'stopped at the first step not done; nothing after it ran');
  assert.match(s1.steps.claude!.detail, /not signed in, per `claude auth status`: run `claude auth login`, then `worklane init` again \(it picks up here\)/);
  assert.match(t.out(), /stopped at Claude login \(5 steps left\)/);
  assert.equal(s1.finishedAt, null);
  const toolsAt = s1.steps.tools!.at;

  // Signed in now. The rerun needs no --mode (the state has it), and starts over from the top, checking, not redoing.
  t.w.claudeIn = true;
  const again = world({ ...t.w });
  assert.equal(await initCommand(again.args({ target: root, mode: undefined }), again.io), 0, again.out());
  assert.match(again.out(), /resuming: 1 of 6 steps done earlier/);
  assert.match(again.out(), /\[1\/6\] Tools present\n {3}done earlier: node /);
  assert.deepEqual(again.downloads, [], 'nothing installed again');
  const s2 = readInitState(localInitFile(root))!;
  assert.equal(s2.steps.tools!.at, toolsAt, 'a step done earlier keeps when it was done');
  assert.deepEqual(stepsFor('local').map((s) => [s.id, s2.steps[s.id]?.status]), [['tools', 'done'], ['claude', 'done'], ['github', 'done'], ['repo-config', 'done'], ['protection', 'done'], ['discord', 'skipped']]);
  assert.match(s2.steps.github!.detail, /gh signed in; you can push to example-org\/example-shop/);
  assert.match(s2.steps['repo-config']!.detail, /\.worklane\/ valid \(example-org\/example-shop\), hooks installed/);
  assert.ok(existsSync(join(root, '.claude', 'settings.json')), 'the hooks for local runs, as `install` writes them');
  assert.match(s2.steps.protection!.detail, /main isn't protected on GitHub yet[\s\S]*reported only/);
  assert.ok(s2.finishedAt);
  assert.match(again.out(), /not in local mode: separate OS users: local mode runs the agents as you/);
  // A third run: everything done earlier, the optional step skipped earlier stays skipped (not asked again).
  const third = world({ ...t.w });
  assert.equal(await initCommand(third.args({ target: root }), third.io), 0);
  assert.match(third.out(), /resuming: 6 of 6/);
  assert.match(third.out(), /skipped earlier: optional/);
});

test('init: with a terminal, a missing login is opened (claude auth login, gh auth login) and checked again before going on', async () => {
  const root = repo();
  const t = world({ claudeIn: false, ghIn: false, onLogin: (cmd) => (cmd === 'claude' ? (t.w.claudeIn = true) : (t.w.ghIn = true)) });
  assert.equal(await initCommand(t.args({ target: root, interactive: true }), t.io), 0, t.out());
  assert.deepEqual(t.logins, ['claude auth login', 'gh auth login']);
  // A login that doesn't take: stopped there, not passed over.
  const u = world({ claudeIn: false });
  assert.equal(await initCommand(u.args({ target: repo(), interactive: true }), u.io), 1);
  assert.deepEqual(u.logins, ['claude auth login']);
  // Signed in to GitHub, but no push on the repo: stopped at GitHub, saying so.
  const v = world({ push: false });
  const root2 = repo();
  assert.equal(await initCommand(v.args({ target: root2 }), v.io), 1);
  assert.match(readInitState(localInitFile(root2))!.steps.github!.detail, /your login can't push to example-org\/example-shop/);
  // No GitHub origin (and no config naming the repo): said, not guessed.
  const dir = mkdtempSync(join(tmpdir(), 'init-no-origin-'));
  execFileSync('git', ['init', '-q', dir]);
  const n = world();
  assert.equal(await initCommand(n.args({ target: dir }), n.io), 1);
  assert.match(readInitState(localInitFile(dir))!.steps.github!.detail, /no GitHub origin: add one/);
});

test('init: the mode is asked when not given (no terminal: refused, never guessed)', async () => {
  const root = repo();
  const none = world();
  assert.equal(await initCommand(none.args({ target: root, mode: undefined }), none.io), 2);
  assert.match(none.out(), /give --mode local or --mode server \(there's no terminal to ask on\)/);
  assert.equal(readInitState(localInitFile(root)), null, 'nothing recorded');
  const asked = world({ ask: () => 'local' });
  assert.equal(await initCommand(asked.args({ target: root, mode: undefined, interactive: true }), asked.io), 0, asked.out());
  assert.match(asked.asked[0]!, /Where should Worklane run\?[\s\S]*local {3}on this machine, as you[\s\S]*server {2}a hardened multi-user Linux server/);
  const bad = world({ ask: () => 'cloud' });
  assert.equal(await initCommand(bad.args({ target: repo(), mode: undefined, interactive: true }), bad.io), 2);
  assert.match(bad.out(), /"cloud" is neither local nor server/);
  assert.match((await (async () => { const x = world(); await initCommand(x.args({ target: join(root, 'nowhere') }), x.io); return x.out(); })()), /no directory .*nowhere: local mode sets up a checkout/);
});

/** A tarball holding one executable, and its sha256: a release download as a test can make it. */
function tarball(name: string): { file: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), 'init-tgz-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', name), `#!/bin/sh\necho "${name} stand-in"\n`);
  chmodSync(join(dir, 'src', name), 0o755);
  const file = join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', join(dir, 'src'), name]);
  return { file, sha256: checksumOf(file, 'sha256') };
}

test('init, tools: a missing tool is shown first (URL, checksum, where), installed only when said, and checked against its checksum', { skip: posix }, async () => {
  const tgz = tarball('gitleaks');
  const plan = (sha256: string) => (t: InstallableTool, prefix: string): ToolInstall | null => (t === 'gitleaks' ? { tool: t, version: '8.30.1', url: 'https://downloads.example.test/gitleaks_8.30.1.tar.gz', checksum: { algo: 'sha256', value: sha256 }, archive: 'tar.gz', member: 'gitleaks', dest: join(prefix, 'bin', 'gitleaks'), prefix } : installPlan(t, prefix));
  const download = async (_url: string, file: string) => copyFileSync(tgz.file, file);

  // No --yes and no terminal: shown, not installed.
  const ask = world({ tools: new Set(['git', 'claude', 'gh']), plan: plan(tgz.sha256), download });
  assert.equal(await initCommand(ask.args({ target: repo() }), ask.io), 1);
  assert.match(ask.out(), new RegExp(`gitleaks 8\\.30\\.1: https://downloads\\.example\\.test/gitleaks_8\\.30\\.1\\.tar\\.gz \\(sha256 ${tgz.sha256}\\) -> \\S+/bin/gitleaks`));
  assert.match(ask.out(), /missing: gitleaks; run `worklane init --yes` to install them as shown/);
  assert.deepEqual(ask.downloads, [], 'nothing downloaded before a yes');

  // Said no on the terminal: not installed either.
  const no = world({ tools: new Set(['git', 'claude', 'gh']), plan: plan(tgz.sha256), download, ask: () => 'n' });
  assert.equal(await initCommand(no.args({ target: repo(), interactive: true }), no.io), 1);
  assert.match(no.asked.join(), /Install these\? \[y\/N\]/);
  assert.deepEqual(no.downloads, []);

  // --yes: downloaded, checked, unpacked into <prefix>/bin, and the step checked again (it finds it).
  const yes = world({ tools: new Set(['git', 'claude', 'gh']), plan: plan(tgz.sha256), download });
  assert.equal(await initCommand(yes.args({ target: repo(), yes: true }), yes.io), 0, yes.out());
  const bin = join(yes.w.prefix, 'bin', 'gitleaks');
  assert.equal(execFileSync(bin, { encoding: 'utf8' }).trim(), 'gitleaks stand-in');
  assert.equal(statSync(bin).mode & 0o777, 0o755);
  assert.deepEqual(yes.downloads, ['https://downloads.example.test/gitleaks_8.30.1.tar.gz']);
  assert.match(yes.out(), /installed gitleaks 8\.30\.1 at /);

  // A download that doesn't match its checksum: refused, nothing installed, the step failed with both sums.
  const wrong = world({ tools: new Set(['git', 'claude', 'gh']), plan: plan('0'.repeat(64)), download });
  const root = repo();
  assert.equal(await initCommand(wrong.args({ target: root, yes: true }), wrong.io), 1);
  assert.ok(!existsSync(join(wrong.w.prefix, 'bin', 'gitleaks')), 'nothing installed');
  assert.match(readInitState(localInitFile(root))!.steps.tools!.detail, new RegExp(`checksum mismatch for https://downloads\\.example\\.test/gitleaks_8\\.30\\.1\\.tar\\.gz: got sha256 ${tgz.sha256}, want 0{64}; nothing was installed`));
});

test("init, tools: the real pins: a tampered download of the pinned gitleaks is refused against the engine's own checksum", { skip: (posix || !toolPlatform()) && 'a pinned platform' }, async () => {
  const t = world({ tools: new Set(['git', 'claude', 'gh']) });
  const root = repo();
  assert.equal(await initCommand(t.args({ target: root, yes: true }), t.io), 1);
  const plat = toolPlatform()!;
  const want = PINS.gitleaks.sha256[`${plat.os}-${plat.arch}`];
  assert.deepEqual(t.downloads, [`https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${plat.os}_${plat.arch}.tar.gz`]);
  assert.match(readInitState(localInitFile(root))!.steps.tools!.detail, new RegExp(`checksum mismatch for \\S+gitleaks_8\\.30\\.1_${plat.os}_${plat.arch}\\.tar\\.gz: got sha256 [0-9a-f]{64}, want ${want}`));
  assert.ok(!existsSync(join(t.w.prefix, 'bin', 'gitleaks')));
  // git isn't something init installs: said, with how.
  const g = world({ tools: new Set(['claude', 'gh', 'gitleaks']) });
  assert.equal(await initCommand(g.args({ target: repo() }), g.io), 1);
  assert.match(g.out(), /not something worklane installs here: git \(git: on macOS `xcode-select --install`; on Linux your package manager\)/);
});

test("the pins: init's are bootstrap.sh's (gitleaks, Claude Code), and each platform's download is named as its project publishes it", () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'bootstrap.sh'), 'utf8');
  const v = (name: string) => sh.match(new RegExp(`^${name}=(\\S+)$`, 'm'))?.[1];
  assert.equal(v('GITLEAKS_VERSION'), PINS.gitleaks.version);
  assert.equal(v('CLAUDE_VERSION'), PINS.claude.version);
  for (const [k, sum] of Object.entries(PINS.gitleaks.sha256)) assert.equal(v(`GITLEAKS_SHA256_${k.replace('-', '_').toUpperCase()}`), sum, `gitleaks ${k}`);
  const p = installPlan('gh', '/p', { os: 'darwin', arch: 'arm64' })!;
  assert.deepEqual([p.url, p.archive, p.member, p.checksum.value], ['https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_macOS_arm64.zip', 'zip', 'gh_2.101.0_macOS_arm64/bin/gh', PINS.gh.sha256['darwin-arm64']]);
  assert.equal(installPlan('gh', '/p', { os: 'linux', arch: 'x64' })!.url, 'https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.tar.gz');
  assert.equal(installPlan('gitleaks', '/p', { os: 'linux', arch: 'arm64' })!.checksum.value, PINS.gitleaks.sha256['linux-arm64']);
  const c = installPlan('claude', '/p', null)!;
  assert.deepEqual([c.url, c.checksum.algo, c.archive], ['https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.296.tgz', 'sha512', 'npm']);
  assert.equal(installPlan('gitleaks', '/p', null), null, 'nothing pinned for native Windows');
  assert.deepEqual(toolPlatform('win32', 'x64'), null);
  assert.deepEqual(toolPlatform('darwin', 'arm64'), { os: 'darwin', arch: 'arm64' });
});

test('init, server mode: as root only; tools are never installed; the Claude login, GitHub and the checkout are handed to add-project', async () => {
  const notRoot = world();
  assert.equal(await initCommand(notRoot.args({ target: 'example-org/shop', mode: 'server' }), notRoot.io, () => false), 2);
  assert.match(notRoot.out(), /server mode runs the setup scripts as root: sudo worklane init --mode server example-org\/shop --instance shop/);
  // A missing tool: the owner's step (bootstrap --hardened), not downloaded.
  const bare = world({ tools: new Set(['git', 'claude']) });
  assert.equal(await initCommand(bare.args({ target: 'example-org/shop', mode: 'server', instance: 'shopa', yes: true }), bare.io, () => true), 1);
  assert.match(readInitState(serverInitFile('shopa'))!.steps.tools!.detail, /missing: gitleaks\. On a server, installing tools is the owner's step: sudo bash scripts\/bootstrap\.sh --hardened/);
  assert.deepEqual(bare.downloads, []);
  // add-project stopping at the App: the Claude step fails with its line, and the rerun hands off again.
  const stopped = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 1, steps: { instance: 'done', app: 'failed' }, last: 'app failed: no dashboard hub (retry: ...)' }) });
  assert.equal(await initCommand(stopped.args({ target: 'example-org/shop', mode: 'server', instance: 'shopb' }), stopped.io, () => true), 1);
  assert.match(readInitState(serverInitFile('shopb'))!.steps.claude!.detail, /add-project stopped \(exit 1\): app failed: no dashboard hub/);
  const all = Object.fromEntries(['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'].map((s) => [s, 'done']));
  const manifest = { app: "the instance's GitHub App is set up (credentials.yaml github: kind app), made through the manifest flow" };
  const ok = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 0, steps: all, details: manifest, last: '' }) });
  assert.equal(await initCommand(ok.args({ target: 'example-org/shop', mode: 'server', instance: 'shopb' }), ok.io, () => true), 0, ok.out());
  assert.equal(ok.addProjects(), 1, 'one hand-off covers the Claude login, GitHub, the checkout and the coordinator');
  const s = readInitState(serverInitFile('shopb'))!;
  assert.deepEqual(stepsFor('server').map((x) => [x.id, s.steps[x.id]?.status]), [['tools', 'done'], ['claude', 'done'], ['github', 'done'], ['repo-config', 'done'], ['coordinator', 'done'], ['protection', 'done'], ['discord', 'skipped'], ['tailscale', 'skipped']]);
  assert.match(s.steps.github!.detail, /GitHub App \(made through the manifest flow\)/);
  assert.equal(await initCommand(ok.args({ target: 'not a repo', mode: 'server' }), ok.io, () => true), 2);
});

test('init, server mode: the true status. A failed or waiting add-project step is never "all done"; how the App was made, as add-project found it', async () => {
  const steps = (over: Record<string, string>) => ({ ...Object.fromEntries(['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'].map((s) => [s, 'done'])), ...over });
  const byHand = "the instance's GitHub App is set up (credentials.yaml github: kind app), made by hand (credentials.sh github-app)";
  // The audit's run: the service step failed, after every step before it was done. Exit 1, the coordinator step failed.
  const failed = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 1, steps: steps({ service: 'failed', 'test-user': 'started' }), details: { app: byHand, service: '.worklane: missing' }, last: 'service failed: .worklane: missing' }) });
  assert.equal(await initCommand(failed.args({ target: 'example-org/shop', mode: 'server', instance: 'shopc' }), failed.io, () => true), 1, failed.out());
  assert.doesNotMatch(failed.out(), /all \d+ steps done/);
  assert.match(failed.out(), /stopped at Coordinator running/);
  const f = readInitState(serverInitFile('shopc'))!;
  assert.deepEqual([f.steps.github?.status, f.steps['repo-config']?.status, f.steps.coordinator?.status, f.finishedAt], ['done', 'done', 'failed', null]);
  assert.match(f.steps.coordinator!.detail, /add-project stopped \(exit 1\): service failed: \.worklane: missing/);
  // Never claims the manifest flow for an App made by hand.
  assert.match(f.steps.github!.detail, /GitHub App \(made by hand \(credentials\.sh github-app\)\)/);
  assert.doesNotMatch(f.steps.github!.detail, /manifest/);
  assert.equal(failed.addProjects(), 1, 'add-project runs once per init');

  // A repo with no config: the service waits for the setup PR (exit 3). The repo config isn't done until it merges.
  const pr = 'https://github.com/example-org/shop/pull/1';
  const waiting = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 3, steps: steps({ service: 'waiting', 'test-user': 'started' }), details: { app: byHand, service: `waiting for the setup PR ${pr} to merge: review it, merge it, and the coordinator starts` }, last: '' }) });
  assert.equal(await initCommand(waiting.args({ target: 'example-org/shop', mode: 'server', instance: 'shopd' }), waiting.io, () => true), 1, waiting.out());
  const w = readInitState(serverInitFile('shopd'))!;
  assert.equal(w.steps['repo-config']!.status, 'failed');
  assert.match(w.steps['repo-config']!.detail, new RegExp(`waiting for the setup PR ${pr.replaceAll('/', '\\/').replaceAll('.', '\\.')} to merge.*\\(add-project: service\\)`));
  assert.equal(w.steps.coordinator, undefined, 'not reached');
  assert.equal(waiting.addProjects(), 1);

  // Merged since: the rerun's add-project goes on to the end, and only then is it all done.
  const merged = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 0, steps: steps({}), details: { app: byHand }, last: '' }) });
  assert.equal(await initCommand(merged.args({ target: 'example-org/shop', mode: 'server', instance: 'shopd' }), merged.io, () => true), 0, merged.out());
  assert.match(merged.out(), /all 8 steps done or skipped/);
  assert.deepEqual(stepsFor('server').map((x) => readInitState(serverInitFile('shopd'))!.steps[x.id]?.status), ['done', 'done', 'done', 'done', 'done', 'done', 'skipped', 'skipped']);
});

test('init (#469), local mode: a config with no CI chosen (an empty required_checks, PR mode) is never "all done": the repo-config step says why and the fix; chosen, it finishes', async () => {
  const root = repo(false);
  const t = world();
  assert.equal(await initCommand(t.args({ target: root }), t.io), CI_CHOICE_EXIT, t.out());
  assert.equal(CI_CHOICE_EXIT, 5, "bootstrap.sh reads it as 5: it ends at the wizard's URL then");
  const s = readInitState(localInitFile(root))!;
  assert.equal(s.steps['repo-config']!.status, 'failed');
  assert.match(s.steps['repo-config']!.detail, /^\.worklane\/ valid \(example-org\/example-shop\), hooks installed; but required_checks is empty and no CI is chosen: no PR is ever marked ready, so nothing ever merges\. Fix: on the dashboard's First-run page, "Required checks named": add the starter CI .* Then run `worklane init` again \(it picks up here\)$/);
  assert.match(t.out(), /stopped at Repo config/);
  assert.equal(s.finishedAt, null);
  nameCheck(root);
  const again = world();
  assert.equal(await initCommand(again.args({ target: root }), again.io), 0, again.out());
  assert.equal(readInitState(localInitFile(root))!.steps['repo-config']!.status, 'done');
});

test('init (#469), server mode: the same refusal, judged on the checkout add-project made, as its default branch was last fetched', async () => {
  const all = Object.fromEntries(['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'].map((s) => [s, 'done']));
  const ok = () => world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 0, steps: all, details: {}, last: '' }) });
  const { dir: upstream } = exampleProject();
  const checkout = srvCheckoutPath('shopz', 'shop');
  onRealMachine(checkout); // throws unless it is inside this test's system root: never the machine's own /srv (#815)
  mkdirSync(dirname(checkout), { recursive: true });
  execFileSync('git', ['clone', '-q', upstream, checkout]);
  const first = ok();
  assert.equal(await initCommand(first.args({ target: 'example-org/shop', mode: 'server', instance: 'shopz' }), first.io, () => true), CI_CHOICE_EXIT, first.out());
  const s = readInitState(serverInitFile('shopz'))!;
  assert.equal(s.steps['repo-config']!.status, 'failed');
  assert.match(s.steps['repo-config']!.detail, /required_checks is empty and no CI is chosen/);
  assert.equal(s.steps.coordinator, undefined, 'not reached');
  // The choice merged on the default branch and fetched there (the coordinator fetches it): init finishes.
  nameCheck(upstream);
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: checkout });
  const second = ok();
  assert.equal(await initCommand(second.args({ target: 'example-org/shop', mode: 'server', instance: 'shopz' }), second.io, () => true), 0, second.out());
  assert.equal(readInitState(serverInitFile('shopz'))!.steps['repo-config']!.status, 'done');
});

test('init, server mode: the record is the machine\'s, outside root\'s home, so doctor as the coordinator reads it; one it cannot read is said, never "not reached yet"', async () => {
  const machine = process.env[`${BRAND.envPrefix}_MACHINE_INIT_DIR`]!;
  assert.equal(serverInitFile('shope'), join(machine, 'shope.json'));
  assert.ok(!serverInitFile('shope').startsWith(process.env[`${BRAND.envPrefix}_STATE_DIR`]!), "not under root's own state");
  const t = world({ tools: new Set(['git', 'claude', 'gitleaks']), addProject: async () => ({ code: 3, steps: { instance: 'done', app: 'done', 'claude-token': 'done', checkout: 'done', policy: 'done', service: 'waiting' }, details: { service: 'waiting for the setup PR https://github.com/example-org/shop/pull/2 to merge' }, last: '' }) });
  await initCommand(t.args({ target: 'example-org/shop', mode: 'server', instance: 'shope' }), t.io, () => true);
  const root = repo();
  const checks = doctor(root, { mode: 'server', instance: 'shope', initIo: t.io }).filter((c) => c.name.startsWith('setup'));
  const level = Object.fromEntries(checks.map((c) => [c.name, c.level]));
  // The registry's server steps (src/setup-steps.ts): what this user can't see for itself is read from init's record;
  // the setup PR's wait is the config step's, and the coordinator (which nothing runs without) fails doctor until then.
  // init's groups (src/setup-steps.ts walked groups), as before: Claude and GitHub from init's record, the repo config
  // waiting on its setup PR; and each step's own line.
  assert.deepEqual([level['setup tools'], level['setup claude'], level['setup github'], level['setup repo-config'], level['setup coordinator']], ['ok', 'ok', 'ok', 'fail', 'fail'], JSON.stringify(checks));
  assert.match(checks.find((c) => c.name === 'setup repo-config')!.detail, /^Repo config \(server mode\): waiting for the setup PR https:\/\/github\.com\/example-org\/shop\/pull\/2/);
  assert.match(checks.find((c) => c.name === 'setup step claude-token')!.detail, /as init recorded it \(add-project: claude-token\)/);
  assert.ok(!checks.some((c) => c.level === 'ok' && /not reached yet/.test(c.detail)));
  // Opened to one group, read only, owner kept (Linux): what writeServerInitState does with the coordinator's group.
  const f = join(mkdtempSync(join(tmpdir(), 'init-share-')), 'x.json');
  writeFileSync(f, '{}', { mode: 0o600 });
  const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(shareReadWithGroup(f, group, 'darwin'), false, 'only on Linux');
  if (process.platform === 'linux') {
    assert.equal(shareReadWithGroup(f, group), true);
    assert.equal(statSync(f).mode & 0o777, 0o640);
    assert.equal(shareReadWithGroup(f, 'no-such-group-here'), false);
  }
  // A record there that this user can't read (another user's, closed): one failure saying so.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(serverInitFile('shope'), 0o000);
    try {
      const closed = doctor(root, { mode: 'server', instance: 'shope', initIo: t.io }).filter((c) => c.name.startsWith('setup'));
      assert.deepEqual(closed.map((c) => [c.name, c.level]), [['setup', 'fail']]);
      assert.match(closed[0]!.detail, /can't read init's record .*shope\.json as this user \(EACCES\)/);
    } finally {
      chmodSync(serverInitFile('shope'), 0o600);
    }
  }
});

test('doctor: every setup step of the registry checked live, and what the mode cannot do, each saying why; never a failure once init is done', async () => {
  const root = repo();
  const t = world();
  assert.equal(await initCommand(t.args({ target: root }), t.io), 0);
  const names = (cs: { name: string }[]) => cs.map((c) => c.name);
  const local = doctor(root, { initIo: t.io });
  const setup = local.filter((c) => c.name.startsWith('setup '));
  // init's walked groups, one line each and all ok; then every registry step (src/setup-steps.ts) on its own line, in
  // its order (linger only where loginctl answers: Linux), a step not done a warning, never a failure.
  assert.deepEqual(names(setup).filter((n) => !n.startsWith('setup step ')), ['setup tools', 'setup claude', 'setup github', 'setup repo-config', 'setup protection', 'setup discord']);
  assert.ok(setup.filter((c) => !c.name.startsWith('setup step ')).every((c) => c.level === 'ok'), JSON.stringify(setup));
  assert.deepEqual(names(setup).filter((n) => n.startsWith('setup step ') && n !== 'setup step linger'), ['engine', 'path', 'tools', 'docker', 'claude-login', 'gh-login', 'origin', 'default-branch', 'questions', 'config-on-main', 'hooks', 'owners', 'required-checks', 'agents-config', 'pre-commit', 'fingerprints', 'protection', 'deploy-gate', 'service', 'first-task'].map((id) => `setup step ${id}`));
  assert.ok(setup.every((c) => c.level !== 'fail'), JSON.stringify(setup));
  for (const id of ['tools', 'claude-login', 'gh-login', 'origin', 'hooks', 'owners']) assert.equal(setup.find((c) => c.name === `setup step ${id}`)!.level, 'ok', id);
  const off = local.filter((c) => c.level === 'off');
  assert.deepEqual(names(off), ['not in local mode: separate OS users', 'not in local mode: root-run add-project', 'not in local mode: test sandbox']);
  assert.match(off[1]!.detail, /Add project runs scripts\/setup\/add-project\.sh as root through the machine helper, and local mode has neither root nor the helper/);
  assert.match(off[2]!.detail, /needs Docker in local mode[\s\S]*docker isn't on PATH/);
  // With Docker, the test sandbox is there.
  t.w.tools.add('docker');
  assert.deepEqual(names(doctor(root, { initIo: t.io }).filter((c) => c.level === 'off')), ['not in local mode: separate OS users', 'not in local mode: root-run add-project']);
  // Server mode has everything.
  assert.deepEqual(names(doctor(root, { mode: 'server', initIo: t.io }).filter((c) => c.level === 'off')), []);
  assert.deepEqual(unavailableIn('server'), []);
  // Live: signed out of Claude since, doctor says so and where init picks up.
  t.w.claudeIn = false;
  const signedOut = doctor(root, { initIo: t.io });
  const c = signedOut.find((x) => x.name === 'setup claude')!;
  assert.equal(c.level, 'fail');
  assert.match(c.detail, /Claude login \(local mode\): not signed in, per `claude auth status`; `worklane init` picks up here/);
  const step = signedOut.find((x) => x.name === 'setup step claude-login')!;
  assert.equal(step.level, 'warn');
  assert.match(step.detail, /Signed in to Claude \(local mode\): not signed in, per `claude auth status`; today: Run `claude auth login` in a terminal, then `worklane init` again/);
  // Never run: one line saying how, nothing else.
  const fresh = exampleProject().dir;
  const none = doctor(fresh, { initIo: t.io }).filter((x) => x.name.startsWith('setup') || x.level === 'off');
  assert.deepEqual(none.map((x) => [x.name, x.level]), [['setup', 'warn']]);
  assert.match(none[0]!.detail, /`worklane init --mode local\|server` walks the checklist/);
  // In a marked test run, doctor never asks the service manager: its stand-ins saw no call (#738, rule A).
  assert.deepEqual(hostTools.calls().filter((c) => c.tool === 'systemctl' || c.tool === 'launchctl'), []);
});

test('the dashboard first-run page: the checklist init recorded and what local mode lacks, for the owner and writers only', async () => {
  const root = repo();
  const t = world({ claudeIn: false });
  await initCommand(t.args({ target: root }), t.io);
  const stateDir = projectStateDir(root);
  // The page checks the steps live in a worker with the real probe: it inherits this PATH, only stand-ins (#738, rule A).
  const savedPath = process.env.PATH;
  process.env.PATH = testPath(hostBin);
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'init-slots-')) });
  try {
    const base = d.url.split('/?')[0]!;
    const get = (user: string) => fetch(`${base}/api/first-run`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(user) } });
    const r = await get('example-owner');
    assert.equal(r.status, 200);
    const f = (await r.json()) as ReturnType<typeof firstRunView>;
    assert.equal(f.mode, 'local');
    assert.equal(f.recorded, true);
    assert.deepEqual(f.steps.map((s) => [s.id, s.status]), [['tools', 'done'], ['claude', 'failed'], ['github', 'pending'], ['repo-config', 'pending'], ['protection', 'pending'], ['discord', 'pending']]);
    assert.deepEqual([f.done, f.total], [1, 6]);
    assert.equal(f.command, `worklane init ${root}`);
    assert.deepEqual(f.unavailable.map((u) => u.feature).slice(0, 2), ['separate OS users', 'root-run add-project']);
    assert.equal((await get('example-collaborator')).status, 200);
    const v = await get('someone-else');
    assert.equal(v.status, 403);
    assert.match(((await v.json()) as { error: string }).error, /^the first-run checklist is for the instance's owners and writers/);
  } finally {
    await d.close();
    process.env.PATH = savedPath;
  }
  // Never run here: all pending, no mode, and the command to start.
  const empty = firstRunView(join(mkdtempSync(join(tmpdir(), 'init-none-')), 'init.json'), { root: '/r', repo: 'o/r', instance: null });
  assert.deepEqual([empty.recorded, empty.mode, empty.done, empty.command], [false, null, 0, 'worklane init --mode local /r']);
  assert.equal(firstRunView('/nowhere/init.json', { root: '/r', repo: 'o/r', instance: 'shop' }).command, 'sudo worklane init --mode server o/r --instance shop');
});

test('init, end to end in local mode: the CLI with stand-in claude and gh, through doctor; a rerun changes nothing', { skip: posix }, () => {
  const root = repo();
  const bin = mkdtempSync(join(tmpdir(), 'init-bin-'));
  // gitleaks as the tools step and doctor ask it (installs are tested above, against their checksums).
  writeFileSync(join(bin, 'gitleaks'), '#!/bin/sh\necho 8.30.1\n');
  chmodSync(join(bin, 'gitleaks'), 0o755);
  // #738, rule A: the CLI this test starts isn't a marked test run (its environment is built from scratch), and its
  // PATH ends in /usr/bin:/bin, so every host tool init and doctor can run gets a recording stand-in here. systemctl
  // answers the Claude step's `--user show-environment` as a manager that sets none of the login variables; any
  // other call fails, as with no bus. gh and claude are scripts/ci/stand-ins'.
  const tools = hostToolStandIns(bin, { tools: ['systemctl', 'launchctl', 'loginctl', 'docker', 'tailscale'], answers: { systemctl: { '--user show-environment': 'PATH=/usr/bin:/bin\n' } } });
  const home = mkdtempSync(join(tmpdir(), 'init-home-'));
  const env = { PATH: [bin, join(repoRoot, 'scripts', 'ci', 'stand-ins'), dirname(process.execPath), dirname(which('git')!), '/usr/bin', '/bin'].join(':'), HOME: home, [`${BRAND.envPrefix}_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'init-e2e-state-')), [`${BRAND.envPrefix}_PREFIX`]: join(home, '.local') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  const first = cli('init', '--mode', 'local', '--yes', root);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /\[2\/6\] Claude login\n {3}done: signed in \(claude\.ai\)/);
  assert.match(first.stdout, /\[3\/6\] GitHub\n {3}done: gh signed in; you can push to example-org\/example-shop/);
  assert.match(first.stdout, /kept \.worklane\/; hooks merged into/);
  const second = cli('init', root);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /resuming: 6 of 6/);
  assert.doesNotMatch(second.stdout, /kept \.worklane|installed /, 'nothing done twice');
  const doc = cli('doctor', '--root', root);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  for (const id of ['tools', 'claude', 'github', 'repo-config', 'protection', 'discord']) assert.match(doc.stdout, new RegExp(`^ok {4}setup ${id}: `, 'm'));
  for (const id of ['tools', 'claude-login', 'gh-login', 'origin', 'hooks', 'owners']) assert.match(doc.stdout, new RegExp(`^ok {4}setup step ${id}: `, 'm'));
  assert.match(doc.stdout, /^off {3}not in local mode: separate OS users: /m);
  // Signed out since: doctor fails, naming the step. (#738: claude is asked with the agents' environment only, so its
  // stand-in reads the sign-out from its home, where a real login lives; gh's still from STANDIN_SIGNED_OUT.)
  mkdirSync(join(home, '.claude-stand-in'), { recursive: true });
  writeFileSync(join(home, '.claude-stand-in', 'signed-out'), '');
  const out = spawnSync(process.execPath, [engineCli, 'doctor', '--root', root], { encoding: 'utf8', env: { ...env, STANDIN_SIGNED_OUT: '1' } });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^FAIL {2}setup claude: Claude login \(local mode\): not signed in/m);
  // The service manager's stand-ins were asked only read-only queries: the Claude step's environment, and (this child
  // isn't a marked test run) whether the coordinator's unit is active. Never launchd, and nothing that changes a unit.
  const manager = tools.calls().filter((c) => c.tool === 'systemctl' || c.tool === 'launchctl');
  assert.ok(manager.some((c) => c.args.join(' ') === '--user show-environment'), JSON.stringify(manager));
  assert.deepEqual(manager.filter((c) => !(c.tool === 'systemctl' && (c.args.join(' ') === '--user show-environment' || (c.args[0] === '--user' && c.args[1] === 'is-active' && c.args.length === 3)))), [], 'nothing beyond those queries');
});

test("down on a Mac: launchd still listing the agent after bootout (as on the macOS runner) is waited out, booted out again by its plist, and never reported gone while it isn't", () => {
  const calls: string[] = [];
  // Listed for the first 6 looks after the first bootout, then gone.
  let looks = 0;
  const lingering = (args: string[]) => {
    calls.push(args.join(' '));
    if (args[0] === 'print') return looks++ < 7;
    return true;
  };
  assert.equal(launchdUnload('dev.x.shop', '/p/dev.x.shop.plist', { uid: 501, run: lingering, sleep: () => {} }), true);
  assert.equal(calls[1], 'bootout gui/501/dev.x.shop');
  assert.ok(calls.includes('bootout gui/501 /p/dev.x.shop.plist'), 'booted out again by its plist');
  assert.equal(calls.filter((c) => c.startsWith('bootout')).length, 2);
  // Never unloads: false (down then says so), after the wait.
  assert.equal(launchdUnload('dev.x.shop', '/p', { uid: 501, run: (a) => a[0] === 'print' || true, sleep: () => {}, waitMs: 2000 }), false);
  // Not loaded at all: nothing to do.
  const none: string[] = [];
  assert.equal(launchdUnload('dev.x.shop', '/p', { uid: 501, run: (a) => (none.push(a[0]!), a[0] !== 'print'), sleep: () => {} }), true);
  assert.deepEqual(none, ['print']);
});
