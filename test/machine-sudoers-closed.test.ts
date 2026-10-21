// Issue #898, #902 round 3: the owner's narrower-or-equal rule fails closed (principle 1).
//   - The machine helper's rule is rewritten without --replace-sudoers only when the installed one is in the engine's
//     own exact shape and the engine's rule only drops whole commands or users from it. Anything else waits: a tag, a
//     second spec or alias, a Defaults or include line, a negation, an escape, a CR.
//   - A user is added without the flag only for the instance add-project is creating, never one root took out.
//   - instance-remove.sh and instance-rename.sh check this before their first change, and stop with nothing changed.
// Each installed rule below grants, as sudo reads it, less than the engine's rule (or can't be told), so rewriting it
// to the engine's would widen it. The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every
// host tool (none may be called).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { machine, withCommand, withoutCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
type M = ReturnType<typeof machine>;
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";

/** Every file under the machine's temp dir, with its mode and bytes. */
const snapshot = (m: M) => readdirSync(m.T, { recursive: true }).map(String).sort().map((f) => {
  const st = statSync(join(m.T, f));
  return `${f} ${st.mode} ${st.isFile() ? readFileSync(join(m.T, f), 'utf8') : ''}`;
});

/** The engine's rule for alpha and old (E), changed as each case says. H is the helper's path. */
const VARIANTS: [string, (e: string, h: string) => string][] = [
  ['a password asked of one coordinator, on a spec line of its own', (e) => `${e}wl-alpha ALL=(root) PASSWD: WORKLANE_MACHINE\n`],
  ['a NOEXEC tag for one coordinator, on a spec line of its own', (e) => `${e}wl-alpha ALL=(root) NOPASSWD: NOEXEC: WORKLANE_MACHINE\n`],
  ['one coordinator on a narrower alias of its own', (e, h) => `${e.replace('wl-alpha, wl-old ALL=', 'wl-old ALL=')}Cmnd_Alias WL_NARROW = ${h} set-slots 1\nwl-alpha ALL=(root) NOPASSWD: WL_NARROW\n`],
  ['the full spec held only by an unrelated user, the coordinators asked a password', (e) => `${e.replace('wl-alpha, wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE', 'wl-alpha, wl-old ALL=(root) PASSWD: WORKLANE_MACHINE')}wl-zed ALL=(root) NOPASSWD: WORKLANE_MACHINE\n`],
  ['a negated user in the user list', (e) => e.replace('wl-alpha, wl-old ALL=', 'wl-alpha, wl-old, !wl-old ALL=')],
  ['a negated command in the alias', (e, h) => withCommand(e, `!${h} set-slots 16`)],
  ['a Defaults line: requiretty for one coordinator', (e) => `${e}Defaults:wl-alpha requiretty\n`],
  ['a Defaults line: noexec on the alias', (e) => `${e}Defaults!WORKLANE_MACHINE noexec\n`],
  ['an #include line', (e) => `${e}#include /etc/sudoers.d/worklane-extra\n`],
  ['an @include line', (e) => `${e}@include /etc/sudoers.d/worklane-extra\n`],
  ['an escaped comma standing in for a command the rule lacks', (e, h) => {
    // sudo reads "<h> retired\, <command>" as one command (its arguments hold a comma), so <command> isn't granted.
    const { rule, command } = withoutCommand(e);
    return withCommand(rule, `${h} retired\\, ${command}`);
  }],
  ['the alias defined twice', (e, h) => `${e}Cmnd_Alias WORKLANE_MACHINE = ${h} set-slots 1\n`],
  ['CRLF line ends', (e) => e.replace(/\n/g, '\r\n')],
];

