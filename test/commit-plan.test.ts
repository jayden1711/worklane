// The commit scan's model of a command line (#971, src/guard/commit.ts): which checkouts a commit can land in, what
// it records, and which lines it refuses as unmodelled. The hook-level attacks are in test/adversarial/commit-scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPlan, type CommitPlan, type GitQuery } from '../src/guard/commit.js';

/** Every directory is a checkout whose top level is itself; no aliases. */
const git: GitQuery = (cwd, args) => {
  if (args.includes('rev-parse')) {
    const dirs = args.flatMap((a, i) => (args[i - 1] === '-C' ? [a] : []));
    return { status: 0, stdout: `${dirs.reduce((d, x) => (x.startsWith('/') ? x : `${d}/${x}`), cwd)}\n` };
  }
  return { status: 1, stdout: '' };
};
const plan = (command: string, env: NodeJS.ProcessEnv = {}): CommitPlan | null => commitPlan(command, { cwd: '/w', env, git });
const refused = (command: string) => {
  const p = plan(command);
  assert.ok(p && 'refuse' in p, `refused: ${JSON.stringify(command)} -> ${JSON.stringify(p)}`);
};
const scans = (command: string) => {
  const p = plan(command);
  assert.ok(p && 'scans' in p, `modelled: ${JSON.stringify(command)} -> ${JSON.stringify(p)}`);
  return p.scans;
};

test('a line with no commit is no business of the commit scan, however it is written', () => {
  for (const c of [
    'ls -la',
    'for f in *; do echo "$f"; done',
    '(cd sub && make)',
    'git log --oneline | head -5',
    'git -c core.pager=cat log',
    `gh pr create --title t --body "$(cat <<'EOF'\nRun \`git commit -a\` first.\nEOF\n)"`,
    `cat <<'EOF' > notes.md\ngit commit -m x\nEOF`,
    'echo "commit"',
    'git -C "$D" status',
    'git log -n "$N" --format=%h',
    'which git && command -v git',
    `gh pr create --title t --body "$(cat <<EOF\nThis commit adds a check.\nEOF\n)"`,
  ]) assert.equal(plan(c), null, c);
});

test('a plain commit scans the staged changes of the checkout it runs in, from its top level', () => {
  assert.deepEqual(scans('git commit -m wip'), [{ top: '/w', scope: { unstaged: false, untracked: false, head: false } }]);
  assert.deepEqual(scans(`git commit -m "$(cat <<'EOF'\nfix: it's (really) done\n\ngit commit -a\nEOF\n)"`).length, 1);
  assert.deepEqual(scans('git commit -s -m x 2>&1 | tail -3')[0]!.scope, { unstaged: false, untracked: false, head: false });
  assert.deepEqual(scans('git -c user.name=A -c commit.gpgsign=false commit -m x')[0]!.top, '/w');
});

test('the checkout: -C and directory changes are followed, every place the commit can land is scanned', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'plan-')));
  const w = join(base, 'w');
  const o = join(base, 'o');
  for (const d of [o, join(w, 'sub', 'deeper'), join(w, 'deeper')]) mkdirSync(d, { recursive: true });
  symlinkSync(o, join(w, 'lnk'));
  const at = (c: string, env: NodeJS.ProcessEnv = {}, q: GitQuery = git) => commitPlan(c, { cwd: w, env, git: q });
  const tops = (c: string) => {
    const p = at(c);
    assert.ok(p && 'scans' in p, `${c} -> ${JSON.stringify(p)}`);
    return p.scans.map((s) => s.top).sort();
  };
  assert.deepEqual(tops(`git -C ${o} commit -m x`), [o]);
  assert.deepEqual(tops('git -C a -C b commit -m x'), [join(w, 'a', 'b')]);
  assert.deepEqual(tops(`cd ${o} && git commit -m x`), [o, w]);
  assert.deepEqual(tops(`cd ${o} || git commit -m x`), [o, w]);
  assert.deepEqual(tops('cd sub; cd deeper && git commit -m x'), [w, join(w, 'deeper'), join(w, 'sub'), join(w, 'sub', 'deeper')]);
  // WHY: each of these may end where the model doesn't: it is refused, never guessed.
  for (const c of ['cd $D', 'cd', 'cd ~/o', 'cd -', 'cd -P sub', 'cd -L sub', 'cd sub/..', 'cd lnk', 'cd lnk/../sub', 'cd missing', 'cd sub deeper', 'pushd', 'pushd +1', 'popd', `cd ${o}/../o`]) {
    const p = at(`${c} && git commit -m x`);
    assert.ok(p && 'refuse' in p, `${c} -> ${JSON.stringify(p)}`);
  }
  assert.ok('refuse' in at('cd sub && git commit -m x', { CDPATH: '/elsewhere' })!);
  // A place the commit may run that isn't a checkout, or whose lookup fails, refuses the line: it is never skipped.
  const notThere: GitQuery = (cwd, args) => (args.includes('rev-parse') && cwd === o ? { status: 128, stdout: '' } : git(cwd, args));
  assert.ok('refuse' in at(`cd ${o} && git commit -m x`, {}, notThere)!);
  const timesOut: GitQuery = (cwd, args) => (args.includes('rev-parse') ? { status: null, stdout: '' } : git(cwd, args));
  assert.ok('refuse' in at('git commit -m x', {}, timesOut)!);
});

