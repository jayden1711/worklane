// #890: runReadDenials, the entries a run is denied for its task and project. Exceptions are kept as the hook keeps
// them, never by denying less than it; a path the sandbox can't take as written refuses the run.
import { exampleProject } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EXPAND_LIMIT, gitStores, runReadDenials } from '../src/read-denials.js';
import { projectStateDir } from '../src/guardrails/context.js';

/**
 * The entries a pattern no exception overlaps also gets for a worktree made after the run starts (read-denials-late):
 * one glob over the project's worktree root, the engine's own, and each of `parents`.
 */
const late = (main: string, rel: string[], parents: string[] = []) =>
  [join(main, '.claude', 'worktrees'), join(projectStateDir(main), 'worktrees'), ...parents].flatMap((d) => rel.map((r) => join(d, '*', r)));

const skip = process.platform === 'win32' && 'POSIX paths, as the sandbox takes them';

/** An example project whose guardrails list these secret paths. */
function project(secret: string[]) {
  const { dir } = exampleProject();
  const f = join(dir, '.worklane', 'guardrails.yaml');
  const text = execFileSync('git', ['show', 'HEAD:.worklane/guardrails.yaml'], { cwd: dir, encoding: 'utf8' });
  writeFileSync(f, text.replace(/^secret_paths:\n(?: {2}- .*\n)+/m, `secret_paths:\n${secret.map((s) => `  - ${JSON.stringify(s)}\n`).join('')}`));
  execFileSync('git', ['commit', '-q', '-am', 'secret paths'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function task(hidden: string[]) {
  const f = join(mkdtempSync(join(tmpdir(), 'task-')), 't.json');
  writeFileSync(f, JSON.stringify({ id: 't', done_when: [{ manual: 'x' }], hidden }));
  return f;
}

const paths = (r: ReturnType<typeof runReadDenials>) => {
  if ('error' in r) assert.fail(r.error);
  return r.paths;
};

test('#890: an exception the pattern overlaps: the pattern is passed as what it matches now, the exception left out', { skip }, () => {
  const dir = project(['./.env', './.env.*', '!./.env.example']);
  for (const n of ['.env', '.env.local', '.env.example', '.env.prod']) writeFileSync(join(dir, n), 'x');
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  // "./.env.*" (overlapped) gets no glob over the worktree parents; "./.env" does.
  assert.deepEqual(p.sort(), [join(dir, '.env'), join(dir, '.env.local'), join(dir, '.env.prod'), ...late(dir, ['.env'])].sort());
});

test('#890: with no exception, a glob is passed as written (the sandbox expands it whenever a command is wrapped); dir/** is the directory', { skip }, () => {
  const dir = project(['./config/*.key', 'secrets/', 'keys/*/', '~/.ssh/**', '/etc/app/token']);
  // "keys/*/" never reaches the sandbox ending in "/": it refuses a deny glob that does, as one that can match nothing.
  assert.deepEqual(paths(runReadDenials({ cwd: dir, home: '/home/user' })).sort(), ['/etc/app/token', '/home/user/.ssh', join(dir, 'config/*.key'), join(dir, 'keys/*/**'), join(dir, 'secrets'), ...late(dir, ['config/*.key', 'secrets/**', 'keys/*/**'])].sort());
});

test('#890: a literal path an exception names is left out, as the hook leaves it', { skip }, () => {
  const dir = project(['./a.txt', '!./a.txt', './b.txt']);
  assert.deepEqual(paths(runReadDenials({ cwd: dir, home: '/h' })).sort(), [join(dir, 'b.txt'), ...late(dir, ['b.txt'])].sort());
});

test('#890: an overlapped glob that can\'t be listed in full is denied whole: stricter, never looser', { skip }, () => {
  const dir = project(['./**/.env*', '!./.env.example']);
  const big = join(dir, 'big');
  mkdirSync(big);
  for (let i = 0; i <= EXPAND_LIMIT; i++) writeFileSync(join(big, `f${i}`), '');
  assert.deepEqual(paths(runReadDenials({ cwd: dir, home: '/h' })), [join(dir, '**/.env*')]);
});

test('#890: a task\'s hidden paths add the repository\'s object stores and every checkout; secret paths alone don\'t touch git', { skip }, () => {
  const dir = project(['./.env']);
  const wt = join(dirname(dir), 'wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'x', wt, 'HEAD'], { cwd: dir, stdio: 'ignore' });
  // A store that exists: git refuses to list one that doesn't, and so does the run (read-denials-routes.test.ts).
  const shared = join(dirname(dir), 'shared.git');
  execFileSync('git', ['init', '-q', '--bare', shared], { stdio: 'ignore' });
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(shared, 'objects')}\n`);
  const plain = paths(runReadDenials({ cwd: wt, home: '/h' }));
  assert.deepEqual(plain.sort(), [join(dir, '.env'), join(wt, '.env'), ...late(dir, ['.env'], [dirname(wt)])].sort());
  const hid = paths(runReadDenials({ cwd: wt, home: '/h', taskFile: task(['evals/**']) }));
  for (const p of [join(wt, 'evals'), join(dir, 'evals'), join(dir, '.git', 'objects'), join(shared, 'objects'), join(dir, '.git', 'lfs')]) assert.ok(hid.includes(p), `${p}: ${JSON.stringify(hid)}`);
  const g = gitStores(wt);
  assert.ok(!('error' in g) && g.checkouts.includes(dir) && g.checkouts.includes(wt));
});

test('#890: paths the sandbox can\'t take as written refuse the run', { skip }, () => {
  const cases: [string[], RegExp][] = [
    [['./a[1].txt'], /"\[" or "\]"/],
    [['/**/id_rsa'], /needs a directory to start from/],
  ];
  for (const [secret, why] of cases) {
    const r = runReadDenials({ cwd: project(secret), home: '/h' });
    assert.ok('error' in r && why.test(r.error), JSON.stringify(r));
  }
  const r = runReadDenials({ cwd: project(['~/.npmrc']), home: undefined });
  assert.ok('error' in r && /needs the run's home/.test(r.error), JSON.stringify(r));
});

test('#890: no project config and no task: nothing added, and nothing refused', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bare-'));
  assert.deepEqual(runReadDenials({ cwd: dir, home: '/h' }), { paths: [] });
});
