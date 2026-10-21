// Signed receipts, #918 round 4 (second adversarial review): the signer keeps its own chain head, so a truncated,
// deleted or substituted receipts file is never signed on (A2, A3, A4); the receipts file is never written through a
// name planted beside it (A11); verify prints no untrusted control character (A5, A6) and reads only regular files,
// under a size cap (A7); the key writer's read-back checks the file it made (inode, mode, links). Fixture logs, keys
// and directories made here, in temp dirs; no network, no real state.
//
// The calls take their options as plain objects (`sign`, `rotate` below) so this file also builds against the
// round-3 code, where it shows each route still open (the fail-without run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { createOwnerOnly } from '../src/os/index.js';
import { canonicalJson, keyId, keySigner, pae, PAYLOAD_TYPE, statementOf, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, rotateFile, signLog } from '../src/signed-receipts-store.js';
import { engineCli } from './helpers.js';

const POSIX = process.platform !== 'win32';
const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');

const sign = (o: Record<string, unknown>) => signLog(o as unknown as Parameters<typeof signLog>[0]);
const rotate = (o: Record<string, unknown>) => rotateFile(o as unknown as Parameters<typeof rotateFile>[0]);
const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 20_000 });

function keys(): { pub: KeyObject; signer: ReceiptSigner; privFile: string; pubFile: string } {
  const k = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'rk4-'));
  const privFile = join(dir, 'k.key');
  const pubFile = join(dir, 'k.pub');
  writeFileSync(privFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  writeFileSync(pubFile, k.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  return { pub: k.publicKey, signer: keySigner(k.privateKey), privFile, pubFile };
}

/** A coordinator's event log: one decision that merged, one held for the owner that then failed to merge. */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'r4-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
}

/** The signer's own chain state file, in a directory of its own (0700), away from the receipts. */
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rs4-')), 'chain-state.json');

/**
 * What someone who owns the log's database file does: drops the append-only trigger, and the held decision (the last
 * one) now says it merged on its own.
 */
function editHeldDecision(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare("UPDATE events SET payload = ? WHERE id = (SELECT max(id) FROM events WHERE type = 'merge.decided')").run(JSON.stringify({ issue: 8, number: 42, head: H2, auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}

const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

test('sign never writes through a link planted at a name beside --out: the old temp name <out>.<pid>.tmp (A11)', { skip: !POSIX && 'symlinks need privileges on Windows' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  // Stands in for any file the signer can write, its private key included.
  const victim = join(f.dir, 'victim.key');
  writeFileSync(victim, 'THE SIGNER KEY', { mode: 0o644 });
  const planted = `${out}.${process.pid}.tmp`;
  symlinkSync(victim, planted);
  const state = stateFile();
  sign({ log: f.path, out, signer: k.signer, state, genesis: true });
  assert.equal(readFileSync(victim, 'utf8'), 'THE SIGNER KEY', 'the receipts went into the planted link');
  assert.equal(lstatSync(victim).mode & 0o777, 0o644, 'the planted link target was chmod-ed');
  assert.ok(lstatSync(out).isFile(), '--out is a regular file, not the planted link');
  assert.ok(lstatSync(planted).isSymbolicLink(), 'the planted link is left as it was');
  assert.ok(verifyChain(readReceiptFiles(out), { keys: [k.pub] }).ok);
  // And over a receipts file that already exists.
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.equal(sign({ log: f.path, out, signer: k.signer, state }).added, 1);
  assert.equal(readFileSync(victim, 'utf8'), 'THE SIGNER KEY');
  assert.ok(lstatSync(out).isFile());
  assert.equal(lstatSync(out).mode & 0o777, 0o600);
});

test('receipts truncated, then the log edited after the cut: never signed again (A2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  assert.equal(sign({ log: f.path, out, signer: k.signer, state, genesis: true }).added, 5);
  const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
  writeFileSync(out, `${lines.slice(0, 3).join('\n')}\n`);
  editHeldDecision(f.path);
  const before = text(out);
  const stateBefore = text(state);
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state }), /chain head/);
  assert.equal(text(out), before, 'nothing was written');
  assert.equal(text(state), stateBefore, "the signer's chain head is unchanged");
  // Cut to nothing at all (an empty file): the same.
  writeFileSync(out, '');
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state }), /chain head/);
  assert.equal(text(out), '');
});

