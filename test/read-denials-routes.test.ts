// #890, review round 2: the routes and false refusals round 1 left open. Each one is checked against sandbox-runtime's
// own read-deny expansion (the library Claude Code's sandbox is built on), as a command in that sandbox would see it:
// - a symlinked directory under a glob an exception overlaps;
// - alternates of alternates, which git follows (measured: git 2.43 reads 6 stores down the chain, no more);
// - "[" or "]" in a path the runner resolved itself (a checkout, a home, a file an agent made), which must not
//   refuse every run, and must still hide the file.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';
import { projectStateDir } from '../src/guardrails/context.js';

/** The globs a pattern no exception overlaps also gets over the worktree parents (read-denials-late.test.ts). */
const late = (main: string, rel: string) => [join(main, '.claude', 'worktrees', '*', rel), join(projectStateDir(main), 'worktrees', '*', rel)];

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

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

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Does the sandbox these denyRead entries describe hide `target`? Each entry resolved as sandbox-runtime resolves it
 * on Linux: a glob expanded by its own expandReadDenyGlobLinux (matches listed where they really live), a plain path
 * mounted where it really lives when it exists. A target at or under a mount is hidden.
 */
async function hides(entries: string[], target: string): Promise<boolean> {
  const utils = await import(join(SRT, 'sandbox-utils.js'));
  const glob = await import(join(SRT, 'read-deny-glob.js'));
  const mounts: string[] = [];
  for (const e of entries) {
    const stripped: string = utils.removeTrailingGlobSuffix(e);
    if (utils.containsGlobChars(stripped)) mounts.push(...(glob.expandReadDenyGlobLinux(e, [], new Set()) as string[]));
    else if (existsSync(stripped)) mounts.push(real(stripped));
  }
  return mounts.some((m) => utils.isAtOrUnder(real(target), m));
}

// --- Symlinked directories ---

test('#890: an overlapped glob with a symlinked directory under it still hides what the link reaches, as the hook matches it', { skip }, async () => {
  const dir = project(['./**/.env*', '!./.env.example']);
  for (const n of ['.env.local', '.env.example']) writeFileSync(join(dir, n), 'x');
  const elsewhere = join(dirname(dir), 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, '.env.prod'), 'SECRET');
  symlinkSync('../elsewhere', join(dir, 'linked'));
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  assert.ok(await hides(p, join(dir, 'linked', '.env.prod')), `linked/.env.prod hidden: ${JSON.stringify(p)}`);
  assert.ok(await hides(p, join(dir, '.env.local')));
});

test('#890: a symlinked directory the glob never descends into, or a link to a file, keeps the exception readable', { skip }, async () => {
  const dir = project(['./.env', './.env.*', '!./.env.example']);
  for (const n of ['.env', '.env.local', '.env.example']) writeFileSync(join(dir, n), 'x');
  const elsewhere = join(dirname(dir), 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync('../elsewhere', join(dir, 'linked'));
  symlinkSync('README.md', join(dir, 'readme-link'));
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  assert.deepEqual(p.sort(), [join(dir, '.env'), join(dir, '.env.local'), ...late(dir, '.env')].sort());
  assert.equal(await hides(p, join(dir, '.env.example')), false);

  const deep = project(['./**/.env*', '!./.env.example']);
  for (const n of ['.env.local', '.env.example']) writeFileSync(join(deep, n), 'x');
  symlinkSync('README.md', join(deep, 'readme-link'));
  const q = paths(runReadDenials({ cwd: deep, home: '/h' }));
  assert.equal(await hides(q, join(deep, '.env.example')), false, JSON.stringify(q));
  assert.ok(await hides(q, join(deep, '.env.local')));
});

// --- Alternates of alternates ---

/** Bare repositories ref1..refN beside `dir`: dir's objects borrow from ref1, each refK from refK+1 (a relative path). */
function alternatesChain(dir: string, n: number) {
  const base = dirname(dir);
  const refs: string[] = [];
  for (let k = 1; k <= n; k++) {
    const r = join(base, `ref${k}.git`);
    execFileSync('git', ['init', '-q', '--bare', r], { stdio: 'ignore' });
    refs.push(r);
  }
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(refs[0]!, 'objects')}\n`);
  for (let k = 1; k < n; k++) writeFileSync(join(refs[k - 1]!, 'objects', 'info', 'alternates'), `# borrowed\n../../ref${k + 1}.git/objects\n`);
  return refs;
}

