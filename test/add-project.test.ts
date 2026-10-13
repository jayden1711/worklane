// scripts/setup/add-project.sh, step by step, with every setup script it runs stood in for (the real ones run end to
// end in CI's "add-project (real systemd)" job): the steps in order as JSON lines, each skipped on a rerun when done,
// a failure stopping the run with its exact retry, every instance on the machine kept when the machine helper and
// the dashboards are rerun, and the Claude token never echoed. Also the name and repo checks, the same in the
// script, the helper and the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  stub(join(s, 'dashboards.sh'), 'dashboards', `opts=""; while [ "\${1#--}" != "$1" ]; do opts="$opts $1 $2"; shift 2; done
hub=""; for n in "$@"; do hub="\${hub:+$hub,}$n=$T/homes/wl-$n/state"; touch "$T/active/worklane-dashboard-$n.service"; done
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
  const run = (args: string[] = ['alpha', 'example/alpha'], input = `${TOKEN}\n`) => {
    const r = spawnSync('bash', [join(s, 'add-project.sh'), ...args], { encoding: 'utf8', input, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T } });
    const lines = r.stdout.split('\n').filter(Boolean);
    return { ...r, lines, events: lines.map((l) => JSON.parse(l) as { step: string; state: string; detail: string; ask?: Record<string, string>; retry?: string }) };
  };
  const calls = () => (existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { T, s, run, calls, instDir };
}

test('add-project runs the steps in order, one JSON line per change on stdout, and keeps every instance on the machine', { skip: !posix }, () => {
  const m = machine();
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  // stdout is the progress lines only, every one JSON.
  for (const l of r.lines) assert.doesNotThrow(() => JSON.parse(l), l);
  const order = r.events.filter((e) => e.state === 'started').map((e) => e.step);
  assert.deepEqual(order, STEPS);
  for (const step of STEPS) assert.ok(r.events.some((e) => e.step === step && e.state === 'done'), `${step} done`);
  // The App's click and the Claude token are asks, in their steps.
  const asks = r.events.filter((e) => e.state === 'ask');
  assert.deepEqual(asks.map((e) => [e.step, e.ask?.kind]), [['app', 'approve_link'], ['claude-token', 'paste_secret']]);
  assert.equal(asks[0]!.ask!.url, 'https://hub.example.test/setup/app-manifest/start/amf-1');
  assert.equal(asks[1]!.ask!.credential, 'claude-token');
  // The default policy, shown for the owner.
  assert.match(r.events.find((e) => e.step === 'policy' && e.state === 'done')!.detail, /^auto_merge off, \$20\/day, 2 workers: change them/);
  // No test_run in the repo's tests.yaml: no test user.
  assert.match(r.events.find((e) => e.step === 'test-user' && e.state === 'done')!.detail, /no test_run/);
  // The machine helper and the dashboards, with the instance already there and the new one; the hub's settings kept.
  const calls = m.calls();
  assert.ok(calls.includes('machine-helper alpha old'), calls.join('\n'));
  assert.ok(calls.includes('dashboards --client-id Iv1.signin0001 --public-url https://hub.example.test --console-user admin --console-devices tag:owner alpha old'), calls.join('\n'));
  assert.deepEqual(calls.filter((c) => !c.startsWith('machine-helper') && !c.startsWith('dashboards')), ['instance alpha', 'ensure_instance_home alpha example/alpha', 'app app-manifest alpha example/alpha --ask-lines --timeout 15', 'install_claude_token wl-alpha-agent', 'checkout alpha example/alpha', 'service alpha']);
  // The token reached the agent's own credentials, and no output.
  assert.match(readFileSync(join(m.T, 'homes', 'wl-alpha-agent', '.claude', '.credentials.json'), 'utf8'), new RegExp(TOKEN));
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'the token is never echoed');
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

test('no Claude token, or not one from claude setup-token: the step fails and nothing is stored', { skip: !posix }, () => {
  const m = machine();
  const none = m.run(undefined, '');
  assert.equal(none.status, 1);
  assert.deepEqual([none.events.at(-1)!.step, none.events.at(-1)!.state], ['claude-token', 'failed']);
  assert.match(none.events.at(-1)!.detail, /no token came/);
  assert.ok(!existsSync(join(m.T, 'homes', 'wl-alpha-agent', '.claude', '.credentials.json')));
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

const NAMES_OK = ['alpha', 'a', 'ab-c', 'a1', 'abcdefghijklmnopqrstu'];
const NAMES_BAD = ['', 'Alpha', '1a', '-a', 'a_b', 'dash', 'x-agent', 'x-eval', 'x-work', 'abcdefghijklmnopqrstuv', 'a b', 'a;id', 'a\n'];
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
