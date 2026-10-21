// `<cli> receipts keygen | sign | rotate | verify` (#717): signed receipts from the command line. verify needs only
// the receipts and the public key: no engine state, no network, no instance.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { BRAND } from './brand.js';
import { createOwnerOnly } from './os/index.js';
import { fieldChecks, keyId, ReceiptError, verifyChain } from './signed-receipts.js';
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
  `       ${BRAND.cli} receipts sign --log <events.db> --key <private> --out <file> [--trust <start pub>]...`,
  `       ${BRAND.cli} receipts rotate --out <file> --key <current private> --next <new public> [--trust <start pub>]...`,
].join('\n');

/** Every value of option `name`, taken out of `args`. */
function values(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) {
    const v = args[i + 1];
    args.splice(i, 2);
    if (v === undefined || v.startsWith('--')) throw new ReceiptError(`${name} needs a value`);
    out.push(v);
  }
  return out;
}

function one(args: string[], name: string): string {
  const v = values(args, name);
  if (v.length !== 1) throw new ReceiptError(`give ${name} once`);
  return v[0]!;
}

class Usage extends Error {}

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
        console.log(`receipt key ${keyId(k.publicKey)}: private ${priv} (0600; give it only to the signer), public ${pub} (give it to auditors)`);
        return 0;
      }
      case 'sign': {
        const log = one(args, '--log');
        const key = one(args, '--key');
        const out = one(args, '--out');
        const trust = values(args, '--trust').map(loadPublicKey);
        done(args);
        const signer = loadSigner(key);
        const r = signLog({ log, out, signer, trust });
        console.log(`${r.added} new receipts signed with key ${keyId(signer.publicKey)}; ${r.count} in the chain, head ${r.head ?? 'none'}`);
        console.log(NOT_ROOT_SIGNED);
        return 0;
      }
      case 'rotate': {
        const out = one(args, '--out');
        const key = one(args, '--key');
        const next = one(args, '--next');
        const trust = values(args, '--trust').map(loadPublicKey);
        done(args);
        const nextKey = loadPublicKey(next);
        const r = rotateFile({ out, signer: loadSigner(key), next: nextKey, trust });
        console.log(`the chain in ${out} now continues under key ${keyId(nextKey)} (${r.count} receipts, head ${r.head ?? 'none'}); sign with its private key from now on`);
        console.log(NOT_ROOT_SIGNED);
        return 0;
      }
      default:
        throw new Usage();
    }
  } catch (e) {
    if (e instanceof Usage) {
      console.error(USAGE);
      return 2;
    }
    if (e instanceof ReceiptError) {
      console.error(`${BRAND.cli} receipts: ${e.message}`);
      return 1;
    }
    throw e;
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
    console.error(`${(e as Error).message}\n${USAGE}`);
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
    console.error(`${BRAND.cli} receipts verify: --anchor takes a receipt id (64 lowercase hex characters, as verify prints the head), not ${JSON.stringify(anchor[0]!.slice(0, 80))}`);
    return 2;
  }
  let keys;
  try {
    keys = paths.map(loadPublicKey);
  } catch (e) {
    console.error(`${BRAND.cli} receipts verify: ${(e as Error).message}`);
    return 2;
  }
  if (!existsSync(target)) {
    console.error(`FAILED: no receipts at ${target}`);
    return 1;
  }
  let envelopes: unknown[];
  try {
    envelopes = readReceiptFiles(target);
  } catch (e) {
    console.error(`FAILED: ${(e as Error).message}`);
    return 1;
  }
  const r = verifyChain(envelopes, { keys, ...(anchor.length ? { anchor: anchor[0]! } : {}) });
  if (!r.ok) {
    console.error(r.index < envelopes.length ? `FAILED: receipt ${r.index + 1} of ${envelopes.length}: ${r.problem}` : `FAILED: ${r.problem}`);
    return 1;
  }
  const kinds = new Map<string, number>();
  for (const s of r.statements) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  console.log(`${r.count} receipts verified: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  console.log(`keys, in order: ${r.keys.join(' -> ')}`);
  console.log(`head (keep it, and pass it as --anchor next time to catch a dropped tail): ${r.head}`);
  // VERIFIES vs ATTESTS (docs/design.md §5a): what the signer checked itself, and every other field only attested.
  const checks = r.statements.flatMap((s, i) => fieldChecks(s).map((c) => ({ ...c, receipt: i + 1 })));
  const flagged = checks.filter((c) => c.result === 'mismatch');
  if (!checks.length) console.log("verified independently by the signer: none. Every field is attested: the coordinator's claim as its log recorded it, signed as such");
  else {
    const fields = [...new Set(checks.map((c) => `${c.field} (${c.how})`))];
    console.log(`verified independently by the signer: ${checks.length} field checks, of ${fields.join(', ')}; every other field is attested (the coordinator's claim as its log recorded it)`);
  }
  for (const c of flagged) console.log(`FLAGGED: receipt ${c.receipt}: ${c.field}: the coordinator claimed ${JSON.stringify(c.claimed).slice(0, 100)}, the signer found ${JSON.stringify(c.found).slice(0, 100)} (${c.how})`);
  console.log('A receipt proves what the log said and in what order, signed by the chain key; never that an attested field was true.');
  return flagged.length ? EXIT_FLAGGED : 0;
}
