// Issue #898, the owner's rule for rewriting the machine helper's sudoers rule (#902 round 2):
//   - an add-project rerun rewrites it on its own only when the result is narrower than or equal to what is installed
//     (every grant machine-helper.sh would write is there already, so the rewrite only drops stale lines);
//   - when the engine's rule would grant more (a command, or a user: the hub's, say), nothing is rewritten. It prints a
//     unified diff ("--- installed <file>", "+++ engine (machine-helper.sh)") and the line "rerun as root with
//     --replace-sudoers to install the engine's rule: <command>", and waits (exit 3);
//   - --replace-sudoers, root's at a root shell, installs the engine's rule; the machine helper (a coordinator's route)
//     can never pass it;
//   - machine-helper.sh run directly holds the same rule.
// The machine is test/sudoers-machine-fixture.ts, with recording stand-ins for every host tool (none may be called).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { helperSrc, machine, withCommand, withoutCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
type M = ReturnType<typeof machine>;
const RERUN = "rerun as root with --replace-sudoers to install the engine's rule: ";
const header = (m: M) => `--- installed ${join(m.T, 'sudoers-machine')}\n+++ engine (machine-helper.sh)\n`;
/** The changed lines of the unified diff in some output (no headers, no context). */
const changed = (out: string, sign: '+' | '-') => out.split('\n').filter((l) => l.startsWith(sign) && !l.startsWith(`${sign}${sign}${sign} `));
const waiting = (r: ReturnType<M['run']>) => r.events.find((e) => e.step === 'machine-helper' && e.state === 'waiting');

test('#898 owner rule: a stale-only rule (a grant the engine no longer writes) is rewritten on its own, the diff showing only what it drops', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const retired = `${m.T}/helper claude-account switch`;
  m.setSudoers(withCommand(m.expected('alpha', 'old'), retired));
  const r = m.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.helperRuns(), 2, 'rewritten without a flag');
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.ok(r.stderr.includes(header(m)), r.stderr);
  assert.deepEqual(changed(r.stderr, '-'), [`-    ${retired}, \\`]);
  assert.deepEqual(changed(r.stderr, '+'), [], 'it adds nothing');
  assert.equal(m.hostCalls(), '');
});

test('#898 owner rule: an installed rule narrower than the engine\'s is NOT rewritten: the diff is shown, and the step waits for --replace-sudoers', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const { rule, command } = withoutCommand(m.expected('alpha', 'old'));
  m.setSudoers(rule);
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.helperRuns(), 1, 'machine-helper.sh never ran');
  assert.equal(m.sudoers(), rule, 'the installed rule is as it was');
  assert.ok(r.stderr.includes(header(m)), r.stderr);
  assert.deepEqual(changed(r.stderr, '+'), [`+    ${command}, \\`]);
  const cmd = `sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers=${m.pin('alpha', 'old')}`;
  assert.ok(r.stderr.includes(`\n${RERUN}${cmd}\n`), r.stderr);
  assert.equal(waiting(r)?.detail, `${RERUN}${cmd}`);
  assert.ok(!r.events.some((e) => e.step === 'dashboards'), 'it stops there');
  assert.equal(m.hostCalls(), '');
});

