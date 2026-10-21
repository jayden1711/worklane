// The MCP broker's unit (scripts/setup/mcp-broker.sh, #551): ProtectControlGroups is on, so the broker and every
// server it starts see the cgroup tree read-only. Not ProtectKernelTunables: with it the broker's servers didn't start
// on real systemd (ci-slow run 39093672334); /proc/sys stays unwritable to them by the kernel's permissions alone. The
// proof is real systemd's (ci-slow.yml runs scripts/ci/mcp-broker-kernel.sh in the add-project job). These tests hold
// the unit, that CI step and its checks; they read the fixture server it runs, and never run its tries. The one run of
// it here is its refusal outside the broker's sandbox (#608), started only once its source shows the guard comes first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

/** The [Service] lines of the unit mcp-broker.sh writes (its heredoc), comments dropped. */
function brokerUnit(): string[] {
  const sh = read('scripts', 'setup', 'mcp-broker.sh');
  const m = /cat > "\$tmp" <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(sh);
  assert.ok(m, 'the unit heredoc in mcp-broker.sh');
  return m[1]!.split('\n').filter((l) => l && !l.startsWith('#'));
}

test("the MCP broker's unit has ProtectControlGroups on, beside the rest of its sandbox, and not ProtectKernelTunables (#551)", () => {
  const unit = brokerUnit();
  for (const line of ['ProtectControlGroups=yes', 'ProtectKernelModules=yes', 'ProtectSystem=strict', 'ProtectHome=read-only', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'UMask=0077']) {
    assert.ok(unit.includes(line), `unit: ${line}`);
  }
  assert.equal(unit.filter((l) => l.startsWith('ProtectControlGroups=')).length, 1, "set once: a later line can't turn it back off");
  assert.deepEqual(unit.filter((l) => l.startsWith('ProtectKernelTunables=')), [], "with it, the broker's servers don't start on real systemd");
});

test('ci-slow proves it on real systemd: the probe runs after the MCP broker step, and checks the unit, the mounts and a server inside the broker', () => {
  const yml = read('.github', 'workflows', 'ci-slow.yml');
  const broker = yml.indexOf('sudo bash scripts/setup/mcp-broker.sh ci |');
  const probe = yml.indexOf('run: bash scripts/ci/mcp-broker-kernel.sh ci');
  assert.ok(broker > 0 && probe > broker, 'the probe step comes after the broker is set up and the escape plugin approved');
  const job = yml.slice(yml.indexOf('\n  add-project-real-systemd:'));
  assert.ok(job.includes('run: bash scripts/ci/mcp-broker-kernel.sh ci'), "in add-project's job");
  const sh = read('scripts', 'ci', 'mcp-broker-kernel.sh');
  for (const s of [
    'for prop in none ProtectKernelTunables ProtectControlGroups; do',
    '[ "$(systemctl show -p ProtectControlGroups --value "$unit")" = yes ]',
    `o="$(sudo awk '$5 == "/sys/fs/cgroup" { o = $6 } END { print o }' "/proc/$pid/mountinfo")"`,
    'mcp-preview "$id" escape kernel',
    'mcp-snapshot "$id"',
    "'/proc/sys/kernel/domainname=denied\\(' '/proc/sys/vm/swappiness=denied\\(' '/sys/fs/cgroup/.*/escaped=denied\\(' '/sys/fs/cgroup/cgroup.procs=denied\\(' '/sys/fs/cgroup:mount=ro$'",
    "grep -q 'WROTE'",
  ]) assert.ok(sh.includes(s), `probe: ${s}`);
  // The snapshot's wait is on its own result: the status file still says the same id is done from its preview.
  assert.ok(!sh.includes('mcp-snapshot "$id" && wait_status'), "wait_status returns at once on the preview's done");
  assert.ok(sh.includes(`sudo jq -e '.snapshotWithSecrets == true' "$p" > /dev/null 2>&1 && break`));
  // The broker's own start of a server prints its error and the broker's journal before the step's checks, and the job's
  // failure dump has the broker's journal: a failure carries bubblewrap's words.
  const step = job.slice(job.indexOf('mcp-snapshot kit-notes && wait_status kit-notes'));
  const journal = step.indexOf('sudo journalctl -u "worklane-mcp@ci" --no-pager | tail -n 30');
  assert.ok(journal > 0 && journal < step.indexOf("jq -e '.snapshotWithSecrets == true"), 'the journal before the check');
  assert.ok(step.indexOf("jq -c '{snapshotError}'") < journal);
  assert.match(job.slice(job.indexOf('- name: the units and the fake\'s log, on failure')), /^\s+sudo journalctl --no-pager -n 80 -u "worklane-mcp@ci" \|\| true$/m);
  const mcp = JSON.parse(read('test', 'fixtures', 'plugins', 'escape', '.mcp.json')) as { mcpServers: Record<string, { args: string[] }> };
  assert.deepEqual(mcp.mcpServers.kernel?.args, ['${CLAUDE_PLUGIN_ROOT}/server.js', 'kernel']);
});

