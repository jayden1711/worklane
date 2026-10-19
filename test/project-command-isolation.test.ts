// Issue #713: project commands (checks, worktree setup, full runs, suite tuning, a browser flow's app, auto-config) run
// code agents wrote, as the agent user. They run inside a sandbox that hides the agent's credentials, and what they
// print reaches no event or prompt with a credential in it.
//
// No real sudo and no real state: the current user stands in for the agent user (the command's own `env -i ...`, run
// without the `sudo -n -u <agent> --` in front of it), and its "home" is a temp dir holding planted stand-in keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
// Namespace imports: run against the code before #713 (the fail-without), a name it lacks is undefined, not a load error.
import * as osAdapter from '../src/os/index.js';
import { sh } from '../src/coordinator/shared.js';
import { createWorktree, createWorktreeAsync } from '../src/worktrees.js';
import * as instance from '../src/instance.js';
import type { CredentialsFile } from '../src/instance.js';

const { projectCommand } = osAdapter;
const posix = process.platform === 'linux';
const PROJECT_SANDBOX_TOOL = '/usr/bin/bwrap';
// The real sandbox: bubblewrap at its fixed path, allowed to make its namespaces here. ci-slow's real-users job sets
// PROJECT_SANDBOX_REQUIRED=1 after machine.sh installs it, so there a missing sandbox fails instead of skipping.
const sandboxRuns = posix && spawnSync(PROJECT_SANDBOX_TOOL,['--dev-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', '/bin/sh', '-c', ':']).status === 0;
const realSkip = process.env.PROJECT_SANDBOX_REQUIRED === '1' ? false : !posix ? 'bubblewrap is Linux only' : !sandboxRuns && `no usable ${PROJECT_SANDBOX_TOOL} here (ci-slow's real-users job runs this with it)`;

/** Run a project command as projectCommand builds it for the agent user, as this user: its argv after `sudo -n -u <agent> --`. */
function asStandIn(command: string, runAs: { user: string; home: string; hide?: string[] }, cwd: string, o: { sandboxTool?: string } = {}) {
  const pc = projectCommand(command, runAs, {}, o);
  assert.equal(pc.file, 'sudo');
  assert.deepEqual(pc.args.slice(0, 5), ['-n', '-u', runAs.user, '--', '/usr/bin/env']);
  return spawnSync(pc.args[4]!, pc.args.slice(5), { cwd, env: {}, encoding: 'utf8', timeout: 60_000 });
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
    profile: key(join(root, 'elsewhere', 'p1', '.credentials.json')),
    apiKey: key(join(home, '.config', 'shop-claude-key', 'api_key')),
    provider: key(join(root, 'keys', 'provider')),
  };
  // A profiles dir that is a symlink: what it points at is hidden, not just the link.
  symlinkSync(join(root, 'elsewhere'), join(home, '.claude-profiles'));
  writeFileSync(join(home, 'notes.txt'), 'ordinary\n');
  const work = join(root, 'work');
  mkdirSync(work);
  return { root, home, keys, work, provider: join(root, 'keys', 'provider') };
}

test('a check run as the agent user reads nothing at its credential paths; its own work and files are as before', { skip: realSkip }, () => {
  const p = plantedHome();
  const runAs = { user: 'shop-agent', home: p.home, hide: [p.provider] };
  const paths = [join(p.home, '.claude', '.credentials.json'), join(p.home, '.claude.json'), join(p.home, '.claude-profiles', 'p1', '.credentials.json'), join(p.root, 'elsewhere', 'p1', '.credentials.json'), join(p.home, '.config', 'shop-claude-key', 'api_key'), p.provider];
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
