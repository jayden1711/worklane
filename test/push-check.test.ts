import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { checkedPush, DEFAULT_PUSH_LIMITS, pushProblems, type PushLimits } from '../src/push-check.js';
import { repoRoot } from './helpers.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The default-branch guard every push carries: main, with each refusal recorded in `blocked`. */
function guard(o: { directLand?: boolean } = {}) {
  const blocked: { ref: string; head: string }[] = [];
  return Object.assign({ defaultBranch: 'main', ...o, blocked: (ref: string, head: string) => void blocked.push({ ref, head }) }, { refusals: blocked });
}

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

test('refuse_paths: a ? stands for one character outside the BMP, as ** does (#966)', () => {
  const r = repo();
  const head = r.commit({ 'keys/\u{1F511}.pem': 'k\n' });
  for (const glob of ['keys/?.pem', 'keys/??.pem', 'keys/**']) {
    const p = pushProblems(r.work, r.baseSha, head, limits({ refuse_paths: [glob] }));
    assert.equal(p.length, 1, `${glob}: ${p.join('\n')}`);
    assert.match(p[0]!, /push\.refuse_paths/);
  }
});

test('a CI workflow change is refused with the reason (no Workflows permission), whatever the limits', () => {
  const r = repo();
  const head = r.commit({ '.github/workflows/ci.yml': 'on: push\n' });
  const p = pushProblems(r.work, r.baseSha, head, limits());
  assert.equal(p.length, 1);
  assert.match(p[0]!, /\.github\/workflows\/ci\.yml/);
  assert.match(p[0]!, /no Workflows permission/);
});

test('a change that adds or edits a SKILL.md failing the skill lint is refused; a passing or deleted one is not', () => {
  const r = repo();
  const good = `## When to use\nx\n## Inputs and access\nx\n## Steps\nx\n## Validate\nx\n## Return\nx\n## Approval\nx\n`;
  const ok = r.commit({ '.claude/skills/a/SKILL.md': good });
  assert.deepEqual(pushProblems(r.work, r.baseSha, ok, limits()), []);
  const bad = r.commit({ '.claude/skills/a/SKILL.md': good.replace('## Validate\nx\n', '## Validate\n\n') });
  const p = pushProblems(r.work, ok, bad, limits());
  assert.equal(p.length, 1);
  assert.match(p[0]!, /\.claude\/skills\/a\/SKILL\.md \(the "Validate" section is empty\)/);
  const gone = r.commit({ '.claude/skills/a/SKILL.md': null });
  assert.deepEqual(pushProblems(r.work, bad, gone, limits()), []);
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
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: bad, ref: 'refs/heads/task', limits: limits({ refuse_paths: ['data/**'] }), guard: guard(), force: true });
  assert.equal(res.ok, false);
  assert.ok(!res.ok && 'refused' in res && res.refused.length === 1);
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task'), '', 'nothing pushed');
  const ok = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: bad, ref: 'refs/heads/task', limits: limits(), guard: guard(), force: true });
  assert.deepEqual(ok, { ok: true });
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], bad);
});

test('checkedPush without force is compare-and-swap: a moved remote branch is an error, not overwritten', () => {
  const r = repo();
  const a = r.commit({ 'a': '1\n' });
  git(r.work, 'push', '-q', 'origin', `${a}:refs/heads/main`);
  git(r.work, 'reset', '-q', '--hard', r.baseSha);
  const b = r.commit({ 'b': '1\n' });
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: b, ref: 'refs/heads/main', limits: limits(), guard: guard({ directLand: true }) });
  assert.ok(!res.ok && 'error' in res);
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], a);
});

test('checkedPush with expect: updates the branch only while it is still at that commit', () => {
  const r = repo();
  const a = r.commit({ 'a': '1\n' });
  git(r.work, 'push', '-q', 'origin', `${a}:refs/heads/task`);
  const b = r.commit({ 'b': '1\n' });
  assert.deepEqual(checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: b, ref: 'refs/heads/task', limits: limits(), guard: guard(), expect: a }), { ok: true });
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], b);
  const c = r.commit({ 'c': '1\n' });
  const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: c, ref: 'refs/heads/task', limits: limits(), guard: guard(), expect: a });
  assert.ok(!res.ok && 'error' in res, 'the branch is at b, not a: refused');
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/task').split('\t')[0], b);
});

test('checkedPush refuses the default branch, however the ref is spelled, records it, and pushes nothing', () => {
  const r = repo();
  const head = r.commit({ 'a.js': '1\n' });
  for (const ref of ['refs/heads/main', 'main', 'heads/main', `${head}:refs/heads/main`]) {
    for (const force of [false, true]) {
      const g = guard();
      const res = checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head, ref, limits: limits(), guard: g, force });
      assert.ok(!res.ok && 'refused' in res, `${ref}${force ? ' (force)' : ''} is refused`);
      assert.match((res as { refused: string[] }).refused[0]!, /refs\/heads\/main, the default branch: .* never pushes it/);
      assert.deepEqual(g.refusals, [{ ref: 'refs/heads/main', head }], 'the refusal is recorded');
    }
  }
  assert.equal(git(r.work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], r.baseSha, 'main is untouched');
  // A task branch whose name merely contains it goes through; so does the direct land, the one push of main by design.
  assert.deepEqual(checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head, ref: 'refs/heads/feature/main', limits: limits(), guard: guard(), force: true }), { ok: true });
  assert.deepEqual(checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head, ref: 'refs/heads/main', limits: limits(), guard: guard({ directLand: true }) }), { ok: true });
});

