// `bench pull`'s pack walk (#748, slice 4, review round 3): before the host's `git index-pack` sees what came out of a
// task's /testbed, every entry's declared size is read from the pack itself (a whole object's from its header, a
// delta's target from its delta header) and summed against the caps. A small delta pack can declare gigabytes, which
// index-pack would build in memory (1,115 bytes peaked at 1.58 GB, measured in review). Stand-ins only: packs built
// here or by host git in temp folders, the fixtures of test/bench-pull-fixtures.ts, no docker, no network, no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { bench, cliDeps, docker, git, GIT_ENV, pinsMod, TASKISH, TREE, treePack, treesDir, verbs, type Sent } from './bench-pull-fixtures.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this change.
const cli = () => import('../scripts/bench/cli.js');
const pullMod = () => import('../scripts/bench/pull.js') as Promise<Record<string, unknown>>;
type Walk = (pack: Buffer, caps: { treeBytes: number; objectBytes: number }) => Promise<{ decoded: number; spent: number }>;
const walk = async (): Promise<Walk> => {
  const f = (await pullMod()).packDeclaredBytes;
  assert.equal(typeof f, 'function', 'pull.ts exports packDeclaredBytes');
  return f as Walk;
};

const MiB = 1024 * 1024;
const ok = (stdout: string): Sent => ({ status: 0, stdout, stderr: '' });
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
/** A delta bomb: a 1 MiB zero blob, then an OFS_DELTA on it declaring `targetMiB` MiB, two bytes per MiB copied. */
function deltaBomb(targetMiB: number): Buffer {
  const blob = Buffer.concat([entryHeader(3, MiB), deflateSync(Buffer.alloc(MiB))]);
  const delta = Buffer.from([...varint(MiB), ...varint(targetMiB * MiB), ...Array.from({ length: targetMiB }, () => [0xc0, 0x10]).flat()]);
  const second = Buffer.concat([entryHeader(6, delta.length), Buffer.from(ofs(blob.length)), deflateSync(delta)]);
  return finish([blob, second]);
}
/** The sizes git itself reads for every object of `pack`, summed (index-pack into a temp bare repo). */
function gitSizes(pack: Buffer): number {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pull-pack-')));
  git(['init', '--bare', '-q', '--template=', d]);
  execFileSync('git', ['--git-dir', d, 'index-pack', '--stdin'], { env: GIT_ENV, input: pack });
  return git(['--git-dir', d, 'cat-file', '--batch-all-objects', '--batch-check=%(objectsize)'])
    .split('\n')
    .reduce((n, l) => n + Number(l), 0);
}
const BIG = { treeBytes: 1024 * MiB, objectBytes: 256 * MiB };

test("the pack walk reads the same sizes git does: whole objects from their headers, deltas from their targets", linux, async () => {
  const f = await walk();
  const small = deltaBomb(2);
  assert.equal((await f(small, BIG)).decoded, 3 * MiB, 'a 1 MiB blob and a delta to 2 MiB');
  assert.equal((await f(small, BIG)).decoded, gitSizes(small), 'what git reads, for the crafted delta pack');
  for (const b64 of [TREE.b64, TREE.history, TREE.treeOnly]) {
    const pack = Buffer.from(b64, 'base64');
    assert.equal((await f(pack, BIG)).decoded, gitSizes(pack), 'what git reads, for a pack git made');
  }
});

test('a delta bomb is refused before index-pack: a pack of a few KB that declares hundreds of MiB', linux, async () => {
  const { pull } = await cli();
  const { parsePins } = await pinsMod();
  const bomb = deltaBomb(300);
  assert.ok(bomb.length < 8 * 1024, `the pack is small (${bomb.length} bytes)`);
  const b = await bench();
  const out: string[] = [];
  const d = docker({ pack: () => ok(bomb.toString('base64')) });
  // WHY: performance.now(), monotonic: an NTP step can't move it (#582).
  const started = performance.now();
  assert.equal(await pull(cliDeps(b, out, d) as never, 'smoke', () => parsePins(b.pinsText)), 1, out.join('\n'));
  const text = out.join('\n');
  assert.match(text, /FAIL +t01 +.*declares .*over \d+ bytes.*before it is indexed/);
  assert.doesNotMatch(text, TASKISH);
  assert.deepEqual(readdirSync(treesDir(b.layout)), [], 'nothing kept, no temporary folder left');
  assert.deepEqual(new Set(verbs(d, 'rm').map((a) => a[2])), new Set(d.containers.keys()), 'its container removed');
  assert.ok(performance.now() - started < 30_000,'refused without building the target');
});

