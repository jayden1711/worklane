// The host's egress rule (scripts/setup/egress-firewall.sh, #543): every sandbox user, test-run users (wl-test-*)
// included by default, may send nothing but loopback; the one exception is a unit's cgroup in the set egress_ok, which
// systemd fills from the unit's NFTSet= (test-user.sh's rootless Docker unit, for its image pulls). Here, as this user
// with no root: the rule --print writes, with the users and systemd's version stubbed; the Docker unit's NFTSet= line;
// and the functions apply and check run, with systemctl and nft stubbed. The real-systemd CI job (scripts/ci/
// egress-real-systemd.sh) proves the same with real nft, systemd and a real rootless Docker pull.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const setup = join(repoRoot, 'scripts', 'setup');
const script = join(setup, 'egress-firewall.sh');

/**
 * A bin dir first on PATH: getent lists a machine's users, systemctl --version says `systemd`. The rule's record, which
 * --print reads, is a file of the test's own (EGRESS_RECORD_PRINT, honoured with --print only), absent unless `record`
 * is given: never the machine's /etc/worklane/egress.users.
 */
function machine(systemd: number, record?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'));
  const rec = join(dir, 'egress.users');
  if (record !== undefined) writeFileSync(rec, record);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const users = ['root:x:0:0::/root:/bin/bash', 'wl-shop:x:1000:1000::/srv/home-shop:/bin/bash', 'wl-exp-shop:x:1001:1001::/:/usr/sbin/nologin', 'wl-score-shop:x:1002:1002::/:/usr/sbin/nologin', 'wl-test-shop:x:1003:1003::/var/lib/worklane-test/shop:/usr/sbin/nologin', 'wl-test-a-b:x:1004:1004::/:/usr/sbin/nologin'];
  stub('getent', `[ "$1" = passwd ] && printf '%s\\n' ${users.map((u) => `'${u}'`).join(' ')}`);
  stub('systemctl', `[ "$1" = --version ] && { echo "systemd ${systemd} (${systemd}.4-1ubuntu8)"; echo "+PAM +AUDIT"; exit 0; }; exit 0`);
  const run = (cmd: string, args: string[]) => spawnSync('bash', [cmd, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EGRESS_RECORD_PRINT: rec } });
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const RULE_255 = `table inet worklane_egress {
  set egress_ok {
    type cgroupsv2
  }
  chain out {
    type filter hook output priority 0; policy accept;
  }
}
flush chain inet worklane_egress out
table inet worklane_egress {
  chain out {
    type filter hook output priority 0; policy accept;
    socket cgroupv2 level 3 @egress_ok accept
    meta skuid { 1001, 1002, 1003, 1004 } oifname != "lo" counter drop
  }
}
`;

