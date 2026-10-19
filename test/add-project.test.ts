// scripts/setup/add-project.sh, step by step, with every setup script it runs stood in for (the real ones run end to
// end in CI's "add-project (real systemd)" job): the steps in order as JSON lines, each skipped on a rerun when done,
// a failure stopping the run with its exact retry, every instance on the machine kept when the machine helper and
// the dashboards are rerun, and the Claude token taken only from root (a root shell's hidden prompt, or root's
// stdin), never echoed; with none it waits for root, never a paste box (issue #711). Also the name and repo checks,
// the same in the script, the helper and the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProjectNameOk, addProjectRepoOk } from '../src/machine.js';
import { checkRootStep } from '../src/console/root-steps.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setupDir = join(repoRoot, 'scripts', 'setup');
const helperSrc = join(repoRoot, 'scripts', 'machine', 'worklane-machine.cjs');
const TOKEN = `sk-ant-oat01-${'Q'.repeat(40)}`;
const STEPS = ['instance', 'app', 'claude-token', 'checkout', 'policy', 'service', 'test-user', 'machine-helper', 'dashboards'];

/**
 * A machine in a temp dir: add-project.sh copied beside a lib.sh that sources the real one and points its paths and
 * user/unit checks into the temp dir, and stand-ins for each setup script that record their arguments and leave
 * what the real one would (the instance's users, the checkout, the active unit...). A step fails while
 * <root>/fail-<step> exists. Another instance, "old", is on the machine already, in the helper rule and the hub.
 */
