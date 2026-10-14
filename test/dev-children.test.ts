import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { isChildPid, killTree } from '../src/os/index.js';
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

/** Whether the child is running. Only ever a child's pid: process.kill(0, 0) probes this whole process group (#312). */
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a child's pid: ${pid}`);
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
  assert.ok(Number.isInteger(pid) && pid > 0, `no child pid from the script: stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr)}`);
  assert.ok(await gone(pid), `the child ${pid} is still running`);
  assert.equal(existsSync(work), false);
});

test('a dev script stopped by a signal stops what it started', { skip: process.platform === 'win32' && 'no POSIX signals to send on Windows' }, async () => {
  const { script, work } = fixture('wait');
  const p = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const printed = await new Promise<string>((ok) => p.stdout.once('data', (d: Buffer) => ok(d.toString())));
  const pid = Number(printed.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `no child pid from the script: ${JSON.stringify(printed)}`);
  const exited = new Promise<number | null>((ok) => p.on('exit', (code) => ok(code)));
  p.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.ok(await gone(pid), `the child ${pid} is still running`);
  assert.equal(existsSync(work), false);
});

test('a pid of 0 or below is never a child: never stopped, never signalled', () => {
  // WHY (#312): a pid <= 0 names a process group; process.kill(0, ...) signals every process in this one.
  const dir = mkdtempSync(join(tmpdir(), 'dev-children-pid-'));
  const kills = join(dir, 'kills');
  const script = join(dir, 'run.mjs');
  writeFileSync(
    script,
    [
      "import { EventEmitter } from 'node:events';",
      "import { appendFileSync } from 'node:fs';",
      `import { exitCleanup } from ${JSON.stringify(helper)};`,
      'const cleanup = exitCleanup();',
      'for (const pid of [0, -1, -process.pid]) {',
      '  const p = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kill: () => appendFileSync(' + JSON.stringify(kills) + ', `${pid}\\n`) });',
      '  cleanup.track(p);',
      '}',
    ].join('\n'),
  );
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(kills), false, existsSync(kills) ? `stopped as children: ${readFileSync(kills, 'utf8')}` : '');
});

test('a child that does not start is not tracked, and its spawn error ends the script, named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-children-nostart-'));
  const script = join(dir, 'run.mjs');
  const missing = join(dir, 'no-such-program');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      `import { exitCleanup } from ${JSON.stringify(helper)};`,
      'const cleanup = exitCleanup();',
      `const c = cleanup.track(spawn(${JSON.stringify(missing)}, [], { stdio: 'ignore' }));`,
      "console.log(String(c.pid));",
      'setTimeout(() => {}, 2000);',
    ].join('\n'),
  );
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.stdout.trim(), 'undefined', 'it never had a pid');
  assert.notEqual(r.status, 0, 'the script did not carry on without it');
  assert.match(r.stderr, /a child didn't start \(.*no-such-program\): spawn .*no-such-program ENOENT/);
});

test('the engine kills a process tree only for a child\'s pid: never 0, 1, below 0 or none', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
  for (const pid of [undefined, Number.NaN, 0, 1, -1, -2, 1.5]) assert.equal(isChildPid(pid), false, String(pid));
  assert.equal(isChildPid(2), true);
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await once(bystander, 'spawn');
    let fellBack = 0;
    // Never 1 here: without the guard, kill(-1) signals every process this user may signal.
    for (const pid of [undefined, 0, -bystander.pid!, 1.5]) killTree(pid, () => fellBack++);
    assert.equal(fellBack, 4, 'each falls back to the child handle (a no-op for one that never started)');
    assert.ok(alive(bystander.pid!), 'a negative pid never reached a process');
  } finally {
    bystander.kill('SIGKILL');
  }
});

test('the screenshot script starts its dashboards and Chrome only through the clean-up', () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'dev', 'screenshots.mjs'), 'utf8');
  const spawns = src.match(/\bspawn\(/g) ?? [];
  const tracked = src.match(/cleanup\.track\(spawn\(/g) ?? [];
  assert.ok(spawns.length >= 2);
  assert.equal(tracked.length, spawns.length, 'every long-lived child is tracked');
});