test('receipts deleted, then the log edited: never a new chain without --genesis (A3)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, signer: k.signer, state, genesis: true });
  unlinkSync(out);
  editHeldDecision(f.path);
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state }), /missing or empty.*chain head/);
  assert.ok(!existsSync(out), 'no new chain was started');
  // --genesis never starts over a chain the signer already has.
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state, genesis: true }), /already has a chain/);
  assert.ok(!existsSync(out));
});

test('a new chain only with --genesis, only where the signer has no chain, and never adopting receipts it finds (A3)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state }), /--genesis/);
  assert.ok(!existsSync(out) && !existsSync(state), 'nothing was written');
  // Receipts already at --out, but no state of the signer's own: someone else's file, never adopted.
  const other = keys();
  const elsewhere = stateFile();
  sign({ log: f.path, out, signer: other.signer, state: elsewhere, genesis: true });
  const before = text(out);
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state, genesis: true }), /never adopted/);
  assert.equal(text(out), before);
  assert.ok(!existsSync(state));
});

test('the log edited behind intact receipts is still refused with the chain state in place (pin)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, signer: k.signer, state, genesis: true });
  editHeldDecision(f.path);
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  const before = text(out);
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state }), /log changed/);
  assert.equal(text(out), before);
});

test('a retired start key cannot get a forged chain extended: the signer follows its own head, never --trust (A4)', () => {
  const f = fixtureLog();
  const s = keys();
  const k2 = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, signer: s.signer, state, genesis: true });
  rotate({ out, signer: s.signer, next: k2.pub, state, trust: [s.pub] });
  // After a rotation the new key signs on from the signer's own state, with nothing more to trust.
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.equal(sign({ log: f.path, out, signer: k2.signer, state, trust: [s.pub] }).added, 1);
  // The holder of the retired start key edits the log, signs a fresh chain over it and rotates it to the current key.
  editHeldDecision(f.path);
  const fake = join(mkdtempSync(join(tmpdir(), 'rf4-')), 'fake.jsonl');
  const forgerState = stateFile();
  sign({ log: f.path, out: fake, signer: s.signer, state: forgerState, genesis: true });
  rotate({ out: fake, signer: s.signer, next: k2.pub, state: forgerState, trust: [s.pub] });
  assert.ok(verifyChain(readReceiptFiles(fake), { keys: [s.pub] }).ok, 'the forged chain verifies from the start key on its own');
  copyFileSync(fake, out);
  f.log.append('merge.decided', { issue: 10, number: 44, head: sha('e'), auto: true, reasons: [] }, 'inst');
  const before = text(out);
  assert.throws(() => sign({ log: f.path, out, signer: k2.signer, state, trust: [s.pub] }), /chain head/);
  assert.equal(text(out), before, 'the forged chain was not extended');
});

test('receipts sign takes no --trust: a usage error, nothing signed (A4)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const r = cli('sign', '--log', f.path, '--key', k.privFile, '--out', out, '--trust', k.pubFile);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--trust/);
  assert.ok(!existsSync(out));
});

test("the signer's chain state lives apart from the receipts, in a directory only it can write", { skip: !POSIX && 'POSIX modes' }, () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  // Beside the receipts: whoever can write that directory could swap the state with the receipts.
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state: join(f.dir, 'chain-state.json'), genesis: true }), /separate/);
  // In a directory its group may write.
  const shared = mkdtempSync(join(tmpdir(), 'rg4-'));
  chmodSync(shared, 0o770);
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state: join(shared, 's.json'), genesis: true }), /only/);
  // A link at the state's name is never read or written through.
  const linked = mkdtempSync(join(tmpdir(), 'rl4-'));
  const real = stateFile();
  sign({ log: f.path, out, signer: k.signer, state: real, genesis: true });
  symlinkSync(real, join(linked, 's.json'));
  f.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.throws(() => sign({ log: f.path, out, signer: k.signer, state: join(linked, 's.json') }), /link/);
  assert.ok(!existsSync(join(f.dir, 'chain-state.json')) && !existsSync(join(shared, 's.json')));
});

