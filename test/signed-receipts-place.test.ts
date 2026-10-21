// Signed receipts, #918 round 6: the signer's state is reached by one checked path, and its lock is never taken over
// from a place that can't check its holder. A `--state` whose path runs through a directory link is refused, so no
// one can flip where it points after the check (row 1 of the round-5 review); a lock from another pid namespace, boot
// or host is never taken over, and a FIFO there is refused at once (rows 2 and 6); a hard-linked state is refused
// (row 5); a receipts line that isn't canonical JSON (a duplicate key) is refused (row 8). Fixture logs, keys and
// directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-5 code (the fail-without
// run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, keySigner, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';
import { engineCli } from './helpers.js';

const POSIX = process.platform !== 'win32';
const LINUX = process.platform === 'linux';
const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');
/** The signer lock's name in the state's directory (round 6), and the one beside the state file (round 5). */
const LOCK_NAMES = (state: string) => [join(dirname(state), '.receipts-signer.lock'), `${state}.lock`];

const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 20_000 });
const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

function keys(): { pub: KeyObject; signer: ReceiptSigner; privFile: string; pubFile: string } {
  const k = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'rk6-'));
  const privFile = join(dir, 'k.key');
  const pubFile = join(dir, 'k.pub');
  writeFileSync(privFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  writeFileSync(pubFile, k.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  return { pub: k.publicKey, signer: keySigner(k.privateKey), privFile, pubFile };
}

/** A log with one decision that merged; `held` adds a decision held for the owner and its failed merge. */
function fixtureLog(): { dir: string; path: string; held: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'r6-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  const held = () => {
    log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'] }, 'inst');
    log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  };
  return { dir, path, held };
}

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rs6-')), 'chain-state.json');

/** A pid that answered and is gone now. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid!;
}

test('a --state through a directory link in a directory others can write is refused (round 5 review, row 1)', { skip: !POSIX && 'symlinks and modes' }, () => {
  const f = fixtureLog();
  const k = keys();
  // The receipts' directory, writable by everyone (no sticky bit), holding a link to the signer's own directory.
  const shared = mkdtempSync(join(tmpdir(), 'rw6-'));
  chmodSync(shared, 0o777);
  const own = mkdtempSync(join(tmpdir(), 'ro6-'));
  symlinkSync(own, join(shared, 'state-dir'));
  const out = join(shared, 'receipts.jsonl');
  assert.throws(() => sign({ log: f.path, out, state: join(shared, 'state-dir', 'chain-state.json'), genesis: true, signer: k.signer }), /only the signer can write/);
  assert.ok(!existsSync(join(own, 'chain-state.json')) && !existsSync(out), 'nothing was written');
});

test("a --state through a directory link, even the signer's own, is refused: nothing on the way can be flipped (row 1)", { skip: !POSIX && 'symlinks' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const top = mkdtempSync(join(tmpdir(), 'rt6-'));
  const real = mkdtempSync(join(tmpdir(), 'rr6-'));
  mkdirSync(join(real, 'sub'), { mode: 0o700 });
  symlinkSync(real, join(top, 'link'));
  assert.throws(() => sign({ log: f.path, out, state: join(top, 'link', 'sub', 'chain-state.json'), genesis: true, signer: k.signer }), /only the signer can write/);
  assert.ok(!existsSync(join(real, 'sub', 'chain-state.json')) && !existsSync(out), 'nothing was written');
});

test('a signer lock from another pid namespace, boot or host is never taken over, even with its pid gone here (row 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  const published = readFileSync(out, 'utf8');
  const elsewhere = JSON.stringify({ pid: deadPid(), owner: JSON.stringify({ by: 'a signer elsewhere', pidns: 'pid:[1]', boot: 'another-boot', host: 'another-host' }), acquiredAt: new Date().toISOString() });
  for (const lock of LOCK_NAMES(state)) writeFileSync(lock, elsewhere, { mode: 0o600 });
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /never taken over/);
  assert.equal(text(out), published, 'nothing was signed');
});

test('a signer lock from this very place whose pid is gone is taken over (pin)', { skip: !LINUX && 'pid namespace and boot id are read on Linux only' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  const here = { by: 'a signer that died', pidns: readlinkSync('/proc/self/ns/pid'), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), host: hostname() };
  const stale = JSON.stringify({ pid: deadPid(), owner: JSON.stringify(here), acquiredAt: new Date().toISOString() });
  for (const lock of LOCK_NAMES(state)) writeFileSync(lock, stale, { mode: 0o600 });
  assert.equal(sign({ log: f.path, out, state, signer: k.signer }).added, 2);
});

test('a FIFO at the signer lock is refused at once, never waited on (row 6)', { skip: !POSIX && 'FIFOs' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  for (const lock of LOCK_NAMES(state)) execFileSync('mkfifo', [lock]);
  const r = cli('sign', '--log', f.path, '--key', k.privFile, '--out', out, '--state', state);
  assert.equal(r.status, 1, `exit ${r.status} (null: it hung): ${r.stderr}`);
  assert.match(r.stderr, /not a regular file/);
});

test('a state file with a second name (a hard link) is refused (row 5)', { skip: !POSIX && 'hard links' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  const alias = join(dirname(state), 'alias.json');
  linkSync(state, alias);
  const published = readFileSync(out, 'utf8');
  assert.throws(() => sign({ log: f.path, out, state: alias, signer: k.signer }), /names/);
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /names/);
  assert.equal(text(out), published);
});

test('a lock whose pid now belongs to another process is named for what it is, and still refused (pid reuse)', { skip: !LINUX && 'process start times are read on Linux only' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  // Taken here by a process that died; its pid is now this test's own (alive), with another start time.
  const here = { by: 'a signer that died', pidns: readlinkSync('/proc/self/ns/pid'), boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), host: hostname(), identity: 'another-boot:1' };
  const reused = JSON.stringify({ pid: process.pid, owner: JSON.stringify(here), acquiredAt: new Date().toISOString() });
  for (const lock of LOCK_NAMES(state)) writeFileSync(lock, reused, { mode: 0o600 });
  const published = readFileSync(out, 'utf8');
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /now belongs to another process/);
  assert.equal(text(out), published);
});

test('an option given with no value is a usage error (exit 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  for (const args of [['--state'], ['--state', stateFile(), '--out']]) {
    const r = cli('sign', '--log', f.path, '--key', k.privFile, ...(args[0] === '--out' ? [] : ['--out', out]), ...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /needs a value/);
  }
});

test('the state a run replaces is kept as <state>.prev, for recovering a failed rotation', () => {
  const f = fixtureLog();
  const a = keys();
  const b = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: a.signer });
  const before = readFileSync(state, 'utf8');
  const r = cli('rotate', '--out', out, '--key', a.privFile, '--next', b.pubFile, '--state', state);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(text(`${state}.prev`), before);
  assert.notEqual(readFileSync(state, 'utf8'), before);
});

test('verify refuses a line that is not exactly canonical JSON: a duplicate payload key (row 8)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, state: stateFile(), genesis: true, signer: k.signer });
  const envs = readReceiptFiles(out) as Envelope[];
  const lines = envs.map((e) => canonicalJson(e));
  // A forged payload first, the real one second: JSON.parse keeps the last, another reader may keep the first.
  const forged = Buffer.from('{"forged":true}', 'utf8').toString('base64');
  lines[1] = lines[1]!.replace('{"payload":', `{"payload":"${forged}","payload":`);
  const file = join(mkdtempSync(join(tmpdir(), 'rv6-')), 'r.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  const r = cli('verify', file, '--key', k.pubFile);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /canonical JSON/);
});