test('#898 owner rule: with --replace-sudoers (root, at a root shell) the narrower rule is replaced by the engine\'s', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  m.setSudoers(withoutCommand(m.expected('alpha', 'old')).rule);
  assert.equal(m.run().status, 3);
  const r = m.run([`--replace-sudoers=${m.pin('alpha', 'old')}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(m.calls().includes(`machine-helper --replace-sudoers=${m.pin('alpha', 'old')} --may-add= alpha old`), m.calls().join('\n'));
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.equal(m.hostCalls(), '');
});

test('#898 owner rule: a hand-added line is never kept, and never dropped while the engine\'s rule adds: with the engine\'s rule also wider it waits; on its own it waits too (#902 round 3: a line outside the engine\'s shape fails closed)', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const hand = 'wl-alpha ALL=(root) NOPASSWD: ALL\n';
  const narrowerPlusHand = `${withoutCommand(m.expected('alpha', 'old')).rule}${hand}`;
  m.setSudoers(narrowerPlusHand);
  const waits = m.run();
  assert.equal(waits.status, 3, waits.stderr);
  assert.equal(m.sudoers(), narrowerPlusHand, 'never rewritten to drop one line while adding another');
  m.setSudoers(`${m.expected('alpha', 'old')}${hand}`);
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(changed(r.stderr, '-'), [`-${hand.trimEnd()}`]);
  assert.deepEqual(changed(r.stderr, '+'), []);
  assert.equal(m.run([`--replace-sudoers=${m.pin('alpha', 'old')}`]).status, 0);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.equal(m.hostCalls(), '');
});

test('#898 owner rule: a user the installed rule lacks is a widening too: a hub-only instance\'s coordinator waits for the flag', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  // beta: on the machine and in the hub, never in the helper's rule.
  for (const u of ['wl-beta', 'wl-beta-agent']) writeFileSync(join(m.T, 'users', u), '');
  mkdirSync(join(m.T, 'homes', 'wl-beta', '.local', 'state', 'worklane', 'instances', 'beta', 'state'), { recursive: true });
  writeFileSync(join(m.T, 'hub.service'), readFileSync(join(m.T, 'hub.service'), 'utf8').replace('--hub ', `--hub beta=${m.T}/homes/wl-beta/state,`));
  const before = m.sudoers();
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.sudoers(), before);
  assert.deepEqual(changed(r.stderr, '+'), ['+wl-alpha, wl-beta, wl-old ALL=(root) NOPASSWD: WORKLANE_MACHINE']);
  assert.equal(m.run([`--replace-sudoers=${m.pin('alpha', 'beta', 'old')}`]).status, 0);
  assert.equal(m.sudoers(), m.expected('alpha', 'beta', 'old'));
});

test('#898 owner rule: the coordinator\'s route (the machine helper\'s add-project) can never pass --replace-sudoers, and its rerun on a narrower rule waits with the diff', { skip: !posix }, () => {
  const { parseAddProject } = createRequire(import.meta.url)(helperSrc) as { parseAddProject: (a: string[]) => { name: string; repo: string } | null };
  for (const a of [['add-project', 'alpha', 'example/alpha', '--replace-sudoers'], ['add-project', '--replace-sudoers', 'alpha', 'example/alpha'], ['add-project', 'alpha', '--replace-sudoers']]) assert.equal(parseAddProject(a), null, JSON.stringify(a));
  // The sudoers pattern lets a coordinator pass exactly a name and a repo, neither of which can start with a dash.
  const lib = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8');
  const pattern = new RegExp(/^ADD_PROJECT_SUDOERS_ARGS='(.*)'$/m.exec(lib)![1]!);
  assert.doesNotMatch('add-project alpha example/alpha --replace-sudoers', pattern);
  assert.doesNotMatch('add-project --replace-sudoers example/alpha', pattern);
  // As the helper runs it: exactly the name and the repo, no stdin.
  const m = machine();
  assert.equal(m.run().status, 0);
  const narrower = withoutCommand(m.expected('alpha', 'old')).rule;
  m.setSudoers(narrower);
  const r = m.run([]);
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.sudoers(), narrower);
  assert.ok(r.stderr.includes(header(m)));
  assert.equal(m.hostCalls(), '');
});

test('#898 owner rule: machine-helper.sh run directly holds the rule too: a wider engine rule prints the diff and the --replace-sudoers command, changes nothing, exit 3', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  const { rule, command } = withoutCommand(m.expected('alpha', 'old'));
  m.setSudoers(rule);
  const r = m.helper('alpha', 'old');
  assert.equal(r.status, 3, r.stderr);
  assert.ok(r.stdout.startsWith(header(m)), r.stdout);
  assert.deepEqual(changed(r.stdout, '+'), [`+    ${command}, \\`]);
  assert.ok(r.stdout.endsWith(`\n${RERUN}sudo bash ${m.real}/machine-helper.sh --replace-sudoers=${m.pin('alpha', 'old')} alpha old\n`), r.stdout);
  assert.equal(m.sudoers(), rule);
  assert.equal(m.hostCalls(), '', 'refused before any step: no host tool reached');
});

test('#898 owner rule: a machine on v0.5.2\'s exact rule is not a superset of this engine\'s: the rerun prints that diff (the comment, 7 claude-account lines out, 4 set-policy lines in) and waits', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  const v052 = readFileSync(join(repoRoot, 'test', 'fixtures', 'machine-sudoers-v0.5.2.txt'), 'utf8').split('/usr/local/libexec/worklane-machine').join(`${m.T}/helper`);
  m.setSudoers(v052);
  const r = m.run();
  assert.equal(r.status, 3, r.stderr);
  assert.equal(m.sudoers(), v052, 'not rewritten');
  assert.ok(r.stderr.includes(header(m)), r.stderr);
  const out = changed(r.stderr, '-');
  const into = changed(r.stderr, '+');
  assert.deepEqual(out.filter((l) => l.startsWith('-#')).length, 1, out.join('\n'));
  assert.match(out.find((l) => l.startsWith('-#'))!, /switch the agents' Claude account/);
  assert.equal(into.filter((l) => l.startsWith('+#')).length, 1, into.join('\n'));
  assert.deepEqual(out.filter((l) => l.includes('claude-account')).map((l) => l.replace(/^-\s*\S+ /, '').replace(/, \\$/, '')), [
    'claude-account switch',
    '^claude-account profile-add [a-z][a-z0-9-]*$',
    '^claude-account remove [a-z][a-z0-9-]*$',
    '^claude-account use [a-z][a-z0-9-]*$',
    '^claude-account login [a-z][a-z0-9-]*$',
    '^claude-account failover [a-z][a-z0-9+-]* back$',
    '^claude-account failover [a-z][a-z0-9+-]* stay$',
  ]);
  assert.deepEqual(into.filter((l) => l.includes('set-policy')).map((l) => l.replace(/^\+\s*\S+ /, '').replace(/, \\$/, '')).sort(), [
    '^set-policy [a-z][a-z_.]* [a-z0-9.+-]+$',
    'set-policy auto_merge off',
    'set-policy land_mode pr',
    'set-policy main_watch auto',
  ]);
  assert.ok(r.stderr.includes(`\n${RERUN}sudo bash ${m.s}/add-project.sh alpha example/alpha --replace-sudoers=${m.pin('alpha', 'old')}\n`), r.stderr);
  assert.equal(m.hostCalls(), '');
});
