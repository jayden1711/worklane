import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { checkedPush, DEFAULT_PUSH_LIMITS, pushProblems, type PushLimits } from '../src/push-check.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const base = mkdtempSync(join(tmpdir(), 'push-check-'));
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false']]) git(work, 'config', k!, v!);
  writeFileSync(join(work, 'README.md'), 'hello\n');
  git(work, 'add', 'README.md');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  const baseSha = git(work, 'rev-parse', 'HEAD');
  const commit = (files: Record<string, string | null>, msg = 'change') => {
    for (const [p, body] of Object.entries(files)) {
      if (body === null) git(work, 'rm', '-q', p);
      else {
        mkdirSync(dirname(join(work, p)), { recursive: true });
        writeFileSync(join(work, p), body);
        git(work, 'add', p);
      }
    }
    git(work, 'commit', '-q', '-m', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  return { work, remote, baseSha, commit };
}

const limits = (over: Partial<PushLimits> = {}): PushLimits => ({ ...DEFAULT_PUSH_LIMITS, ...over });

test('a small ordinary change passes the push limits', () => {
  const r = repo();
  const head = r.commit({ 'src/a.js': 'export const a = 1;\n' });
  assert.deepEqual(pushProblems(r.work, r.baseSha, head, limits()), []);
});

test('a file over the size limit is refused, even one added in one commit and deleted in a later one', () => {
  const r = repo();
  r.commit({ 'model/weights.bin': 'x'.repeat(4096) }, 'add a big file');
  const head = r.commit({ 'model/weights.bin': null }, 'delete it again');
  assert.equal(git(r.work, 'diff', '--name-only', `${r.baseSha}..${head}`), '', 'the net diff is empty');
  const p = pushProblems(r.work, r.baseSha, head, limits({ max_file_mb: 0.002 }));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /model\/weights\.bin \(0\.0 MB\)/);
  assert.match(p[0]!, /over the 0\.002 MB limit/);
  assert.match(p[0]!, /every commit on the branch/);
});

test('a file that was already on the base is not counted against the change', () => {
  const r = repo();
  const big = r.commit({ 'big.bin': 'x'.repeat(4096) }, 'big file on main');
  const head = r.commit({ 'src/a.js': 'a\n' });
  assert.deepEqual(pushProblems(r.work, big, head, limits({ max_file_mb: 0.002 })), []);
});

test('refuse_paths: a refused path in any commit is named, even if a later commit removed it', () => {
  const r = repo();
  r.commit({ 'data/cache.json': '{}\n', 'runs/1/out.log': 'x\n' });
  const head = r.commit({ 'data/cache.json': null, 'runs/1/out.log': null, 'src/a.js': 'a\n' });
  const p = pushProblems(r.work, r.baseSha, head, limits({ refuse_paths: ['data/**', 'runs/**', '**/*.ckpt'] }));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /data\/cache\.json, runs\/1\/out\.log/);
  assert.match(p[0]!, /push\.refuse_paths/);
});

test('a checkpoint glob with ** matches at any depth', () => {
  const r = repo();
  const head = r.commit({ 'models/deep/m.ckpt': 'w\n' });
  assert.match(pushProblems(r.work, r.baseSha, head, limits({ refuse_paths: ['**/*.ckpt'] })).join(''), /models\/deep\/m\.ckpt/);
});

test('a CI workflow change is refused with the reason (no Workflows permission), whatever the limits', () => {
  const r = repo();
  const head = r.commit({ '.github/workflows/ci.yml': 'on: push\n' });
  const p = pushProblems(r.work, r.baseSha, head, limits());
  assert.equal(p.length, 1);
  assert.match(p[0]!, /\.github\/workflows\/ci\.yml/);
  assert.match(p[0]!, /no Workflows permission/);
});

test('a change over max_changed_lines is refused with its size; at the limit it passes', () => {
  const r = repo();
  const head = r.commit({ 'src/a.js': 'a\nb\nc\nd\n' });
  assert.deepEqual(pushProblems(r.work, r.baseSha, head, limits({ max_changed_lines: 4 })), []);
  const p = pushProblems(r.work, r.baseSha, head, limits({ max_changed_lines: 3 }));
  assert.match(p.join(''), /changes 4 lines, over the 3-line limit/);
});

test('every problem is reported at once, not just the first', () => {
  const r = repo();
  const head = r.commit({ '.github/workflows/x.yml': 'a\n', 'data/x': 'b\n', 'big': 'x'.repeat(4096) });
  assert.equal(pushProblems(r.work, r.baseSha, head, limits({ max_file_mb: 0.002, max_changed_lines: 1, refuse_paths: ['data/**'] })).length, 4);
});

test('checkedPush: a refused range is never pushed; a clean one is', () => {
  const r = repo();
  const bad = r.commit({ 'data/x': 'b\n' });
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: bad, ref: 'refs/heads/task', limits: limits({ refuse_paths: ['data/**'] }), force: true });
  assert.equal(res.ok, false);
  assert.ok(!res.ok && 'refused' in res && res.refused.length === 1);
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task'), '', 'nothing pushed');
  const ok = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: bad, ref: 'refs/heads/task', limits: limits(), force: true });
  assert.deepEqual(ok, { ok: true });
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], bad);
});

test('checkedPush without force is compare-and-swap: a moved remote branch is an error, not overwritten', () => {
  const r = repo();
  const a = r.commit({ 'a': '1\n' });
  git(r.work, 'push', '-q', 'origin', `${a}:refs/heads/main`);
  git(r.work, 'reset', '-q', '--hard', r.baseSha);
  const b = r.commit({ 'b': '1\n' });
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: b, ref: 'refs/heads/main', limits: limits() });
  assert.ok(!res.ok && 'error' in res);
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], a);
});

test('checkedPush with expect: updates the branch only while it is still at that commit', () => {
  const r = repo();
  const a = r.commit({ 'a': '1\n' });
  git(r.work, 'push', '-q', 'origin', `${a}:refs/heads/task`);
  const b = r.commit({ 'b': '1\n' });
  assert.deepEqual(checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: b, ref: 'refs/heads/task', limits: limits(), expect: a }), { ok: true });
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], b);
  const c = r.commit({ 'c': '1\n' });
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: c, ref: 'refs/heads/task', limits: limits(), expect: a });
  assert.ok(!res.ok && 'error' in res, 'the branch is at b, not a: refused');
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], b);
});

test('the engine pushes code only through checkedPush (lease refs and the demo seed are the only other pushes)', () => {
  const allowed = new Set(['src/push-check.ts', 'src/claims.ts', 'src/demo.ts']);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const rel = relative(repoRoot, p).split(sep).join('/'); // the allow-list uses /, Windows paths use backslashes
        // 'push' as a git argument: ['push', ...] or git(cwd, 'push', ...).
        if (!allowed.has(rel) && /(\[|,)\s*['"]push['"]\s*[,)]/.test(readFileSync(p, 'utf8'))) offenders.push(rel);
      }
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'a git push outside push-check.ts skips the push limits');
});
