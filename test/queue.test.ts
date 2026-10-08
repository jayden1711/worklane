import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJob } from '../src/queue.js';
import { slotStatus, tryAgentSlot } from '../src/slots.js';
import { engineCli } from './helpers.js';

const posix = process.platform !== 'win32';

async function until(pred: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

test('agent slots are capped machine-wide and freed when the holder dies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  const a = tryAgentSlot('harness A', dir);
  const b = tryAgentSlot('harness B', dir);
  assert.ok(a && b);
  assert.equal(tryAgentSlot('harness C', dir), null, 'cap reached across harnesses');
  assert.equal(slotStatus(dir).agents.length, 2);
  a.release();
  assert.ok(tryAgentSlot('harness C', dir));
  // A slot file left by a dead process doesn't count.
  writeFileSync(join(dir, 'agent-1.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, owner: 'crashed', acquiredAt: '' }));
  assert.ok(slotStatus(dir).agents.every((x) => x.owner !== 'crashed'));
});

test('regression: a queued run survives the session that started it being killed', { skip: !posix && 'posix process groups' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'q-'));
  const stateDir = join(base, 'state');
  const marker = join(base, 'ran');
  // A stand-in "session": its own process group, which queues a job and then hangs.
  const session = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { queueJob } from ${JSON.stringify(new URL('../src/queue.js', import.meta.url).href)};
       const job = queueJob({ stateDir: ${JSON.stringify(stateDir)}, cwd: ${JSON.stringify(base)}, cliPath: ${JSON.stringify(engineCli)},
         command: ${JSON.stringify(`node -e "setTimeout(() => require('fs').writeFileSync('ran', 'ok'), 1500)"`)} });
       console.log(job.id); setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, AGENT_SLOTS_DIR: join(base, 'slots') } },
  );
  let id = '';
  session.stdout!.on('data', (d: Buffer) => (id += d.toString().trim()));
  assert.ok(await until(() => id.length > 0, 10_000), 'job queued');
  process.kill(-session.pid!, 'SIGKILL'); // the session ends, hard
  assert.ok(await until(() => existsSync(marker), 20_000), 'job ran after the session died');
  assert.ok(await until(() => readJob(stateDir, id).status === 'passed', 10_000), readJob(stateDir, id).status);
});

test('a queued full run waits while another run is live, then starts by itself', { skip: !posix && 'posix shell probe' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'q-'));
  const stateDir = join(base, 'state');
  const busy = join(base, 'other-run-live');
  writeFileSync(busy, '');
  const { queueJob } = await import('../src/queue.js');
  process.env.AGENT_SLOTS_DIR = join(base, 'slots');
  try {
    const job = queueJob({ stateDir, cwd: base, cliPath: engineCli, idleProbe: `test ! -e ${JSON.stringify(busy)}`, command: 'echo done > ran' });
    // Wait until the runner reports it's blocked by the probe (no fixed sleeps: CI machines are slow).
    assert.ok(await until(() => /idle probe/.test(readJob(stateDir, job.id).waitingFor ?? ''), 60_000), 'runner reports waiting on the probe');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(existsSync(join(base, 'ran')), false, 'did not start while another run was live');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(busy);
    assert.ok(await until(() => readJob(stateDir, job.id).status === 'passed', 60_000), readJob(stateDir, job.id).status);
  } finally {
    delete process.env.AGENT_SLOTS_DIR;
  }
});
