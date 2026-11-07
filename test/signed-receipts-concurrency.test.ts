// Signed receipts, #918 round 5: no signed receipt the signer's state doesn't cover, and one signer at a time. A
// failure between the two writes (state, receipts) never lets a cut receipts file and an edited log be signed again
// (row 1 of the round-4 review); a second `sign` while one runs is refused, and a state changed under a run is
// refused (row 2); every error `sign` prints is escaped; a missing --state is a usage error; --genesis never replaces
// anything at --out; the state's place is compared by real path. Fixture logs, keys and directories made here, in temp
// dirs; no network, no real state.
//
// The calls take their options as plain objects, so this file also builds against the round-4 code (the fail-without
// run). Failures and interleavings are forced by wrapping node:fs functions for one call (syncBuiltinESMExports), as
// the reviewers' probes did; no repo file is changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, keySigner, receiptId, verifyChain, type Envelope, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';
import { engineCli } from './helpers.js';

const POSIX = process.platform !== 'win32';
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');

/** The signer's chain registry for each log (round 12: a registry holds one first chain, for one log), unless a test gives its own. */
const registries = new Map<unknown, string>();
const registryFor = (log: unknown) => registries.get(log) ?? registries.set(log, join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl')).get(log)!;
const sign = (o: Record<string, unknown>) => signLog({ ...(o.genesis ? { registry: registryFor(o.log) } : {}), ...o } as unknown as Parameters<typeof signLog>[0]);
const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 20_000 });
const text = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
/** Any control character but the newline that ends each line. */
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

function keys(): { pub: KeyObject; signer: ReceiptSigner; privFile: string; pubFile: string } {
  const k = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'rk5-'));
  const privFile = join(dir, 'k.key');
  const pubFile = join(dir, 'k.pub');
  writeFileSync(privFile, k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  writeFileSync(pubFile, k.publicKey.export({ type: 'spki', format: 'pem' }).toString());
  return { pub: k.publicKey, signer: keySigner(k.privateKey), privFile, pubFile };
}

/** A log with one decision that merged; `held` adds a decision held for the owner and its failed merge. */
function fixtureLog(): { dir: string; path: string; log: EventLog; held: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'r5-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  const held = () => {
    log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'] }, 'inst');
    log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  };
  return { dir, path, log, held };
}

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rs5-')), 'chain-state.json');

/** Whoever owns the log's database file: drops the append-only trigger and flips the held decision to auto. */
function editHeldDecision(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.prepare("UPDATE events SET payload = ? WHERE id = (SELECT max(id) FROM events WHERE type = 'merge.decided')").run(JSON.stringify({ issue: 8, number: 42, head: H2, auto: true, reasons: [] }));
  } finally {
    db.close();
  }
}

/** Run `fn` with node:fs's `name` wrapped (`wrap` gets the real one), put back afterwards. */
function withFs<K extends 'renameSync' | 'openSync' | 'fsyncSync'>(name: K, wrap: (real: (typeof fs)[K]) => (typeof fs)[K], fn: () => void): void {
  const real = fs[name];
  (fs as Record<K, (typeof fs)[K]>)[name] = wrap(real);
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    (fs as Record<K, (typeof fs)[K]>)[name] = real;
    syncBuiltinESMExports();
  }
}

/** Run `fn` with the second of the two publishing writes (a rename onto `out` or `state`) failing, as a crash would. */
function secondWriteFails(out: string, state: string, fn: () => void): void {
  let published = 0;
  withFs(
    'renameSync',
    (real) =>
      ((from: string, to: string) => {
        if ((to === out || to === state) && ++published === 2) throw Object.assign(new Error('simulated failure of the second write'), { code: 'EIO' });
        real(from, to);
      }) as typeof fs.renameSync,
    fn,
  );
}

/**
 * Run `fn`, calling `during` once, right after the signer opens `out` to read it: it has read its state and holds the
 * receipts as they were, and has not read the log or written anything yet.
 */