test('egress rule on systemd 255: test users covered by default; the set\'s cgroups (level 3) accepted before the uid drop', { skip: !posix && 'bash' }, () => {
  const m = machine(255);
  try {
    const r = m.run(script, ['--print']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, RULE_255);
    assert.equal(r.stderr, '', 'nothing to explain: every sandbox user is covered');
    // --with-test-users changes nothing there: they are covered anyway.
    assert.equal(m.run(script, ['--print', '--with-test-users']).stdout, RULE_255);
    // The coordinator (wl-shop) and root are never covered.
    assert.doesNotMatch(r.stdout, /\b1000\b|\{ 0,/);
    const accept = r.stdout.indexOf('socket cgroupv2 level 3 @egress_ok accept');
    assert.ok(accept > 0 && accept < r.stdout.indexOf('meta skuid'), 'the exception comes before the drop');
  } finally {
    m.done();
  }
});

test('egress rule on systemd older than 255: test users opt-in, and it says why; no set nothing could fill', { skip: !posix && 'bash' }, () => {
  const m = machine(252);
  try {
    const r = m.run(script, ['--print']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /meta skuid \{ 1001, 1002 \} oifname != "lo" counter drop/, 'jobs and scorers only');
    assert.doesNotMatch(r.stdout, /egress_ok|cgroupv2/);
    assert.match(r.stderr, /^note: test users \(wl-test-\*\) are not covered: this machine's systemd is 252, and the exception for their Docker's image pulls \(NFTSet=\) needs 255 or later\. --with-test-users covers them anyway, and their Docker then can't pull images$/m);
    const w = m.run(script, ['--print', '--with-test-users']);
    assert.match(w.stdout, /meta skuid \{ 1001, 1002, 1003, 1004 \} oifname != "lo" counter drop/);
    assert.doesNotMatch(w.stdout, /egress_ok/);
    assert.match(w.stderr, /test users \(wl-test-\*\) are covered \(--with-test-users\), and with systemd 252 \(NFTSet= needs 255\) their Docker can't pull images/);
  } finally {
    m.done();
  }
});

test('regression: apply keeps the set across a reload: the rule never deletes its table, it flushes only its chain\'s rules', { skip: !posix && 'bash' }, () => {
  // Before #543 the file ran `delete table inet worklane_egress` and made it again: with the set in that table, every
  // reload (apply, instance-remove, experiments install) emptied it, and Docker could pull nothing until it restarted.
  const m = machine(255);
  try {
    const rule = m.run(script, ['--print']).stdout;
    assert.doesNotMatch(rule, /delete/, 'nothing is deleted');
    assert.doesNotMatch(rule, /flush (table|set|ruleset)/, 'neither the table nor the set is flushed');
    assert.deepEqual(rule.split('\n').filter((l) => l.startsWith('flush')), ['flush chain inet worklane_egress out']);
    // The set is declared (made when missing, kept with its elements when there) before the chain's rules are flushed.
    assert.ok(rule.indexOf('set egress_ok {') < rule.indexOf('flush chain'));
    // The boot unit loads the same file; apply then puts any running exempt unit in the set.
    const sh = readFileSync(script, 'utf8');
    assert.match(sh, /^ExecStart=\/usr\/sbin\/nft -f \$RULES$/m);
    const apply = sh.slice(sh.indexOf('apply_cmd() {'), sh.indexOf('\n}\n', sh.indexOf('apply_cmd() {')));
    assert.ok(apply.indexOf('nft -f "$RULES"') < apply.indexOf('join_running'), 'after the rule loads');
  } finally {
    m.done();
  }
});

/** Runs <body> in bash with egress-firewall.sh's functions <fns> defined, systemctl and nft as stubs (nft logs its argv). */
function withFunctions(fns: string[], units: Record<string, { nftset?: string; cg?: string }>, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-fn-'));
  try {
    const sh = readFileSync(script, 'utf8');
    const defs = fns.map((f) => {
      const from = sh.indexOf(`\n${f}() {`);
      assert.ok(from >= 0, `${f} is defined`);
      return sh.slice(from, sh.indexOf('\n}\n', from) + 3);
    });
    // systemctl show -p ControlGroup --value <unit>: its cgroup; show -p NFTSet: "[unprintable]", as systemd 255 prints
    // it (measured on ubuntu-latest, #543); cat <unit>: its unit file, with its NFTSet= line; list-units [... <pattern>]:
    // the units matching the pattern (all of them without one), one a line as --plain --no-legend prints them.
    const show = Object.entries(units)
      .flatMap(([u, p]) => [
        `'NFTSet ${u}') echo '[unprintable]' ;;`,
        `'ControlGroup ${u}') echo '${p.cg ?? ''}' ;;`,
        `'cat ${u}') printf '%s\\n' '# /etc/systemd/system/${u}' '[Service]' 'Type=simple' ${p.nftset ? `'NFTSet=${p.nftset}'` : ''} 'Restart=on-failure' ;;`,
      ])
      .join('\n      ');
    const prog = `set -euo pipefail
TABLE=worklane_egress SET=egress_ok
systemctl() {
  local pat='*' a u
  case "$1" in
    list-units)
      for a in "$@"; do case "$a" in list-units | -*) ;; *) pat="$a" ;; esac; done
      for u in ${Object.keys(units).join(' ')}; do case "$u" in $pat) echo "$u loaded active running x" ;; esac; done ;;
    show | cat)
      if [ "$1" = cat ]; then a="cat $2"; else a="$3 $5"; fi
      case "$a" in
      ${show}
      esac ;;
  esac
}
nft() { echo "nft $*" >> '${dir}/nft'; }
${defs.join('\n')}
${body}`;
    const r = spawnSync('bash', ['-c', prog], { encoding: 'utf8' });
    let nft = '';
    try {
      nft = readFileSync(join(dir, 'nft'), 'utf8');
    } catch {
      /* no nft call */
    }
    return { ...r, nft };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const OURS = 'cgroup:inet:worklane_egress:egress_ok';
const dockerCg = (n: string) => `/worklane.slice/worklane-test.slice/worklane-test-${n}-docker.service`;

test('apply puts each running test-user Docker unit whose NFTSet= names the set in it, as systemd would; no other unit, whatever its NFTSet=', { skip: !posix && 'bash' }, () => {
  // A Docker unit started before the set existed (test-user.sh install before the first apply) found nothing to join.
  // Only worklane-test-<name>-docker.service may join: another unit's text naming the set (a continuation line, a key in
  // the wrong section that systemd ignores) is never read.
  const r = withFunctions(['in_set_by_unit', 'exempt_units', 'join_running'], {
    'worklane-test-shop-docker.service': { nftset: OURS, cg: dockerCg('shop') },
    'worklane-test-a-b-docker.service': { nftset: `cgroup:inet:other_table:x ${OURS}`, cg: dockerCg('a-b') },
    'worklane-test-other-docker.service': { nftset: 'cgroup:inet:other_table:egress_ok', cg: dockerCg('other') },
    'longer-name.service': { nftset: 'cgroup:inet:worklane_egress:egress_ok_too', cg: '/system.slice/longer-name.service' },
    'two-sets.service': { nftset: `cgroup:inet:other_table:x ${OURS}`, cg: '/worklane.slice/worklane-test.slice/two-sets.service' },
    'worklane-test-shop-run.service': { nftset: OURS, cg: '/worklane.slice/worklane-test.slice/worklane-test-shop-run.service' },
    'plain.service': { cg: '/system.slice/plain.service' },
  }, 'join_running');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.nft, [
    'nft add element inet worklane_egress egress_ok { "worklane.slice/worklane-test.slice/worklane-test-shop-docker.service" }',
    'nft add element inet worklane_egress egress_ok { "worklane.slice/worklane-test.slice/worklane-test-a-b-docker.service" }',
    '',
  ].join('\n'));
  assert.equal(r.stdout, [
    `exempt: worklane-test-shop-docker.service (NFTSet=): its cgroup ${dockerCg('shop')} may send out`,
    `exempt: worklane-test-a-b-docker.service (NFTSet=): its cgroup ${dockerCg('a-b')} may send out`,
    '',
  ].join('\n'));
});

test('check: each test user\'s running Docker must have NFTSet= and be in the set, or it says how to fix it', { skip: !posix && 'bash' }, () => {
  const loaded = `table inet worklane_egress {\n\tset egress_ok {\n\t\ttype cgroupsv2\n\t\telements = { "${dockerCg('shop').slice(1)}" }\n\t}\n}`;
  const r = withFunctions(['in_set_by_unit', 'docker_check'], {
    'worklane-test-shop-docker.service': { nftset: OURS, cg: dockerCg('shop') },
    'worklane-test-a-b-docker.service': { nftset: OURS, cg: dockerCg('a-b') },
    'worklane-test-old-docker.service': { cg: dockerCg('old') },
    'plain.service': { cg: '/system.slice/plain.service' },
  }, `if docker_check '${loaded}'; then echo rc=0; else echo rc=1; fi`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.nft, '', 'check changes nothing');
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'PASS worklane-test-shop-docker.service may pull images (its cgroup is in the set egress_ok)',
    `FAIL worklane-test-a-b-docker.service's cgroup ${dockerCg('a-b')} isn't in the set egress_ok: run apply again, or restart it`,
    'FAIL worklane-test-old-docker.service has no NFTSet=cgroup:inet:worklane_egress:egress_ok (an older test-user.sh install), so its image pulls are dropped: run test-user.sh install old again, with the options it was installed with',
    'rc=1',
  ]);
});

test('test-user.sh: the Docker unit joins the egress rule\'s set (the same table and set names) on systemd 255, and says why not on an older one', { skip: !posix && 'bash' }, () => {
  for (const [v, want] of [
    [255, ['# Its image pulls get past the host egress rule for the test user (egress-firewall.sh): this cgroup only.', `NFTSet=${OURS}`]],
    [252, ['# No NFTSet= (systemd 252; it needs 255): the host egress rule leaves the test user out unless --with-test-users.']],
  ] as const) {
    const m = machine(v);
    try {
      const r = m.run(join(setup, 'test-user.sh'), ['--print', 'install', 'shop']);
      assert.equal(r.status, 0, r.stderr);
      const docker = r.stdout.slice(r.stdout.indexOf('# /etc/systemd/system/worklane-test-shop-docker.service'), r.stdout.indexOf('# sudoers rule')).split('\n');
      const at = docker.indexOf('DelegateSubgroup=daemon');
      assert.deepEqual(docker.slice(at + 1, at + 1 + want.length), [...want], `systemd ${v}`);
      assert.equal(docker.filter((l) => l.startsWith('NFTSet=')).length, v >= 255 ? 1 : 0);
      if (v >= 255) {
        // What the unit names is what the rule declares and accepts.
        const rule = m.run(script, ['--print']).stdout;
        const [, table, set] = /^NFTSet=cgroup:inet:([a-z_]+):([a-z_]+)$/.exec(want[1]!)!;
        assert.match(rule, new RegExp(`^table inet ${table} \\{\\n  set ${set} \\{\\n    type cgroupsv2\\n`));
        assert.ok(rule.includes(`@${set} accept`));
      }
    } finally {
      m.done();
    }
  }
});

test('test-user.sh install loads the egress rule again where it is in use, with its flags, so a new test user is covered', { skip: !posix && 'bash' }, () => {
  const sh = readFileSync(join(setup, 'test-user.sh'), 'utf8');
  const install = sh.slice(sh.indexOf('install_cmd() {'), sh.indexOf('\n}\n', sh.indexOf('install_cmd() {')));
  assert.match(install, /if \[ -f "\$EGRESS_RECORD" \]; then[\s\S]*?grep -qx '# --with-test-users' "\$EGRESS_RECORD"[\s\S]*?bash "\$here\/egress-firewall\.sh" apply \$egress_flags \|\| egress_rc=\$\?/);
  // After Docker is up (so apply finds it running and puts it in the set), before the final check.
  assert.ok(install.indexOf('is active"') < install.indexOf('egress-firewall.sh" apply'));
  assert.ok(install.indexOf('egress-firewall.sh" apply') < install.indexOf('check_cmd ||'));
  // Regression: a failed check after the rule loaded (exit 3: e.g. another instance's old Docker unit) was reported as
  // "the egress rule didn't load". Each case says what happened.
  assert.match(install, /3\) echo "the egress rule is loaded, with \$user in it, but its check failed: [^"]*" >&2; exit 1 ;;/);
  assert.match(install, /\*\) echo "the egress rule didn't load \(egress-firewall\.sh apply exited \$egress_rc\)[^"]*" >&2; exit 1 ;;/);
  const ef = readFileSync(script, 'utf8');
  const apply = ef.slice(ef.indexOf('apply_cmd() {'), ef.indexOf('\n}\n', ef.indexOf('apply_cmd() {')));
  assert.match(apply, /nft -f "\$RULES"[\s\S]*check_cmd \|\| exit 3$/, 'apply exits 3 when its check fails after the rule loaded');
});