/** A DSSE envelope over `st`, signed by `k` (what a key holder can make). */
function sealWith(k: { signer: ReceiptSigner; pub: KeyObject }, st: unknown): Envelope {
  const bytes = Buffer.from(canonicalJson(st), 'utf8');
  return { payloadType: PAYLOAD_TYPE, payload: bytes.toString('base64'), signatures: [{ keyid: keyId(k.pub), sig: k.signer.sign(pae(PAYLOAD_TYPE, bytes)).toString('base64') }] };
}

/** A signed chain of the fixture log, its envelopes, and a place for an auditor's copies. */
function chain(): { k: ReturnType<typeof keys>; envs: Envelope[]; dir: string } {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, signer: k.signer, state: stateFile(), genesis: true });
  return { k, envs: readReceiptFiles(out) as Envelope[], dir: mkdtempSync(join(tmpdir(), 'ra4-')) };
}

const lines = (envs: readonly Envelope[]) => `${envs.map((e) => canonicalJson(e)).join('\n')}\n`;
/** Any control character but the newline that ends each line, or a C1 control (U+0080-U+009F). */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const SPOOF = '\u001b[2K\r9 receipts verified: all good\u009b2K';

function assertPrintable(r: { stdout: string; stderr: string }, what: string): void {
  for (const [name, s] of [['stdout', r.stdout], ['stderr', r.stderr]] as const) {
    assert.doesNotMatch(s, CONTROL, `${what}: a raw control character in ${name}: ${JSON.stringify(s)}`);
    for (const line of s.split('\n')) assert.ok(!line.startsWith('9 receipts verified'), `${what}: a spoofed line in ${name}`);
  }
}

test('verify prints no untrusted control character: keyid, schema messages, file names, verified field and how (A5, A6)', () => {
  const c = chain();
  // The envelope's keyid (not signed).
  const keyid = [...c.envs];
  keyid[1] = { ...keyid[1]!, signatures: [{ ...keyid[1]!.signatures[0]!, keyid: SPOOF }] };
  writeFileSync(join(c.dir, 'keyid.jsonl'), lines(keyid));
  const r1 = cli('verify', join(c.dir, 'keyid.jsonl'), '--key', c.k.pubFile);
  assert.equal(r1.status, 1);
  assertPrintable(r1, 'keyid');
  assert.match(r1.stderr, /\\u001b/, 'the control character is shown, escaped');
  // A key the schema doesn't know (its message names the key; the schema is checked before the signature).
  const st = statementOf(c.envs[1]!) as Record<string, unknown>;
  const extra = [...c.envs];
  extra[1] = { ...extra[1]!, payload: Buffer.from(canonicalJson({ ...st, [SPOOF]: 1 }), 'utf8').toString('base64') };
  writeFileSync(join(c.dir, 'zod.jsonl'), lines(extra));
  const r2 = cli('verify', join(c.dir, 'zod.jsonl'), '--key', c.k.pubFile);
  assert.equal(r2.status, 1);
  assertPrintable(r2, 'schema message');
  // A file name in a receipts directory, named in the error for a line that isn't JSON.
  const named = mkdtempSync(join(tmpdir(), 'rn4-'));
  writeFileSync(join(named, `${SPOOF}.jsonl`), 'not json\n');
  const r3 = cli('verify', named, '--key', c.k.pubFile);
  assert.equal(r3.status, 1);
  assertPrintable(r3, 'file name');
  // The verified list's field and how, as a key holder can write them, in the summary and in a FLAGGED line.
  const verified = [c.envs[0]!, sealWith(c.k, { ...st, verified: [{ field: 'inputs.head', how: SPOOF, found: H2 }, { field: `x${SPOOF}`, how: 'git', found: 1 }] })];
  writeFileSync(join(c.dir, 'verified.jsonl'), lines(verified));
  const r4 = cli('verify', join(c.dir, 'verified.jsonl'), '--key', c.k.pubFile);
  assert.equal(r4.status, 3, r4.stdout + r4.stderr);
  assertPrintable(r4, 'verified field and how');
  assert.match(r4.stdout, /FLAGGED: receipt 2: inputs\.head/);
});

