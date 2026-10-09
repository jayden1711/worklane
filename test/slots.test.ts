import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { currentCap, slotStatus, tryAgentSlot } from '../src/slots.js';
import { repoRoot } from './helpers.js';

const slotsDir = (cap: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'slots-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ max_agents: cap }));
  return dir;
};

test('acceptance: eight processes racing for slots under a cap of 4 get exactly 4', async () => {
  const dir = slotsDir(4);
  const slots = join(repoRoot, 'dist', 'src', 'slots.js');
  const child = (k: number) =>
    new Promise<string>((res) => {
      // Each process takes a slot if it can, reports, and holds it while the others try.
      const p = spawn(process.execPath, ['--input-type=module', '-e', `const { tryAgentSlot } = await import(${JSON.stringify(pathToFileURL(slots).href)}); const l = tryAgentSlot('p${k}', ${JSON.stringify(dir)}); console.log(l ? 'got' : 'none'); setTimeout(() => {}, 3000);`]);
      let out = '';
      p.stdout.on('data', (d) => {
        out += String(d);
        if (out.includes('\n')) res(out.trim());
      });
      p.on('exit', () => res(out.trim()));
    });
  const results = await Promise.all(Array.from({ length: 8 }, (_, k) => child(k)));
  assert.equal(results.filter((r) => r === 'got').length, 4, results.join(','));
});

test('regression: after the cap drops, a free low-numbered slot does not let a newcomer past the cap', () => {
  const dir = slotsDir(4);
  const held = [0, 1, 2, 3].map((k) => tryAgentSlot(`a${k}`, dir)!);
  assert.ok(held.every(Boolean));
  assert.equal(tryAgentSlot('extra', dir), null, 'full at 4');
  writeFileSync(join(dir, 'cap.json'), JSON.stringify({ cap: 2 }));
  assert.equal(currentCap(dir), 2, 'the adaptive cap wins over max_agents');
  held[0]!.release();
  assert.equal(slotStatus(dir).agents.length, 3);
  assert.equal(tryAgentSlot('newcomer', dir), null, 'slot 0 is free, but 3 are running against a cap of 2');
  held[1]!.release();
  assert.equal(tryAgentSlot('newcomer', dir), null, '2 running, cap 2');
  held[2]!.release();
  const got = tryAgentSlot('newcomer', dir);
  assert.ok(got, 'room again once below the cap');
  assert.equal(slotStatus(dir).agents.length, 2);
  got!.release();
  held[3]!.release();
});