test('#890: alternates are followed as deep as git follows them, and every store on the way is hidden', { skip }, async () => {
  const dir = project(['./.env']);
  const refs = alternatesChain(dir, 6);
  // The scorer's blob, only in the last store: git reads it from the run's repository (measured: git reads 6 deep).
  const f = join(dirname(dir), 'scorer');
  writeFileSync(f, 'SECRET_SCORER\n');
  const oid = execFileSync('git', ['--git-dir', refs[5]!, 'hash-object', '-w', f], { encoding: 'utf8' }).trim();
  assert.equal(spawnSync('git', ['cat-file', '-e', oid], { cwd: dir }).status, 0, 'precondition: git reaches the 6th store');
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  for (const r of [join(dir, '.git'), ...refs]) assert.ok(await hides(p, join(r, 'objects')), `${r}/objects hidden: ${JSON.stringify(p)}`);
});

test('#890: an alternates chain deeper than git follows refuses the run; a cycle is followed once', { skip }, () => {
  const deep = project(['./.env']);
  alternatesChain(deep, 7);
  const r = runReadDenials({ cwd: deep, home: '/h', taskFile: task(['evals/**']) });
  assert.ok('error' in r && /alternates/.test(r.error), JSON.stringify(r));

  const loop = project(['./.env']);
  const refs = alternatesChain(loop, 2);
  writeFileSync(join(refs[1]!, 'objects', 'info', 'alternates'), '../../ref1.git/objects\n');
  const p = paths(runReadDenials({ cwd: loop, home: '/h', taskFile: task(['evals/**']) }));
  for (const r of refs) assert.ok(p.includes(join(r, 'objects')), JSON.stringify(p));
});

test("#890: an alternates file deeper in the chain that can't be read refuses the run", { skip: skip || (process.getuid?.() === 0 && 'root reads any file') }, () => {
  const dir = project(['./.env']);
  const refs = alternatesChain(dir, 2);
  chmodSync(join(refs[0]!, 'objects', 'info', 'alternates'), 0o000);
  const r = runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) });
  chmodSync(join(refs[0]!, 'objects', 'info', 'alternates'), 0o644);
  assert.ok('error' in r && /can't be read/.test(r.error), JSON.stringify(r));
});

test("#890: a run that hides nothing doesn't read the alternates, so a chain that can't be followed doesn't refuse it", { skip }, () => {
  const dir = project(['./.env']);
  // A store that isn't there: git can't follow the chain (git follows a quoted line, so that no longer stands for one).
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(dirname(dir), 'nowhere', 'objects')}\n`);
  assert.deepEqual(paths(runReadDenials({ cwd: dir, home: '/h' })), [join(dir, '.env'), ...late(dir, '.env')]);
  const r = runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) });
  assert.ok('error' in r && /alternates .* can't be read in full/.test(r.error), JSON.stringify(r));
});

// --- "[" and "]" in paths the runner resolved itself ---

test('#890: a checkout whose path holds "[" or "]" is not refused; srt still hides its secrets, and the exception stays readable', { skip }, async () => {
  const src = project(['./.env', './.env.*', '!./.env.example', '~/.npmrc']);
  const dir = `${src}[1]`;
  renameSync(src, dir);
  for (const n of ['.env', '.env.local', '.env.example']) writeFileSync(join(dir, n), 'x');
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'agent[2]');
  mkdirSync(home);
  writeFileSync(join(home, '.npmrc'), 'TOKEN');
  const p = paths(runReadDenials({ cwd: dir, home, taskFile: task(['evals/**']) }));
  assert.deepEqual(p.filter((e) => /[[\]]/.test(e)), [], 'no "[" or "]" reaches the sandbox');
  // "?" matches the bracket character itself: fail closed, the file is still hidden.
  for (const t of [join(dir, '.env'), join(dir, '.env.local'), join(home, '.npmrc'), join(dir, '.git', 'objects')]) assert.ok(await hides(p, t), `${t} hidden: ${JSON.stringify(p)}`);
  assert.equal(await hides(p, join(dir, '.env.example')), false);
});

test('#890: a file named with "[" or "]" that a secret glob matches is not refused, and srt hides it', { skip }, async () => {
  const dir = project(['./.env', './.env.*', '!./.env.example']);
  for (const n of ['.env', '.env.[x]', '.env.example']) writeFileSync(join(dir, n), 'x');
  const p = paths(runReadDenials({ cwd: dir, home: '/h' }));
  assert.ok(await hides(p, join(dir, '.env.[x]')), JSON.stringify(p));
  assert.equal(await hides(p, join(dir, '.env.example')), false);
});

test('#890: a pattern the project or the task wrote with "[" or "]" still refuses the run', { skip }, () => {
  const secret = runReadDenials({ cwd: project(['./a[1].txt']), home: '/h' });
  assert.ok('error' in secret && /"\[" or "\]"/.test(secret.error), JSON.stringify(secret));
  const hidden = runReadDenials({ cwd: project(['./.env']), home: '/h', taskFile: task(['evals[1]/**']) });
  assert.ok('error' in hidden && /"\[" or "\]"/.test(hidden.error), JSON.stringify(hidden));
});
