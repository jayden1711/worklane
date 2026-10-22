// #890 round 20: every WorktreeOptions comes from worktreeOptions (or a record of ones it built), so the root is resolved
// once and the task directory carried. A literal without those fields, or one claiming a resolved root, doesn't compile:
// the @ts-expect-error lines below are checked by `npm run typecheck`, which covers test/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as worktrees from '../src/worktrees.js';
import type { WorktreeOptions } from '../src/worktrees.js';

test('#890 r20: a WorktreeOptions literal doesn\'t compile; worktreeOptions builds one with a resolved root', () => {
  // @ts-expect-error taskDir and rootResolved are required
  const missing: WorktreeOptions = { repo: '/r', root: 'wt', stateDir: '/s', setup: [] };
  // @ts-expect-error rootResolved is set only by worktreeOptions
  const claimed: WorktreeOptions = { repo: '/r', root: 'wt', stateDir: '/s', setup: [], taskDir: null, rootResolved: true };
  void missing;
  void claimed;
  const build = (worktrees as unknown as { worktreeOptions?: (o: Record<string, unknown>) => WorktreeOptions }).worktreeOptions;
  assert.equal(typeof build, 'function');
  const o = build!({ repo: '/r', root: 'wt', stateDir: '/s', setup: [], taskDir: null });
  assert.equal(o.rootResolved, true);
  assert.equal(o.root, '/r/wt');
});
