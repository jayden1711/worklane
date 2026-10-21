// `<cli> receipts keygen | sign | rotate | verify` (#717): signed receipts from the command line. verify needs only
// the receipts and the public key: no engine state, no network, no instance.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { BRAND } from './brand.js';
import { writeOwnerOnly } from './os/index.js';
import { keyId, ReceiptError, verifyChain } from './signed-receipts.js';
import { loadPublicKey, loadSigner, readReceiptFiles, rotateFile, signLog } from './signed-receipts-store.js';

/** Said by every signing command until the root-owned signer exists (docs/design.md §5a, slice 3). */
export const NOT_ROOT_SIGNED = `not yet root-signed: this signed with the key file you passed, as the user you ran it as; nothing installs a signer the coordinator can't reach yet (#717)`;

const USAGE = [
  `usage: ${BRAND.cli} receipts verify <file|dir> --key <pub> [--key <pub>]... [--anchor <receipt id>]`,
  `       ${BRAND.cli} receipts keygen --private <file> --public <file>`,
  `       ${BRAND.cli} receipts sign --log <events.db> --key <private> --out <file>`,
  `       ${BRAND.cli} receipts rotate --out <file> --key <current private> --next <new public>`,
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
        for (const f of [priv, pub]) if (existsSync(f)) throw new ReceiptError(`${f} exists: never overwritten (a key in use would be lost)`);
        const k = generateKeyPairSync('ed25519');
        writeOwnerOnly(priv, k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
        writeOwnerOnly(pub, k.publicKey.export({ type: 'spki', format: 'pem' }).toString());
        console.log(`receipt key ${keyId(k.publicKey)}: private ${priv} (0600; give it only to the signer), public ${pub} (give it to auditors)`);
        return 0;
      }
      case 'sign': {
        const log = one(args, '--log');
        const key = one(args, '--key');
        const out = one(args, '--out');
        done(args);
        const signer = loadSigner(key);
        const r = signLog({ log, out, signer });
        console.log(`${r.added} new receipts signed with key ${keyId(signer.publicKey)}; ${r.count} in the chain, head ${r.head ?? 'none'}`);
        console.log(NOT_ROOT_SIGNED);
        return 0;
      }
      case 'rotate': {
        const out = one(args, '--out');
        const key = one(args, '--key');
        const next = one(args, '--next');
        done(args);
        const nextKey = loadPublicKey(next);
        const r = rotateFile({ out, signer: loadSigner(key), next: nextKey });
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
  const r = verifyChain(envelopes, { keys, ...(anchor[0] ? { anchor: anchor[0] } : {}) });
  if (!r.ok) {
    console.error(`FAILED: receipt ${r.index + 1} of ${envelopes.length}: ${r.problem}`);
    return 1;
  }
  const kinds = new Map<string, number>();
  for (const s of r.statements) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  console.log(`${r.count} receipts verified: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  console.log(`keys, in order: ${r.keys.join(' -> ')}`);
  console.log(`head (keep it, and pass it as --anchor next time to catch a dropped tail): ${r.head}`);
  console.log('A receipt proves what the log said and in what order, signed by the chain key; never that the inputs it names were true.');
  return 0;
}
