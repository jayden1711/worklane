import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecorder, gitDiffReads, readRun } from '../src/run-record.js';
import { unreadFiles } from '../src/unread.js';

test('what a git command showed: named paths, rev:path, a whole range, and never a listing of names', () => {
  assert.deepEqual(gitDiffReads('git diff abc..def -- src/a.ts src/b.ts'), { all: false, paths: ['src/a.ts', 'src/b.ts'] });
  assert.deepEqual(gitDiffReads('git show def:src/c.ts'), { all: false, paths: ['src/c.ts'] });
  assert.deepEqual(gitDiffReads('git diff abc..def'), { all: true, paths: [] });
  assert.deepEqual(gitDiffReads('git show def'), { all: true, paths: [] });
  assert.deepEqual(gitDiffReads('git diff --stat abc..def'), { all: false, paths: [] }, 'counts, not contents');
  assert.deepEqual(gitDiffReads('git diff --name-only abc..def'), { all: false, paths: [] });
  assert.deepEqual(gitDiffReads('git log --oneline -3'), { all: false, paths: [] });
  assert.deepEqual(gitDiffReads('cd repo && git diff abc..def -- "src/d.ts" | head -50'), { all: false, paths: ['src/d.ts'] });
});

test('the run record keeps the files the session read, relative to its worktree', () => {
  const state = mkdtempSync(join(tmpdir(), 'state-'));
  const cwd = join(tmpdir(), 'wt', 'issue-9');
  const r = new RunRecorder(state, { role: 'evaluator-verdict', model: 'opus', cwd });
  const use = (id: string, name: string, input: object) => r.line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  use('t1', 'Read', { file_path: join(cwd, 'src', 'a.ts') });
  use('t2', 'Bash', { command: 'git diff abc..def -- src/b.ts' });
  use('t3', 'Bash', { command: 'git show def:src/c.ts' });
  use('t4', 'Bash', { command: 'git diff --stat abc..def' });
  use('t5', 'Read', { file_path: join(cwd, 'src', 'a.ts') });
  use('t6', 'Grep', { pattern: 'x' });
  r.finish({ reason: 'succeeded', costUsd: 0.1, turns: 3, model: 'opus' });
  const rec = readRun(state, r.id)!;
  assert.deepEqual(rec.read, ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'each once; the stat listing is not a read');
  assert.equal(rec.diffedAll, undefined);
  assert.equal(rec.otherTools, 3, 'reads and searches still counted as before');
});

test('unread: changed files the run never read, from the record, not from what the reviewer says it reviewed', () => {
  const changed = ['src/a.ts', 'src/b.ts', 'src/d.ts'];
  assert.deepEqual(unreadFiles(changed, { read: ['src/a.ts', './src/b.ts'] }), ['src/d.ts']);
  assert.deepEqual(unreadFiles(changed, { read: ['src\\a.ts', 'src\\b.ts', 'src\\d.ts'] }), [], 'Windows separators');
  assert.deepEqual(unreadFiles(changed, { read: [], diffedAll: true }), [], 'the whole range was shown');
  // A reviewer that claims to have reviewed everything but whose run read nothing: everything is unread.
  assert.deepEqual(unreadFiles(changed, { read: [] }), changed);
  assert.deepEqual(unreadFiles(changed, null), changed, 'no record proves nothing');
});
