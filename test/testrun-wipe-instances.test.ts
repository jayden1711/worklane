// A wipe stops only its own instance's run. Instance names and run ids are both [a-z0-9-], so with the units named
// <cli>-test-<name>-<id>-<pid>, instance aa's `wipe b` matched "<cli>-test-aa-b-*": instance aa-b's runs and its Docker
// unit, which root then killed. The helper (scripts/machine/<cli>-testrun.sh) runs here as this user with systemctl
// stubbed by a table of units and their User=; the real-systemd CI job proves the same with two real instances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { systemdRunStats } from '../src/testrun/host.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const helperSrc = join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-testrun.sh`);
const real = (t: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].map((d) => join(d, t)).find((p) => existsSync(p));

/** The helper as instance <name>, its paths in a temp dir; systemctl answers from `units` (unit -> User=) and logs each stop. */
function helperAs(name: string, units: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-wipe-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  const table = join(dir, 'units');
  writeFileSync(table, Object.entries(units).map(([u, user]) => `${u} ${user}\n`).join(''));
  const log = join(dir, 'systemctl.log');
  // list-units: each unit matching any of the globs given (as systemd matches them); show -p User --value: its User=;
  // stop: logged, and the unit gone; kill and reset-failed: nothing.
  stub(
    'systemctl',
    `case "$1" in
  list-units) shift; pats=(); for a in "$@"; do [[ "$a" == -* ]] || pats+=("$a"); done
    while read -r u who; do for p in "\${pats[@]}"; do if [[ "$u" == $p ]]; then echo "$u loaded active running x"; break; fi; done; done < '${table}' ;;
  show) u="\${@: -1}"; while read -r x who; do [ "$x" = "$u" ] && echo "$who"; done < '${table}' ;;
  stop) shift; for u in "$@"; do echo "stop $u" >> '${log}'; grep -v "^$u " '${table}' > '${table}.new'; mv '${table}.new' '${table}'; done ;;
esac
exit 0`,
  );
  for (const t of ['getent', 'chown', 'runuser', 'git', 'install', 'systemd-run']) stub(t, 'exit 0');
  stub('id', `[ "$1" = -un ] && { echo root-stand-in; exit 0; }; exit 0`);
  stub('rm', `a=(); for x in "$@"; do [ "$x" = --one-file-system ] || a+=("$x"); done; exec ${real('rm')} "\${a[@]}"`);
  for (const t of ['sha256sum', 'cut', 'mkdir', 'stat', 'sh', 'cat', 'env', 'awk', 'sed', 'grep', 'tr', 'head', 'tail', 'mv']) {
    const p = real(t);
    if (p && !existsSync(join(bin, t))) symlinkSync(p, join(bin, t));
  }
  // macOS has no sha256sum: shasum's output reads the same for cut -c1-8.
  if (!existsSync(join(bin, 'sha256sum'))) stub('sha256sum', `exec ${real('shasum')} -a 256 "$@"`);
  let src = readFileSync(helperSrc, 'utf8');
  for (const [re, to] of [
    [/^export PATH=\S+$/m, `export PATH=${bin}`],
    [/^BASE=\S+$/m, `BASE=${join(dir, 'base')}`],
    [/^TMP_BASE=\S+$/m, `TMP_BASE=${join(dir, 't')}`],
    [/^ENV_DIR=\S+$/m, `ENV_DIR=${join(dir, 'env')}`],
    [/^sock_dir=.*$/m, `sock_dir=${join(dir, 's')}`],
  ] as const) {
    assert.match(src, re);
    src = src.replace(re, to);
  }
  const helper = join(dir, 'helper');
  writeFileSync(helper, src);
  const run = (...args: string[]) => spawnSync('/bin/bash', [helper, name, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  const stopped = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('stop ')).flatMap((l) => l.split(' ').slice(1)) : []);
  return { run, stopped, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('regression: instance aa\'s wipe of run b or b-1 never stops instance aa-b\'s units (its runs, old names or new, nor its Docker); its own old-named ones it does', { skip: !posix && 'bash' }, () => {
  const c = BRAND.cli;
  const units = {
    // Instance aa-b's: its Docker, a run made by the old helper (run 1: the same name as aa's run b-1 would get), one made by this one.
    [`${c}-test-aa-b-docker.service`]: 'wl-test-aa-b',
    [`${c}-test-aa-b-1-100.service`]: 'wl-test-aa-b',
    [`${c}-test-aa-b_1_100.service`]: 'wl-test-aa-b',
    // Instance aa's own: run b-1 by the old helper (left by an update), run b by this one, and run b-2 (not b's).
    [`${c}-test-aa-b-1-101.service`]: 'wl-test-aa',
    [`${c}-test-aa_b_300.service`]: 'wl-test-aa',
    [`${c}-test-aa_b-2_301.service`]: 'wl-test-aa',
    // Run b's fetch (docs/test-runs.md "Network"), and one of aa-b's run 1 named the same way.
    [`${c}-test-aa_b_fetch_302.service`]: 'wl-test-aa',
    [`${c}-test-aa-b_1_fetch_102.service`]: 'wl-test-aa-b',
    // Run b's network (slirp4netns, root's: no User=), and aa-b's run 1's.
    [`${c}-test-aa_b_net_303.service`]: '',
    [`${c}-test-aa-b_1_net_103.service`]: '',
  };
  const h = helperAs('aa', units);
  try {
    const b = h.run('wipe', 'b');
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(h.stopped(), [`${c}-test-aa_b_300.service`, `${c}-test-aa_b_fetch_302.service`, `${c}-test-aa_b_net_303.service`], 'wipe b: run b\'s own units only (its command\'s, its fetch\'s and its network\'s)');
    const b1 = h.run('wipe', 'b-1');
    assert.equal(b1.status, 0, b1.stderr);
    assert.deepEqual(h.stopped(), [`${c}-test-aa_b_300.service`, `${c}-test-aa_b_fetch_302.service`, `${c}-test-aa_b_net_303.service`, `${c}-test-aa-b-1-101.service`], 'wipe b-1: the old-named unit that is aa\'s, never aa-b\'s of the same shape');
  } finally {
    h.done();
  }
});

test('#545: a wipe stops its run\'s network unit whether it is the test user\'s (User=, slirp4netns as the test user) or root\'s (no User=), never one of another user\'s', { skip: !posix && 'bash' }, () => {
  const c = BRAND.cli;
  const units = {
    [`${c}-test-aa_b_300.service`]: 'wl-test-aa',
    // Run b's network: the test user's (this helper's), and root's (a helper before #545, or where the egress rule drops the test user).
    [`${c}-test-aa_b_net_303.service`]: 'wl-test-aa',
    [`${c}-test-aa_b_net_304.service`]: '',
    // A unit of that name with anyone else's User= was never this helper's.
    [`${c}-test-aa_b_net_305.service`]: 'wl-test-aa-b',
  };
  const h = helperAs('aa', units);
  try {
    const b = h.run('wipe', 'b');
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(h.stopped(), [`${c}-test-aa_b_300.service`, `${c}-test-aa_b_net_303.service`, `${c}-test-aa_b_net_304.service`]);
  } finally {
    h.done();
  }
});

test('exec names its unit <cli>-test-<name>_<id>_<pid>, the name wipe looks for; the engine takes its "Running as unit" line as systemd-run\'s, by either name', () => {
  const src = readFileSync(helperSrc, 'utf8');
  assert.match(src, /^run_unit\(\) \{ printf '[a-z]+-test-%s_%s_%s' "\$name" "\$1" "\$2"; \}$/m);
  assert.match(src, /^ {2}unit="\$\(run_unit "\$id" "\$\$"\)"$/m);
  assert.match(src, /^ {2}unit="\$\(run_unit "\$id" "fetch_\$\$"\)"$/m, 'the fetch\'s unit too');
  for (const unit of [`${BRAND.cli}-test-aa-b_fast-abc-1_4243.service`, `${BRAND.cli}-test-aa-b-fast-abc-1-4243.service`]) {
    const line = `Running as unit: ${unit}\n`;
    const s = systemdRunStats(`${line}the run's own\n`);
    assert.deepEqual(s.own, [[0, line.length]], unit);
  }
});
