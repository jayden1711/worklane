// #846: a child the engine starts gets only the environment the engine built for it, never a key from Object.prototype.
// These drive real engine spawn sites (a plain-object env, a spread, and none at all) with Object.prototype polluted as
// a malicious dependency would pollute it, and look at what the child did. The protection is src/os/child-process.ts
// (every spawn in src/ goes through it); test/child-process.test.ts covers the module and its lint backstop.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { systemGit } from '../src/checkout-sync.js';
import { decisionDiff } from '../src/decision-detail.js';
import { holdFlock } from '../src/os/index.js';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { checkSetupOffThread } from '../src/setup-steps.js';

/** Runs `f` with `vars` on Object.prototype, as a polluting dependency would set them, and takes them off after. */
async function polluted<T>(vars: Record<string, string>, f: () => T | Promise<T>): Promise<T> {
  const proto = Object.prototype as Record<string, unknown>;
  for (const k of Object.keys(vars)) assert.ok(!Object.hasOwn(proto, k), `${k} isn't on Object.prototype already`);
  try {
    for (const [k, v] of Object.entries(vars)) proto[k] = v;
    return await f();
  } finally {
    for (const k of Object.keys(vars)) delete proto[k];
  }
}

/** git's GIT_CONFIG_* injection: any config setting, for every git the engine runs (#846's GIT_* route). */
const gitConfig = (key: string, value: string) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value });

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(): { dir: string; base: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wl846-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'f.txt'), 'two\n');
  git(dir, 'commit', '-q', '-am', 'two');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}

test('#846 spawnSync with a spread env (checkout-sync systemGit): git sees no GIT_CONFIG_* from Object.prototype', async () => {
  const { dir } = repo();
  const run = systemGit(dir);
  assert.equal(run(['config', '--get', 'wl846.canary']).status, 1, 'unset with a clean prototype');
  const r = await polluted(gitConfig('wl846.canary', 'from-the-prototype'), () => run(['config', '--get', 'wl846.canary']));
  assert.equal(r.stdout.trim(), '', 'the child read no config from a prototype key');
  assert.equal(r.status, 1, 'git finds no such setting');
});

test('#846 execFile with a spread env and a callback (decisionDiff): git diff keeps its prefixes under a polluted prototype', async () => {
  const { dir, base, head } = repo();
  const clean = await decisionDiff(dir, base, head);
  assert.ok(clean.diff?.includes('--- a/f.txt'), 'a/ and b/ prefixes with a clean prototype');
  const dirty = await polluted(gitConfig('diff.noprefix', 'true'), () => decisionDiff(dir, base, head));
  assert.equal(dirty.diff, clean.diff, 'the same diff: no config reached git from a prototype key');
});

test('#846 spawn with no env (holdFlock): perl loads no module named by PERL5OPT on Object.prototype', { skip: process.platform === 'win32' && 'flock needs macOS or Linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wl846-perl-'));
  const mark = join(dir, 'loaded');
  writeFileSync(join(dir, 'WL846Canary.pm'), `package WL846Canary; open(my $f, '>', ${JSON.stringify(mark)}); close($f); 1;\n`);
  const lock = join(dir, 'lock');
  writeFileSync(lock, '');
  const held = await polluted({ PERL5OPT: '-MWL846Canary', PERL5LIB: dir }, () => holdFlock(lock, 'shared'));
  await held.release();
  assert.equal(existsSync(mark), false, 'the lock holder ran no code named by a prototype key');
});

test("#846 round 2: the setup check's Worker (checkSetupOffThread) never takes its env from Object.prototype.env", async () => {
  // A stand-in Worker records the options it is given, so no real probe (gh, claude, the service manager) runs here.
  // Node's Worker reads `options.env`; with no own env on the options, that is Object.prototype.env (measured, #883 review).
  const wt = createRequire(import.meta.url)('node:worker_threads') as Record<string, unknown>;
  const real = wt.Worker;
  const seen: Record<string, unknown>[] = [];
  wt.Worker = class extends EventEmitter {
    constructor(_file: unknown, options: Record<string, unknown>) {
      super();
      seen.push(options);
    }
  };
  syncBuiltinESMExports();
  try {
    const env = await polluted({ env: { WL846_CANARY: 'from-the-prototype' } as unknown as string }, () => {
      void checkSetupOffThread({} as Parameters<typeof checkSetupOffThread>[0], { cache: new Map() });
      assert.equal(seen.length, 1, 'one worker started');
      return seen[0]!.env as Record<string, unknown> | undefined;
    });
    assert.ok(env, 'the worker is given an environment');
    assert.equal(Object.hasOwn(env, 'WL846_CANARY'), false, "the worker's environment is not the prototype's");
    assert.equal(env.PATH, process.env.PATH, "the worker's environment is the engine's own");
  } finally {
    wt.Worker = real;
    syncBuiltinESMExports();
  }
});