function duringRead(out: string, during: () => void, fn: () => void): void {
  let fired = false;
  withFs(
    'openSync',
    (real) =>
      ((path: string, ...rest: unknown[]) => {
        const fd = (real as (...a: unknown[]) => number)(path, ...rest);
        if (path === out && !fired) {
          fired = true;
          during();
        }
        return fd;
      }) as typeof fs.openSync,
    fn,
  );
}

test('a failed second write, then the receipts cut back and the log edited: never signed again (round 4 review, row 1)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  assert.equal(sign({ log: f.path, out, state, genesis: true, signer: k.signer }).added, 3);
  const published = readFileSync(out, 'utf8');
  f.held();
  secondWriteFails(out, state, () => assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /simulated failure/));
  // Whoever writes the receipts and the log: back to what the first run published, and the held decision flipped.
  writeFileSync(out, published);
  editHeldDecision(f.path);
  const before = [text(out), text(state)];
  assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /chain head/);
  assert.deepEqual([text(out), text(state)], before, 'nothing was written');
});

test('a failed second write and nothing edited: the next sign publishes the very receipts the state names (pin)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  secondWriteFails(out, state, () => assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /simulated failure/));
  sign({ log: f.path, out, state, signer: k.signer });
  const envs = readReceiptFiles(out) as Envelope[];
  assert.ok(verifyChain(envs, { keys: [k.pub] }).ok);
  assert.equal(envs.length, 5);
  const own = JSON.parse(readFileSync(state, 'utf8')) as { count: number; head: string };
  assert.deepEqual([own.count, own.head], [5, receiptId(envs.at(-1)!)]);
});

test('a second sign while one runs is refused, so the log edited between their reads is never signed both ways (row 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  let second: unknown = 'not run';
  duringRead(
    out,
    () => {
      try {
        sign({ log: f.path, out, state, signer: k.signer });
        second = 'signed';
      } catch (e) {
        second = e;
      }
      // Between the two runs' reads of the log: the held decision flipped.
      editHeldDecision(f.path);
    },
    () => sign({ log: f.path, out, state, signer: k.signer }),
  );
  assert.ok(second instanceof Error && /another sign/.test(second.message), `the second run: ${String(second)}`);
  const envs = readReceiptFiles(out) as Envelope[];
  assert.ok(verifyChain(envs, { keys: [k.pub] }).ok);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).head, receiptId(envs.at(-1)!), 'the receipts and the state agree');
});

test('a state changed after the signer read it is refused, nothing written (a stale read, row 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  // Another state, valid on its own terms: what another writer, one that took no lock, would leave.
  const other = fixtureLog();
  const otherState = stateFile();
  // (Its own registry: this key started a chain in this file's registry already.)
  sign({ log: other.path, out: join(other.dir, 'r.jsonl'), state: otherState, genesis: true, registry: join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl'), signer: k.signer });
  const replaced = readFileSync(otherState, 'utf8');
  f.held();
  const published = readFileSync(out, 'utf8');
  duringRead(
    out,
    () => writeFileSync(state, replaced),
    () => assert.throws(() => sign({ log: f.path, out, state, signer: k.signer }), /changed/),
  );
  assert.equal(text(out), published, 'the receipts were not written');
  assert.equal(text(state), replaced, 'the state was not written over');
});

test('receipts sign and rotate: --trust and a missing --state are usage errors (exit 2)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const noState = cli('sign', '--log', f.path, '--key', k.privFile, '--out', out);
  assert.equal(noState.status, 2, noState.stderr);
  assert.match(noState.stderr, /--state/);
  const rotate = cli('rotate', '--out', out, '--key', k.privFile, '--next', keys().pubFile, '--state', stateFile(), '--trust', k.pubFile);
  assert.equal(rotate.status, 2, rotate.stderr);
  assert.match(rotate.stderr, /takes no --trust/);
  assert.ok(!existsSync(out));
});