// WHY: never run the escape fixture here. It writes at load, outside any sandbox: its default mode into every home, and
// its kernel mode into the cgroup tree (a delegated cgroup takes the child it makes) and the root cgroup.procs. A
// fixture that doesn't know "kernel" (main's, in a fail-without run) falls into the default mode. ci-slow's probe runs it
// inside the broker's sandbox, the only place it may run; here the probe's own checks get its words, as data.

/** The probe's verdict on a kernel server's description, as mcp-broker-kernel.sh reaches it: its patterns, read from it. */
function probeAccepts(description: string): boolean {
  const sh = read('scripts', 'ci', 'mcp-broker-kernel.sh');
  const loop = /^for t in ((?:'[^']*' ?)+); do$/m.exec(sh);
  assert.ok(loop, "the probe's pattern loop");
  const patterns = [...loop[1]!.matchAll(/'([^']*)'/g)].map((m) => new RegExp(`^${m[1]}`));
  assert.ok(sh.includes(`if echo "$tries" | grep -q 'WROTE'; then`), "the probe's WROTE check");
  const lines = description.split(' ');
  return patterns.every((re) => lines.some((l) => re.test(l))) && !description.includes('WROTE');
}

// The kernel server's description in ci-slow run 39097410636 (real systemd, inside the broker's sandbox), word for word.
const cgroup = `/sys/fs/cgroup/system.slice/system-worklane\\x2dmcp.slice/${['worklane-mcp', 'ci.service'].join('@')}`;
const ci = [
  '/proc/sys/kernel/domainname=denied(EACCES)',
  '/proc/sys/vm/swappiness=denied(EACCES)',
  `${cgroup}/escaped=denied(EROFS)`,
  '/sys/fs/cgroup/cgroup.procs=denied(EROFS)',
  '/proc/sys:mount=none',
  '/sys/fs/cgroup:mount=ro',
].join(' ');

test("the probe accepts the kernel server's real-systemd report, and refuses one where any try landed or the cgroup tree is writable", () => {
  assert.equal(probeAccepts(ci), true);
  for (const [from, to] of [
    ['/proc/sys/kernel/domainname=denied(EACCES)', '/proc/sys/kernel/domainname=WROTE'],
    ['/proc/sys/vm/swappiness=denied(EACCES)', '/proc/sys/vm/swappiness=WROTE'],
    [`${cgroup}/escaped=denied(EROFS)`, `${cgroup}/escaped=WROTE`],
    ['/sys/fs/cgroup/cgroup.procs=denied(EROFS)', '/sys/fs/cgroup/cgroup.procs=WROTE'],
    ['/sys/fs/cgroup:mount=ro', '/sys/fs/cgroup:mount=rw'],
    ['/sys/fs/cgroup:mount=ro', '/sys/fs/cgroup:mount=none'],
    ['/proc/sys/vm/swappiness=denied(EACCES) ', ''],
  ]) {
    assert.ok(ci.includes(from!), from);
    assert.equal(probeAccepts(ci.replace(from!, to!)), false, `${from} -> ${to}`);
  }
  // The fixture's kernel mode makes exactly these tries (its source, read, never run).
  const server = read('test', 'fixtures', 'plugins', 'escape', 'server.js');
  for (const s of ["'/proc/sys/kernel/domainname', '/proc/sys/vm/swappiness'", "path.join('/sys/fs/cgroup', own, 'escaped')", "attempt('/sys/fs/cgroup/cgroup.procs'", "for (const m of ['/proc/sys', '/sys/fs/cgroup'])"]) {
    assert.ok(server.includes(s), `fixture: ${s}`);
  }
});

// #608: the fixture makes its tries only inside the broker's units (the throwaway snapshot unit, and the broker's own
// unit with sandbox-runtime around the server); anywhere else, and as root in any mode, it refuses before it has an fs.
const escape = join(repoRoot, 'test', 'fixtures', 'plugins', 'escape');
type Facts = { uid: number | null; euid: number | null; status: string | null; cgroup: string | null; mountinfo: string | null };
type Guard = { facts: () => Facts; refusal: (f: Facts) => string | null };

/** server.js's first statements are its guard: no module but the guard's is loaded, and nothing runs, before it exits. */
function assertGuardFirst(): void {
  const code = readFileSync(join(escape, 'server.js'), 'utf8').split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('//'));
  assert.deepEqual(code.slice(0, 3), ["const { facts, refusal } = require('./confined.js');", 'const why = refusal(facts());', 'if (why) {'], "server.js's first statements: the guard");
  assert.match(code[3]!, /^ {2}process\.stderr\.write\(`[^`]*\$\{why\}[^`]*`\);$/, 'the refusal names its reason');
  assert.match(code[4]!, /^ {2}process\.exit\([1-9]\d*\);$/, 'and exits non-zero');
  assert.equal(code[5], '}');
}

