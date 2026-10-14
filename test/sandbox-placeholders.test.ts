import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, excludeSandboxPlaceholders, removeSandboxPlaceholders } from '../src/worktrees.js';
import { BRAND } from '../src/brand.js';
import { exampleProject } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('regression: the sandbox\'s empty mount points in a worktree are never committed, and are removed after the run', () => {
  const { dir } = exampleProject();
  // Project files that share names with protected paths: changes to them must still show.
  writeFileSync(join(dir, '.gitmodules'), '');
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'hooks', 'guard.py'), 'print(1)\n');
  git(dir, 'add', '.gitmodules', '.claude/hooks/guard.py');
  git(dir, '-c', 'user.name=a', '-c', 'user.email=a@example.com', 'commit', '-q', '-m', 'project files');
  const o = { repo: dir, root: '.claude/worktrees', stateDir: mkdtempSync(join(tmpdir(), 'wt-state-')), setup: [] };
  const { path } = createWorktree(o, 'issue-14', 'worklane/issue-14', 'HEAD');
  // What Claude Code's sandbox left on Linux in real runs: empty files and directories.
  const files = ['.bash_profile', '.bashrc', '.claude/launch.json', '.claude/loop.md', '.claude/scheduled_tasks.json'];
  const dirs = ['.claude/agents', '.claude/commands', '.claude/output-styles', '.claude/routines'];
  for (const f of files) {
    mkdirSync(join(path, f, '..'), { recursive: true });
    writeFileSync(join(path, f), '');
  }
  for (const d of dirs) mkdirSync(join(path, d), { recursive: true });
  // Not placeholders: non-empty files.
  writeFileSync(join(path, '.mcp.json'), '{"mcpServers":{}}');
  writeFileSync(join(path, '.claude', 'notes.md'), 'an agent may not add harness files\n');
  assert.equal(git(path, 'status', '--porcelain'), '', 'nothing for the clean-worktree check to flag');
  git(path, 'add', '-A');
  assert.equal(git(path, 'diff', '--cached', '--name-only'), '', 'an agent\'s git add -A stages none of them');
  writeFileSync(join(path, '.gitmodules'), '[submodule "x"]\n');
  writeFileSync(join(path, '.claude', 'hooks', 'guard.py'), 'print(2)\n');
  assert.deepEqual(git(path, 'status', '--porcelain').split('\n').map((l) => l.trim()).sort(), ['M .claude/hooks/guard.py', 'M .gitmodules'], 'tracked files at protected paths still show');
  git(path, 'checkout', '--', '.gitmodules', '.claude/hooks/guard.py');

  const removed = removeSandboxPlaceholders(path);
  assert.deepEqual(removed.sort(), [...files, ...dirs].sort());
  assert.equal(existsSync(join(path, '.mcp.json')), true, 'a non-empty file is not a placeholder');
  assert.equal(existsSync(join(path, '.claude', 'notes.md')), true);
  assert.equal(existsSync(join(path, '.claude', 'hooks', 'guard.py')), true, 'a tracked file is never removed');
});

test('the exclude block follows the current list: an older block is replaced, the repo\'s own lines are kept', () => {
  const { dir } = exampleProject();
  const file = join(dir, '.git', 'info', 'exclude');
  // As an earlier version wrote it: a marker line and patterns, no end line.
  writeFileSync(file, `# the repo's own\n*.log\n# ${BRAND.cli}: empty mount points Claude Code's sandbox leaves in worktrees; never commit them\n/.bashrc\n/.claude/commands\n`);
  excludeSandboxPlaceholders(dir);
  excludeSandboxPlaceholders(dir);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# the repo's own\n\*\.log\n/);
  assert.equal(text.match(/empty mount points/g)?.length, 1, 'one block, rewritten in place');
  assert.match(text, /^\/\.claude\/$/m);
  assert.doesNotMatch(text, /^\/\.claude\/commands$/m);
  assert.match(text, /end\n$/);
});