test('every error sign prints is escaped: an ESC/CR name in --out it cannot read', { skip: (!POSIX || process.getuid?.() === 0) && 'POSIX permissions, not root' }, () => {
  const f = fixtureLog();
  const k = keys();
  // A signer with a chain of its own, then pointed at a receipts directory whose entry it can't stat.
  const state = stateFile();
  sign({ log: f.path, out: join(f.dir, 'r.jsonl'), state, genesis: true, signer: k.signer });
  const out = mkdtempSync(join(tmpdir(), 'rd5-'));
  writeFileSync(join(out, '\u001b[2K\r0 receipts: all good.jsonl'), '');
  chmodSync(out, 0o400);
  try {
    const r = cli('sign', '--log', f.path, '--key', k.privFile, '--out', out, '--state', state);
    assert.equal(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, CONTROL, JSON.stringify(r.stderr));
  } finally {
    chmodSync(out, 0o700);
  }
});

test('--genesis never replaces anything at --out, even a file of blank lines', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  writeFileSync(out, '\n\n');
  assert.throws(() => sign({ log: f.path, out, state: stateFile(), genesis: true, signer: k.signer }), /--out/);
  assert.equal(text(out), '\n\n');
});

test("the state's place is compared by real path: --out through a link to the state's directory is refused", { skip: !POSIX && 'symlinks' }, () => {
  const f = fixtureLog();
  const k = keys();
  const state = stateFile();
  const alias = join(mkdtempSync(join(tmpdir(), 'rl5-')), 'alias');
  symlinkSync(join(state, '..'), alias);
  assert.throws(() => sign({ log: f.path, out: join(alias, 'r.jsonl'), state, genesis: true, signer: k.signer }), /separate/);
  assert.ok(!existsSync(join(state, '..', 'r.jsonl')));
});

test('verify escapes format and default-ignorable characters too (zero-width, BOM, soft hyphen, Hangul fillers)', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  sign({ log: f.path, out, state: stateFile(), genesis: true, signer: k.signer });
  const envs = readReceiptFiles(out) as Envelope[];
  const odd = String.fromCodePoint(0x200b, 0xfeff, 0x2060, 0xad, 0x34f, 0x115f, 0x3164, 0x202e);
  envs[1] = { ...envs[1]!, signatures: [{ ...envs[1]!.signatures[0]!, keyid: `x${odd}y` }] };
  const file = join(mkdtempSync(join(tmpdir(), 'rv5-')), 'r.jsonl');
  writeFileSync(file, `${envs.map((e) => canonicalJson(e)).join('\n')}\n`);
  const r = cli('verify', file, '--key', k.pubFile);
  assert.equal(r.status, 1);
  for (const c of odd) assert.ok(!r.stderr.includes(c), `U+${c.codePointAt(0)!.toString(16)} printed raw`);
  assert.match(r.stderr, /x\\u200b\\ufeff\\u2060\\u00ad\\u034f\\u115f\\u3164\\u202ey/);
});

test('the state is on disk (fsync) before the receipts it names are written, so a power loss keeps it ahead', () => {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  sign({ log: f.path, out, state, genesis: true, signer: k.signer });
  f.held();
  const opened = new Map<number, string>();
  const seen: string[] = [];
  withFs(
    'openSync',
    (real) => ((path: string, ...rest: unknown[]) => {
      const fd = (real as (...a: unknown[]) => number)(path, ...rest);
      opened.set(fd, String(path));
      return fd;
    }) as typeof fs.openSync,
    () =>
      withFs(
        'fsyncSync',
        (real) => ((fd: number) => {
          seen.push(`fsync ${opened.get(fd)}`);
          real(fd);
        }) as typeof fs.fsyncSync,
        () =>
          withFs(
            'renameSync',
            (real) => ((from: string, to: string) => {
              if (to === out || to === state) seen.push(`publish ${to}`);
              real(from, to);
            }) as typeof fs.renameSync,
            () => sign({ log: f.path, out, state, signer: k.signer }),
          ),
      ),
  );
  const synced = seen.indexOf(`fsync ${state}`);
  assert.ok(synced >= 0 && synced > seen.indexOf(`publish ${state}`) && synced < seen.indexOf(`publish ${out}`), seen.join('; '));
  // And its directory, so the rename that put it there is on disk too (round 6 advisory).
  const dirSynced = seen.indexOf(`fsync ${dirname(state)}`);
  assert.ok(dirSynced > seen.indexOf(`publish ${state}`) && dirSynced < seen.indexOf(`publish ${out}`), seen.join('; '));
});