test('the content: working-tree forms, staging in the line and amends widen the scan', () => {
  const scope = (c: string) => scans(c)[0]!.scope;
  for (const c of ['git commit -a -m x', 'git commit -am x', 'git commit -m x f', 'git commit -o -m x f', 'git commit -i -m x f', 'git commit --only -m x -- f', 'git commit --inc -m x f', 'git commit -p -m x', 'git commit --pathspec-from-file=list -m x']) {
    assert.deepEqual(scope(c), { unstaged: true, untracked: false, head: false }, c);
  }
  for (const c of ['git commit -m notes.md', 'git commit -F notes.md', 'git commit -C HEAD', 'git commit --author "A <a@b>" -m x', 'git commit -mnotes.md']) {
    assert.deepEqual(scope(c), { unstaged: false, untracked: false, head: false }, c);
  }
  assert.deepEqual(scope('git add -A && git commit -m x'), { unstaged: true, untracked: true, head: false });
  assert.deepEqual(scope('git status && git rm -q old && git commit -m x'), { unstaged: true, untracked: true, head: false });
  assert.deepEqual(scope('git commit --amend --no-edit'), { unstaged: false, untracked: false, head: true });
  assert.deepEqual(scope('git commit --amen -a --no-edit'), { unstaged: true, untracked: false, head: true });
});

test('what the model cannot follow is refused, never scanned narrowly', () => {
  for (const c of [
    'git commit -m x &',
    'git commit -m x & touch f',
    'touch f && git commit -a -m x',
    'echo x > f; git commit -a -m x',
    'npm run fmt && git commit -a -m x',
    'X=1 git commit -m x',
    'GIT_INDEX_FILE=/tmp/i git commit -m x',
    'export GIT_DIR=/o/.git; git commit -m x',
    'git --git-dir=/o/.git commit -m x',
    'git --work-tree /o commit -m x',
    'git -c core.worktree=/o commit -m x',
    'git -c filter.x.clean=cat commit -a -m x',
    'git commit -Z -m x',
    'git commit --frobnicate -m x',
    'git commit --a -m x',
    'git commit $OPTS -m x',
    'git commit "$@"',
    'git commit -m x > log.txt',
    'git commit -a -F - < "$(touch f)"',
    'git add -A > "$(touch f)" && git commit -m x',
    'git commit -m "$(date)"',
    'git commit -m "`date`"',
    'git add -f ignored && git commit -m x',
    'git add -e && git commit -m x',
    'git stash pop && git commit -a -m x',
    'git commit -m a && git commit --amend -m b',
    'bash -c "git commit -m x"',
    'sh -c \'cd /o; git commit -m x\'',
    'eval "git commit -m x"',
    'xargs git commit -m x < /dev/null',
    'timeout 30 git commit -m x',
    'env -C /o git commit -m x',
    '/usr/bin/env git commit -m x',
    'G=git; $G commit -m x',
    'echo "$(git commit -m x)"',
    '(git commit -m x)',
    '{ git commit -m x; }',
    'if true; then git commit -m x; fi',
    'git commit -m x | tee out.txt',
    'cat f | bash; git commit -m x',
    'git config alias.ci commit && git ci -m x',
    'git checkout $B',
    'git log -n $N',
    'git add *.ts',
    'git $"commit" -am x',
    "git $'commit' -am x",
    'git {commit,-a} -m x',
    'find . -name x | xargs git',
    'git status && git diff --output=f && git commit -a -m x',
    'git log --ext-diff -p && git commit -a -m x',
    'git -c alias.ci=commit ci -m x',
  ]) refused(c);
});

test('a git alias is looked up: one for commit or a shell command is refused, others are not the scan\'s business', () => {
  const aliases: Record<string, string> = { ci: 'commit', c2: 'ci -a', sh: '!git commit -am x', lg: 'log --oneline' };
  const withAliases: GitQuery = (cwd, args) => {
    const key = args.at(-1)?.replace(/^alias\./, '') ?? '';
    return args.includes('--get') && aliases[key] ? { status: 0, stdout: `${aliases[key]}\n` } : git(cwd, args);
  };
  const p = (c: string) => commitPlan(c, { cwd: '/w', env: {}, git: withAliases });
  for (const c of ['git ci -m x', 'git c2 -m x', 'git sh']) assert.ok(p(c) && 'refuse' in p(c)!, c);
  assert.equal(p('git lg'), null);
  assert.equal(p('git lfs pull'), null);
});