function machine() {
  const T = mkdtempSync(join(tmpdir(), 'add-project-'));
  const s = join(T, 'scripts', 'setup');
  mkdirSync(s, { recursive: true });
  mkdirSync(join(T, 'scripts', 'machine'), { recursive: true });
  copyFileSync(join(setupDir, 'add-project.sh'), join(s, 'add-project.sh'));
  copyFileSync(helperSrc, join(T, 'scripts', 'machine', 'worklane-machine.cjs'));
  for (const d of ['users', 'active', 'homes', 'srv', 'bin']) mkdirSync(join(T, d), { recursive: true });
  const instDir = (n: string) => join(T, 'homes', `wl-${n}`, '.local', 'state', 'worklane', 'instances', n);
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
as_root() { :; }
home_of() { echo "$T/homes/$1"; }
user_exists() { [ -e "$T/users/$1" ]; }
unit_active() { [ -e "$T/active/$1" ]; }
run_as() { local user="$1" script="$2"; shift 2; HOME="$T/homes/$user" bash -euo pipefail -c "$script" _ "$@"; }
ensure_instance_home() {
  local d="$T/homes/wl-$1/.local/state/worklane/instances/$1"
  mkdir -p "$d/state"
  printf 'version: 1\\nname: %s\\nrepos:\\n  - path: "x"\\n    repo: %s\\n' "$1" "$2" > "$d/instance.yaml"
  printf 'version: 1\\nbudget: { daily_usd: 20 }\\nagents: { max_workers: 2 }\\nland_mode: pr\\nauto_merge: false\\n' > "$d/policy.yaml"
  echo "ensure_instance_home $*" >> "$T/calls"
}
claude_login_ok() { :; }
# The engine's \`policy own\` (as root; test/policy-edit.test.ts runs it with stand-ins): recorded, and then root's.
own_policy() { echo "own_policy $1" >> "$T/owned"; touch "$T/owned-$1"; }
policy_root_ok() { [ -e "$T/owned-$1" ]; }
install_claude_token() {
  mkdir -p "$T/homes/$1/.claude"
  { printf '{"claudeAiOauth":{"accessToken":"'; cat; printf '"}}'; } > "$T/homes/$1/.claude/.credentials.json"
  echo "install_claude_token $1" >> "$T/calls"
}
SRV_ROOT="$T/srv" ENGINE_CLI="$T/bin/worklane" MACHINE_HELPER="$T/helper" MACHINE_SUDOERS="$T/sudoers-machine" HUB_UNIT="$T/hub.service" ADD_PROJECT_LOCK="$T/lock"
SETUP_POLL_SECONDS=0 SETUP_WAIT_SECONDS="$(cat "$T/wait-seconds" 2>/dev/null || true)"
`,
  );
  const stub = (file: string, step: string, body: string) => {
    writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\nT=${JSON.stringify(T)}\necho "${step} $*" >> "$T/calls"\nif [ -e "$T/fail-${step}" ]; then echo "${step} went wrong: $(cat "$T/fail-${step}")" >&2; exit 1; fi\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub(join(s, 'instance.sh'), 'instance', 'touch "$T/users/wl-$1" "$T/users/wl-$1-agent"; mkdir -p "$T/srv/$1"');
  // `instance auto-config`: the setup PR, open; merged from the check numbered in <root>/merge-after on.
  stub(join(T, 'bin', 'worklane'), 'app', `if [ "$1 $2" = "instance auto-config" ]; then
  n=$(( $(cat "$T/ac-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$T/ac-count"
  if [ -e "$T/merge-after" ] && [ "$n" -ge "$(cat "$T/merge-after")" ]; then rm -f "$T/no-config"; echo '{"kind":"merged","detail":"the config is on main","pr":"https://github.com/example/alpha/pull/1","questions":[]}'; exit 0; fi
  echo '{"kind":"proposed","detail":"proposed in PR #1","pr":"https://github.com/example/alpha/pull/1","questions":[]}'; exit 0
fi
[ "$1" = app-manifest ] || exit 2
echo 'open, as a machine owner: https://hub.example.test/setup/app-manifest/start/amf-1'
echo 'ask: {"kind":"approve_link","title":"Create '"$2"'-worklane on GitHub","detail":"Approve it.","url":"https://hub.example.test/setup/app-manifest/start/amf-1"}'
d="$T/homes/wl-$2/.local/state/worklane/instances/$2"; printf 'version: 1\\ngithub:\\n  kind: app\\n  app_id: 91\\n' > "$d/credentials.yaml"
mkdir -p "$T/homes/wl-$2/.config/$2-app"; echo key > "$T/homes/wl-$2/.config/$2-app/private-key.pem"
echo "OK: App x (id 91), installation 4242"`);
  // <root>/no-config: the repo has no config on its default branch yet (its setup PR not merged), so none in the checkout.
  stub(join(s, 'checkout.sh'), 'checkout', 'mkdir -p "$T/srv/$1/${2#*/}/.git"; [ -e "$T/no-config" ] && exit 0; mkdir -p "$T/srv/$1/${2#*/}/.worklane"; printf "suites: {}\\n" > "$T/srv/$1/${2#*/}/.worklane/tests.yaml"');
  stub(join(s, 'service.sh'), 'service', 'touch "$T/active/worklane-$1.service"');
  stub(join(s, 'test-user.sh'), 'test-user', 'touch "$T/users/wl-test-$2" "$T/active/worklane-test-$2-docker.service"');
  stub(join(s, 'machine-helper.sh'), 'machine-helper', `cp "$T/scripts/machine/worklane-machine.cjs" "$T/helper"
users=""; for n in "$@"; do users="\${users:+$users, }wl-$n"; done
printf 'Cmnd_Alias WORKLANE_MACHINE = x\\n%s ALL=(root) NOPASSWD: WORKLANE_MACHINE\\n' "$users" > "$T/sudoers-machine"`);
  stub(join(s, 'dashboards.sh'), 'dashboards', `none=""; if [ "\${1:-}" = --no-instances ]; then none=1; shift; fi
opts=""; while [ "$#" -gt 0 ] && [ "\${1#--}" != "$1" ]; do opts="$opts $1 $2"; shift 2; done
hub=""; for n in "$@"; do hub="\${hub:+$hub,}$n=$T/homes/wl-$n/state"; touch "$T/active/worklane-dashboard-$n.service"; done
if [ -n "$none" ]; then [ "$#" -eq 0 ] || exit 2; hub=-; mkdir -p "$T/homes/wl-dash/.local/state/worklane/dashboard-hub"; echo t > "$T/homes/wl-dash/.local/state/worklane/dashboard-hub/dashboard-token"; fi
printf '[Service]\\nExecStart=/usr/local/bin/worklane dashboard --hub %s --service%s --signin-dir /x\\n' "$hub" "$opts" > "$T/hub.service"`);
  // "old": an instance set up earlier, in the machine helper's rule and the hub.
  for (const u of ['wl-old', 'wl-old-agent']) writeFileSync(join(T, 'users', u), '');
  mkdirSync(join(instDir('old'), 'state'), { recursive: true });
  writeFileSync(join(T, 'sudoers-machine'), 'Cmnd_Alias WORKLANE_MACHINE = x\nwl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE\n');
  writeFileSync(join(T, 'hub.service'), `[Service]\nExecStart=/usr/local/bin/worklane dashboard --hub old=${instDir('old')}/state --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x --console-user admin --console-devices tag:owner\n`);
  // The hub is up: its token, which the App step needs.
  const hubTok = join(T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub');
  mkdirSync(hubTok, { recursive: true });
  writeFileSync(join(hubTok, 'dashboard-token'), 't');
  // Without a terminal: root's automation, the token on stdin; or the machine helper, for a dashboard, with none.
  const run = (args: string[] = ['alpha', 'example/alpha'], input = `${TOKEN}\n`) => {
    const r = spawnSync('bash', [join(s, 'add-project.sh'), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T } });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, lines, events: lines.map((l) => JSON.parse(l) as Step) };
  };
  // At a root shell (a terminal, util-linux script's pty): the token typed at the hidden prompt once it is shown, so
  // nothing is typed before the prompt turns echo off.
  const runTty = (token: string, args: string[] = ['alpha', 'example/alpha']) =>
    new Promise<{ status: number | null; out: string; events: Step[] }>((resolve) => {
      const cmd = ['bash', join(s, 'add-project.sh'), ...args].map((a) => `'${a}'`).join(' ');
      const c = spawn('script', ['-qec', cmd, '/dev/null'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T } });
      let out = '';
      let typed = false;
      const kill = setTimeout(() => c.kill(), 60_000);
      c.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
        if (!typed && out.includes('Paste the token')) {
          typed = true;
          c.stdin.write(`${token}\r`);
        }
      });
      c.on('close', (status) => {
        clearTimeout(kill);
        const lines = out.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.startsWith('{"step"'));
        resolve({ status, out, events: lines.map((l) => JSON.parse(l) as Step) });
      });
    });
  /** The agent user signed in already (root ran credentials.sh <name> claude, or claude auth login as it). */
  const signedIn = (n = 'alpha') => {
    mkdirSync(join(T, 'homes', `wl-${n}-agent`, '.claude'), { recursive: true });
    writeFileSync(join(T, 'homes', `wl-${n}-agent`, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-installed-by-root' } }));
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { T, s, run, runTty, signedIn, calls, instDir };
}
type Step = { step: string; state: string; detail: string; ask?: Record<string, string>; retry?: string };
/** util-linux's script, for a pty: what CI's Ubuntu has; elsewhere the terminal tests skip. */
const hasScript = posix && spawnSync('script', ['-qec', 'true', '/dev/null'], { encoding: 'utf8' }).status === 0;

test('add-project runs the steps in order, one JSON line per change on stdout, and keeps every instance on the machine', { skip: !posix }, () => {
  const m = machine();
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  // stdout is the progress lines only, every one JSON.
  for (const l of r.lines) assert.doesNotThrow(() => JSON.parse(l), l);
  const order = r.events.filter((e) => e.state === 'started').map((e) => e.step);
  assert.deepEqual(order, STEPS);
  for (const step of STEPS) assert.ok(r.events.some((e) => e.step === step && e.state === 'done'), `${step} done`);
  // The App's click is an ask, in its step; nothing asks a dashboard for the Claude token (issue #711).
  const asks = r.events.filter((e) => e.state === 'ask');
  assert.deepEqual(asks.map((e) => [e.step, e.ask?.kind]), [['app', 'approve_link']]);
  assert.equal(asks[0]!.ask!.url, 'https://hub.example.test/setup/app-manifest/start/amf-1');
  // The default policy, shown for the owner.
  assert.match(r.events.find((e) => e.step === 'policy' && e.state === 'done')!.detail, /^auto_merge off, \$20\/day, 2 workers: change them/);
  // No test_run in the repo's tests.yaml: no test user.
  assert.match(r.events.find((e) => e.step === 'test-user' && e.state === 'done')!.detail, /no test_run/);
  // The machine helper and the dashboards, with the instance already there and the new one; the hub's settings kept.
  const calls = m.calls();
  assert.ok(calls.includes('machine-helper alpha old'), calls.join('\n'));
  assert.ok(calls.includes('dashboards --client-id Iv1.signin0001 --public-url https://hub.example.test --console-user admin --console-devices tag:owner alpha old'), calls.join('\n'));
  assert.deepEqual(calls.filter((c) => !c.startsWith('machine-helper') && !c.startsWith('dashboards')), ['instance alpha', 'ensure_instance_home alpha example/alpha', 'app app-manifest alpha example/alpha --ask-lines --timeout 15', 'install_claude_token wl-alpha-agent', 'checkout alpha example/alpha', 'service alpha']);
  // The token on root's stdin reached the agent's own credentials, and no output.
  assert.match(readFileSync(join(m.T, 'homes', 'wl-alpha-agent', '.claude', '.credentials.json'), 'utf8'), new RegExp(TOKEN));
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'the token is never echoed');
});

test('at a root shell (a terminal), the claude-token step takes the token at its hidden prompt, for the agent user only, never echoed', { skip: !hasScript && 'no util-linux script for a terminal' }, async () => {
  const m = machine();
  const r = await m.runTty(TOKEN);
  assert.equal(r.status, 0, r.out.slice(-2000));
  assert.deepEqual(r.events.filter((e) => e.state === 'started').map((e) => e.step), STEPS);
  assert.ok(m.calls().includes('install_claude_token wl-alpha-agent'));
  assert.match(readFileSync(join(m.T, 'homes', 'wl-alpha-agent', '.claude', '.credentials.json'), 'utf8'), new RegExp(TOKEN));
  assert.ok(!r.out.includes(TOKEN.slice(13)), 'the token is never echoed, not even by the terminal');
  const none = await machine().runTty('');
  assert.equal(none.status, 3);
  assert.deepEqual([none.events.at(-1)!.step, none.events.at(-1)!.state], ['claude-token', 'waiting']);
});

test('issue #711: with no token (the machine helper, for a dashboard, gives no stdin) the claude-token step asks no paste box: it waits for root to install the login, and nothing is stored', { skip: !posix }, () => {
  const m = machine();
  const r = m.run(undefined, '');
  assert.equal(r.status, 3, r.stderr);
  const last = r.events.at(-1)!;
  assert.deepEqual([last.step, last.state], ['claude-token', 'waiting']);
  assert.match(last.detail, new RegExp(`only root installs, on this machine: sudo bash ${m.s}/credentials\\.sh alpha claude`));
  assert.match(last.detail, /sudo -u wl-alpha-agent -i claude auth login/);
  assert.equal(last.retry, `sudo bash ${m.s}/add-project.sh alpha example/alpha, once that is done (it skips the steps already done)`);
  assert.ok(!r.events.some((e) => e.state === 'ask' && e.step === 'claude-token'), 'no paste box asked for');
  assert.ok(!m.calls().some((c) => c.startsWith('install_claude_token')));
  assert.ok(!existsSync(join(m.T, 'homes', 'wl-alpha-agent', '.claude', '.credentials.json')), 'nothing stored');
  // Once root has installed it, the rerun goes on from there.
  m.signedIn();
  const again = m.run(undefined, '');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.events.find((e) => e.step === 'claude-token' && e.state === 'done')!.detail, /has a Claude login/);
});

test('a rerun skips every step already done, and asks for nothing', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const before = m.calls().length;
  const r = m.run(undefined, '');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(m.calls().length, before, 'no setup script ran again');
  assert.deepEqual(r.events.map((e) => `${e.step} ${e.state}`), STEPS.flatMap((s) => [`${s} started`, `${s} done`]));
  assert.ok(!r.events.some((e) => e.state === 'ask'));
});

test('a failed step stops the run there, naming the exact retry; the rerun skips what was done and goes on', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'fail-checkout'), 'the clone was refused');
  const r = m.run();
  assert.equal(r.status, 1);
  const last = r.events.at(-1)!;
  assert.deepEqual([last.step, last.state], ['checkout', 'failed']);
  assert.match(last.detail, /checkout went wrong: the clone was refused/);
  assert.equal(last.retry, `sudo bash ${m.s}/add-project.sh alpha example/alpha (it skips the steps already done); or this step alone: sudo bash ${m.s}/checkout.sh alpha example/alpha`);
  assert.ok(!r.events.some((e) => ['policy', 'service', 'test-user', 'machine-helper', 'dashboards'].includes(e.step)), 'nothing after it started');
  assert.ok(!m.calls().some((c) => c.startsWith('service')));

  rmSync(join(m.T, 'fail-checkout'));
  const again = m.run(undefined, '');
  assert.equal(again.status, 0, again.stderr);
  for (const step of ['instance', 'app', 'claude-token']) assert.match(again.events.find((e) => e.step === step && e.state === 'done')!.detail, /there|set up|has a Claude login/, step);
  assert.equal(m.calls().filter((c) => c.startsWith('instance ') || c.startsWith('app ')).length, 2, 'the instance and the App were not made again');
  assert.equal(m.calls().filter((c) => c.startsWith('checkout ')).length, 2, 'the failed step ran again');
  assert.ok(again.events.some((e) => e.step === 'dashboards' && e.state === 'done'));
});

test('regression (audit B4): a repo with no config: the service step waits for its setup PR, never fails on it; goes on once it merges', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'no-config'), '');
  writeFileSync(join(m.T, 'wait-seconds'), '0');
  const r = m.run();
  // Before: service.sh ran and failed (".worklane: missing"), exit 1.
  assert.equal(r.status, 3, r.stderr);
  assert.ok(!r.events.some((e) => e.state === 'failed'), JSON.stringify(r.events));
  const last = r.events.at(-1)!;
  assert.deepEqual([last.step, last.state], ['service', 'waiting']);
  assert.match(last.detail, /^waiting for the setup PR https:\/\/github\.com\/example\/alpha\/pull\/1 to merge/);
  assert.equal(last.retry, `sudo bash ${m.s}/add-project.sh alpha example/alpha, once that is done (it skips the steps already done)`);
  assert.ok(!m.calls().some((c) => c.startsWith('service ')), 'service.sh never ran without the config');
  assert.ok(!r.events.some((e) => ['test-user', 'machine-helper', 'dashboards'].includes(e.step)));

  // How the App was made, as recorded beside its key: by hand here.
  writeFileSync(join(m.T, 'homes', 'wl-alpha', '.config', 'alpha-app', 'made-by'), 'by-hand\n');
  // Rerun: still open on the first check, merged on the next; the checkout is brought up to it and the run goes on.
  writeFileSync(join(m.T, 'wait-seconds'), '600');
  writeFileSync(join(m.T, 'merge-after'), '3');
  const again = m.run(undefined, '');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.events.filter((e) => e.step === 'service').map((e) => e.state), ['started', 'waiting', 'done']);
  assert.match(again.events.find((e) => e.step === 'app' && e.state === 'done')!.detail, /, made by hand \(credentials\.sh github-app\)$/);
  assert.deepEqual(m.calls().filter((c) => /^(checkout|service) /.test(c)), ['checkout alpha example/alpha', 'checkout alpha example/alpha', 'service alpha']);
  assert.ok(again.events.some((e) => e.step === 'dashboards' && e.state === 'done'));
});

// WHY: wizard screen 5 makes the manifest flow the App step's only way. A failure there must never send the owner off
// to make an App by hand and copy its key to the server: it names the manifest flow and its own retry, nothing else.
test("the App step is manifest only: with no hub it stops, naming the hub and the manifest retry, never an App made by hand", { skip: !posix }, () => {
  const m = machine();
  rmSync(join(m.T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub', 'dashboard-token'));
  const r = m.run();
  assert.equal(r.status, 1);
  const last = r.events.at(-1)!;
  assert.deepEqual([last.step, last.state], ['app', 'failed']);
  assert.match(last.detail, /no dashboard hub on this machine yet[\s\S]*manifest flow[\s\S]*dashboards\.sh/);
  assert.equal(last.retry, `sudo bash ${m.s}/add-project.sh alpha example/alpha (it skips the steps already done); or this step alone: sudo ${m.T}/bin/worklane app-manifest alpha example/alpha`);
  assert.doesNotMatch(`${last.detail} ${last.retry} ${r.stderr}`, /by hand|credentials\.sh|key\.pem/);
  assert.ok(!m.calls().some((c) => c.startsWith('app ')), 'the manifest flow never started');
});

// WHY: on a machine's first project there is no hub for GitHub to send the browser back to, and add-project starts
// the hub in its last step, so the App step used to stop there. Now it starts the hub alone first, with the sign-in App
// the hub's setup mode stored (dashboards.sh --setup), and goes on; the last step adds the instance to it.
/** A machine with no hub at all: no unit, no token. `signin`: what the hub's setup mode stored for wl-dash. */
function firstProject(signin: Record<string, string>) {
  const m = machine();
  rmSync(join(m.T, 'hub.service'));
  rmSync(join(m.T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub'), { recursive: true });
  const d = join(m.T, 'homes', 'wl-dash', '.config', 'dashboard-signin');
  mkdirSync(d, { recursive: true });
  for (const [f, v] of Object.entries(signin)) writeFileSync(join(d, f), v);
  return m;
}

test("a machine's first project: no hub yet, so the App step starts it alone, with what setup mode stored, before the manifest flow; the last step adds the instance", { skip: !posix }, () => {
  const m = firstProject({ 'client-secret': 's', 'client-id': 'Iv1.stored00001', 'public-url': 'https://hub.example.test' });
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  // The same nine steps, in the same order, none failed: no step of its own, no by-hand step.
  assert.deepEqual(r.events.filter((e) => e.state === 'started').map((e) => e.step), STEPS);
  assert.ok(!r.events.some((e) => e.state === 'failed'));
  const calls = m.calls();
  const first = calls.indexOf('dashboards --no-instances --client-id Iv1.stored00001 --public-url https://hub.example.test');
  const app = calls.indexOf('app app-manifest alpha example/alpha --ask-lines --timeout 15');
  assert.ok(first > calls.indexOf('ensure_instance_home alpha example/alpha') && first < app, calls.join('\n'));
  // The last step: the hub with its instances, its settings kept from the unit the first start wrote.
  assert.equal(calls.at(-1), 'dashboards --client-id Iv1.stored00001 --public-url https://hub.example.test alpha old');
  assert.equal(calls.filter((c) => c.startsWith('dashboards ')).length, 2);
  assert.match(r.stderr, /no dashboard hub on this machine yet: starting it, with no instance/);
  // A rerun starts nothing again.
  const again = m.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(m.calls().length, calls.length, 'every step skipped');
});

test("a machine's first project with no sign-in App yet: the App step stops, naming dashboards.sh --setup, and starts nothing", { skip: !posix }, () => {
  const m = firstProject({});
  const r = m.run();
  assert.equal(r.status, 1);
  const last = r.events.at(-1)!;
  assert.deepEqual([last.step, last.state], ['app', 'failed']);
  assert.match(last.detail, /no dashboard hub on this machine yet, and no sign-in App for one \(the App is made through GitHub's manifest flow[^)]*\): make the sign-in App first with sudo bash \S+\/dashboards\.sh --setup --public-url/);
  assert.doesNotMatch(`${last.detail} ${last.retry}`, /by hand|credentials\.sh|key\.pem/);
  assert.ok(!m.calls().some((c) => c.startsWith('dashboards') || c.startsWith('app ')), m.calls().join('\n'));
});

test('a second project is unchanged: with a hub on the machine, the hub is never started alone', { skip: !posix }, () => {
  const m = machine();
  // Even with what setup mode stored still there, and even when the hub's token is missing (the hub is down).
  const d = join(m.T, 'homes', 'wl-dash', '.config', 'dashboard-signin');
  mkdirSync(d, { recursive: true });
  for (const [f, v] of Object.entries({ 'client-secret': 's', 'client-id': 'Iv1.stored00001', 'public-url': 'https://other.example.test' })) writeFileSync(join(d, f), v);
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!m.calls().some((c) => c.includes('--no-instances')), m.calls().join('\n'));
  assert.ok(m.calls().includes('dashboards --client-id Iv1.signin0001 --public-url https://hub.example.test --console-user admin --console-devices tag:owner alpha old'), "the hub's own settings, not the stored ones");
  const down = machine();
  rmSync(join(down.T, 'homes', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub', 'dashboard-token'));
  mkdirSync(join(down.T, 'homes', 'wl-dash', '.config', 'dashboard-signin'), { recursive: true });
  writeFileSync(join(down.T, 'homes', 'wl-dash', '.config', 'dashboard-signin', 'client-secret'), 's');
  assert.equal(down.run().status, 1);
  assert.ok(!down.calls().some((c) => c.startsWith('dashboards')), 'a hub that is down is not replaced by an empty one');
});

test("an instance by that name for another repo is never reused", { skip: !posix }, () => {
  const m = machine();
  mkdirSync(m.instDir('alpha'), { recursive: true });
  writeFileSync(join(m.instDir('alpha'), 'instance.yaml'), 'version: 1\nname: alpha\nrepos:\n  - path: "x"\n    repo: example/other\n');
  const r = m.run();
  assert.equal(r.status, 1);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0]!.detail, /already exists for another repo \(example\/other\)/);
  assert.deepEqual(m.calls(), []);
});

const NAMES_OK = ['alpha', 'a', 'ab-c', 'a1', 'abcdefghijklmnopqrstu', 'test', 'ci', 'a-b-c'];
const NAMES_BAD = ['', 'Alpha', '1a', '-a', 'a_b', 'dash', 'x-agent', 'x-eval', 'x-work', 'test-x', 'ci-x', 'dashboard-x', 'hub', 'agent', 'abcdefghijklmnopqrstuv', 'a b', 'a;id', 'a\n'];
const REPOS_OK = ['example/alpha', 'a/b', 'a-b/c.d_e-f', 'A1/.github', `${'a'.repeat(39)}/r`];
const REPOS_BAD = ['', 'a', 'a/', '/b', 'a/b/c', 'a/.', 'a/..', '-a/b', 'a-/b', 'a--b/c', 'a b/c', 'a/b c', `${'a'.repeat(40)}/r`, `a/${'r'.repeat(101)}`, 'a/b;id', 'a/$(id)', '../b'];

test('the helper refuses add-project with a bad name or repo, or anything but exactly two arguments', () => {
  const { parseAddProject } = createRequire(import.meta.url)(helperSrc) as { parseAddProject: (a: string[]) => { name: string; repo: string } | null };
  for (const n of NAMES_OK) assert.deepEqual(parseAddProject(['add-project', n, 'example/alpha']), { name: n, repo: 'example/alpha' }, n);
  for (const r of REPOS_OK) assert.deepEqual(parseAddProject(['add-project', 'alpha', r]), { name: 'alpha', repo: r }, r);
  for (const n of NAMES_BAD) assert.equal(parseAddProject(['add-project', n, 'example/alpha']), null, JSON.stringify(n));
  for (const r of REPOS_BAD) assert.equal(parseAddProject(['add-project', 'alpha', r]), null, JSON.stringify(r));
  for (const a of [['add-project'], ['add-project', 'alpha'], ['add-project', 'alpha', 'example/alpha', 'extra'], ['add-project', 'alpha', 'example/alpha', '--client-id', 'x'], ['Add-project', 'alpha', 'example/alpha']]) assert.equal(parseAddProject(a), null, JSON.stringify(a));
  // The engine's allowlist and the script agree with the helper.
  for (const n of NAMES_OK) assert.ok(addProjectNameOk(n) && checkRootStep('add-project', [n, 'example/alpha']).allowed, n);
  for (const n of NAMES_BAD) assert.ok(!addProjectNameOk(n) && !checkRootStep('add-project', [n, 'example/alpha']).allowed, JSON.stringify(n));
  for (const r of REPOS_OK) assert.ok(addProjectRepoOk(r), r);
  for (const r of REPOS_BAD) assert.ok(!addProjectRepoOk(r) && !checkRootStep('add-project', ['alpha', r]).allowed, JSON.stringify(r));
  assert.ok(!checkRootStep('add-project', ['alpha', 'example/alpha', 'x']).allowed);
});

test('the installed helper runs add-project.sh only from a root-owned engine, and runs nothing for a refused list', () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /^const ADD_PROJECT = '\/opt\/worklane\/current\/scripts\/setup\/add-project\.sh';$/m);
  assert.match(src, /spawnSync\('bash', \[real, p\.name, p\.repo\]/, 'exactly the two checked arguments');
  const r = spawnSync(process.execPath, [helperSrc, 'add-project', 'Bad', 'example/alpha'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: .*add-project <name> <owner\/repo>/);
});

test("the script refuses a bad name or repo before any step", { skip: !posix }, () => {
  const m = machine();
  for (const n of NAMES_BAD.filter(Boolean)) {
    const r = m.run([n, 'example/alpha']);
    assert.equal(r.status, 2, JSON.stringify(n));
    assert.deepEqual(r.lines, []);
  }
  for (const repo of REPOS_BAD.filter(Boolean)) {
    const r = m.run(['alpha', repo]);
    assert.equal(r.status, 2, JSON.stringify(repo));
    assert.deepEqual(r.lines, []);
  }
  assert.deepEqual(m.calls(), []);
});

test('the sudoers rule lets coordinators run add-project only with its two argument shapes, as one anchored pattern', { skip: !posix && 'bash' }, () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; machine_sudoers wl-alpha', '_', join(setupDir, 'lib.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('add-project'))!;
  assert.equal(line.trim(), '/usr/local/libexec/worklane-machine ^add-project [a-z][a-z0-9-]* [A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$');
  const re = new RegExp(line.trim().split(' ').slice(1).join(' '));
  for (const n of NAMES_OK) assert.match(`add-project ${n} example/alpha`, re);
  for (const repo of REPOS_OK) assert.match(`add-project alpha ${repo}`, re);
  for (const a of ['add-project alpha', 'add-project alpha example/alpha extra', 'add-project Alpha example/alpha', 'add-project alpha a/b/c', 'add-project alpha a;id/b', 'add-project -x a/b']) assert.doesNotMatch(a, re, a);
});

test("the policy step makes the instance's policy.yaml root's, and a rerun on an earlier install (its coordinator's file) does it then (#726)", { skip: !posix && 'bash' }, () => {
  const m = machine();
  const owned = () => (existsSync(join(m.T, 'owned')) ? readFileSync(join(m.T, 'owned'), 'utf8').trim().split('\n') : []);
  assert.equal(m.run().status, 0);
  assert.deepEqual(owned(), ['own_policy alpha'], 'a new install: root\'s from the start');
  // Root's already: done, not taken over again.
  assert.equal(m.run().status, 0);
  assert.deepEqual(owned(), ['own_policy alpha']);
  // An install from before: the same policy.yaml, its coordinator user's. The rerun makes it root's, content and all.
  rmSync(join(m.T, 'owned-alpha'));
  const before = readFileSync(join(m.instDir('alpha'), 'policy.yaml'), 'utf8');
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(owned(), ['own_policy alpha', 'own_policy alpha']);
  assert.ok(r.events.some((e) => e.step === 'policy' && e.state === 'done' && / policy set alpha /.test(e.detail)), JSON.stringify(r.events));
  assert.equal(readFileSync(join(m.instDir('alpha'), 'policy.yaml'), 'utf8'), before, 'the setup step itself never rewrites it');
});

test('the sudoers rule lets coordinators run set-policy with one anchored pattern of plain words (#726)', { skip: !posix && 'bash' }, () => {
  const r = spawnSync('bash', ['-c', 'source "$1"; machine_sudoers wl-alpha', '_', join(setupDir, 'lib.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('set-policy'))!.trim().replace(/, \\$/, '');
  const re = new RegExp(line.split(' ').slice(1).join(' '));
  for (const a of ['set-policy auto_merge on', 'set-policy settings.workers 3', 'set-policy settings.run_windows 0900-1700+2200-0600']) assert.match(a, re, a);
  for (const a of ['set-policy auto_merge', 'set-policy auto_merge on x', 'set-policy Auto on', 'set-policy auto_merge on;id', 'set-policy auto_merge {"x":1}']) assert.doesNotMatch(a, re, a);
});
