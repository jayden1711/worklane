// Round 4 of #927: a shallow file line is read as one object id of the repo's own format, and nothing else.
// - In a sha1 repo git reads a 64-hex line as a cut at its first 40 hex digits. Round 3 took any 40- or 64-hex line as
//   an id, so the line hid the commit that added a refused file, and the snapshot copied the same cut. A separate
//   process toggling the line got the file onto the remote in 34 of 80 checkedPush calls (measured by the round-3 check).
// - In a sha256 repo git refuses a 40-hex line (`fatal: bad shallow line`), and round 3's pushProblems threw instead of
//   refusing.
// - Round 2's 1 KB form: git reads the file 1 KB at a time, so an id 1,023 characters into one line is a line of its own
//   to git. An exact-match check took the whole line as no id at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkedPush, DEFAULT_PUSH_LIMITS, pushProblems } from '../src/push-check.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LIMITS = { ...DEFAULT_PUSH_LIMITS, refuse_paths: ['**/*.pem'] };
const guard = { defaultBranch: 'main', blocked: () => undefined };
const CUT = /history is cut inside the range \(its shallow file has a line that isn't exactly a full lowercase object id/;

/** base, K (adds keys/secret.pem), D (drops it), H (a note), in a repo of `format`: the net diff is clean, the history isn't. */
function repo(format: 'sha1' | 'sha256' = 'sha1') {
  const root = mkdtempSync(join(tmpdir(), 'push-shallow-format-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', `--object-format=${format}`, '-b', 'main', remote);
  git(root, 'init', '-q', `--object-format=${format}`, '-b', 'main', work);
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
  const drop = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'notes.txt'), 'n\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'notes');
  const head = git(work, 'rev-parse', 'HEAD');
  return { work, remote, base, drop, head, shallow: join(work, '.git', 'shallow') };
}

const plainCount = (r: ReturnType<typeof repo>) => git(r.work, 'rev-list', '--count', `${r.base}..${r.head}`);
const pushedKey = (r: ReturnType<typeof repo>) => {
  try {
    git(r.remote, 'cat-file', '-e', `${r.head}~2:keys/secret.pem`);
    return true;
  } catch {
    return false;
  }
};
const push = (r: ReturnType<typeof repo>) =>
  checkedPush({ cwd: r.work, remote: r.remote, base: r.base, head: r.head, ref: 'refs/heads/task', limits: LIMITS, guard, force: true });

/** Runs `fn` with node:child_process's spawnSync wrapped: `before(args)` runs before each call it is handed. */
function withSpawnHook<T>(before: (args: string[]) => void, fn: () => T): T {
  const cp = createRequire(import.meta.url)('node:child_process') as Record<string, (...a: unknown[]) => unknown>;
  const orig = cp.spawnSync!;
  cp.spawnSync = (...a: unknown[]) => {
    before(Array.isArray(a[1]) ? a[1].map(String) : []);
    return orig(...a);
  };
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    cp.spawnSync = orig;
    syncBuiltinESMExports();
  }
}

// ---- A sha1 repo: a 64-hex line is a cut at its first 40 to git.

for (const [what, at] of [['the drop', 'drop'], ['the head', 'head']] as const) {
  test(`a sha1 repo whose shallow line is ${what}'s id plus 24 hex digits is refused, never 0 problems`, () => {
    const r = repo();
    writeFileSync(r.shallow, `${r[at]}${'0'.repeat(24)}\n`);
    assert.notEqual(plainCount(r), '3', 'git reads the line as a cut');
    const p = pushProblems(r.work, r.base, r.head, LIMITS);
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0]!, CUT);
    assert.match(p[0]!, /\(sha1\)/);
  });
}

test('the same 64-hex line, removed right before the push\'s spawn, lands nothing on the remote', () => {
  const r = repo();
  writeFileSync(r.shallow, `${r.drop}${'0'.repeat(24)}\n`);
  const res = withSpawnHook((args) => {
    if (args.includes('push')) rmSync(r.shallow, { force: true });
  }, () => push(r));
  assert.ok(!res.ok && 'refused' in res && CUT.test(res.refused.join('\n')), JSON.stringify(res));
  assert.equal(pushedKey(r), false);
});

// ---- A sha256 repo: a 40-hex line is a refusal, not an exception.

test('a sha256 repo whose shallow line is 40 hex digits gets a refusal from pushProblems and checkedPush, not a throw', () => {
  const r = repo('sha256');
  assert.equal(r.drop.length, 64);
  writeFileSync(r.shallow, `${r.drop.slice(0, 40)}\n`);
  let p: string[] = [];
  assert.doesNotThrow(() => { p = pushProblems(r.work, r.base, r.head, LIMITS); });
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, CUT);
  assert.match(p[0]!, /\(sha256\)/);
  let res: ReturnType<typeof push> | undefined;
  assert.doesNotThrow(() => { res = push(r); });
  assert.ok(res && !res.ok && 'refused' in res && CUT.test(res.refused.join('\n')), JSON.stringify(res));
  assert.equal(pushedKey(r), false);
});

test('a sha256 repo still reads its own 64-hex line: a cut outside the range pushes, one inside is refused', () => {
  const r = repo('sha256');
  writeFileSync(r.shallow, `${r.drop}\n`);
  const inside = pushProblems(r.work, r.base, r.head, LIMITS);
  assert.equal(inside.length, 1, inside.join('\n'));
  assert.match(inside[0]!, /a shallow boundary at /);
  writeFileSync(r.shallow, `${r.base}\n`);
  assert.ok(pushProblems(r.work, r.base, r.head, LIMITS).some((x) => /keys\/secret\.pem/.test(x)));
});

// ---- Round 2's 1 KB form: an id outside the range, 983 characters, then an id inside it, on one line.

test('a shallow line that hides an in-range id 1,023 characters in is refused, never 0 problems', () => {
  const r = repo();
  writeFileSync(r.shallow, `${r.base}${'x'.repeat(983)}${r.drop}\n`);
  assert.notEqual(plainCount(r), '3', 'git reads the drop as a cut of its own');
  const p = pushProblems(r.work, r.base, r.head, LIMITS);
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /history is cut inside the range/);
});
