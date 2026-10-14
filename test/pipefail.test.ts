import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv, shellCommand } from '../src/os/index.js';
import { createWorktree } from '../src/worktrees.js';
import { repoRoot } from './helpers.js';

const run = (command: string) => {
  const [file, args] = shellCommand(command);
  return spawnSync(file, args, { encoding: 'utf8', env: childEnv() }).status;
};

test('regression: a pipeline fails when any stage fails (`false | tail` is red)', () => {
  assert.notEqual(run('false | tail -1'), 0);
  assert.notEqual(run('node -e "process.exit(3)" | cat'), 0);
  assert.equal(run('true | tail -1'), 0);
  assert.equal(run('echo ok | grep -q ok'), 0);
});

test('regression: a worktree setup step piped into cat reports its failure', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pipefail-wt-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), '1');
  git('add', 'a');
  git('-c', 'user.email=a@example.com', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const { setupErrors } = createWorktree({ repo, root: 'wt', stateDir: join(repo, 'state'), setup: ['node -e "process.exit(2)" | cat'] }, 'x', 'x', 'main');
  assert.equal(setupErrors.length, 1);
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

test('every project command goes through the pipefail shell: no shell: true, no execSync in src/', () => {
  const offenders = sources(join(repoRoot, 'src')).filter((f) => /shell:\s*true|\bexecSync\(/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'use shellCommand() from the OS adapter');
});