/** egress-firewall.sh's decide and record, with lib.sh sourced: the mode, coverage and record for a run with these inputs. */
function decide(systemd: number, withTestUsers: boolean, record: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-decide-'));
  try {
    const sh = readFileSync(script, 'utf8');
    const fn = (f: string) => {
      const from = sh.indexOf(`\n${f}() {`);
      assert.ok(from >= 0, `${f} is defined`);
      return sh.slice(from, sh.indexOf('\n}\n', from) + 3);
    };
    const mark = join(dir, 'egress.users');
    if (record !== null) writeFileSync(mark, record);
    const prog = `set -euo pipefail
source '${join(setup, 'lib.sh')}'
${fn('decide')}
${fn('record')}
covered() { echo 1001; [ -z "$with_tests" ] || echo 1003; }
MARK='${mark}' sysd=${systemd} tests='${withTestUsers ? 1 : ''}'
decide
echo "mode=$mode with_tests=$with_tests nftset=$nftset"
record`;
    const r = spawnSync('bash', ['-c', prog], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const [state, ...rec] = r.stdout.split('\n');
    return { state, record: rec.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upgrade: an install whose rule covered test users before #543 (--with-test-users) keeps dropping their Docker; one that didn\'t gets the exception', { skip: !posix && 'bash' }, () => {
  // Owner rule: nothing reopens a route an existing install had closed. With --with-test-users before #543 all of the
  // test user's traffic was dropped, Docker's too, so a run joining Docker's namespaces got nowhere. The exception would
  // reopen that there. The rule's record (root's /etc/worklane/egress.users) tells the two installs apart.
  const legacyOptIn = '# --with-test-users\n1001\n1002\n1003\n1004\n';
  for (const [rec, flags, why] of [
    [legacyOptIn, ['--with-test-users'], 'before #543 with the flag, applied with it again (what test-user.sh, experiments.sh and instance-remove.sh pass)'],
    [legacyOptIn, [], 'before #543 with the flag, applied without it'],
    ['# docker: dropped\n1001\n1002\n1003\n1004\n', [], 'a record that says dropped'],
    ['# --with-test-users\n# docker: dropped\n1001\n', ['--with-test-users'], 'a record that says dropped, with the flag'],
  ] as const) {
    const m = machine(255, rec);
    try {
      const r = m.run(script, ['--print', ...flags]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /egress_ok|cgroupv2/, `no set and no exception: ${why}`);
      assert.match(r.stdout, /meta skuid \{ 1001, 1002, 1003, 1004 \} oifname != "lo" counter drop/, `test users still covered: ${why}`);
      assert.match(r.stderr, /^note: test users \(wl-test-\*\) are covered, and their Docker gets no exception, so it can't pull images .*this install's rule covered them before with all of their Docker's traffic dropped \(its record, .*egress\.users\), and the exception would reopen routes out through Docker that it had closed/m, why);
      // test-user.sh's Docker unit gets no NFTSet= there either.
      const t = m.run(join(setup, 'test-user.sh'), ['--print', 'install', 'shop']);
      assert.equal(t.status, 0, t.stderr);
      assert.doesNotMatch(t.stdout, /^NFTSet=/m, `no NFTSet= on the Docker unit: ${why}`);
      assert.match(t.stdout, /^# No NFTSet=: the host egress rule \(egress-firewall\.sh\) drops all traffic of the test user, Docker included/m);
    } finally {
      m.done();
    }
  }
  // Test users weren't covered before (no record, a record from before #543 without the flag, or one that says exempt):
  // the new default, with the exception.
  for (const rec of [undefined, '1001\n1002\n', '# --with-test-users\n# docker: exempt\n1001\n1002\n1003\n1004\n']) {
    const m = machine(255, rec);
    try {
      assert.equal(m.run(script, ['--print']).stdout, RULE_255, String(rec));
      assert.match(m.run(join(setup, 'test-user.sh'), ['--print', 'install', 'shop']).stdout, /^NFTSet=cgroup:inet:worklane_egress:egress_ok$/m);
    } finally {
      m.done();
    }
  }
});

test('the record: once a rule covers test users with no exception for their Docker, every later apply keeps it so, whatever its flags or systemd', { skip: !posix && 'bash' }, () => {
  // A fresh install on systemd 255: the exception; the flag changes nothing.
  assert.deepEqual(decide(255, false, null), { state: 'mode=exempt with_tests=1 nftset=1', record: '# docker: exempt\n1001\n1003\n' });
  assert.deepEqual(decide(255, true, null), { state: 'mode=exempt with_tests=1 nftset=1', record: '# --with-test-users\n# docker: exempt\n1001\n1003\n' });
  assert.equal(decide(255, false, '# --with-test-users\n# docker: exempt\n1001\n1003\n').state, 'mode=exempt with_tests=1 nftset=1');
  // On systemd 252 without the flag test users aren't covered, so nothing was closed for them: later, the default.
  const old = decide(252, false, null);
  assert.deepEqual(old, { state: 'mode=exempt with_tests= nftset=', record: '# docker: exempt\n1001\n' });
  assert.equal(decide(255, false, old.record).state, 'mode=exempt with_tests=1 nftset=1');
  // On systemd 252 with the flag test users are covered and Docker dropped: recorded, and kept after an upgrade to 255,
  // without the flag too (test users stay covered).
  const closed = decide(252, true, null);
  assert.deepEqual(closed, { state: 'mode=dropped with_tests=1 nftset=', record: '# --with-test-users\n# docker: dropped\n1001\n1003\n' });
  assert.deepEqual(decide(255, false, closed.record), { state: 'mode=dropped with_tests=1 nftset=', record: '# docker: dropped\n1001\n1003\n' });
  assert.deepEqual(decide(252, false, closed.record), { state: 'mode=dropped with_tests=1 nftset=', record: '# docker: dropped\n1001\n1003\n' });
  // A record from before #543: the flag in it means test users were covered, Docker included.
  assert.equal(decide(255, false, '# --with-test-users\n1001\n1003\n').state, 'mode=dropped with_tests=1 nftset=');
  assert.equal(decide(255, false, '1001\n').state, 'mode=exempt with_tests=1 nftset=1');
  // dropped wins over exempt.
  assert.equal(decide(255, false, '# docker: exempt\n# docker: dropped\n').state, 'mode=dropped with_tests=1 nftset=');
});

/** --print and test-user.sh --print on systemd 255 with a record made by `make`: test users covered, Docker dropped. */
function assertDroppedWith(make: (rec: string) => void, why: string) {
  const m = machine(255);
  try {
    make(join(m.dir, 'egress.users'));
    const r = m.run(script, ['--print']);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /egress_ok|cgroupv2/, `no set and no exception: ${why}`);
    assert.match(r.stdout, /meta skuid \{ 1001, 1002, 1003, 1004 \} oifname != "lo" counter drop/, `test users still covered: ${why}`);
    const t = m.run(join(setup, 'test-user.sh'), ['--print', 'install', 'shop']);
    assert.equal(t.status, 0, t.stderr);
    assert.doesNotMatch(t.stdout, /^NFTSet=/m, `no NFTSet= on the Docker unit: ${why}`);
  } finally {
    m.done();
  }
}

// Option (b) fails closed: a record that exists but can't be read might be one that says dropped, so it counts as one.
test('the record: one that is a directory counts as dropped (no set, no exception, no NFTSet=)', { skip: !posix && 'bash' }, () => {
  assertDroppedWith((rec) => mkdirSync(rec), 'the record is a directory');
});

test('the record: one with no read permission counts as dropped, whatever it says', { skip: (!posix && 'bash') || (process.getuid?.() === 0 && 'root reads a mode-000 file') }, () => {
  assertDroppedWith((rec) => {
    writeFileSync(rec, '# docker: exempt\n1001\n1002\n1003\n1004\n');
    chmodSync(rec, 0o000);
  }, 'the record is mode 000');
});

test('egress-firewall.sh refuses bad arguments', { skip: !posix && 'bash' }, () => {
  const m = machine(255);
  try {
    for (const a of [[], ['frob'], ['apply', 'extra'], ['--bogus'], ['check', '--nope']]) {
      const r = m.run(script, a);
      assert.equal(r.status, 2, a.join(' '));
      assert.match(r.stderr, /usage: egress-firewall\.sh/);
    }
  } finally {
    m.done();
  }
});

const ciScript = join(repoRoot, 'scripts', 'ci', 'egress-real-systemd.sh');

/** Runs the CI job's await_netns_thread (with its threads_line) in bash, the job's other helpers as stubs: the Nth look
 * at the threads (netns_threads) finds looks[N-1] ('' for none); sudo and docker_up log to one file, summary to another. */
function awaitThread(looks: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-ci-'));
  try {
    const sh = readFileSync(ciScript, 'utf8');
    const def = (f: string) => {
      const from = sh.indexOf(`\n${f}() {`);
      assert.ok(from >= 0, `${f} is defined in egress-real-systemd.sh`);
      const line = sh.slice(from, sh.indexOf('\n', from + 1));
      return line.trimEnd().endsWith('}') ? line : sh.slice(from, sh.indexOf('\n}\n', from) + 3);
    };
    writeFileSync(join(dir, 'looks'), looks.map((l) => l || '-').join('\n') + '\n');
    const prog = `set -euo pipefail
t='${dir}' U=wl-test-ci DU=worklane-test-ci-docker.service
fail() { echo "FAIL: $*" >&2; exit 1; }
summary() { echo "$*" >> "$t/summary"; }
sudo() { echo "$*" >> "$t/log"; }
docker_up() { echo up >> "$t/log"; }
netns_threads() {
  local n l
  n=$(( $(cat "$t/n" 2> /dev/null || echo 0) + 1 ))
  echo "$n" > "$t/n"
  l="$(sed -n "$n"p "$t/looks")"
  : > "$t/threads-$1"
  if [ -n "$l" ] && [ "$l" != - ]; then echo "$l" > "$t/threads-$1"; fi
}
${def('threads_line')}
DOCKER_RESTARTS=0
${def('await_netns_thread')}
await_netns_thread new
echo "restarts=$DOCKER_RESTARTS"`;
    const r = spawnSync('bash', ['-c', prog], { encoding: 'utf8' });
    const read = (f: string) => {
      try {
        return readFileSync(join(dir, f), 'utf8');
      } catch {
        return '';
      }
    };
    return { ...r, log: read('log').split('\n').filter(Boolean), summary: read('summary').split('\n').filter(Boolean), looked: Number(read('n')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('egress-real-systemd.sh: while no test-user thread is in a non-host netns, Docker is restarted, at most 3 times, and each look goes in the summary', { skip: !posix && 'bash' }, () => {
  const restart = 'systemctl restart worklane-test-ci-docker.service';
  // A thread there at the first look: no restart.
  let r = awaitThread(['12447:12447:4026532268']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^restarts=0$/m);
  assert.deepEqual(r.log, []);
  assert.equal(r.looked, 1);
  assert.equal(r.summary.length, 1);
  assert.match(r.summary[0] ?? '',/^- look 1 \(no restart\): test-user threads in a non-host netns \(pid:tid:netns\): 12447:12447:4026532268/);
  // None at the first two looks: two restarts, each followed by docker_up, and it stops at the first look with one.
  r = awaitThread(['', '', '12447:12447:4026532268', '1:1:1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^restarts=2$/m);
  assert.deepEqual(r.log, [restart, 'up', restart, 'up']);
  assert.equal(r.looked, 3);
  assert.deepEqual(
    r.summary.map((l) => l.replace(/: .*/, '')),
    ['- look 1 (no restart)', '- look 2 (after Docker restart 1 of 3)', '- look 3 (after Docker restart 2 of 3)'],
  );
  assert.match(r.summary[0] ?? '',/: no thread of any wl-test-ci process in a non-host netns$/);
  assert.match(r.summary[2] ?? '',/: test-user threads in a non-host netns \(pid:tid:netns\): 12447:12447:4026532268/);
  // None ever: exactly 3 restarts, it says so, and it passes nothing itself (the job's own no-thread check fails later).
  r = awaitThread(['', '', '', '', '', '']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^restarts=3$/m);
  assert.equal(r.log.filter((l) => l === restart).length, 3);
  assert.equal(r.looked, 4);
  assert.equal(r.summary.length, 5);
  assert.match(r.summary[3] ?? '',/^- look 4 \(after Docker restart 3 of 3\): no thread/);
  assert.match(r.summary[4] ?? '',/^- still none after 3 restarts: .*the job fails at its no-thread check$/);
});

test('egress-real-systemd.sh: the restarts come right before the after-upgrade probe; its no-thread and no-join checks stay, and after a restart the dropped state is asserted again', () => {
  const sh = readFileSync(ciScript, 'utf8');
  const at = sh.indexOf('\nawait_netns_thread new\njoin_probe new\n');
  assert.ok(at >= 0, 'await_netns_thread new, then join_probe new');
  assert.ok(sh.indexOf('\nassert_dropped "after the upgrade"\n') >= 0 && sh.indexOf('\nassert_dropped "after the upgrade"\n') < at, 'the dropped state asserted before the restarts');
  assert.match(sh.slice(at), /\nif \[ "\$DOCKER_RESTARTS" -gt 0 \]; then\n(?: {2}#.*\n)* {2}assert_dropped "after the upgrade and /);
  assert.match(sh, /\n\[ -s "\$t\/threads-new" \] \|\| fail "after the upgrade /);
  // The no-join check: a run joins nothing since #545 (its own user namespace), so the plain test-user unit must join one
  // (else the probe can't tell), and the run must join none.
  assert.match(sh, /\ngrep -q "\^the containers' netns \(pid \[0-9\]\*, tid \[0-9\]\*, net:\\\[\[0-9\]\*\\\]\): joined; " "\$t\/join-new-plain\.out" \|\| fail /);
  assert.match(sh, /\nif grep -q ": joined; " "\$t\/join-new-run\.out"; then fail /);
  // Every join, through every thread, before and after, still reaches nothing.
  assert.match(sh, /if grep -q -- "-> \$PUB: OK\\\$" "\$t\/join-old-\$w\.out"; then fail /);
  assert.match(sh, /if grep -q -- "-> \$PUB: OK\\\$" "\$t\/join-new-\$w\.out"; then fail /);
  // assert_dropped checks the unit and the rule.
  const fn = sh.slice(sh.indexOf('\nassert_dropped() {'), sh.indexOf('\n}\n', sh.indexOf('\nassert_dropped() {')));
  assert.match(fn, /systemctl cat "\$DU" \| grep '\^NFTSet='; then fail/);
  assert.match(fn, /grep -Eq 'socket cgroupv2\|egress_ok' "\$t\/new-table"; then fail/);
  assert.match(fn, /if pull 90 2> \/dev\/null; then fail/);
});

test('egress-real-systemd.sh (#545): the default join probe is asserted refused from a run, with a plain unit showing the route is there, and fails without #545 (the helper before it lets the run out)', () => {
  const sh = readFileSync(ciScript, 'utf8');
  const at = sh.indexOf('\nawait_netns_thread default\njoin_probe default\n');
  assert.ok(at >= 0, 'a thread to join, then the default probe');
  const after = sh.slice(at);
  assert.match(after, /\nif grep -q ": joined; -> \$PUB: OK\$" "\$t\/join-default-run\.out"; then\n[\s\S]*?\n {2}fail "a test run joined Docker's namespaces and reached /);
  assert.match(after, /\nif grep -q ": joined; " "\$t\/join-default-run\.out"; then fail /);
  assert.match(after, /\ngrep -q "\^the containers' netns \(pid \[0-9\]\*, tid \[0-9\]\*, net:\\\[\[0-9\]\*\\\]\): joined; -> \$PUB: OK\$" "\$t\/join-default-plain\.out" \|\| fail /);
  // The fail-without: main before #545's helper installed, the same probe, which must reach the stand-in; then this one back.
  const pre = after.indexOf('sudo install -o root -g root -m 0755 "$t/helper-pre545.sh" "$H"\nawait_netns_thread pre545\njoin_probe pre545\nsudo install -o root -g root -m 0755 scripts/machine/worklane-testrun.sh "$H"\n');
  assert.ok(pre > 0, 'the old helper, probed, then this one back');
  assert.match(after.slice(pre), /\ngrep -q "\^the containers' netns \(pid \[0-9\]\*, tid \[0-9\]\*, net:\\\[\[0-9\]\*\\\]\): joined; -> \$PUB: OK\$" "\$t\/join-pre545-run\.out" \|\| fail /);
  assert.match(sh, /^PRE545=[0-9a-f]{40}$/m);
  // The helper this job installs is put back on any exit.
  const cleanup = sh.slice(sh.indexOf('\ncleanup() {'), sh.indexOf('\n}\n', sh.indexOf('\ncleanup() {')));
  assert.match(cleanup, /sudo install -o root -g root -m 0755 scripts\/machine\/worklane-testrun\.sh "\$H"/);
});
