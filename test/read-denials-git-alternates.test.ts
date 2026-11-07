// #890, review round 3: the alternates chain is the one git itself reads, never a reading of the files that can
// differ from git's. Each case below is one where git reads a store that a parser of its own got wrong: a relative
// line resolved against a symlinked path (git resolves it against the store's real path), a line with leading
// whitespace (git doesn't trim it), and a quoted path. Every store git reads is checked hidden with sandbox-runtime's
// own read-deny expansion (the library Claude Code's sandbox is built on).
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';

const skip = process.platform !== 'linux' && "sandbox-runtime's Linux read-deny rules, where CI runs";
const SRT = join(repoRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist', 'sandbox');

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

/** Does the sandbox these denyRead entries describe hide `target`? Resolved as sandbox-runtime resolves them (Linux). */
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

const bare = (d: string) => execFileSync('git', ['init', '-q', '--bare', d], { stdio: 'ignore' });

/** The scorer's blob written into `store` only; git, run in `cwd`, must reach it (the route this closes). */
function scorerIn(store: string, cwd: string) {
  const f = join(mkdtempSync(join(tmpdir(), 'blob-')), 'score.py');
  writeFileSync(f, 'SECRET_SCORER\n');
  const oid = execFileSync('git', ['--git-dir', store, 'hash-object', '-w', f], { encoding: 'utf8' }).trim();
  assert.equal(spawnSync('git', ['cat-file', '-e', oid], { cwd }).status, 0, 'precondition: git reads the scorer from the run\'s repository');
}

test('#890: a relative alternate behind a symlinked store is the store git reads (resolved against the real path)', { skip }, async () => {
  const { dir } = exampleProject();
  const base = dirname(dir);
  mkdirSync(join(base, 'real'));
  mkdirSync(join(base, 'sym'));
  const ref1 = join(base, 'real', 'ref1.git');
  const ref2 = join(base, 'real', 'ref2.git');
  bare(ref1);
  bare(ref2);
  symlinkSync(ref1, join(base, 'sym', 'lnk'));
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(base, 'sym', 'lnk', 'objects')}\n`);
  // Relative to ref1's real objects: real/ref2.git. Read lexically from sym/lnk/objects it would be sym/ref2.git.
  writeFileSync(join(ref1, 'objects', 'info', 'alternates'), '../../ref2.git/objects\n');
  scorerIn(ref2, dir);
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(ref2, 'objects')), `real/ref2.git/objects hidden: ${JSON.stringify(p)}`);
  assert.ok(await hides(p, join(ref1, 'objects')));
});

test('#890: a relative alternate of a checkout reached through a symlink is the store git reads', { skip }, async () => {
  const { dir: made } = exampleProject();
  const base = dirname(made);
  mkdirSync(join(base, 'realdir'));
  const dir = join(base, 'realdir', 'repo');
  renameSync(made, dir);
  const link = join(base, 'lnkrepo');
  symlinkSync(join('realdir', 'repo'), link);
  const ref = join(base, 'realdir', 'ref.git');
  bare(ref);
  // From the real objects (realdir/repo/.git/objects) this is realdir/ref.git; read lexically from lnkrepo, base/ref.git.
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), '../../../ref.git/objects\n');
  scorerIn(ref, link);
  const p = paths(runReadDenials({ cwd: link, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(ref, 'objects')), `realdir/ref.git/objects hidden: ${JSON.stringify(p)}`);
});

test('#890: an alternates line with leading whitespace is the path git reads, untrimmed', { skip }, async () => {
  const { dir } = exampleProject();
  const ref2 = join(dirname(dir), 'ref2.git');
  bare(ref2);
  symlinkSync(join(ref2, 'objects'), join(dir, '.git', 'objects', ' x'));
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), ' x\n');
  scorerIn(ref2, dir);
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  assert.ok(await hides(p, join(ref2, 'objects')), `ref2.git/objects hidden: ${JSON.stringify(p)}`);
});

test('#890: a quoted alternates line, and a store whose path git prints quoted, are the stores git reads', { skip }, async () => {
  const { dir } = exampleProject();
  const odd = join(dirname(dir), 'réf "q"\\.git');
  bare(odd);
  const plain = join(dirname(dir), 'plain.git');
  bare(plain);
  // git unquotes a line that starts with '"', C-style.
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(odd, 'objects')}\n"${join(plain, 'objects').replace(/\\/g, '\\\\')}"\n`);
  scorerIn(odd, dir);
  scorerIn(plain, dir);
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**']) }));
  for (const s of [odd, plain]) assert.ok(await hides(p, join(s, 'objects')), `${s}/objects hidden: ${JSON.stringify(p)}`);
});
