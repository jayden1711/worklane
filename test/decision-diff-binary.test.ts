// The owner's decision diff never shows a binary file's bytes (#927 round 10). The diff is read with `--text` (#807 F2:
// a NUL, or a `-diff` attribute, is also how a change hides its text from review as "binary"), and round 9 showed it
// with its NULs dropped. That showed a binary file's printable bytes (a DER private key's), and it glued byte runs
// together, so a key shape a NUL had ended lost the boundary its redaction rule needs (both measured or inferred by
// round 9's reviews). main shows "Binary files differ". Now a binary file's lines show only as the text they decode to,
// and a NUL shows as a mark that is still a boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionDiff } from '../src/decision-detail.js';

/** A scratch repo with a base commit, and a commit adding `files`: its diff as the owner's decision view shows it. */
async function shown(files: Record<string, Buffer | string>): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'decision-binary-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  for (const [name, data] of Object.entries(files)) writeFileSync(join(repo, name), data);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD').trim();
  const d = await decisionDiff(repo, base, head);
  assert.ok(d.diff !== null, JSON.stringify(d));
  return d.diff;
}

/** Every run of printable ASCII bytes in `b` at least `n` long. */
function printableRuns(b: Buffer, n: number): string[] {
  return b.toString('latin1').match(new RegExp(`[\\x20-\\x7e]{${n},}`, 'g')) ?? [];
}

/** A fresh DER private key with at least one run of 6 printable bytes, so the check below has something to find. */
function derKey(make: () => Buffer): Buffer {
  for (let i = 0; i < 400; i++) {
    const k = make();
    if (printableRuns(k, 6).length) return k;
  }
  throw new Error('no key with a printable run of 6 in 400 tries');
}

test('a DER private key (ed25519 PKCS#8, RSA-2048 PKCS#1) shows no 6-byte run of its printable bytes', async () => {
  const ed = derKey(() => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }));
  const rsa = derKey(() => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'der' }));
  const diff = await shown({ 'id_ed25519.der': ed, 'id_rsa.der': rsa });
  assert.match(diff, /id_ed25519\.der/);
  assert.match(diff, /id_rsa\.der/);
  for (const [name, key] of [['ed25519', ed], ['rsa', rsa]] as const) {
    const leaked: string[] = [];
    for (const run of printableRuns(key, 6)) for (let i = 0; i + 6 <= run.length; i++) if (diff.includes(run.slice(i, i + 6))) leaked.push(run.slice(i, i + 6));
    assert.deepEqual(leaked, [], `${name}: printable bytes of the key are shown`);
  }
});

// Fixed-length key shapes, each between NULs, with a letter or digit right after the trailing NUL: with the NULs
// dropped, the rule's boundary (a lookahead, or `\b` before) is gone. Fake shapes, none of them real.
const SHAPES: [string, string][] = [
  ['AWS access key', `AKIA${'Q7W2R9T4Y6H3L8V5'}`],
  ['Google API key', `AIza${'SyD7k2Lm9Qr3Ws8Xv5Zb1Nc4Hd6Jf0Gp2T'.padEnd(35, 'a').slice(0, 35)}`],
  ['32-byte hex key', `0x${'9f3a'.repeat(16)}`],
];
for (const [what, key] of SHAPES) {
  test(`a ${what} between NULs in a binary file, a letter after the trailing NUL, is redacted`, async () => {
    const body = Buffer.concat([Buffer.from('a binary blob with a key inside it\n'), Buffer.from('k'), Buffer.from([0]), Buffer.from(key), Buffer.from([0]), Buffer.from('x tail bytes\n')]);
    const diff = await shown({ 'blob.bin': body });
    assert.equal(diff.includes(key.slice(4, 20)), false, `the key is shown: ${JSON.stringify(diff.slice(-300))}`);
    assert.match(diff, /a binary blob with a key inside it/, 'the text line still shows');
  });
}

/** `text` as UTF-32 with a byte-order mark. */
function utf32(text: string, order: 'le' | 'be'): Buffer {
  const points = [0xfeff, ...Array.from(text, (c) => c.codePointAt(0)!)];
  const b = Buffer.alloc(points.length * 4);
  points.forEach((p, i) => (order === 'le' ? b.writeUInt32LE(p, i * 4) : b.writeUInt32BE(p, i * 4)));
  return b;
}

for (const order of ['le', 'be'] as const) {
  test(`a UTF-32${order.toUpperCase()} file shows its lines as text, and a token in it is redacted`, async () => {
    const token = `ghp_${'Utf32Tk9Lm3Qr7Ws2Xv5Zb8Nc4Hd6Jf1Gp0'.padEnd(36, 'a').slice(0, 36)}`;
    const diff = await shown({ 'notes32.txt': utf32(`first line of the notes\ntoken: ${token}\nthe last line\n`, order) });
    const seen = diff.replace(/␀/g, '');
    assert.equal(seen.includes(token.slice(4, 20)), false, `the token is shown: ${JSON.stringify(diff.slice(-300))}`);
    assert.match(diff, /first line of the notes/);
    assert.match(diff, /the last line/);
  });
}

test('a text file with one NUL still shows its lines, the NUL as a mark', async () => {
  const body = Buffer.concat([
    Buffer.from('the first line of this text file\nthe second line holds one '),
    Buffer.from([0]),
    Buffer.from(' NUL in the middle of it\nand the third line is plain text again\n'),
  ]);
  const diff = await shown({ 'notes.txt': body });
  assert.match(diff, /\+the first line of this text file\n/);
  assert.match(diff, /\+the second line holds one ␀ NUL in the middle of it\n/);
  assert.match(diff, /\+and the third line is plain text again\n/);
  assert.equal(diff.includes('\0'), false);
});
