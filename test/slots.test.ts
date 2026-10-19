import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { machineCap, slotStatus, tryAgentSlot } from '../src/slots.js';
import { slotsConfigPath, slotsDirFor as machineSlotsDir } from '../src/os/index.js';
import { devSlotsPath } from '../src/os/system-paths.js';
import { readSlotFile, slotFile, type SlotPath, type SlotPathLike } from '../src/slot-file.js';

/**
 * Whether slot path `p` names the file `file`: a random text written to `file` with plain fs is read back through
 * `p`, read-only (then removed). Nothing is written through `p`: if it pointed elsewhere, nothing lands there (rule A,
 * #806 round 7). A slot path has no identity or text to compare (#806 round 6).
 */
function namesFile(p: SlotPathLike, file: string): boolean {
  const text = `names ${randomBytes(6).toString('hex')}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  try {
    return readSlotFile(p) === text;
  } catch {
    return false;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Whether slot path `p` names the directory `dir`. */
const names = (p: SlotPath, dir: string): boolean => namesFile(slotFile(p, `.names-${process.pid}`), join(dir, `.names-${process.pid}`));
import { repoRoot } from './helpers.js';
import { onRealMachine } from './isolate.js';

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
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ max_agents: 2 }));
  assert.equal(machineCap(dir), 2, 'the operator lowers the cap');
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

test('slot locations: durable system paths when present, env overrides, the old in-dir config as a fallback', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'sys-'));
  const system = { dir: join(root, 'var-lib', 'agent-slots'), config: join(root, 'etc', 'slots.json') };
  const saved = { dir: process.env.AGENT_SLOTS_DIR, config: process.env.AGENT_SLOTS_CONFIG };
  delete process.env.AGENT_SLOTS_DIR;
  delete process.env.AGENT_SLOTS_CONFIG;
  try {
    // The machine's /var/tmp, inside the test's own root (test/isolate.ts): a test never uses the real one.
    // A slot path (#772) has no identity or text to compare: a marker made in the expected dir is read through it (`names`).
    assert.equal(onRealMachine(devSlotsPath()), '/var/tmp/agent-slots');
    assert.ok(names(machineSlotsDir(system), devSlotsPath()), 'no system dir: the development default');
    mkdirSync(system.dir, { recursive: true });
    assert.ok(names(machineSlotsDir(system), system.dir), 'the durable dir when it exists');
    assert.equal(slotsConfigPath(system.dir, system), join(system.dir, 'config.json'), 'no system config yet');
    assert.ok(namesFile(slotsConfigPath(machineSlotsDir(system), system), join(system.dir, 'config.json')), 'no system config yet (a slot path)');
    mkdirSync(join(root, 'etc'));
    writeFileSync(system.config, JSON.stringify({ max_agents: 6 }));
    assert.equal(slotsConfigPath(system.dir, system), system.config);
    // A test's own `system` never marks a slot path as the system dir (#806 round 3: no caller's path is compared with
    // the slot dir), so the slot-path form keeps the dir's own config; the machine's SYSTEM_SLOTS does mark one
    // (test/slot-path.test.ts, "the machine's own system slot dir").
    assert.ok(namesFile(slotsConfigPath(machineSlotsDir(system), system), join(system.dir, 'config.json')), 'a slot path from a test system is no system dir');
    assert.equal(slotsConfigPath('/some/other/dir', system), '/some/other/dir/config.json', 'a custom slot dir keeps its own config');
    // Inside the test machine: in a test run, a slot directory outside it is refused (#669).
    process.env.AGENT_SLOTS_DIR = join(root, 'custom-slots');
    process.env.AGENT_SLOTS_CONFIG = system.config;
    assert.ok(names(machineSlotsDir(system), join(root, 'custom-slots')));
    const custom = mkdtempSync(join(tmpdir(), 'slots-'));
    assert.equal(machineCap(custom), 6, 'the configured file is read wherever it lives');
  } finally {
    for (const [k, v] of [['AGENT_SLOTS_DIR', saved.dir], ['AGENT_SLOTS_CONFIG', saved.config]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
