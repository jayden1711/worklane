// lint-test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readStopFile, STOP_NO_REASON, STOP_UNREADABLE, stopFilePath } from '../src/auto-merge-stop.js';
import { autoMergeState } from '../src/dashboard.js';
import { readStop } from '../src/watchdog/wire.js';
import { repoRoot } from './helpers.js';

/** Each stop file a present stop must hold for (#982), with the reason it shows. */
const STOPS: { name: string; write: (file: string) => void; reason: string }[] = [
  { name: 'a reason', write: (f) => writeFileSync(f, JSON.stringify({ reason: 'main went red after #12', by: 'red_main' })), reason: 'main went red after #12' },
  { name: 'an empty reason', write: (f) => writeFileSync(f, JSON.stringify({ reason: '', by: 'red_main' })), reason: STOP_NO_REASON },
  { name: 'a blank reason', write: (f) => writeFileSync(f, JSON.stringify({ reason: ' \n' })), reason: STOP_NO_REASON },
  { name: 'no reason', write: (f) => writeFileSync(f, '{}'), reason: STOP_NO_REASON },
  { name: 'a null reason', write: (f) => writeFileSync(f, '{"reason": null}'), reason: STOP_NO_REASON },
  { name: 'an empty-list reason', write: (f) => writeFileSync(f, '{"reason": []}'), reason: STOP_NO_REASON },
  { name: 'a number reason', write: (f) => writeFileSync(f, '{"reason": 0}'), reason: STOP_NO_REASON },
  { name: 'an empty file', write: (f) => writeFileSync(f, ''), reason: STOP_UNREADABLE },
  { name: 'bytes that are not JSON', write: (f) => writeFileSync(f, '{"reason": '), reason: STOP_UNREADABLE },
  { name: 'JSON null', write: (f) => writeFileSync(f, 'null'), reason: STOP_UNREADABLE },
  { name: 'a JSON string', write: (f) => writeFileSync(f, '""'), reason: STOP_UNREADABLE },
  { name: 'a directory', write: (f) => mkdirSync(f), reason: STOP_UNREADABLE },
  { name: 'a dangling symlink', write: (f) => symlinkSync(join(f, '..', 'gone.json'), f), reason: STOP_UNREADABLE },
];

const policyOn = (dir: string) => {
  const file = join(dir, 'policy.yaml');
  writeFileSync(file, 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: true\n');
  return file;
};

test('regression (#982): a stop file that is there holds whatever its reason holds, and shows a reason that is never empty', () => {
  for (const s of STOPS) {
    const dir = mkdtempSync(join(tmpdir(), 'am-stop-'));
    s.write(stopFilePath(dir));
    assert.equal(readStopFile(stopFilePath(dir))?.reason, s.reason, s.name);
  }
  assert.equal(readStopFile(stopFilePath(mkdtempSync(join(tmpdir(), 'am-stop-')))), null, 'no file: no stop');
  assert.equal(readStopFile(join(mkdtempSync(join(tmpdir(), 'am-stop-')), 'missing-dir', 'auto-merge-stopped.json')), null, 'no state dir: no stop');
});

test("regression (#982): the dashboard's auto-merge state and the watchdog read every present stop file as stopped", () => {
  for (const s of STOPS) {
    const dir = mkdtempSync(join(tmpdir(), 'am-stop-'));
    const policy = policyOn(dir);
    assert.equal(autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir }).on, true, `${s.name}: control, no stop file`);
    s.write(stopFilePath(dir));
    const st = autoMergeState({ policyFile: policy, repoAuto: true, stateDir: dir });
    assert.equal(st.on, false, s.name);
    assert.equal(st.stopped, s.reason, s.name);
    assert.equal(st.why, `stopped: ${s.reason}; the operator clears it`, s.name);
    assert.equal(readStop(dir)?.reason, s.reason, `${s.name}: watchdog`);
  }
});

test('regression (#982): only src/auto-merge-stop.ts names the stop file, so no other reader can read it another way', () => {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|js)$/.test(e.name) && readFileSync(p, 'utf8').includes('auto-merge-stopped')) found.push(relative(repoRoot, p).split('\\').join('/'));
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepEqual(found, ['src/auto-merge-stop.ts']);
});
