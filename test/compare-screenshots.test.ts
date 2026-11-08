import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from './helpers.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number) {
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

/**
 * A throwaway repo laid out like this one: the real compare script and its clean-up helper, an npm package
 * whose builds do nothing, and a stand-in screenshot script that starts a long-lived child (as the real one
 * starts dashboards and Chrome), prints both pids, and waits.
 */
function fakeRepo(): string {
  const base = mkdtempSync(join(tmpdir(), 'compare-signals-'));
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.email=ci@example.com', '-c', 'user.name=ci', ...a], { cwd, stdio: 'ignore' });
  mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(join(repo, 'scripts', 'dev'), { recursive: true });
  for (const f of ['compare-screenshots.mjs', 'children.mjs']) copyFileSync(join(repoRoot, 'scripts', 'dev', f), join(repo, 'scripts', 'dev', f));
  // The git runner compare-screenshots.mjs imports (#807).
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'lib', 'git.cjs'), join(repo, 'scripts', 'lib', 'git.cjs'));
  writeFileSync(
    join(repo, 'scripts', 'dev', 'screenshots.mjs'),
    [
      "import { spawn } from 'node:child_process';",
      "import { exitCleanup } from './children.mjs';",
      'const cleanup = exitCleanup();',
      "const kid = cleanup.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));",
      'console.log(`PIDS ${process.pid} ${kid.pid}`);',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  const pkg = { name: 'compare-signals', version: '0.0.0', private: true, scripts: { build: 'node -e ""', 'build:web': 'node -e ""' } };
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }));
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  return repo;
}

test('stopping the compare script stops the screenshot run it started, and what that started', { skip: process.platform === 'win32' && 'no POSIX signals to send on Windows', timeout: 120_000 }, async () => {
  const repo = fakeRepo();
  const p = spawn(process.execPath, [join(repo, 'scripts', 'dev', 'compare-screenshots.mjs'), '--base', 'origin/main', '--head', 'main', '--out', join(repo, 'out')], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const pids = await new Promise<[number, number]>((ok, fail) => {
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/PIDS (\d+) (\d+)/);
      if (m) ok([Number(m[1]), Number(m[2])]);
    });
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('exit', (code) => fail(new Error(`compare exited (${code}) before the screenshot run started:\n${out}`)));
  });
  const [screenshots, grandchild] = pids;
  try {
    assert.ok(alive(screenshots) && alive(grandchild), 'the screenshot run and its child are running');
    const exited = new Promise<number | null>((ok) => p.on('exit', (code) => ok(code)));
    p.kill('SIGTERM');
    assert.equal(await exited, 143, 'compare exits as a stopped process');
    assert.ok(await gone(screenshots), `the screenshot run (${screenshots}) is still running`);
    assert.ok(await gone(grandchild), `what the screenshot run started (${grandchild}) is still running`);
  } finally {
    // Failing or not, nothing is left behind, and the pipes a leftover would hold open are let go.
    for (const pid of [grandchild, screenshots, p.pid!]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    p.stdout.destroy();
    p.stderr.destroy();
    rmSync(dirname(repo), { recursive: true, force: true });
  }
});
