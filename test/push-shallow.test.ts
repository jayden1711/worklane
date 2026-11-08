// A shallow cut inside the pushed range is refused (#807, round 2). The `shallow` file lists commits whose parents git
// treats as missing, and an agent can write it into the shared repo: with the head's parent listed, the walks of
// base..head stopped short and a refused file in an earlier commit read as 0 problems; deleted again before the push,
// the push carried that file to the remote (measured by #927's final check). The limits now refuse a range cut by
// such a file, before and after their walks and once more right before the push. A cut outside the range (a
// depth-limited clone's base) leaves the range whole and pushes as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedPush, DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LIMITS = { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['**/*.pem'] };
const guard = { defaultBranch: 'main', blocked: () => undefined };

/** base, then a commit adding keys/secret.pem, then one removing it: the net diff is clean, the history isn't. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'push-shallow-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(work, 'config', k!, v!);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', remote, 'main');
  mkdirSync(join(work, 'keys'));
  writeFileSync(join(work, 'keys', 'secret.pem'), 'k\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add a key');
  git(work, 'rm', '-q', 'keys/secret.pem');
  git(work, 'commit', '-q', '-m', 'drop it');
  const head = git(work, 'rev-parse', 'HEAD');
  const shallow = join(work, '.git', 'shallow');
  return { work, remote, base, head, shallow };
}

test('a .git/shallow written by hand that cuts the range is refused, never 0 problems', () => {
  const r = repo();
  assert.equal(pushProblems(r.work, r.base, r.head, LIMITS).length, 1, 'the key is seen in a whole history');
  writeFileSync(r.shallow, `${r.head}\n`);
  const p = pushProblems(r.work, r.base, r.head, LIMITS);
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /history is cut inside the range \(a shallow boundary at [0-9a-f]{12}\)/);
});

test('the delete-between race: the check sees the cut and refuses, so nothing reaches the remote, and deleting it afterwards changes nothing', () => {
  const r = repo();
  writeFileSync(r.shallow, `${r.head}\n`);
  const res = checkedPush({ cwd: r.work, remote: r.remote, base: r.base, head: r.head, ref: 'refs/heads/task', limits: LIMITS, guard, force: true });
  assert.ok(!res.ok && 'refused' in res, JSON.stringify(res));
  assert.match((res as { refused: string[] }).refused.join('\n'), /history is cut inside the range/);
  rmSync(r.shallow);
  assert.equal(git(r.remote, 'for-each-ref', 'refs/heads/task'), '', 'nothing pushed');
  // Pushed again with the file gone, the whole history is judged: the key is refused.
  const again = checkedPush({ cwd: r.work, remote: r.remote, base: r.base, head: r.head, ref: 'refs/heads/task', limits: LIMITS, guard, force: true });
  assert.ok(!again.ok && 'refused' in again && again.refused.some((x) => /keys\/secret\.pem/.test(x)), JSON.stringify(again));
  assert.equal(git(r.remote, 'for-each-ref', 'refs/heads/task'), '');
});

test('a shallow file git can\'t read as a list (a directory in its place) fails closed', () => {
  const r = repo();
  mkdirSync(r.shallow);
  writeFileSync(join(r.shallow, 'x'), '');
  const p = pushProblems(r.work, r.base, r.head, LIMITS);
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /history is cut inside the range \(can't read its shallow file/);
  assert.ok(existsSync(r.shallow));
});

test('a depth-limited clone pushes a change above its cut as before: the cut is its base, outside the range', () => {
  const r = repo();
  const clone = join(mkdtempSync(join(tmpdir(), 'push-shallow-clone-')), 'c');
  git(r.work, 'clone', '-q', '--depth', '1', pathToFileURL(r.remote).href, clone);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(clone, 'config', k!, v!);
  const base = git(clone, 'rev-parse', 'HEAD');
  writeFileSync(join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'a change');
  const head = git(clone, 'rev-parse', 'HEAD');
  assert.deepEqual(pushProblems(clone, base, head, LIMITS), []);
  // A refused file above the cut is still refused.
  writeFileSync(join(clone, 'b.pem'), 'k\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'a key');
  assert.match(pushProblems(clone, base, git(clone, 'rev-parse', 'HEAD'), LIMITS).join('\n'), /b\.pem/);
});
