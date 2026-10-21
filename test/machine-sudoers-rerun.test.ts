// Issue #898: the machine helper's sudoers rule follows the engine. add-project's machine-helper step is done only
// when the installed rule is byte for byte what machine-helper.sh writes for these instances (machine_sudoers): the
// helper's bytes alone (which the updater keeps in step) never make it done. A rerun then rewrites the rule through
// machine-helper.sh, on its own only when that drops grants; a rule the engine's would widen waits for root's
// --replace-sudoers (test/machine-sudoers-narrow.test.ts has the owner's cases). `machine-helper.sh --check` says
// which case applies, changing nothing, and the updater names it with the exact command.
//
// The machine is test/sudoers-machine-fixture.ts: stand-ins for every setup script, temp paths, and recording
// stand-ins (exit 1) first on PATH for every host tool; each test asserts none was called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { KINDS } from '../src/watchdog/index.js';
import { repoRoot } from './helpers.js';
import { machine, olderRule, withCommand } from './sudoers-machine-fixture.js';

const posix = process.platform !== 'win32';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('#898: a rerun after an upgrade does not take the helper\'s bytes and a listed instance as done: a rule the engine\'s would widen waits for --replace-sudoers, which installs it byte for byte', { skip: !posix }, () => {
  const m = machine();
  const first = m.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(m.helperRuns(), 1);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'), 'the first run installs exactly machine-helper.sh\'s rule');

  // An older engine wrote the rule (one command fewer); the updater has since put the helper's bytes in step.
  const older = olderRule(m.expected('alpha', 'old'));
  m.setSudoers(older);
  const again = m.run();
  assert.equal(again.status, 3, again.stderr);
  assert.equal(m.helperRuns(), 1, 'not rewritten on its own: the engine\'s rule is wider');
  assert.equal(m.sudoers(), older);
  const replaced = m.run(['--replace-sudoers']);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.ok(m.calls().includes('machine-helper --replace-sudoers alpha old'), m.calls().join('\n'));
  assert.equal(m.sudoers(), m.expected('alpha', 'old'), 'byte for byte what machine-helper.sh writes for these instances');

  // Current now: the next rerun skips it, and says why.
  const third = m.run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(m.helperRuns(), 2, 'a current rule is not rewritten');
  assert.match(m.step(third)!.detail, /what machine-helper\.sh writes/);
  assert.equal(m.hostCalls(), '', 'no host tool was reached');
});

