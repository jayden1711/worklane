import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, removeSandboxPlaceholders } from '../src/worktrees.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('regression: the sandbox\'s empty mount points in a worktree are never committed, and are removed after the run', () => {
  const { dir } = exampleProject();
  // A project file that happens to share a name with a protected path: changes to it must still show.
  writeFileSync(join(dir, '.gitmodules'), '');
  git(dir, 'add', '.gitmodules');
  git(dir, '-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '-m', 'submodules file');
  const o = { repo: dir, root: '.claude/worktrees', stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] };
  const { path } = createWorktree(o, 'issue-11', 'worklane/issue-11', 'HEAD');
  // What Claude Code's sandbox leaves on Linux (seen on a real run): empty files and directories.
  for (const f of ['.bash_profile', '.bashrc', '.claude/launch.json', '.claude/loop.md']) {
    mkdirSync(join(path, f, '..'), { recursive: true });
    writeFileSync(join(path, f), '');
  }
  for (const d of ['.claude/agents', '.claude/commands']) mkdirSync(join(path, d), { recursive: true });
  // Not a placeholder: a non-empty file at a protected path.
  writeFileSync(join(path, '.mcp.json'), '{"mcpServers":{}}');
  assert.equal(git(path, 'status', '--porcelain'), '', 'nothing for the clean-worktree check to flag');
  git(path, 'add', '-A');
  assert.equal(git(path, 'diff', '--cached', '--name-only'), '', 'an agent\'s git add -A stages none of them');
  writeFileSync(join(path, '.gitmodules'), '[submodule "x"]\n');
  assert.match(git(path, 'status', '--porcelain'), /^ ?M \.gitmodules$/m, 'a tracked file at a protected path still shows');
  git(path, 'checkout', '--', '.gitmodules');

  const removed = removeSandboxPlaceholders(path);
  assert.deepEqual(removed.sort(), ['.bash_profile', '.bashrc', '.claude/agents', '.claude/commands', '.claude/launch.json', '.claude/loop.md']);
  assert.equal(existsSync(join(path, '.mcp.json')), true, 'a non-empty file is not a placeholder');
  assert.equal(existsSync(join(path, '.gitmodules')), true, 'a tracked file is never removed');
});
