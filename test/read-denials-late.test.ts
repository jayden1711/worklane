// #890, second adversarial review: the guard hook matches a relative hidden or secret path only inside the run's own
// checkout, so the run's sandbox and Read rules are the only cover for every other checkout. That includes a worktree
// created while the run goes on: its paths are denied by globs over each worktree parent, which the sandbox expands
// on every command and a Read rule matches at call time. And an exception that names a hidden directory itself never
// drops that directory: to the hook it excepts nothing beneath it.
import { exampleProject, repoRoot } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReadDenials } from '../src/read-denials.js';
import { withDeniedReads } from '../src/sandbox.js';
import { globToRegExp } from '../src/guardrails/glob.js';

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

/** Is `target` denied by the Read rules withDeniedReads writes for these entries (the "//" absolute form, read as a guardrail glob)? */
function readDenied(entries: string[], target: string): boolean {
  const s = withDeniedReads({ permissions: { deny: [] as string[] } }, entries);
  return s.permissions.deny.some((r) => {
    const m = /^Read\(\/\/(.*)\)$/.exec(r);
    return !!m && globToRegExp(m[1]!).test(target.slice(1));
  });
}

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });

test('#890: a worktree added after the run starts is denied too, in the configured worktree root and beside an existing worktree', { skip }, async () => {
  const { dir } = exampleProject();
  mkdirSync(join(dir, 'evals-secret'));
  writeFileSync(join(dir, 'evals-secret', 'score.py'), 'SECRET_SCORER\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'eval');
  const root = join(dir, '.claude', 'worktrees');
  const exp = join(root, 'exp');
  git(dir, 'worktree', 'add', '-q', '-b', 'exp', exp, 'HEAD');
  const side = join(dirname(dir), 'side', 'one');
  git(dir, 'worktree', 'add', '-q', '-b', 'one', side, 'HEAD');
  const p = paths(runReadDenials({ cwd: exp, home: '/h', taskFile: task(['evals-secret/**', 'evals-secret/score.py']) }));
  // After the run's denials were worked out: a worker's worktree in the configured root, and one beside `side/one`.
  const late = join(root, 'late');
  git(dir, 'worktree', 'add', '-q', '-b', 'late', late, 'HEAD');
  const late2 = join(dirname(dir), 'side', 'two');
  git(dir, 'worktree', 'add', '-q', '-b', 'two', late2, 'HEAD');
  writeFileSync(join(late, '.env'), 'TOKEN=late\n');
  for (const t of [join(late, 'evals-secret', 'score.py'), join(late2, 'evals-secret', 'score.py'), join(late, '.env')]) {
    assert.ok(await hides(p, t), `${t} hidden from sandboxed commands: ${JSON.stringify(p)}`);
    assert.ok(readDenied(p, t), `${t} denied to Read`);
  }
  // The run's own source stays readable.
  assert.equal(await hides(p, join(exp, 'README.md')), false);
});

test('#890: an exception that names a hidden directory itself never drops the directory', { skip }, async () => {
  for (const neg of ['!evals*', '!evals', '!./evals']) {
    const { dir } = exampleProject();
    mkdirSync(join(dir, 'evals'));
    writeFileSync(join(dir, 'evals', 'x.py'), 'SECRET\n');
    const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**', neg]) }));
    assert.ok(await hides(p, join(dir, 'evals', 'x.py')), `${neg}: evals/x.py hidden: ${JSON.stringify(p)}`);
  }
});

test('#890: an exception beneath a hidden directory keeps that file readable and hides the rest', { skip }, async () => {
  const { dir } = exampleProject();
  mkdirSync(join(dir, 'evals'));
  for (const n of ['x.py', 'ok.txt']) writeFileSync(join(dir, 'evals', n), 'x\n');
  const p = paths(runReadDenials({ cwd: dir, home: '/h', taskFile: task(['evals/**', '!evals/ok.txt']) }));
  assert.ok(await hides(p, join(dir, 'evals', 'x.py')), JSON.stringify(p));
  assert.equal(await hides(p, join(dir, 'evals', 'ok.txt')), false, JSON.stringify(p));
});
