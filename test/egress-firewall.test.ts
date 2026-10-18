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

/** A bin dir first on PATH: getent lists a machine's users, systemctl --version says `systemd`. */
function machine(systemd: number) {
  const dir = mkdtempSync(join(tmpdir(), 'egress-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const users = ['root:x:0:0::/root:/bin/bash', 'wl-shop:x:1000:1000::/srv/home-shop:/bin/bash', 'wl-exp-shop:x:1001:1001::/:/usr/sbin/nologin', 'wl-score-shop:x:1002:1002::/:/usr/sbin/nologin', 'wl-test-shop:x:1003:1003::/var/lib/worklane-test/shop:/usr/sbin/nologin', 'wl-test-a-b:x:1004:1004::/:/usr/sbin/nologin'];
  stub('getent', `[ "$1" = passwd ] && printf '%s\\n' ${users.map((u) => `'${u}'`).join(' ')}`);
  stub('systemctl', `[ "$1" = --version ] && { echo "systemd ${systemd} (${systemd}.4-1ubuntu8)"; echo "+PAM +AUDIT"; exit 0; }; exit 0`);
  const run = (cmd: string, args: string[]) => spawnSync('bash', [cmd, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
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
    // systemctl show -p <prop> --value <unit>: the unit's NFTSet or ControlGroup; list-units [... <pattern>]: the units
    // matching the pattern (all of them without one), one a line as --plain --no-legend prints them.
    const show = Object.entries(units)
      .flatMap(([u, p]) => [`'NFTSet ${u}') echo '${p.nftset ?? ''}' ;;`, `'ControlGroup ${u}') echo '${p.cg ?? ''}' ;;`])
      .join('\n      ');
    const prog = `set -euo pipefail
TABLE=worklane_egress SET=egress_ok
systemctl() {
  local pat='*' a u
  case "$1" in
    list-units)
      for a in "$@"; do case "$a" in list-units | -*) ;; *) pat="$a" ;; esac; done
      for u in ${Object.keys(units).join(' ')}; do case "$u" in $pat) echo "$u loaded active running x" ;; esac; done ;;
    show)
      case "$3 $5" in
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

test('apply puts each running unit whose NFTSet= names the set in it, as systemd would; no other unit', { skip: !posix && 'bash' }, () => {
  // A Docker unit started before the set existed (test-user.sh install before the first apply) found nothing to join.
  const r = withFunctions(['in_set_by_unit', 'exempt_units', 'join_running'], {
    'worklane-test-shop-docker.service': { nftset: OURS, cg: dockerCg('shop') },
    'other-set.service': { nftset: 'cgroup:inet:other_table:egress_ok', cg: '/system.slice/other-set.service' },
    'plain.service': { cg: '/system.slice/plain.service' },
  }, 'join_running');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.nft, 'nft add element inet worklane_egress egress_ok { "worklane.slice/worklane-test.slice/worklane-test-shop-docker.service" }\n');
  assert.equal(r.stdout, `exempt: worklane-test-shop-docker.service (NFTSet=): its cgroup ${dockerCg('shop')} may send out\n`);
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
  assert.match(install, /if \[ -f \/etc\/worklane\/egress\.users \]; then[\s\S]*?grep -qx '# --with-test-users' \/etc\/worklane\/egress\.users[\s\S]*?bash "\$here\/egress-firewall\.sh" apply \$egress_flags \|\| \{[^}]*exit 1; \}/);
  // After Docker is up (so apply finds it running and puts it in the set), before the final check.
  assert.ok(install.indexOf('is active"') < install.indexOf('egress-firewall.sh" apply'));
  assert.ok(install.indexOf('egress-firewall.sh" apply') < install.indexOf('check_cmd ||'));
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
