// The MCP broker's unit (scripts/setup/mcp-broker.sh, #551): ProtectControlGroups is on, so the broker and every
// server it starts see the cgroup tree read-only. Not ProtectKernelTunables: with it the broker's servers didn't start
// on real systemd (ci-slow run 39093672334); /proc/sys stays unwritable to them by the kernel's permissions alone. The
// proof is real systemd's (ci-slow.yml runs scripts/ci/mcp-broker-kernel.sh in the add-project job). These tests hold
// the unit, that CI step and its checks; they read the fixture server it runs, and never run it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