/**
 * The plugin's files copied out of the repo, as the broker's store holds them: no package.json above, so CommonJS (in
 * the repo, the root package.json's "type": "module" makes node load them as ES modules).
 */
function storeCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'escape-608-')), 'escape');
  cpSync(escape, dir, { recursive: true });
  return dir;
}

/** The guard module, loaded only once its source shows it reads /proc and nothing else (no write, no env, no child). */
function guard(): Guard {
  const src = readFileSync(join(escape, 'confined.js'), 'utf8');
  assert.deepEqual([...src.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), ["'fs'"]);
  assert.deepEqual([...new Set([...src.matchAll(/\bfs\.(\w+)/g)].map((m) => m[1]))], ['readFileSync']);
  assert.doesNotMatch(src, /process\.env|child_process|\beval\(|Function\(|import\(/, 'its facts are the kernel\'s, never an env var');
  return createRequire(import.meta.url)(join(storeCopy(), 'confined.js')) as Guard;
}

// Inside: what the server sees in each unit, by the units' own properties (src/mcp/throwaway.ts's THROWAWAY_PROPERTIES,
// scripts/setup/mcp-broker.sh's unit, sandbox-runtime's --ro-bind / / and --cap-drop ALL). The broker's cgroup is ci-slow
// run 39097410636's (the kernel server's report above); the snapshot unit's is its name in src/plugins/cli.ts.
const brokerCgroup = cgroup.slice('/sys/fs/cgroup'.length);
const snapshotUnit = '/system.slice/worklane-mcp-snapshot-ci_escape-probe_4242.service';
const status = (capEff = '0000000000000000', nnp = '1') => `Name:\tnode\nUid:\t61234\t61234\t61234\t61234\nCapEff:\t${capEff}\nNoNewPrivs:\t${nnp}\n`;
// sandbox-runtime's root: bubblewrap's own tmpfs at / with the host's / bound read-only over it (the top one counts).
const mounts = (top = 'ro,nosuid,nodev,relatime') => ['22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw', `410 22 8:1 / / ${top} - ext4 /dev/sda1 rw`, '411 410 0:5 / /dev rw,nosuid - tmpfs tmpfs rw'].join('\n');
const inside = (unit: string, o: Partial<Facts> = {}): Facts => ({ uid: 61234, euid: 61234, status: status(), cgroup: `0::${unit}\n`, mountinfo: mounts(), ...o });

test('the escape fixture checks it is inside the broker\'s sandbox before anything else: server.js loads no fs and runs nothing before its guard, and the guard only reads /proc (#608)', () => {
  assertGuardFirst();
  const g = guard();
  assert.equal(typeof g.refusal, 'function');
  // The places it tries, from the stand-in root a test gives it, '/' otherwise (the units never set it: launch.ts's env).
  assert.ok(readFileSync(join(escape, 'server.js'), 'utf8').includes("const ROOT = process.env.ESCAPE_FIXTURE_ROOT || '/';"));
});

test('the guard lets the fixture run only in the broker\'s units with their sandbox on, and never as root (uid 0) in any mode (#608)', () => {
  const g = guard();
  assert.equal(g.refusal(inside(brokerCgroup)), null, 'the broker\'s unit, inside sandbox-runtime');
  assert.equal(g.refusal(inside(snapshotUnit)), null, 'the throwaway snapshot unit');
  for (const [why, f, says] of [
    ['uid 0', inside(brokerCgroup, { uid: 0 }), /uid 0/],
    ['euid 0', inside(brokerCgroup, { euid: 0 }), /uid 0/],
    ['uid 0, everything else inside', inside(snapshotUnit, { uid: 0, euid: 0 }), /root/],
    ['no uid (not Linux)', inside(brokerCgroup, { uid: null, euid: null }), /uid/],
    ['capabilities', inside(brokerCgroup, { status: status('000001ffffffffff') }), /capabilit/],
    ['no_new_privs off', inside(brokerCgroup, { status: status(undefined, '0') }), /NoNewPrivs/],
    ['/ writable', inside(brokerCgroup, { mountinfo: mounts('rw,relatime') }), /\/ is mounted read-write/],
    ['/ read-only under, writable on top', inside(brokerCgroup, { mountinfo: ['22 1 8:1 / / ro - ext4 /dev/sda1 rw', '410 22 8:1 / / rw - ext4 /dev/sda1 rw'].join('\n') }), /read-write/],
    ['a login session', inside('/user.slice/user-1000.slice/session-3.scope'), /cgroup/],
    ['WSL or a container', inside('/init.scope'), /cgroup/],
    ['the cgroup root', inside('/'), /cgroup/],
    ['another system service', inside('/system.slice/ssh.service'), /cgroup/],
    ['a user manager\'s unit of the same name', inside('/user.slice/user-1000.slice/user@1000.service/app.slice/worklane-mcp@ci.service'), /cgroup/],
    ['a cgroup below the broker\'s', inside(`${brokerCgroup}/x`), /cgroup/],
    ['no /proc', { uid: 1000, euid: 1000, status: null, cgroup: null, mountinfo: null }, /\/proc/],
  ] as [string, Facts, RegExp][]) {
    const r = g.refusal(f);
    assert.ok(r, `${why}: refused`);
    assert.match(r, says, why);
  }
});

test('run outside the broker\'s sandbox, with HOME and the places it tries in a stand-in, the fixture writes nothing and exits non-zero naming why (#608)', () => {
  // WHY: main's fixture wrote $HOME/escaped into a real home when an agent ran it like this. It is started only after its
  // source shows the guard comes first and the guard refuses this very process (the child inherits its uid, cgroup,
  // mounts and no_new_privs).
  assertGuardFirst();
  const g = guard();
  const here = g.refusal(g.facts());
  assert.ok(here, 'this test process is outside the broker\'s units');
  const plugin = storeCopy();
  const base = dirname(plugin);
  const home = join(base, 'home-of-the-run');
  const root = join(base, 'root');
  for (const d of [home, 'home/alice', 'home/wl-ci-mcp/.cache', 'home/wl-ci-mcp/.npm', 'home/wl-ci-mcp/secrets', 'var/lib/worklane-mcp-ci', 'var/lib/worklane/plugins/store/ci/kit', 'var/lib/worklane/plugins/previews', 'etc/worklane', 'opt/worklane']) {
    mkdirSync(d === home ? d : join(root, d), { recursive: true });
  }
  const r = spawnSync(process.execPath, [join(plugin, 'server.js')], { cwd: plugin, encoding: 'utf8', input: '', timeout: 20_000, env: { PATH: process.env.PATH ?? '', HOME: home, ESCAPE_FIXTURE_ROOT: root } });
  assert.ok(typeof r.status === 'number' && r.status !== 0, `exit ${r.status}`);
  assert.match(r.stderr, /refuses to run/);
  assert.ok(r.stderr.includes(here), `stderr names the reason: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.deepEqual((readdirSync(base, { recursive: true, encoding: 'utf8' })).filter((p) => /escaped/.test(p)), [], 'nothing written');
});