test('#898: a rule with a line outside the engine\'s shape is never kept, and never rewritten without root: --replace-sudoers makes it exactly machine-helper.sh\'s', { skip: !posix }, () => {
  const m = machine();
  assert.equal(m.run().status, 0);
  m.setSudoers(`${m.expected('alpha', 'old')}wl-alpha ALL=(root) NOPASSWD: ALL\n`);
  // #902 round 3, fail closed: a line the engine never writes is a doubt, so the rerun waits for root's flag.
  const waits = m.run();
  assert.equal(waits.status, 3, waits.stderr);
  assert.equal(m.helperRuns(), 1);
  const r = m.run(['--replace-sudoers']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.helperRuns(), 2);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.ok(!m.sudoers().includes('NOPASSWD: ALL\n'), 'the added line is gone');
  // A rule that names an instance whose user is gone is not current either: the rerun names only the ones there.
  m.setSudoers(m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-alpha, wl-gone, wl-old ALL='));
  assert.equal(m.run().status, 0);
  assert.equal(m.helperRuns(), 3);
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
  assert.equal(m.hostCalls(), '');
});

test('#898: a sudo upgraded past 1.9.10 since the rule was written: its pattern rules widen it, so they wait for --replace-sudoers', { skip: !posix }, () => {
  const m = machine('1.9.9');
  assert.equal(m.run().status, 0);
  assert.ok(!m.sudoers().includes('^add-project'), 'an older sudo: no pattern rules');
  writeFileSync(join(m.T, 'sudo-version'), '1.9.15\n');
  const waits = m.run();
  assert.equal(waits.status, 3, waits.stderr);
  assert.equal(m.helperRuns(), 1);
  const r = m.run(['--replace-sudoers']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(m.sudoers().includes('^add-project'), 'the pattern rules, now that sudo reads them');
  assert.equal(m.sudoers(), m.expected('alpha', 'old'));
});

test('#898: machine-helper.sh --check says absent, current, stale (no flag) or wider (with --replace-sudoers), and changes nothing', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  const snapshot = () => readdirSync(m.T, { recursive: true }).map(String).sort().map((f) => {
    const st = statSync(join(m.T, f));
    return `${f} ${st.mode} ${st.isFile() ? readFileSync(join(m.T, f), 'utf8') : ''}`;
  });
  const file = join(m.T, 'sudoers-machine');

  m.setSudoers(m.expected('alpha', 'old'));
  let before = snapshot();
  let r = m.check();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `current: ${file} is what machine-helper.sh writes for alpha old\n`);
  assert.deepEqual(snapshot(), before, 'nothing written');

  // One command fewer than the engine's: wider, the command with the flag.
  m.setSudoers(olderRule(m.expected('alpha', 'old')));
  before = snapshot();
  r = m.check();
  assert.equal(r.status, 4, r.stderr);
  assert.ok(r.stdout.trimEnd().endsWith(`wider: rerun as root with --replace-sudoers to install the engine's rule: sudo bash ${m.real}/machine-helper.sh --replace-sudoers alpha old`), r.stdout);
  assert.match(r.stdout, new RegExp(`^--- installed ${esc(file)}\\n\\+\\+\\+ engine \\(machine-helper\\.sh\\)\\n`));
  assert.deepEqual(snapshot(), before, 'nothing written');

  // A command the engine no longer writes, in the engine's own shape: stale, and the rewrite needs no flag.
  m.setSudoers(withCommand(m.expected('alpha', 'old'), `${m.T}/helper claude-account switch`));
  r = m.check();
  assert.equal(r.status, 3);
  assert.ok(r.stdout.includes(`\n-    ${m.T}/helper claude-account switch, \\\n`), r.stdout);
  assert.ok(r.stdout.trimEnd().endsWith(`rewrite it, as root: sudo bash ${m.real}/machine-helper.sh alpha old`), r.stdout);

  // A hand-added line outside that shape: wider (#902 round 3, fail closed), the command with the flag.
  m.setSudoers(`${m.expected('alpha', 'old')}wl-alpha ALL=(root) NOPASSWD: ALL\n`);
  r = m.check();
  assert.equal(r.status, 4);
  assert.match(r.stdout, /^-wl-alpha ALL=\(root\) NOPASSWD: ALL$/m);
  assert.ok(r.stdout.trimEnd().endsWith(`--replace-sudoers alpha old`), r.stdout);

  // No user left for any instance it names: the command removes it, as instance-remove.sh does for the last one.
  m.setSudoers(m.expected('alpha', 'old').replace('wl-alpha, wl-old ALL=', 'wl-gone ALL='));
  r = m.check();
  assert.equal(r.status, 3);
  assert.ok(r.stdout.trimEnd().endsWith(`sudo rm -f ${file}`), r.stdout);

  const absent = machine('1.9.15', false);
  r = absent.check();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^absent: /);
  assert.ok(!existsSync(join(absent.T, 'sudoers-machine')), 'not created');
  assert.equal(m.hostCalls(), '');
  assert.equal(absent.hostCalls(), '');
});

type Check = { state: string; detail: string; fix?: string } | null;
const updater = () =>
  createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
    machineSudoersCheck(engineDir: string, exec?: typeof execFileSync, owner?: number, top?: string): Check;
    run(deps: Record<string, unknown>): Promise<string>;
    SUDOERS_INCIDENT: string;
  };