test('verify reads only regular files, under a size cap: never a FIFO, link or device (A7)', { skip: !POSIX && 'FIFOs and links' }, () => {
  const c = chain();
  writeFileSync(join(c.dir, '0001.jsonl'), lines(c.envs));
  assert.equal(cli('verify', c.dir, '--key', c.k.pubFile).status, 0, 'the plain copy verifies');
  // A FIFO named like a receipts file: refused at once, never waited on.
  const fifo = mkdtempSync(join(tmpdir(), 'rq4-'));
  copyFileSync(join(c.dir, '0001.jsonl'), join(fifo, '0001.jsonl'));
  execFileSync('mkfifo', [join(fifo, '0002.jsonl')]);
  const r1 = cli('verify', fifo, '--key', c.k.pubFile);
  assert.equal(r1.status, 1, `exit ${r1.status} (null: it hung): ${r1.stderr}`);
  assert.match(r1.stderr, /not a regular file/);
  // A link, in a directory or given itself.
  const linked = mkdtempSync(join(tmpdir(), 'rs4l-'));
  symlinkSync(join(c.dir, '0001.jsonl'), join(linked, '0001.jsonl'));
  const r2 = cli('verify', linked, '--key', c.k.pubFile);
  assert.equal(r2.status, 1, r2.stdout);
  assert.match(r2.stderr, /link/);
  const r3 = cli('verify', join(linked, '0001.jsonl'), '--key', c.k.pubFile);
  assert.equal(r3.status, 1, r3.stdout);
  assert.match(r3.stderr, /link/);
  // A device.
  const r4 = cli('verify', '/dev/null', '--key', c.k.pubFile);
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /not a regular file/);
  // Too big (sparse, so it costs no disk): refused from its size, before reading.
  const big = mkdtempSync(join(tmpdir(), 'rb4-'));
  writeFileSync(join(big, 'r.jsonl'), '');
  truncateSync(join(big, 'r.jsonl'), 64 * 1024 * 1024 + 1);
  const r5 = cli('verify', join(big, 'r.jsonl'), '--key', c.k.pubFile);
  assert.equal(r5.status, 1);
  assert.match(r5.stderr, /bytes, over/);
});

test('verify prints each unrecorded check with its receipt, field and found value, and says what a receipt proves', () => {
  const c = chain();
  const st = statementOf(c.envs[1]!) as Record<string, unknown>;
  const runs = [{ name: 'ci', id: 5, conclusion: 'failure' }];
  const envs = [c.envs[0]!, sealWith(c.k, { ...st, verified: [{ field: 'policy.commit', how: 'git', found: M1 }, { field: 'inputs.check_runs', how: 'github', found: runs }] })];
  writeFileSync(join(c.dir, 'u.jsonl'), lines(envs));
  const r = cli('verify', join(c.dir, 'u.jsonl'), '--key', c.k.pubFile);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /UNRECORDED: receipt 2: policy\.commit: .*"c{40}" \(git\)/);
  assert.match(r.stdout, /UNRECORDED: receipt 2: inputs\.check_runs: .*"conclusion":"failure".* \(github\)/);
  // The closing line: the key holder signed that the log said it; never that the log said it.
  assert.match(r.stdout, /key holder signed that the log said/);
  assert.doesNotMatch(r.stdout, /proves what the log said/);
});

test('createOwnerOnly refuses a staged key swapped for a hard link to a same-content file (round 3 advisory)', { skip: !POSIX && 'POSIX modes and links' }, () => {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'rh4-'));
  const file = join(dir, 'k');
  const data = 'KEY BYTES\n';
  // The racer's own file, holding the same bytes, readable by everyone.
  const theirs = join(dir, 'theirs');
  writeFileSync(theirs, data);
  chmodSync(theirs, 0o644);
  const real = fs.linkSync;
  fs.linkSync = ((from: string, to: string) => {
    // Between staging and publishing: the staged name becomes a second name of the racer's file.
    if (to === file) {
      fs.unlinkSync(from);
      real(theirs, from);
    }
    real(from, to);
  }) as typeof fs.linkSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => createOwnerOnly(file, data));
  } finally {
    fs.linkSync = real;
    syncBuiltinESMExports();
  }
  assert.ok(!existsSync(file), 'the swapped file is not left as the key');
  assert.equal(readFileSync(theirs, 'utf8'), data);
});
