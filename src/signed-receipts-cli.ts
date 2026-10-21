// `<cli> receipts keygen | sign | rotate | verify` (#717): signed receipts from the command line. verify needs only
// the receipts and the public key: no engine state, no network, no instance.
import { generateKeyPairSync } from 'node:crypto';
import { lstatSync, rmSync } from 'node:fs';
import { BRAND } from './brand.js';
import { createOwnerOnly } from './os/index.js';
import { AT_UNRECORDED, fieldChecks, keyId, ReceiptError, verifyChain } from './signed-receipts.js';
import { loadPublicKey, loadSigner, readReceiptFiles, rotateFile, signLog } from './signed-receipts-store.js';

/** Said by every signing command until the separate signer user exists (docs/design.md §5a, decision C, slice 3). */
export const NOT_ROOT_SIGNED = `not yet root-signed: this signed with the key file you passed, as the user you ran it as; nothing installs the separate signer user the coordinator can't become yet (#717 slice 3). Every field is attested, none verified by the signer`;

/** A receipt id, as `--anchor` takes it: the SHA-256 of a payload, lowercase hex. */
const RECEIPT_ID = /^[0-9a-f]{64}$/;

/** Exit code of verify when every receipt is authentic but the signer flagged a field it found different. */
export const EXIT_FLAGGED = 3;

/** Whether anything, a dangling link included, is at `path`. */
const taken = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Create a key file exclusively (createOwnerOnly); a name taken meanwhile (EEXIST) is refused, as one taken before. */
function createKeyFile(path: string, data: string) {
  try {
    createOwnerOnly(path, data);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST' || (e as NodeJS.ErrnoException).code === 'ELOOP') throw new ReceiptError(`${path} exists (or is a link): never overwritten, never written through`);
    throw e;
  }
}

const USAGE = [
  `usage: ${BRAND.cli} receipts verify <file|dir> --key <pub> [--key <pub>]... [--anchor <receipt id>]`,
  `       ${BRAND.cli} receipts keygen --private <file> --public <file>`,
  `       ${BRAND.cli} receipts sign --log <events.db> --key <private> --out <file> --state <file> [--genesis --registry <file> [--after <ended chain's state or receipts>]]`,
  `       ${BRAND.cli} receipts rotate --out <file> --key <current private> --next <new public> --state <file>`,
].join('\n');

/**
 * What a terminal may act on or not show, by Unicode property, the set src/path-text.ts's shownPath escapes (#918
 * round 5): control characters (Cc: C0, the newline included, DEL and C1), format characters (Cf: the bidi marks,
 * embeddings, overrides and isolates, zero-width characters, the BOM, the soft hyphen), default-ignorable code points
 * (U+034F, the Hangul fillers, the variation selectors), the line and paragraph separators, and lone surrogates.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\p{Cs}]/gu;

/**
 * `s` as one line no terminal acts on, with nothing hidden: every UNPRINTABLE code point is written as `\uXXXX` (or
 * `\u{XXXXX}` past U+FFFF). WHY (#918 rounds 4 and 5, A5/A6): verify prints text from the receipts and the file
 * system (a keyid, a schema message naming a key, a file name, a verified field), and an ESC or CR in it could clear
 * the line and print a false "verified". Everything these commands print but the usage text goes through it.
 */
export function printable(s: string): string {
  return s.replace(UNPRINTABLE, (ch) => {
    const c = ch.codePointAt(0)!;
    return c > 0xffff ? `\\u{${c.toString(16)}}` : `\\u${c.toString(16).padStart(4, '0')}`;
  });
}
const say = (line: string) => console.log(printable(line));
const warn = (line: string) => console.error(printable(line));

/** Every value of option `name`, taken out of `args`. */
function values(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1];
    args.splice(i, 2);
    // A usage error (exit 2), as a missing option is (#918 round 6, 3b).
    if (v === undefined || v.startsWith('--')) throw new Usage(`${name} needs a value`);
    out.push(v);
  }
  return out;
}

/** A usage error: its message (if any), then the usage, exit 2. */
class Usage extends Error {}

/** The one value of option `name`; missing or given twice is a usage error. */
function one(args: string[], name: string): string {
  const v = values(args, name);
  if (v.length !== 1) throw new Usage(`give ${name} once`);
  return v[0]!;
}

/** Whether flag `name` (no value) was given, taken out of `args`. */
function flag(args: string[], name: string): boolean {
  const had = args.includes(name);
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) args.splice(i, 1);
  return had;
}

