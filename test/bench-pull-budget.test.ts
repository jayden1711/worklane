// `bench pull`'s pack walk, its one budget (#748, slice 4, review round 4). Before the host's `git index-pack` sees
// what came out of a task's /testbed, every entry is charged against TREE_CAPS.treeBytes: the bytes its data inflates
// to (a delta's own data too, not only its target), each delta's target, and a fixed cost an entry. So the walk's own
// time and memory, and what index-pack hashes and builds, are bounded by design. Uncounted delta data let a 300 MB pack
// take the walk 302.6 s, 33 deltas of 248 MiB peaked index-pack at 1.96 GB on 16 CPUs, and 18 million tiny blobs took
// the walk 49.7 s and index-pack 1.41 GB (measured in review and by the builder). index-pack runs on one thread.
// Stand-ins only: packs built here or by host git in temp folders, the fixtures of test/bench-pull-fixtures.ts, a git
// wrapper that records its argv and runs the host git, no docker, no network, no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { bench, cliDeps, docker, git, GIT_ENV, pinsMod, TASKISH, treesDir } from './bench-pull-fixtures.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: pull.ts reads PATH for its git when it loads, so a recording git goes first on PATH before it is imported.
// The wrapper only logs its argv and runs the host's own git.
const wrapDir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-git-')));
const gitLog = join(wrapDir, 'calls.log');
const hostGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
writeFileSync(join(wrapDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${hostGit}' "$@"\n`, { mode: 0o755 });
process.env.PATH = `${wrapDir}:${process.env.PATH ?? ''}`;

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this change.
const cli = () => import('../scripts/bench/cli.js');
const pullMod = () => import('../scripts/bench/pull.js') as Promise<Record<string, unknown>>;
type Caps = { treeBytes: number; objectBytes: number };
type Walk = (pack: Buffer, caps: Caps) => unknown;
const walk = async (): Promise<Walk> => {
  const f = (await pullMod()).packDeclaredBytes;
  assert.equal(typeof f, 'function', 'pull.ts exports packDeclaredBytes');
  return f as Walk;
};
const caps = async (): Promise<Caps> => (await pullMod()).TREE_CAPS as Caps;

const MiB = 1024 * 1024;
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** A pack entry's header: type, then the inflated size, 4 bits then 7 bits a byte. */
const entryHeader = (type: number, size: number): Buffer => {
  const out: number[] = [];
  let c = (type << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(c | 0x80);
    c = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(c);
  return Buffer.from(out);
};
/** A delta header's size: 7 bits a byte, least significant first. */
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let c = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) c |= 0x80;
    out.push(c);
  } while (n > 0);
  return out;
};
/** An OFS_DELTA's base offset, as git writes it. */
const ofs = (o: number): number[] => {
  const out = [o & 127];
  o = Math.floor(o / 128);
  while (o > 0) {
    o--;
    out.unshift(128 | (o & 127));
    o = Math.floor(o / 128);
  }
  return out;
};
const finish = (entries: Buffer[], count = entries.length): Buffer => {
  const body = Buffer.concat([Buffer.from('PACK'), u32(2), u32(count), ...entries]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
};
const blobEntry = (data: Buffer) => Buffer.concat([entryHeader(3, data.length), deflateSync(data)]);

/**
 * A one-byte blob, then `n` valid OFS_DELTAs on it, each building a `target`-byte object out of one-byte copies at
 * 8 bytes each (opcode 0xff): every delta's own data is 8 times its target. Its zlib data is made once and reused.
 */
function copyDeltas(n: number, target: number): Buffer {
  const base = blobEntry(Buffer.from('a'));
  const head = Buffer.from([...varint(1), ...varint(target)]);
  const data = Buffer.alloc(head.length + 8 * target);
  head.copy(data);
  data.fill(Buffer.from([0xff, 0, 0, 0, 0, 1, 0, 0]), head.length);
  const z = deflateSync(data, { level: 9 });
  const entries = [base];
  let pos = 12 + base.length;
  for (let i = 0; i < n; i++) {
    const e = Buffer.concat([entryHeader(6, data.length), Buffer.from(ofs(pos - 12)), z]);
    entries.push(e);
    pos += e.length;
  }
  return finish(entries);
}
/** `n` distinct 4-byte blobs. */
const tinyBlobs = (n: number): Buffer => finish(Array.from({ length: n }, (_, i) => blobEntry(u32(i))));

/** The sizes git itself reads for every object of `pack`, summed (index-pack into a temp bare repo). */
function gitSizes(pack: Buffer): number {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-budget-')));
  git(['init', '--bare', '-q', '--template=', d]);
  execFileSync(hostGit, ['--git-dir', d, 'index-pack', '--stdin'], { env: GIT_ENV, input: pack });
  return git(['--git-dir', d, 'cat-file', '--batch-all-objects', '--batch-check=%(objectsize)'])
    .split('\n')
    .reduce((n, l) => n + Number(l), 0);
}

test("many valid large deltas are refused promptly: each delta's own data counts against the budget, not only its target", linux, async () => {
  const f = await walk();
  // The shape is valid: git takes it, and reads the target (each delta builds the same object, which git keeps once).
  assert.equal(gitSizes(copyDeltas(3, 1024)), 1 + 1024, 'git takes the deltas');
  // 33 deltas of a 31 MiB target each declare 1023 MiB and a byte, under the 1 GiB total, but each carries 248 MiB of
  // its own data: about 8 GiB to inflate, which the walk used to inflate whole (11.5 s in review) and pass to
  // index-pack (1.96 GB with git's default threads on 16 CPUs).
  const pack = copyDeltas(33, 31 * MiB);
  assert.ok(pack.length < 16 * MiB, `the pack is small (${pack.length} bytes), well under the copy-out cap`);
  const started = Date.now();
  await assert.rejects(async () => f(pack, await caps()), /declares over 1073741824 bytes.*before it is indexed/);
  const ms = Date.now() - started;
  assert.ok(ms < 20_000, `refused in ${ms} ms, after inflating at most the budget`);
  // Scaled down, at the edge: 7 deltas of a 1 MiB target fit 64 MiB with their 8 MiB of data each; 8 don't.
  const at = { treeBytes: 64 * MiB, objectBytes: 16 * MiB };
  await assert.rejects(async () => f(copyDeltas(60, MiB), at), /declares over 67108864 bytes/);
  await assert.doesNotReject(async () => f(copyDeltas(7, MiB), at));
  await assert.rejects(async () => f(copyDeltas(8, MiB), at), /declares over 67108864 bytes/);
});

test('every entry costs the budget: a pack of many tiny objects is refused before its entries are read', linux, async () => {
  const f = await walk();
  const small = { treeBytes: MiB, objectBytes: MiB };
  // 2,000 blobs of 4 bytes: 8,000 bytes of data, but each entry is charged 1 KiB.
  await assert.rejects(async () => f(tinyBlobs(2000), small), /declares over 1048576 bytes.*entries/);
  await assert.doesNotReject(async () => f(tinyBlobs(1000), small));
  // At the real caps: a count of 2^20 + 1 is over the budget on its own, refused before any entry is read.
  const one = blobEntry(Buffer.from('hello'));
  await assert.rejects(async () => f(finish([one], 1024 * 1024 + 1), await caps()), /declares over 1073741824 bytes.*entries/);
});

test('the walk refuses a wrong trailer checksum, and a delta base offset before the pack start', linux, async () => {
  const f = await walk();
  const big = { treeBytes: 1024 * MiB, objectBytes: 256 * MiB };
  const blob = blobEntry(Buffer.from('hello'));
  const good = finish([blob]);
  await assert.doesNotReject(async () => f(good, big));
  const flipped = Buffer.from(good);
  flipped.writeUInt8(flipped.readUInt8(flipped.length - 1) ^ 1, flipped.length - 1);
  await assert.rejects(async () => f(flipped, big), /not a well-formed pack.*before it is indexed/, 'a wrong trailer');
  const delta = deflateSync(Buffer.from([...varint(5), ...varint(5), 0x90 | 0x01, 0, 5]));
  const at = 12 + blob.length;
  for (const back of [at - 11, at, at + 100]) {
    const pack = finish([blob, Buffer.concat([entryHeader(6, 5), Buffer.from(ofs(back)), delta])]);
    await assert.rejects(async () => f(pack, big), /not a well-formed pack.*before it is indexed/, `a base ${back} bytes back, from ${at}`);
  }
  const fine = finish([blob, Buffer.concat([entryHeader(6, 5), Buffer.from(ofs(at - 12)), delta])]);
  await assert.doesNotReject(async () => f(fine, big), 'the base at the first entry');
  // A delta header cut short, with a real base.
  const cut = finish([blob, Buffer.concat([entryHeader(6, 1), Buffer.from(ofs(at - 12)), deflateSync(Buffer.from([0x80]))])]);
  await assert.rejects(async () => f(cut, big), /not a well-formed pack.*before it is indexed/, 'a delta header cut short');
});

test('an object over 1 MiB is inflated in pieces, and still held to exactly its size', linux, async () => {
  const f = await walk();
  const big = { treeBytes: 1024 * MiB, objectBytes: 256 * MiB };
  const data = Buffer.alloc(3 * MiB, 7);
  await assert.doesNotReject(async () => f(finish([blobEntry(data)]), big));
  for (const size of [2 * MiB, 3 * MiB + 1, 4 * MiB]) {
    const pack = finish([Buffer.concat([entryHeader(3, size), deflateSync(data)])]);
    await assert.rejects(async () => f(pack, big), /not a well-formed pack.*before it is indexed/, `declares ${size}, inflates to ${data.length}`);
  }
  const cut = finish([Buffer.concat([entryHeader(3, data.length), deflateSync(data).subarray(0, -6)])]);
  await assert.rejects(async () => f(cut, big), /not a well-formed pack.*before it is indexed/, 'cut short');
});

test('bench pull runs git index-pack on one thread, and passes pack.threads=1 to every git it runs', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const b = await bench();
  const out: string[] = [];
  const d = docker();
  writeFileSync(gitLog, '');
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 0, out.join('\n'));
  assert.doesNotMatch(out.join('\n'), TASKISH);
  assert.equal(readdirSync(treesDir(b.layout)).length, 4, 'the four smoke trees are built');
  const calls = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean);
  const indexPacks = calls.filter((c) => / index-pack /.test(` ${c} `));
  assert.equal(indexPacks.length, 4, 'one index-pack a task');
  for (const c of indexPacks) assert.match(` ${c} `, / --threads=1 /, 'index-pack on one thread');
  for (const c of calls) assert.match(` ${c} `, / -c pack\.threads=1 /, 'pack.threads=1 on every git it runs (fetch passes it to its own index-pack and pack-objects)');
});

test("the README gives the measured index-pack and bench pull peaks, not the round-3 claims", linux, () => {
  const text = readFileSync(join(repoRoot, 'scripts', 'bench', 'README.md'), 'utf8');
  assert.match(text, /pack\.threads=1/);
  assert.match(text, /1,894 MiB/);
  assert.doesNotMatch(text, /tracks the 1 GiB total cap/);
  assert.doesNotMatch(text, /peaked at about 1\.5 GB/);
});
