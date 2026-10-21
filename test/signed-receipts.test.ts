// Signed receipts (#717 slice 1; not src/receipts.ts, the claims receipts): every merge decision and merge result in
// an instance's event log becomes a DSSE envelope signed with ed25519, chained by hash, verifiable offline with the
// public key alone. Fixture logs in temp dirs and keys made here; no network, no real state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { EventLog } from '../src/events/log.js';
import { canonicalJson, chainStateOf, fieldChecks, keyId, keySigner, pae, PAYLOAD_TYPE, RECEIPT_SCHEMA, rotateChain, signEvents, statementOf, verifyChain, type Envelope, type ReceiptEvent, type ReceiptSigner } from '../src/signed-receipts.js';
import { readReceiptFiles, signLog } from '../src/signed-receipts-store.js';
import { engineCli } from './helpers.js';

const sha = (c: string) => c.repeat(40).slice(0, 40);
const H1 = sha('a');
const H2 = sha('b');
const M1 = sha('c');
const TOKEN = `ghp_${'Zx9'.repeat(12)}`;

function keys(): { pub: KeyObject; signer: ReceiptSigner } {
  const k = generateKeyPairSync('ed25519');
  return { pub: k.publicKey, signer: keySigner(k.privateKey) };
}

/** A coordinator's event log: one decision that merged, one held for the owner that then failed to merge. */
function fixtureLog(): { dir: string; path: string; log: EventLog } {
  const dir = mkdtempSync(join(tmpdir(), 'rcpt-'));
  const path = join(dir, 'events.db');
  const log = new EventLog(path);
  log.append('coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }, 'inst');
  log.append('merge.decided', { issue: 7, number: 41, head: H1, auto: true, reasons: [] }, 'inst');
  log.append('merge.done', { issue: 7, number: 41, head: H1, sha: M1, url: 'https://example.invalid/pull/41', title: 'a change' }, 'inst');
  log.append('merge.decided', { issue: 8, number: 42, head: H2, auto: false, reasons: ['touches the merge policy'], why: [{ category: 'merge policy', text: 'changes the merge policy: src/x.ts' }] }, 'inst');
  log.append('merge.failed', { issue: 8, number: 42, head: H2, why: 'GitHub refused the merge' }, 'inst');
  return { dir, path, log };
}

/** The signer's own chain state file, in a directory of its own (0700), apart from the receipts (#918 round 4). */
const stateFile = () => join(mkdtempSync(join(tmpdir(), 'rst-')), 'chain-state.json');
const GENESIS = { from: 'genesis' } as const;

function signed(): { dir: string; out: string; state: string; pub: KeyObject; signer: ReceiptSigner; envs: Envelope[]; log: EventLog; path: string } {
  const f = fixtureLog();
  const k = keys();
  const out = join(f.dir, 'receipts.jsonl');
  const state = stateFile();
  signLog({ log: f.path, out, state, genesis: true, registry: join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl'), signer: k.signer });
  return { ...f, out, state, ...k, envs: readReceiptFiles(out) as Envelope[] };
}

const reencode = (env: Envelope, st: unknown): Envelope => ({ ...env, payload: Buffer.from(canonicalJson(st), 'utf8').toString('base64') });

/** Every leaf of a JSON value (an empty array or object counts as one), as a path. */
function leaves(v: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (v !== null && typeof v === 'object') {
    const entries: [string | number, unknown][] = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    return entries.length ? entries.flatMap(([k, x]) => leaves(x, [...path, k])) : [path];
  }
  return [path];
}

function mutated(st: unknown, path: (string | number)[]): unknown {
  const copy = JSON.parse(JSON.stringify(st)) as Record<string | number, unknown>;
  let parent: Record<string | number, unknown> = copy;
  for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  const cur = parent[last];
  parent[last] = typeof cur === 'string' ? `${cur}x` : typeof cur === 'number' ? cur + 1 : typeof cur === 'boolean' ? !cur : cur === null ? 'x' : Array.isArray(cur) ? [...cur, 'x'] : { ...(cur as object), x: 1 };
  return copy;
}

/** A DSSE envelope over `st`, signed by `k` (what a forger could make). */
function sealWith(k: { signer: ReceiptSigner; pub: KeyObject }, st: unknown, bytes = Buffer.from(canonicalJson(st), 'utf8')): Envelope {
  return { payloadType: PAYLOAD_TYPE, payload: bytes.toString('base64'), signatures: [{ keyid: keyId(k.pub), sig: k.signer.sign(pae(PAYLOAD_TYPE, bytes)).toString('base64') }] };
}

test('every merge decision and result in the log gets a receipt that verifies offline with the public key', () => {
  const s = signed();
  const r = verifyChain(s.envs, { keys: [s.pub] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.count, 5);
  const st = r.statements;
  assert.deepEqual(st.map((x) => x.kind), ['chain.started', 'merge.decided', 'merge.result', 'merge.decided', 'merge.result']);
  assert.equal(st[0]!.kind === 'chain.started' && st[0]!.key.keyid, keyId(s.pub));
  for (const x of st) assert.equal(x.schema, RECEIPT_SCHEMA);
  const d1 = st[1]!;
  assert.ok(d1.kind === 'merge.decided');
  assert.equal(d1.engine.version, '1.2.3');
  assert.equal(d1.instance, 'inst');
  assert.deepEqual(d1.inputs, { issue: 7, pr: 41, head: H1, files: null, check_runs: null });
  assert.deepEqual(d1.decision, { auto: true, level: null, reasons: [], why: [] });
  assert.equal(d1.policy.commit, null, 'the deciding engine does not record its policy commit yet: null, never a guess');
  // Nothing in slice 1 is checked independently by the signer: every field is attested, and the receipt says so.
  assert.deepEqual((d1 as { verified?: unknown }).verified, []);
  assert.match(String((d1 as { log?: { digest?: unknown } }).log?.digest), /^[0-9a-f]{64}$/, 'the log as the signer read it, up to this event');
  const res1 = st[2]!;
  assert.ok(res1.kind === 'merge.result');
  assert.deepEqual([res1.merged, res1.commit, res1.decision], [true, M1, r.ids[1]]);
  const res2 = st[4]!;
  assert.ok(res2.kind === 'merge.result');
  assert.deepEqual([res2.merged, res2.commit, res2.why, res2.decision], [false, null, 'GitHub refused the merge', r.ids[3]]);
  // Chained: each receipt names the one before it, the first none.
  assert.deepEqual(st.map((x) => x.prev), [null, ...r.ids.slice(0, -1)]);
  assert.deepEqual(st.map((x) => x.seq), [0, 1, 2, 3, 4]);
  assert.equal(r.head, r.ids.at(-1));
  // A DSSE envelope: its payload type and one signature by the chain's key.
  for (const e of s.envs) {
    assert.equal(e.payloadType, PAYLOAD_TYPE);
    assert.deepEqual(e.signatures.map((x) => x.keyid), [keyId(s.pub)]);
  }
});

test('signing again receipts only what is new, continuing the same chain', () => {
  const s = signed();
  const first = verifyChain(s.envs, { keys: [s.pub] });
  assert.ok(first.ok);
  assert.deepEqual(signLog({ log: s.path, out: s.out, state: s.state, signer: s.signer }), { added: 0, count: 5, head: first.head, unsignable: 0, unrecorded: 0 });
  s.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  const again = signLog({ log: s.path, out: s.out, state: s.state, signer: s.signer });
  assert.equal(again.added, 1);
  const r = verifyChain(readReceiptFiles(s.out), { keys: [s.pub] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.count, 6);
  assert.equal(r.statements[5]!.prev, r.ids[4]);
});

test('a receipt with any field changed fails verification', () => {
  const s = signed();
  let tried = 0;
  for (const [i, env] of s.envs.entries()) {
    const st = statementOf(env);
    for (const path of leaves(st)) {
      const envs = [...s.envs];
      envs[i] = reencode(env, mutated(st, path));
      const r = verifyChain(envs, { keys: [s.pub] });
      assert.ok(!r.ok, `receipt ${i}, field ${path.join('.')} changed, still verified`);
      assert.equal(r.index, i);
      tried++;
    }
    // A field added, the payload type changed, a signature bit flipped, or the key id swapped: each fails too.
    const added = [...s.envs];
    added[i] = reencode(env, { ...(st as object), extra: 1 });
    assert.ok(!verifyChain(added, { keys: [s.pub] }).ok);
    const typed = [...s.envs];
    typed[i] = { ...env, payloadType: `${env.payloadType}x` };
    assert.ok(!verifyChain(typed, { keys: [s.pub] }).ok);
    const sig = Buffer.from(env.signatures[0]!.sig, 'base64');
    sig[0] = sig[0]! ^ 1;
    const flipped = [...s.envs];
    flipped[i] = { ...env, signatures: [{ ...env.signatures[0]!, sig: sig.toString('base64') }] };
    assert.ok(!verifyChain(flipped, { keys: [s.pub] }).ok);
    const other = [...s.envs];
    other[i] = { ...env, signatures: [{ ...env.signatures[0]!, keyid: keyId(keys().pub) }] };
    assert.ok(!verifyChain(other, { keys: [s.pub] }).ok);
  }
  assert.ok(tried >= 40, `only ${tried} fields tried`);
  // Changed and signed again with a key that is not the chain's: still refused.
  const forger = keys();
  const st = statementOf(s.envs[1]!) as { decision: { auto: boolean } };
  const resigned = [...s.envs];
  resigned[1] = sealWith(forger, { ...st, decision: { ...st.decision, auto: false } });
  assert.ok(!verifyChain(resigned, { keys: [s.pub] }).ok);
});

test('a payload that is not canonical JSON is refused even when the right key signed it', () => {
  const s = signed();
  const st = statementOf(s.envs[1]!);
  const loose = Buffer.from(JSON.stringify(st, null, 1), 'utf8');
  const envs = [...s.envs];
  envs[1] = sealWith(s, st, loose);
  const r = verifyChain(envs, { keys: [s.pub] });
  assert.ok(!r.ok);
  assert.match(r.problem, /canonical/);
  // The same statement, canonical and signed by the right key, verifies (the refusal above was the encoding).
  envs[1] = sealWith(s, st);
  assert.ok(verifyChain(envs, { keys: [s.pub] }).ok);
});

test('reordered receipts fail verification', () => {
  const s = signed();
  for (const [a, b] of [[1, 2], [2, 3], [0, 1], [3, 4]] as const) {
    const envs = [...s.envs];
    [envs[a], envs[b]] = [envs[b]!, envs[a]!];
    const r = verifyChain(envs, { keys: [s.pub] });
    assert.ok(!r.ok, `receipts ${a} and ${b} swapped, still verified`);
  }
});

test('a dropped receipt is detected; a dropped tail only against an anchor the auditor kept', () => {
  const s = signed();
  for (const i of [0, 1, 2, 3]) {
    const r = verifyChain(s.envs.filter((_, j) => j !== i), { keys: [s.pub] });
    assert.ok(!r.ok, `receipt ${i} dropped, still verified`);
  }
  const full = verifyChain(s.envs, { keys: [s.pub] });
  assert.ok(full.ok);
  // The last one dropped: the chain alone can't tell (documented); the head an auditor kept from an earlier look can.
  assert.ok(verifyChain(s.envs.slice(0, -1), { keys: [s.pub] }).ok);
  const anchored = verifyChain(s.envs.slice(0, -1), { keys: [s.pub], anchor: full.head! });
  assert.ok(!anchored.ok);
  assert.match(anchored.problem, /anchor/);
  assert.ok(verifyChain(s.envs, { keys: [s.pub], anchor: full.ids[2]! }).ok, 'an anchor inside the chain verifies');
});

test('the wrong public key fails verification, and no key at all is refused', () => {
  const s = signed();
  const r = verifyChain(s.envs, { keys: [keys().pub] });
  assert.ok(!r.ok);
  assert.equal(r.index, 0);
  assert.ok(!verifyChain(s.envs, { keys: [] }).ok);
});

test('a rotated key: the chain follows the rotation, and only the current key signs', () => {
  const s = signed();
  const next = keys();
  const startRef = (statementOf(s.envs[0]!) as { key: { keyid: string; spki: string } }).key;
  const rotated = rotateChain(s.envs, s.signer, next.pub, { from: chainStateOf(s.envs, startRef) });
  writeFileSync(s.out, `${rotated.map((e) => canonicalJson(e)).join('\n')}\n`);
  // The old key may not sign after the rotation; the new one may.
  s.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.throws(() => signLog({ log: s.path, out: s.out, state: s.state, signer: s.signer }), /not the chain's current key/);
  // The new key didn't start the chain: it extends it from the signer's own chain state, which names the start key
  // (#918 round 4, A4: never from a key it is told to trust; test/signed-receipts-hardening.test.ts).
  assert.equal(signLog({ log: s.path, out: s.out, state: s.state, signer: next.signer }).added, 1);
  const envs = readReceiptFiles(s.out) as Envelope[];
  const r = verifyChain(envs, { keys: [s.pub] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.keys, [keyId(s.pub), keyId(next.pub)]);
  assert.deepEqual(r.statements.map((x) => x.kind).slice(-2), ['key.rotated', 'merge.decided']);
  // The new key alone isn't trusted for what the old one started: an auditor needs the chain's start key.
  assert.ok(!verifyChain(envs, { keys: [next.pub] }).ok);
  // A receipt after the rotation signed by the retired key fails.
  const last = envs.length - 1;
  const old = [...envs];
  old[last] = sealWith(s, statementOf(envs[last]!));
  assert.ok(!verifyChain(old, { keys: [s.pub] }).ok);
  // A rotation signed by a key that isn't the chain's current one fails.
  const rogue = keys();
  const bad = [...envs];
  bad[5] = sealWith(rogue, statementOf(envs[5]!));
  assert.ok(!verifyChain(bad, { keys: [s.pub] }).ok);
  // Rotating with a key that isn't the current one is refused.
  assert.throws(() => rotateChain(envs, s.signer, rogue.pub, { from: chainStateOf(envs, startRef) }), /not the chain's current key/);
});

test('a receipts file swapped for a chain someone else started (rotated to this key) is never extended', () => {
  const s = signed();
  const attacker = keys();
  // Started by the attacker's key, then rotated to the real signer's key: valid on its own terms.
  const started = signEvents([], [], attacker.signer, GENESIS);
  const fake = rotateChain(started.envelopes, attacker.signer, s.pub, { from: started.state });
  writeFileSync(s.out, `${fake.map((e) => canonicalJson(e)).join('\n')}\n`);
  const before = readFileSync(s.out, 'utf8');
  assert.throws(() => signLog({ log: s.path, out: s.out, state: s.state, signer: s.signer }), /not a key given to verify against/);
  assert.equal(readFileSync(s.out, 'utf8'), before, 'nothing was written');
  assert.ok(!verifyChain(fake, { keys: [s.pub] }).ok, "and an auditor holding the real key rejects it at its first receipt");
});

test('a planted secret in a decision or a failure never appears in its receipt', () => {
  const k = keys();
  const events: ReceiptEvent[] = [
    { id: 1, ts: '2026-10-20T00:00:00.000Z', type: 'coordinator.started', actor: 'inst', payload: { instance: 'inst', pid: 1, version: '1.2.3' } },
    { id: 2, ts: '2026-10-20T00:00:01.000Z', type: 'merge.decided', actor: 'inst', payload: { issue: 1, number: 2, head: H1, auto: false, reasons: [`held: ${TOKEN}`], why: [{ category: 'x', text: `see ${TOKEN}` }] } },
    { id: 3, ts: '2026-10-20T00:00:02.000Z', type: 'merge.failed', actor: 'inst', payload: { issue: 1, number: 2, head: H1, why: `push with ${TOKEN} refused` } },
  ];
  const { envelopes } = signEvents([], events, k.signer, GENESIS);
  const text = envelopes.map((e) => Buffer.from(e.payload, 'base64').toString('utf8')).join('\n') + envelopes.map((e) => canonicalJson(e)).join('\n');
  assert.ok(!text.includes(TOKEN), 'the token reached a receipt');
  assert.match(text, /REDACTED/);
  assert.ok(text.includes(H1), 'a commit id is not a secret: kept');
  assert.ok(verifyChain(envelopes, { keys: [k.pub] }).ok);
});

test('the signer refuses to extend receipts that no longer verify, and leaves them as they are', () => {
  const s = signed();
  const lines = readFileSync(s.out, 'utf8').split('\n');
  lines.splice(2, 1);
  writeFileSync(s.out, lines.join('\n'));
  const before = readFileSync(s.out, 'utf8');
  s.log.append('merge.decided', { issue: 9, number: 43, head: sha('d'), auto: true, reasons: [] }, 'inst');
  assert.throws(() => signLog({ log: s.path, out: s.out, state: s.state, signer: s.signer }), /don't verify/);
  assert.equal(readFileSync(s.out, 'utf8'), before);
});

test('a garbled merge event in the log is never signed as if it were whole: it is signed as unsignable (round 11)', () => {
  // Round 1 to 10 refused it, which let one appended event end the chain (#918 round-10 review, P3). It is now
  // recorded as an `event.unsignable` receipt, with no decision fields, and the chain goes on.
  const k = keys();
  const events: ReceiptEvent[] = [{ id: 2, ts: '2026-10-20T00:00:01.000Z', type: 'merge.decided', actor: 'inst', payload: { issue: 1, number: 2, head: 'not-a-sha', auto: 'yes' } }];
  const { envelopes } = signEvents([], events, k.signer, GENESIS);
  const st = statementOf(envelopes[1]!) as Record<string, unknown>;
  assert.equal(st.kind, 'event.unsignable');
  assert.equal(st.event, '2');
  for (const field of ['decision', 'inputs', 'policy', 'engine']) assert.ok(!(field in st), `an unsignable receipt has no ${field}`);
  assert.ok(verifyChain(envelopes, { keys: [k.pub] }).ok);
});

test(`${BRAND.cli} receipts: keygen, sign and verify offline from the CLI; a tampered file fails`, () => {
  const f = fixtureLog();
  const keyDir = mkdtempSync(join(tmpdir(), 'rkey-'));
  const priv = join(keyDir, 'receipts.key');
  const pub = join(keyDir, 'receipts.pub');
  const cli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 60_000 });
  const gen = cli('keygen', '--private', priv, '--public', pub);
  assert.equal(gen.status, 0, gen.stderr);
  assert.equal(cli('keygen', '--private', priv, '--public', pub).status, 1, 'never overwrites a key');
  const out = join(f.dir, 'receipts.jsonl');
  const sg = cli('sign', '--log', f.path, '--key', priv, '--out', out, '--state', stateFile(), '--genesis', '--registry', join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl'));
  assert.equal(sg.status, 0, sg.stderr);
  assert.match(sg.stdout, /not yet root-signed/);
  // The auditor's copy, elsewhere, with only the public key.
  const audit = mkdtempSync(join(tmpdir(), 'raud-'));
  copyFileSync(out, join(audit, '0001.jsonl'));
  const ok = cli('verify', audit, '--key', pub);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /5 receipts verified/);
  const lines = readFileSync(out, 'utf8').split('\n');
  [lines[1], lines[2]] = [lines[2]!, lines[1]!];
  writeFileSync(join(audit, '0001.jsonl'), lines.join('\n'));
  const bad = cli('verify', audit, '--key', pub);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAILED/);
  assert.equal(cli('verify', out, '--key', priv).status, 2, 'a private key passed as the public one is refused');
  assert.equal(cli('verify', out).status, 2, 'no key: refused');
  const help = spawnSync(process.execPath, [engineCli, 'help'], { encoding: 'utf8', timeout: 60_000 });
  assert.match(help.stdout, /receipts verify <file\|dir> --key <pub>/);
  // Never a signature from a key the CLI can't read as an ed25519 private key.
  writeFileSync(join(keyDir, 'junk.key'), 'not a key');
  const junk = cli('sign', '--log', f.path, '--key', join(keyDir, 'junk.key'), '--out', join(f.dir, 'r2.jsonl'), '--state', stateFile(), '--genesis', '--registry', join(mkdtempSync(join(tmpdir(), 'rreg-')), 'registry.jsonl'));
  assert.equal(junk.status, 1);
  assert.match(junk.stderr, /not a readable private key/);
  // The auditor is told what the signer checked itself and what is only the coordinator's word (attested).
  assert.match(ok.stdout, /verified independently by the signer: none/);
});

const receiptsCli = (...a: string[]) => spawnSync(process.execPath, [engineCli, 'receipts', ...a], { encoding: 'utf8', timeout: 60_000 });

test('verify --anchor: an empty or malformed anchor is a usage error, never a skipped check (#918 round 2)', () => {
  const s = signed();
  const pub = join(s.dir, 'chain.pub');
  writeFileSync(pub, s.pub.export({ type: 'spki', format: 'pem' }).toString());
  const full = verifyChain(s.envs, { keys: [s.pub] });
  assert.ok(full.ok);
  const head = full.head!;
  const short = join(s.dir, 'short.jsonl');
  writeFileSync(short, `${readFileSync(s.out, 'utf8').split('\n').slice(0, 4).join('\n')}\n`);
  for (const bad of ['', 'xyz', head.toUpperCase(), head.slice(1), `${head}0`]) {
    const r = receiptsCli('verify', short, '--key', pub, '--anchor', bad);
    assert.equal(r.status, 2, `--anchor ${JSON.stringify(bad)}: exit ${r.status}, ${r.stdout}`);
  }
  assert.equal(receiptsCli('verify', short, '--key', pub, '--anchor', head).status, 1, 'the dropped tail is caught');
  assert.equal(receiptsCli('verify', s.out, '--key', pub, '--anchor', head).status, 0);
});

test('keygen creates each key file itself: never through a planted link, never over anything (#918 round 2)', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rkl-'));
  // A dangling link at --private: refused; the link stays a link and nothing appears where it points.
  const priv = join(dir, 'a.key');
  symlinkSync(join(dir, 'victim-a'), priv);
  assert.equal(receiptsCli('keygen', '--private', priv, '--public', join(dir, 'a.pub')).status, 1);
  assert.ok(lstatSync(priv).isSymbolicLink());
  assert.ok(!existsSync(join(dir, 'victim-a')));
  assert.ok(!existsSync(join(dir, 'a.pub')));
  // A dangling link at --public: refused, and no private key is left behind.
  const pub = join(dir, 'b.pub');
  symlinkSync(join(dir, 'victim-b'), pub);
  assert.equal(receiptsCli('keygen', '--private', join(dir, 'b.key'), '--public', pub).status, 1);
  assert.ok(!existsSync(join(dir, 'victim-b')));
  assert.ok(!existsSync(join(dir, 'b.key')));
  // Made normally: both files are regular files, this user's only (0600).
  assert.equal(receiptsCli('keygen', '--private', join(dir, 'c.key'), '--public', join(dir, 'c.pub')).status, 0);
  for (const f of ['c.key', 'c.pub']) {
    assert.ok(lstatSync(join(dir, f)).isFile());
    assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(join(dir, f)).nlink, 1, `${f}: its staging name is gone`);
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no staging or temp file is left behind');
});

test('the signer refuses a log that changed under receipts it already signed: an event edited, dropped or inserted (#918 round 2)', () => {
  const k = keys();
  const at = (id: number) => `2026-10-20T00:00:${String(id).padStart(2, '0')}.000Z`;
  const ev = (id: number, type: string, payload: unknown): ReceiptEvent => ({ id, ts: at(id), type, actor: 'inst', payload });
  const base = [
    ev(1, 'coordinator.started', { instance: 'inst', pid: 1, version: '1.2.3' }),
    ev(2, 'merge.decided', { issue: 1, number: 2, head: H1, auto: true, reasons: [] }),
    ev(4, 'issue.seen', { issue: 1, labels: [] }),
    ev(5, 'merge.done', { issue: 1, number: 2, head: H1, sha: M1, url: 'u', title: 't' }),
  ];
  const signedOnce = signEvents([], base, k.signer, GENESIS);
  const first = signedOnce.envelopes;
  const from = { from: signedOnce.state };
  const next = ev(7, 'merge.decided', { issue: 3, number: 4, head: H2, auto: true, reasons: [] });
  assert.equal(signEvents(first, [...base, next], k.signer, from).added, 1, 'a log that only grew is signed on');
  const edited = base.map((e) => (e.id === 4 ? { ...e, payload: { issue: 1, labels: ['changed'] } } : e));
  assert.throws(() => signEvents(first, [...edited, next], k.signer, from), /log changed/);
  assert.throws(() => signEvents(first, [...base.filter((e) => e.id !== 4), next], k.signer, from), /log changed/);
  assert.throws(() => signEvents(first, [...base, ev(3, 'issue.seen', { issue: 9, labels: [] }), next], k.signer, from), /log changed/);
  assert.throws(() => signEvents(first, [...base.filter((e) => e.id !== 2), next], k.signer, from), /log changed/);
});

test('verify shows what the signer verified against what it only attests, and flags a mismatch with exit 3', () => {
  // Slice 1's signer verifies nothing; this receipt is what slice 3's will make (the format is already v1's).
  const k = keys();
  const ev = (id: number, type: string, payload: unknown): ReceiptEvent => ({ id, ts: `2026-10-20T00:00:0${id}.000Z`, type, actor: 'inst', payload });
  const envs = signEvents([], [ev(1, 'coordinator.started', { instance: 'inst', pid: 1, version: '1' }), ev(2, 'merge.decided', { issue: 1, number: 2, head: H1, auto: true, reasons: [] })], k.signer, GENESIS).envelopes;
  const st = statementOf(envs[1]!) as Record<string, unknown>;
  const dir = mkdtempSync(join(tmpdir(), 'rvf-'));
  const pub = join(dir, 'k.pub');
  writeFileSync(pub, k.pub.export({ type: 'spki', format: 'pem' }).toString());
  const verifyWith = (verified: unknown[]) => {
    const chain = [envs[0]!, sealWith(k, { ...st, verified })];
    writeFileSync(join(dir, 'r.jsonl'), `${chain.map((e) => canonicalJson(e)).join('\n')}\n`);
    return { r: verifyChain(chain, { keys: [k.pub] }), out: receiptsCli('verify', join(dir, 'r.jsonl'), '--key', pub) };
  };
  // A null claim (the engine didn't record it) is "unrecorded": the signer's value is the only one, never a mismatch.
  // `found` holds any canonical JSON value: check runs as [{name, id, conclusion}] fit slice 1's format (#918 round 3).
  const runs = [{ name: 'ci', id: 5, conclusion: 'success' }];
  const filled = verifyWith([
    { field: 'inputs.head', how: 'git', found: H1 },
    { field: 'policy.commit', how: 'git', found: M1 },
    { field: 'inputs.check_runs', how: 'github', found: runs },
    { field: 'result.tree', how: 'git', found: H2 },
  ]);
  assert.ok(filled.r.ok, JSON.stringify(filled.r));
  assert.deepEqual(fieldChecks(filled.r.statements[1]!).map((c) => [c.field, c.result]), [['inputs.head', 'match'], ['policy.commit', 'unrecorded'], ['inputs.check_runs', 'unrecorded'], ['result.tree', 'derived']]);
  assert.equal(filled.out.status, 0, filled.out.stdout + filled.out.stderr);
  assert.match(filled.out.stdout, /verified independently by the signer: 4 field checks/);
  assert.doesNotMatch(filled.out.stdout, /FLAGGED/);
  // A claim the signer found different is flagged, exit 3.
  const wrong = verifyWith([{ field: 'inputs.head', how: 'git', found: H2 }]);
  assert.ok(wrong.r.ok);
  assert.equal(wrong.out.status, 3, wrong.out.stderr);
  assert.match(wrong.out.stdout, /FLAGGED: receipt 2: inputs\.head: the coordinator claimed "a{40}", the signer found "b{40}" \(git\)/);
  // `found` is bounded: an oversized value is not a valid receipt.
  assert.ok(!verifyWith([{ field: 'inputs.files', how: 'git', found: ['x'.repeat(70_000)] }]).r.ok);
});

test('the log digest is unambiguous: bytes moved across a field boundary are a changed log (#918 round 3)', () => {
  const k = keys();
  const at = (id: number) => `2026-10-20T00:00:0${id}.000Z`;
  const started: ReceiptEvent = { id: 1, ts: at(1), type: 'coordinator.started', actor: 'inst', payload: { instance: 'inst', pid: 1, version: '1' } };
  const seen: ReceiptEvent = { id: 2, ts: at(2), type: 'issue.seen', actor: 'inst', payload: undefined, raw: '{"issue":1}\n{"x":2}' };
  const decided: ReceiptEvent = { id: 3, ts: at(3), type: 'merge.decided', actor: 'inst', payload: { issue: 1, number: 2, head: H1, auto: true, reasons: [] } };
  const once = signEvents([], [started, seen, decided], k.signer, GENESIS);
  const first = once.envelopes;
  const shifted: ReceiptEvent = { ...seen, actor: 'inst\n{"issue":1}', raw: '{"x":2}' };
  assert.throws(() => signEvents(first, [started, shifted, decided], k.signer, { from: once.state }), /log changed/);
  assert.equal(signEvents(first, [started, seen, decided], k.signer, { from: once.state }).added, 0, 'the same log is no change');
});