for (const [what, change] of VARIANTS) {
  test(`#902 fail closed: ${what}: an add-project rerun (exactly a name and a repo) waits for --replace-sudoers, and --check says wider`, { skip: !posix }, () => {
    const m = machine();
    assert.equal(m.run().status, 0);
    const installed = change(m.expected('alpha', 'old'), `${m.T}/helper`);
    assert.notEqual(installed, m.expected('alpha', 'old'));
    m.setSudoers(installed);
    const r = m.run();
    assert.equal(r.status, 3, `${what}: ${r.stderr.slice(-1500)}`);
    assert.equal(m.sudoers(), installed, 'not rewritten');
    assert.equal(m.helperRuns(), 1);
    const wait = r.events.find((e) => e.step === 'machine-helper' && e.state === 'waiting');
    assert.equal(wait?.detail, `${RERUN}sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers`);
    const c = m.check();
    assert.equal(c.status, 4, `${what}: ${c.stdout}`);
    assert.match(c.stdout.trimEnd().split('\n').pop()!, /^wider: rerun as root with --replace-sudoers to install the engine's rule: sudo bash \S+\/machine-helper\.sh --replace-sudoers /);
    assert.equal(m.sudoers(), installed);
    assert.equal(m.hostCalls(), '');
  });
}

test('#902 users: a coordinator root took out of the rule is not put back by an add-project rerun without the flag; one being created still is', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  // Root takes wl-alpha out by hand: a narrower rule, in the engine's own shape.
  const narrowed = m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-old ALL=');
  m.setSudoers(narrowed);
  // The coordinator's route: exactly the name and the repo.
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.sudoers(), narrowed, 'wl-alpha is not put back');
  assert.ok(r.stderr.includes('-wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE\n+wl-alpha, wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE\n'), r.stderr);
  assert.equal(m.run(['--replace-sudoers']).status, 0, 'root\'s flag puts it back');
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));

  // A first add that stops before the machine-helper step (no Claude login yet) and is resumed: still a creation.
  const g = machine();
  const stopped = spawnSync('bash', [join(g.s, 'add-project.sh'), 'alpha', 'example/alpha'], { encoding: 'utf8', input: '', env: g.env });
  assert.equal(stopped.status, 3, stopped.stderr);
  const resumed = g.run();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(g.sudoers(), g.expected('alpha', 'old'));
  assert.equal(m.hostCalls() + g.hostCalls(), '');
});

/** instance-remove.sh and instance-rename.sh in the machine's setup dir; their registry a stand-in that records it was reached and fails. */
function withAdminScripts(m: M) {
  for (const f of ['instance-remove.sh', 'instance-rename.sh']) {
    copyFileSync(join(repoRoot, 'scripts', 'setup', f), join(m.s, f));
    chmodSync(join(m.s, f), 0o644);
  }
  writeFileSync(join(m.s, 'instance-records.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(m.T, 'reached'))}, 'instance-records ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`);
  return (file: string, ...args: string[]) => spawnSync('bash', [join(m.s, file), ...args], { encoding: 'utf8', input: '', env: m.env });
}

test('#902 instance-remove.sh stops before its first change when the machine helper\'s rule would need --replace-sudoers, naming that command', { skip: !posix }, () => {
  const m = machine();
  const run = withAdminScripts(m);
  for (const u of ['wl-alpha', 'wl-alpha-agent']) writeFileSync(join(m.T, 'users', u), '');
  const { rule } = withoutCommand(m.expected('alpha', 'old'));
  m.setSudoers(rule);
  const before = snapshot(m);
  const r = run('instance-remove.sh', 'alpha', '--yes');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.startsWith(`--- installed ${join(m.T, 'sudoers-machine')}\n+++ engine (machine-helper.sh)\n`), r.stdout);
  assert.ok(r.stdout.endsWith(`\n${RERUN}sudo bash ${m.s}/machine-helper.sh --replace-sudoers old\n`), r.stdout);
  assert.match(r.stderr, /refused: alpha is not removed, nothing changed/);
  assert.deepEqual(snapshot(m), before, 'nothing changed');
  assert.ok(!existsSync(join(m.T, 'reached')), 'it stopped before reading its registry');
  // A rule it only narrows (alpha dropped): no stop there; it goes on, to its node lookup (the script sets its own
  // PATH) and then its registry (a stand-in here, which stops it).
  m.setSudoers(m.expected('alpha', 'old'));
  const on = run('instance-remove.sh', 'alpha', '--yes');
  assert.doesNotMatch(on.stdout + on.stderr, /--replace-sudoers|is not removed/);
  assert.ok(/needs node on root's PATH/.test(on.stderr) || /^instance-records plan alpha$/m.test(existsSync(join(m.T, 'reached')) ? readFileSync(join(m.T, 'reached'), 'utf8') : ''), on.stderr);
  assert.equal(m.hostCalls(), '');
});

test('#902 instance-rename.sh stops before its first change when the machine helper\'s rule would need --replace-sudoers, naming that command', { skip: !posix }, () => {
  const m = machine();
  const run = withAdminScripts(m);
  const { rule } = withoutCommand(m.expected('old'));
  m.setSudoers(rule);
  const before = snapshot(m);
  const r = run('instance-rename.sh', 'old', 'beta', '--yes');
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.startsWith(`--- installed ${join(m.T, 'sudoers-machine')}\n+++ engine (machine-helper.sh)\n`), r.stdout);
  assert.ok(r.stdout.endsWith(`\n${RERUN}sudo bash ${m.s}/machine-helper.sh --replace-sudoers old\n`), r.stdout);
  assert.match(r.stderr, /refused: old is not renamed, nothing changed/);
  assert.deepEqual(snapshot(m), before, 'nothing changed');
  assert.ok(!existsSync(join(m.T, 'reached')));
  assert.equal(m.hostCalls(), '');
});