test('the walk refuses a pack over the decoded cap, or with one object over the object cap, before it is indexed', linux, async () => {
  const f = await walk();
  const history = Buffer.from(TREE.history, 'base64');
  // Round 4: the budget is what the walk charges (data, delta targets, a fixed cost an entry), at least what git reads.
  const { decoded, spent } = await f(history, BIG);
  assert.equal(decoded, gitSizes(history));
  assert.ok(spent >= decoded);
  assert.deepEqual(await f(history, { treeBytes: spent, objectBytes: MiB }), { decoded, spent }, 'exactly at the cap: taken');
  await assert.rejects(async () => f(history, { treeBytes: spent - 1, objectBytes: MiB }), new RegExp(`declares .*over ${spent - 1} bytes.*before it is indexed`));
  const big = Buffer.from(treePack({ 'big.bin': Buffer.alloc(2 * MiB) }).b64, 'base64');
  await assert.rejects(async () => f(big, { treeBytes: 1024 * MiB, objectBytes: MiB }), /declares an object of over 1048576 bytes.*before it is indexed/);
  await assert.rejects(async () => f(deltaBomb(2), { treeBytes: 1024 * MiB, objectBytes: MiB + 1 }), /declares an object of over 1048577 bytes/, "a delta's target counts, not only its delta data");
});

test('the walk refuses a pack that is not well formed, before it is indexed', linux, async () => {
  const f = await walk();
  const good = deltaBomb(2);
  const blob = Buffer.concat([entryHeader(3, 5), deflateSync(Buffer.from('hello'))]);
  const cases: [Buffer, string][] = [
    [Buffer.alloc(0), 'empty'],
    [Buffer.concat([Buffer.from('KCAP'), good.subarray(4)]), 'no PACK signature'],
    [finish([blob]).fill(4, 7, 8), 'version 4'],
    [finish([blob], 2), 'fewer entries than its count'],
    [Buffer.concat([finish([blob]).subarray(0, -20), Buffer.from('extra'), Buffer.alloc(20)]), 'bytes after the last entry'],
    [finish([Buffer.concat([entryHeader(5, 5), deflateSync(Buffer.from('hello'))])]), 'type 5'],
    [finish([Buffer.concat([entryHeader(3, 10), deflateSync(Buffer.from('hello'))])]), 'a size that is not what it inflates to'],
    [finish([Buffer.concat([entryHeader(3, 5), deflateSync(Buffer.from('hello')).subarray(0, 4)])]), 'cut-short data'],
    [finish([Buffer.concat([entryHeader(3, 5), Buffer.from('not zlib at all')])]), 'not zlib'],
    [finish([blob, Buffer.concat([entryHeader(6, 1), Buffer.from(ofs(blob.length)), deflateSync(Buffer.from([0x80]))])]), 'a delta header cut short'],
  ];
  for (const [pack, why] of cases) await assert.rejects(async () => f(pack, BIG), /not a well-formed pack.*before it is indexed/, why);
});

test("the README says what is checked before index-pack, and doesn't claim the decoded check comes first", linux, () => {
  const text = readFileSync(join(repoRoot, 'scripts', 'bench', 'README.md'), 'utf8');
  assert.match(text, /before `index-pack`/);
  assert.match(text, /256 MiB/);
  assert.doesNotMatch(text, /checked before anything is fetched or checked out, since a small pack can inflate a thousandfold/);
});
