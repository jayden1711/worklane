import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { runHook } from '../src/hook.js';
import { agentReadableDir, writeAgentReadable } from '../src/os/index.js';
import { exampleProject, repoRoot } from './helpers.js';

const AGENT = `${BRAND.envPrefix}_AGENT`;
const TASK = `${BRAND.envPrefix}_TASK_FILE`;
const posix = process.platform !== 'win32';

const decision = (out: { stdout?: string }) => (out.stdout ? (JSON.parse(out.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null);

async function edit(dir: string, stateDir: string, file: string, env: Record<string, string>) {
  return runHook('pre-tool-use', { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, file) } }, { ...process.env, [`${BRAND.envPrefix}_STATE_DIR`]: stateDir, ...env });
}

function project() {
  const { dir, stateDir } = exampleProject();
  const tasks = mkdtempSync(join(tmpdir(), 'tasks-'));
  return { dir, stateDir, tasks };
}

test('the guard blocks an edit to a frozen test named in the task file, and allows other files', async () => {
  const { dir, stateDir, tasks } = project();
  const file = join(tasks, 'issue-1.json');
  writeFileSync(file, JSON.stringify({ id: 'issue-1', done_when: [{ repro: true }], frozen: ['test/repro.test.js'] }));
  const frozen = decision(await edit(dir, stateDir, 'test/repro.test.js', { [AGENT]: '1', [TASK]: file }));
  assert.equal(frozen?.permissionDecision, 'deny');
  const other = decision(await edit(dir, stateDir, 'src/price.js', { [AGENT]: '1', [TASK]: file }));
  assert.notEqual(other?.permissionDecision, 'deny');
});

test('a missing, malformed or unreadable task file denies the agent\'s call instead of skipping the guard', async () => {
  const { dir, stateDir, tasks } = project();
  const cases: [string, string][] = [['missing', join(tasks, 'nope.json')]];
  const bad = join(tasks, 'bad.json');
  writeFileSync(bad, '{ not json');
  cases.push(['malformed', bad]);
  const shape = join(tasks, 'shape.json');
  writeFileSync(shape, JSON.stringify({ id: 'x' }));
  cases.push(['not a task', shape]);
  if (posix && process.getuid?.() !== 0) {
    const locked = join(tasks, 'locked.json');
    writeFileSync(locked, JSON.stringify({ id: 'issue-1', done_when: [{ repro: true }], frozen: [] }));
    chmodSync(locked, 0o000);
    cases.push(['unreadable', locked]);
  }
  for (const [what, file] of cases) {
    const d = decision(await edit(dir, stateDir, 'src/price.js', { [AGENT]: '1', [TASK]: file }));
    assert.equal(d?.permissionDecision, 'deny', what);
    assert.match(d!.permissionDecisionReason, /task file .* can't be read/, what);
  }
  // A human session never has a task file pushed on it: no change there.
  const human = decision(await edit(dir, stateDir, 'src/price.js', { [TASK]: join(tasks, 'nope.json') }));
  assert.notEqual(human?.permissionDecision, 'deny');
});

test('task files live in a directory the agents\' group can read but not write; its parent can\'t be used to swap it', { skip: !posix && 'POSIX modes' }, () => {
  const parent = join(mkdtempSync(join(tmpdir(), 'inst-')), 'name');
  mkdirSync(parent);
  chmodSync(parent, 0o2770); // as instance.sh made it before: group-writable, not sticky
  const dir = join(parent, 'tasks');
  const gid = process.getgid!();
  agentReadableDir(dir, gid);
  assert.equal(statSync(parent).mode & 0o1000, 0o1000, 'the parent became sticky: group members can no longer rename tasks/');
  assert.equal(statSync(dir).mode & 0o777, 0o750);
  if (process.platform === 'linux') assert.equal(statSync(dir).mode & 0o2000, 0o2000, 'setgid, so files keep the group');
  assert.equal(statSync(dir).gid, gid);
  const file = join(dir, 'issue-1.json');
  writeAgentReadable(file, '{}', gid);
  writeAgentReadable(file, '{"again":1}', gid);
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.equal(statSync(file).gid, gid);
  assert.equal(readFileSync(file, 'utf8'), '{"again":1}');
});

test('instance.sh makes the instance root sticky for new instances', () => {
  assert.match(readFileSync(join(repoRoot, 'scripts', 'setup', 'instance.sh'), 'utf8'), /install -d -o "\$coord" -g "\$work" -m 3770 "\/srv\/worklane\/\$name"/);
});

// Separate users for real (CI runners with passwordless sudo): the agent's hook runs as another user.
const other = 'nobody';
const canSwitch = posix && spawnSync('sudo', ['-n', '-u', other, 'true']).status === 0;
const cli = join(repoRoot, 'dist', 'src', 'cli.js');

test('acceptance: with separate users, the agent user can read its task file (so the guard holds) but not change it', { skip: !canSwitch && 'needs passwordless sudo to another user' }, (t) => {
  if (spawnSync('sudo', ['-n', '-u', other, 'test', '-r', cli]).status !== 0) return t.skip(`${other} can't read the engine at ${cli}`);
  const { dir, stateDir } = exampleProject();
  execFileSync('chmod', ['-R', 'a+rX', join(dir, '..')]);
  const group = execFileSync('id', ['-gn', other], { encoding: 'utf8' }).trim();
  const root = mkdtempSync(join(tmpdir(), 'inst-'));
  chmodSync(root, 0o755);
  const tasks = join(root, 'tasks');
  mkdirSync(tasks);
  const file = join(tasks, 'issue-1.json');
  writeFileSync(file, JSON.stringify({ id: 'issue-1', done_when: [{ repro: true }], frozen: ['test/repro.test.js'] }));
  // As the coordinator sets it up: owner us, group the agent's, 2750 and 0640 (chgrp needs root here only
  // because the test user isn't in that group; the coordinator is in the agents' group).
  execFileSync('sudo', ['-n', 'chgrp', group, tasks, file]);
  chmodSync(tasks, 0o2750);
  chmodSync(file, 0o640);
  const hookAs = (taskFile: string, path: string) =>
    spawnSync('sudo', ['-n', '-u', other, 'env', `${AGENT}=1`, `${TASK}=${taskFile}`, `${BRAND.envPrefix}_STATE_DIR=${stateDir}`, `PATH=${process.env.PATH}`, process.execPath, cli, 'hook', 'pre-tool-use'], {
      cwd: dir,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Edit', tool_input: { file_path: join(dir, path) } }),
      encoding: 'utf8',
    });
  const blocked = decision(hookAs(file, 'test/repro.test.js'));
  assert.equal(blocked?.permissionDecision, 'deny', 'the frozen test is guarded for the agent user');
  assert.doesNotMatch(blocked!.permissionDecisionReason, /can't be read/, 'because the file was read, not because it failed');
  assert.notEqual(decision(hookAs(file, 'src/price.js'))?.permissionDecision, 'deny');
  assert.notEqual(spawnSync('sudo', ['-n', '-u', other, 'sh', '-c', `echo '{}' > "${file}"`]).status, 0, 'the agent user cannot rewrite it');
  // A task file the agent user can't read (wrong group) fails closed.
  const hidden = join(root, 'hidden.json');
  writeFileSync(hidden, readFileSync(file));
  chmodSync(hidden, 0o600);
  const closed = decision(hookAs(hidden, 'src/price.js'));
  assert.equal(closed?.permissionDecision, 'deny');
  assert.match(closed!.permissionDecisionReason, /can't be read/);
  assert.ok(existsSync(file));
});