/**
 * `fn` with a git stand-in first on PATH that, the first time a git command line contains `when`, runs `change` (a
 * shell line, in that git's directory) and then the real git: a change to the repo between the push check's git calls,
 * at a chosen one (#981).
 */
function racing<T>(when: string, change: string, fn: () => T): T {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = mkdtempSync(join(tmpdir(), 'push-race-'));
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase " $* " in *"$RACE_WHEN"*) [ -e "$RACE_MARK" ] || { : > "$RACE_MARK"; sh -c "$RACE_CHANGE"; } ;; esac\nexec "$RACE_GIT" "$@"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, RACE_WHEN: process.env.RACE_WHEN, RACE_CHANGE: process.env.RACE_CHANGE, RACE_MARK: process.env.RACE_MARK, RACE_GIT: process.env.RACE_GIT };
  Object.assign(process.env, { PATH: `${dir}:${process.env.PATH}`, RACE_WHEN: when, RACE_CHANGE: change, RACE_MARK: join(dir, 'ran'), RACE_GIT: real });
  try {
    const out = fn();
    assert.ok(statSync(join(dir, 'ran'), { throwIfNoEntry: false }), `the change ran (no git call matched ${JSON.stringify(when)})`);
    return out;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const unix = { skip: process.platform === 'win32' ? 'the git stand-in is a shell script' : false };

test('a repo config broken between the push check\'s git calls gives a named refusal, never a throw (#981)', unix, () => {
  const r = repo();
  const head = r.commit({ 'src/a.js': 'a\n' });
  // The size check is the last read; its rename pairing reads the repo's config.
  const p = racing(' -U0 ', `printf '[broken\\n' >> .git/config`, () => pushProblems(r.work, r.baseSha, head, limits()));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /push limits couldn't read the range .*bad config/);
  assert.match(p[0]!, /nothing is pushed/);
});

test('checkedPush refuses, never throws, when git fails mid-check, and pushes nothing (#981)', unix, () => {
  const r = repo();
  const head = r.commit({ 'src/a.js': 'a\n' });
  const res = racing('rev-list --objects', `printf '[broken\\n' >> .git/config`, () => checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head, ref: 'refs/heads/task', limits: limits(), guard: guard(), force: true }));
  assert.ok(!res.ok && 'refused' in res, JSON.stringify(res));
  assert.match(res.refused[0]!, /push limits couldn't read the range/);
  assert.equal(git(r.remote, 'for-each-ref', 'refs/heads/task'), '', 'nothing pushed');
});

test('a head or base that names no commit is a refusal, not a throw (#981)', () => {
  const r = repo();
  const head = r.commit({ 'src/a.js': 'a\n' });
  for (const [base, h] of [[r.baseSha, 'no-such-branch'], ['no-such-base', head]] as const) {
    const p = pushProblems(r.work, base, h, limits());
    assert.equal(p.length, 1, p.join('\n'));
    assert.match(p[0]!, /push limits couldn't read the range/);
  }
});

test('a head branch deleted between the push check\'s git calls changes nothing: the range is read by commit id (#981)', unix, () => {
  const r = repo();
  r.commit({ 'data/x': 'b\n' });
  git(r.work, 'checkout', '-q', '-b', 'topic');
  git(r.work, 'checkout', '-q', '--detach');
  const p = racing('rev-list --objects', 'git update-ref -d refs/heads/topic', () => pushProblems(r.work, r.baseSha, 'topic', limits({ refuse_paths: ['data/**'] })));
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0]!, /data\/x/);
});

test('checkedPush pushes the commit it checked, even when the head branch moves before the push (#981)', unix, () => {
  const r = repo();
  const good = r.commit({ 'src/a.js': 'a\n' });
  const bad = r.commit({ 'data/x': 'b\n' });
  git(r.work, 'branch', 'topic', good);
  const res = racing(' push ', `git update-ref refs/heads/topic ${bad}`, () => checkedPush({ cwd: r.work, remote: 'origin', base: r.baseSha, head: 'topic', ref: 'refs/heads/task', limits: limits({ refuse_paths: ['data/**'] }), guard: guard(), force: true }));
  assert.deepEqual(res, { ok: true });
  assert.equal(git(r.work, 'rev-parse', 'topic'), bad, 'the branch did move');
  assert.equal(git(r.remote, 'rev-parse', 'refs/heads/task'), good, 'the checked commit was pushed, not the moved branch');
});

test('the coordinator passes the default branch guard on every push, and only the direct land may push main', () => {
  for (const f of ['src/coordinator/landing.ts', 'src/coordinator/merge-flow.ts', 'src/coordinator/fix-runs.ts', 'src/coordinator/decisions.ts', 'src/tune.ts']) {
    const text = readFileSync(join(repoRoot, f), 'utf8');
    for (const call of text.match(/checkedPush\(\{[^\n]*\}\)/g) ?? []) assert.match(call, /guard: /, `${f}: ${call.slice(0, 80)}`);
  }
  const landing = readFileSync(join(repoRoot, 'src/coordinator/landing.ts'), 'utf8');
  assert.equal((landing.match(/pushGuard\(this\.d\.cfg\.project\.land_mode === 'direct'\)/g) ?? []).length, 1, 'one direct land push');
  assert.equal([...readdirSync(join(repoRoot, 'src', 'coordinator'))].map((f) => readFileSync(join(repoRoot, 'src', 'coordinator', f), 'utf8')).join('').match(/pushGuard\(true\)/g), null);
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
