import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

const helper = pathToFileURL(join(repoRoot, 'scripts', 'dev', 'children.mjs')).href;

/** A script that starts a long-lived child through the helper, prints its pid, then ends as `how` says. */
function fixture(how: 'throw' | 'wait'): { script: string; work: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dev-children-'));
  const work = mkdtempSync(join(tmpdir(), 'dev-children-work-'));
  const script = join(dir, 'run.mjs');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { rmSync } from 'node:fs';",
      `import { exitCleanup } from ${JSON.stringify(helper)};`,
      'const cleanup = exitCleanup();',
      `cleanup.finally(() => rmSync(${JSON.stringify(work)}, { recursive: true, force: true }));`,
      "const c = cleanup.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));",
      'console.log(c.pid);',
      how === 'throw' ? "await new Promise((r) => setTimeout(r, 100)); throw new Error('halfway');" : 'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  return { script, work };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number) {
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
}

test('a dev script that throws halfway still stops what it started and removes its temporary directory', async () => {
  const { script, work } = fixture('throw');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 });
  assert.notEqual(r.status, 0, 'it failed');
  assert.match(r.stderr, /halfway/);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  assert.ok(await gone(pid), `the child ${pid} is still running`);
  assert.equal(existsSync(work), false);
});

test('a dev script stopped by a signal stops what it started', { skip: process.platform === 'win32' && 'no POSIX signals to send on Windows' }, async () => {
  const { script, work } = fixture('wait');
  const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pid = await new Promise<number>((ok) => p.stdout.once('data', (d: Buffer) => ok(Number(d.toString().trim()))));
  const exited = new Promise<number | null>((ok) => p.on('exit', (code) => ok(code)));
  p.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.ok(await gone(pid), `the child ${pid} is still running`);
  assert.equal(existsSync(work), false);
});

test('the screenshot script starts its dashboards and Chrome only through the clean-up', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev', 'screenshots.mjs'), 'utf8');
  const spawns = src.match(/\bspawn\(/g) ?? [];
  const tracked = src.match(/cleanup\.track\(spawn\(/g) ?? [];
  assert.ok(spawns.length >= 2);
  assert.equal(tracked.length, spawns.length, 'every long-lived child is tracked');
});
