// The MCP broker's unit (scripts/setup/mcp-broker.sh, #551): ProtectControlGroups is on, so the broker and every
// server it starts see the cgroup tree read-only. Not ProtectKernelTunables: with it the broker's servers didn't start
// on real systemd (ci-slow run 39093672334); /proc/sys stays unwritable to them by the kernel's permissions alone. The
// proof is real systemd's (ci-slow.yml runs scripts/ci/mcp-broker-kernel.sh in the add-project job). These tests hold
// the unit, that CI step, and the fixture server it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const unprivileged = process.platform === 'linux' && process.getuid?.() !== 0 && existsSync('/sys/fs/cgroup/cgroup.procs');

test("the escape fixture's kernel server tries the sysctls and the cgroup tree and reports each try (denied here: not root)", { skip: !unprivileged && 'Linux with cgroup v2, not as root' }, () => {
  // A copy outside the repo: the fixture is CommonJS, as it is in the plugin store, and the repo's package.json is a module.
  const dir = mkdtempSync(join(tmpdir(), 'escape-kernel-'));
  copyFileSync(join(repoRoot, 'test', 'fixtures', 'plugins', 'escape', 'server.js'), join(dir, 'server.js'));
  const input = ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}', '{"jsonrpc":"2.0","id":2,"method":"tools/list"}', ''].join('\n');
  const r = spawnSync(process.execPath, ['server.js', 'kernel'], { cwd: dir, input, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
  const list = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { tools?: { description: string }[] } }).find((m) => m.id === 2);
  assert.ok(list?.result?.tools, `tools/list answered: ${r.stdout}${r.stderr}`);
  const tries = list.result.tools[0]!.description.split(' ');
  assert.equal(tries.length, 6, tries.join('\n'));
  assert.match(tries[0]!, /^\/proc\/sys\/kernel\/domainname=denied\(E[A-Z]+\)$/);
  assert.match(tries[1]!, /^\/proc\/sys\/vm\/swappiness=denied\(E[A-Z]+\)$/);
  assert.match(tries[2]!, /^\/sys\/fs\/cgroup\/.*\/escaped=denied\(E[A-Z]+\)$/);
  assert.match(tries[3]!, /^\/sys\/fs\/cgroup\/cgroup\.procs=denied\(E[A-Z]+\)$/);
  // How each is mounted here (this host's, not a sandbox's): reported, whatever it is.
  assert.match(tries[4]!, /^\/proc\/sys:mount=(ro|rw|none)$/);
  assert.match(tries[5]!, /^\/sys\/fs\/cgroup:mount=(ro|rw|none)$/);
});