/**
 * WHY (#918 round 4, A4): a signer trusts only the start key its own chain state names. `--trust <key>` let a chain
 * that any holder of a retired start key signed and rotated to this key be extended, so it is refused, never ignored.
 */
function noTrust(args: string[], sub: string): void {
  if (args.includes('--trust')) throw new Usage(`receipts ${sub} takes no --trust: the signer trusts only the start key its own chain state (--state) names. An auditor passes start keys to verify, as --key`);
}

export async function receiptsCommand(sub: string | undefined, rest: string[]): Promise<number> {
  const args = [...rest];
  try {
    switch (sub) {
      case 'verify':
        return verify(args);
      case 'keygen': {
        const priv = one(args, '--private');
        const pub = one(args, '--public');
        done(args);
        if (priv === pub) throw new ReceiptError('--private and --public are the same file');
        for (const f of [priv, pub]) if (taken(f)) throw new ReceiptError(`${f} exists (or is a link): never overwritten, never written through (a key in use would be lost)`);
        const k = generateKeyPairSync('ed25519');
        createKeyFile(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
        try {
          createKeyFile(pub, k.publicKey.export({ type: 'spki', format: 'pem' }).toString());
        } catch (e) {
          // WHY: a private key without its public half is a key nobody can check; the file is the one made just above.
          rmSync(priv, { force: true });
          throw e;
        }
        say(`receipt key ${keyId(k.publicKey)}: private ${priv} (0600; give it only to the signer), public ${pub} (give it to auditors)`);
        return 0;
      }
      case 'sign': {
        noTrust(args, 'sign');
        const genesis = flag(args, '--genesis');
        const log = one(args, '--log');
        const key = one(args, '--key');
        const out = one(args, '--out');
        const state = one(args, '--state');
        const after = values(args, '--after');
        if (after.length > 1) throw new Usage('give --after once');
        const registry = values(args, '--registry');
        if (registry.length > 1) throw new Usage('give --registry once');
        if (genesis !== (registry.length === 1)) throw new Usage('--genesis and --registry go together: a new chain is recorded in the signer\'s registry, an existing one names its registry in its state');
        done(args);
        const signer = loadSigner(key);
        const r = signLog({ log, out, state, signer, ...(genesis ? { genesis, registry: registry[0]! } : {}), ...(after.length ? { after: after[0]! } : {}) });
        say(`${r.added} new receipts signed with key ${keyId(signer.publicKey)}; ${r.count} in the chain, head ${r.head ?? 'none'}`);
        // WHY (#918 round 12): a merge event the signer couldn't read, or a time it couldn't keep, is said every time,
        // never only counted by verify.
        say(`of the new receipts, ${r.unsignable} event.unsignable (a merge event the signer couldn't read as a decision or result) and ${r.unrecorded} with at "unrecorded" (the log's time was empty or past the bound); verify lists each`);
        say(NOT_ROOT_SIGNED);
        return 0;
      }
      case 'rotate': {
        noTrust(args, 'rotate');
        const out = one(args, '--out');
        const key = one(args, '--key');
        const next = one(args, '--next');
        const state = one(args, '--state');
        done(args);
        const nextKey = loadPublicKey(next);
        const r = rotateFile({ out, state, signer: loadSigner(key), next: nextKey });
        say(`the chain in ${out} now continues under key ${keyId(nextKey)} (${r.count} receipts, head ${r.head ?? 'none'}); sign with its private key from now on`);
        say(NOT_ROOT_SIGNED);
        return 0;
      }
      default:
        throw new Usage();
    }
  } catch (e) {
    if (e instanceof Usage) {
      if (e.message) warn(`${BRAND.cli} receipts: ${e.message}`);
      console.error(USAGE);
      return 2;
    }
    // WHY (#918 round 5): any other error (a file system error naming a path from --out's directory) is printed the
    // same way, escaped, rather than as a raw stack: no untrusted name reaches the terminal unescaped.
    warn(`${BRAND.cli} receipts: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function done(args: string[]) {
  if (args.length) throw new Usage();
}

function verify(args: string[]): number {
  let paths: string[];
  let anchor: string[];
  try {
    paths = values(args, '--key');
    anchor = values(args, '--anchor');
  } catch (e) {
    warn((e as Error).message);
    console.error(USAGE);
    return 2;
  }
  const [target, ...extra] = args;
  if (!target || extra.length || !paths.length || anchor.length > 1) {
    console.error(USAGE);
    return 2;
  }
  // WHY (#918 round 2): an anchor given is always checked. An empty one (an unset variable in a script) or a
  // malformed one is a usage error, never a check quietly skipped.
  if (anchor.length && !RECEIPT_ID.test(anchor[0]!)) {
    warn(`${BRAND.cli} receipts verify: --anchor takes a receipt id (64 lowercase hex characters, as verify prints the head), not ${JSON.stringify(anchor[0]!.slice(0, 80))}`);
    return 2;
  }
  let keys;
  try {
    keys = paths.map(loadPublicKey);
  } catch (e) {
    warn(`${BRAND.cli} receipts verify: ${(e as Error).message}`);
    return 2;
  }
  if (!taken(target)) {
    warn(`FAILED: no receipts at ${target}`);
    return 1;
  }
  let envelopes: unknown[];
  try {
    envelopes = readReceiptFiles(target);
  } catch (e) {
    warn(`FAILED: ${(e as Error).message}`);
    return 1;
  }
  const r = verifyChain(envelopes, { keys, ...(anchor.length ? { anchor: anchor[0]! } : {}) });
  if (!r.ok) {
    warn(r.index < envelopes.length ? `FAILED: receipt ${r.index + 1} of ${envelopes.length}: ${r.problem}` : `FAILED: ${r.problem}`);
    return 1;
  }
  const kinds = new Map<string, number>();
  for (const s of r.statements) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  say(`${r.count} receipts verified: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  say(`keys, in order: ${r.keys.join(' -> ')}`);
  say(`head (keep it, and pass it as --anchor next time to catch a dropped tail): ${r.head}`);
  // VERIFIES vs ATTESTS (docs/design.md §5a): what the signer checked itself, and every other field only attested.
  const checks = r.statements.flatMap((s, i) => fieldChecks(s).map((c) => ({ ...c, receipt: i + 1 })));
  const flagged = checks.filter((c) => c.result === 'mismatch');
  const unrecorded = checks.filter((c) => c.result === 'unrecorded');
  if (!checks.length) say("verified independently by the signer: none. Every field is attested: the coordinator's claim as its log recorded it, signed as such");
  else {
    const fields = [...new Set(checks.map((c) => `${c.field} (${c.how})`))];
    say(`verified independently by the signer: ${checks.length} field checks, of ${fields.join(', ')}; every other field is attested (the coordinator's claim as its log recorded it)`);
    if (unrecorded.length) say(`of those, ${unrecorded.length} the deciding engine didn't record (null): the signer's value is the only one, not a mismatch`);
  }
  say("a verified list is the key holder's word: verify checks who signed, not which program did the checking");
  const value = (v: unknown) => JSON.stringify(v).slice(0, 100);
  // WHY (#918 round 3 advisory): an unrecorded check is shown, not only counted, so the signer's value is seen.
  for (const c of unrecorded) say(`UNRECORDED: receipt ${c.receipt}: ${c.field}: the deciding engine recorded null; the signer found ${value(c.found)} (${c.how})`);
  for (const c of flagged) say(`FLAGGED: receipt ${c.receipt}: ${c.field}: the coordinator claimed ${value(c.claimed)}, the signer found ${value(c.found)} (${c.how})`);
  // WHY (#918 round 12, the round-11 delta check's 3.5): a receipt the signer made for what it couldn't read is shown,
  // one line each, as a flag is, not only counted. Its `type` is the log's, its `problem` the signing tool's reading.
  for (const [i, s] of r.statements.entries()) {
    if (s.kind === 'event.unsignable') say(`UNSIGNABLE: receipt ${i + 1}: event ${s.event} (${s.type}): ${s.problem}; no decision or result was read from it (log.digest binds the event as stored)`);
    if ((s.kind === 'merge.decided' || s.kind === 'merge.result' || s.kind === 'event.unsignable') && s.at === AT_UNRECORDED) {
      const cut = s.cut.at;
      say(`UNRECORDED TIME: receipt ${i + 1}: event ${s.event}: at is "${AT_UNRECORDED}": ${cut ? `the log's time was ${cut.length ? `past the bound (${cut.length} characters)` : 'empty'}, so the signer kept none of it` : 'the log said so itself'}`);
    }
  }
  say("A receipt proves only that the chain's key holder signed that the log said this, in this order; never that the log said it, or that an attested field was true.");
  return flagged.length ? EXIT_FLAGGED : 0;
}