test('#898: the updater reads machine-helper.sh --check of the installed engine: stale or wider, each with its exact command', { skip: !posix }, () => {
  const m = machine();
  writeFileSync(join(m.T, 'users', 'wl-alpha'), '');
  const engine = join(m.T, 'real');
  // The check's own PATH, with the host tools' stand-ins first.
  const exec = ((file: string, args: string[], o: Record<string, unknown>) =>
    execFileSync(file, args, { ...o, env: { ...(o.env as Record<string, string>), PATH: `${join(m.T, 'host-bin')}:${(o.env as Record<string, string>).PATH}` } })) as unknown as typeof execFileSync;
  const me = process.getuid!();
  const check = (dir = engine, x = exec) => updater().machineSudoersCheck(dir, x, me, m.T);
  m.setSudoers(olderRule(m.expected('alpha', 'old')));
  const wider = check()!;
  assert.equal(wider.state, 'wider');
  assert.equal(wider.fix, `sudo bash ${engine}/scripts/setup/machine-helper.sh --replace-sudoers alpha old`);
  assert.match(wider.detail, /^wider: rerun as root with --replace-sudoers to install the engine's rule: .* The diff: \+/);
  m.setSudoers(withCommand(m.expected('alpha', 'old'), `${m.T}/helper claude-account switch`));
  const stale = check()!;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.fix, `sudo bash ${engine}/scripts/setup/machine-helper.sh alpha old`);
  assert.match(stale.detail, /The diff: -\s+\S+\/helper claude-account switch, \\/);
  m.setSudoers(m.expected('alpha', 'old'));
  assert.equal(check()!.state, 'current');
  // An engine with no machine-helper.sh: nothing to say.
  assert.equal(check(join(m.T, 'no-engine')), null);
  // Run by anyone but its owner (root, for the updater: a test with the real deps), it runs nothing at all.
  let ran = 0;
  const counting = ((...a: Parameters<typeof execFileSync>) => ((ran += 1), (exec as (...x: unknown[]) => unknown)(...a))) as unknown as typeof execFileSync;
  if (me !== 0) assert.equal(updater().machineSudoersCheck(engine, counting), null);
  // A script or lib.sh someone else could write is never run: unknown, said why.
  for (const f of ['machine-helper.sh', 'lib.sh']) {
    chmodSync(join(engine, 'scripts', 'setup', f), 0o664);
    const r = check(engine, counting)!;
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, new RegExp(`${esc(f)} is writable by group or others`));
    chmodSync(join(engine, 'scripts', 'setup', f), 0o644);
  }
  // Nor through a directory someone else could write, anywhere up the path (#902 review: the whole path).
  for (const d of [join(engine, 'scripts', 'setup'), join(engine, 'scripts'), engine]) {
    chmodSync(d, 0o777);
    const r = check(engine, counting)!;
    assert.equal(r.state, 'unknown', d);
    assert.match(r.detail, new RegExp(`${esc(d)} isn't uid ${me}'s alone`));
    chmodSync(d, 0o755);
  }
  // Nor through a link below the engine: scripts/setup a symlink to a copy elsewhere.
  const elsewhere = join(m.T, 'elsewhere');
  renameSync(join(engine, 'scripts', 'setup'), elsewhere);
  symlinkSync(elsewhere, join(engine, 'scripts', 'setup'));
  const linked = check(engine, counting)!;
  assert.equal(linked.state, 'unknown');
  assert.match(linked.detail, /goes through a link/);
  assert.equal(ran, 0, 'nothing was run');
  // The engine directory itself through a link (as /opt/worklane/current is): resolved, checked, run; the command it
  // names keeps the path it was given.
  const engine2 = join(m.T, 'engine2');
  mkdirSync(join(engine2, 'scripts'), { recursive: true });
  for (const d of [engine2, join(engine2, 'scripts')]) chmodSync(d, 0o755);
  renameSync(elsewhere, join(engine2, 'scripts', 'setup'));
  symlinkSync(engine2, join(m.T, 'current'));
  m.setSudoers(olderRule(m.expected('alpha', 'old')));
  const viaLink = check(join(m.T, 'current'))!;
  assert.equal(viaLink.state, 'wider');
  assert.equal(viaLink.fix, `sudo bash ${join(m.T, 'current')}/scripts/setup/machine-helper.sh --replace-sudoers alpha old`);
  assert.equal(m.hostCalls(), '');
});

test('#898: every updater run, updates on or off, names a stale or wider rule in the journal and as an incident with its fix; a current one closes it', async () => {
  const u = updater();
  const warned: string[] = [];
  const raised: string[][] = [];
  const resolved: string[][] = [];
  let answer: Check = { state: 'stale', detail: 'stale: /etc/sudoers.d/worklane-machine is not what machine-helper.sh writes for alpha, and rewriting it only drops grants; rewrite it, as root: sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha', fix: 'sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha' };
  const deps = {
    config: () => null,
    sudoersCheck: () => answer,
    warn: (l: string) => warned.push(l),
    raiseIncident: (...a: string[]) => raised.push(a),
    resolveIncident: (...a: string[]) => resolved.push(a),
    log: () => {},
  };
  assert.equal(await u.run(deps), 'disabled');
  assert.equal(warned.length, 1);
  assert.ok(warned[0]!.includes('sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh alpha'), warned[0]);
  assert.deepEqual(raised, [[u.SUDOERS_INCIDENT, 'machine-helper', answer!.detail, answer!.fix!]]);
  answer = { state: 'current', detail: 'current: ...' };
  await u.run(deps);
  assert.deepEqual(resolved, [[u.SUDOERS_INCIDENT, 'machine-helper']]);
  assert.equal(warned.length, 1, 'nothing said when it is current');
  answer = { state: 'wider', detail: "wider: rerun as root with --replace-sudoers to install the engine's rule: sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers alpha", fix: 'sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers alpha' };
  await u.run(deps);
  assert.deepEqual(raised.at(-1), [u.SUDOERS_INCIDENT, 'machine-helper', answer.detail, answer.fix]);
  assert.match(warned.at(-1)!, /^machine_sudoers_stale: wider: /);
  // A check that throws never stops the run.
  const throwing = { ...deps, sudoersCheck: () => { throw new Error('boom'); } };
  assert.equal(await u.run(throwing), 'disabled');
  assert.match(warned.at(-1)!, /couldn't check the machine helper's sudoers rule: boom/);
  assert.deepEqual(KINDS[u.SUDOERS_INCIDENT as keyof typeof KINDS], { title: "The machine helper's sudoers rule is out of date", severity: 'amber' });
});
