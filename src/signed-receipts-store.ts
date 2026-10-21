// Signed receipts on disk (#717): the event log read read-only, the receipts as JSON lines (one DSSE envelope each),
// and ed25519 keys as PEM files. The format and the checks are src/signed-receipts.ts.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnly } from './events/read-only.js';
import { writeOwnerOnly } from './os/index.js';
import { canonicalJson, keySigner, ReceiptError, RECEIPT_EVENTS, rotateChain, signEvents, verifyChain, type Envelope, type ReceiptEvent, type ReceiptSigner } from './signed-receipts.js';

/** The events receipts are made from, oldest first, from an events database opened read-only. */
export function readReceiptEvents(dbPath: string): ReceiptEvent[] {
  if (!existsSync(dbPath)) throw new ReceiptError(`no event log at ${dbPath}`);
  const db = openReadOnly(dbPath);
  try {
    const rows = db.prepare(`SELECT id, ts, type, actor, payload FROM events WHERE type IN (${RECEIPT_EVENTS.map(() => '?').join(',')}) ORDER BY id`).all(...RECEIPT_EVENTS) as { id: number; ts: string; type: string; actor: string; payload: string }[];
    return rows.map((r) => ({ id: Number(r.id), ts: r.ts, type: r.type, actor: r.actor, payload: JSON.parse(r.payload) as unknown }));
  } finally {
    db.close();
  }
}

/**
 * The receipts in a file (JSON lines), or in a directory's *.jsonl files in name order, as one chain. A missing file
 * is no receipts (a chain not started yet). A line that isn't JSON throws, naming it.
 */
export function readReceiptFiles(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => join(path, f))
    : [path];
  return files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          throw new ReceiptError(`${file}:${i + 1} is not JSON`);
        }
      }),
  );
}

function writeReceipts(path: string, envelopes: readonly Envelope[]): void {
  writeOwnerOnly(path, `${envelopes.map((e) => canonicalJson(e)).join('\n')}\n`);
}

/** An ed25519 private key from a PEM file, as a signer. */
export function loadSigner(path: string): ReceiptSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ReceiptError(`${path} is not a readable private key (${(e as Error).message.split('\n')[0]})`);
  }
  return keySigner(key);
}

/** An ed25519 public key from a PEM file. A private key is refused: a verifier is never handed one. */
export function loadPublicKey(path: string): KeyObject {
  const text = readFileSync(path, 'utf8');
  if (/PRIVATE KEY/.test(text)) throw new ReceiptError(`${path} is a private key: verify takes the public key (keygen's --public file)`);
  let key: KeyObject;
  try {
    key = createPublicKey(text);
  } catch (e) {
    throw new ReceiptError(`${path} is not a readable public key (${(e as Error).message.split('\n')[0]})`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new ReceiptError(`${path} is not an ed25519 key`);
  return key;
}

/**
 * Receipt every merge decision and result in the log not yet receipted, onto the chain in `out` (started there when
 * the file is missing). Writes nothing when there is nothing new, or when it refuses (src/signed-receipts.ts).
 */
export function signLog(o: { log: string; out: string; signer: ReceiptSigner; trust?: readonly KeyObject[] }): { added: number; count: number; head: string | null } {
  const existing = readReceiptFiles(o.out);
  const r = signEvents(existing, readReceiptEvents(o.log), o.signer, { ...(o.trust ? { trust: o.trust } : {}) });
  if (r.added) writeReceipts(o.out, r.envelopes);
  return { added: r.added, count: r.envelopes.length, head: r.head };
}

/** Rotate the chain in `out` to `next`, signed by the current key. */
export function rotateFile(o: { out: string; signer: ReceiptSigner; next: KeyObject; trust?: readonly KeyObject[] }): { count: number; head: string | null } {
  const trust = o.trust?.length ? o.trust : [o.signer.publicKey];
  const envelopes = rotateChain(readReceiptFiles(o.out), o.signer, o.next, { trust });
  writeReceipts(o.out, envelopes);
  const r = verifyChain(envelopes, { keys: trust });
  return { count: envelopes.length, head: r.ok ? r.head : null };
}
