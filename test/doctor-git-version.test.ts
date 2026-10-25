// #1077: the merge decision measures a merge with `git merge-tree --write-tree` (git 2.38) and reads a tree's
// attributes with `check-attr --source` (git 2.40); with an older git every PR waits. Doctor says so up front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { gitTooOld } from '../src/coordinator/change-files.js';
import { doctor } from '../src/doctor.js';

test('gitTooOld: 2.40 or later passes; older, or a version it cannot read, says what the merge decision needs', () => {
  for (const ok of ['git version 2.40.0', 'git version 2.43.0\n', 'git version 2.50.1 (Apple Git-155)', 'git version 3.0.0']) assert.equal(gitTooOld(ok), null, ok);
  for (const [text, said] of [['git version 2.37.3', 'git 2.37'], ['git version 2.39.5', 'git 2.39'], ['git version 1.99.0', 'git 1.99'], ['', "can't read git's version (no output)"], ['hub version 2.40', "can't read git's version (hub version 2.40)"]]) {
    const r = gitTooOld(text!);
    assert.ok(r?.startsWith(`${said}: the merge decision needs git 2.40 or later`), `${text}: ${r}`);
    assert.match(r!, /every PR waits for the owner/);
  }
});

test("doctor fails the git line for a git older than 2.40, and passes the one it runs on", () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-git-'));
  const real = execFileSync('git', ['version'], { encoding: 'utf8' }).trim();
  assert.deepEqual(doctor(root).find((c) => c.name === 'git'), { name: 'git', level: gitTooOld(real) ? 'fail' : 'ok', detail: gitTooOld(real) ?? real });
  const bin = mkdtempSync(join(tmpdir(), 'old-git-'));
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "git version 2.37.0"\n');
  chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  try {
    const line = doctor(root).find((c) => c.name === 'git');
    assert.equal(line?.level, 'fail');
    assert.match(line!.detail, /^git 2\.37: the merge decision needs git 2\.40 or later/);
  } finally {
    process.env.PATH = path;
  }
});
