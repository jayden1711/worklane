// The owner's decision diff past git's 8 MiB output buffer (#927 round 8). #921 (#889) redacts before it cuts, so a
// token across the 512 KiB cut is redacted whole. This PR's buffer branch, which shows output past the buffer instead
// of no diff, cut first and redacted after (`redactString(stdout.slice(0, MAX))`): the head of a token across the cut
// was too short for its rule and was shown. The fixture is a real diff over 8 MiB, so the branch runs as it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionDiff } from '../src/decision-detail.js';

const MAX = 512 * 1024;
const BUFFER = 8 * 1024 * 1024;
const FILLER = 'x'.repeat(60);
const TOKENS = 100;
/** A distinct GitHub-token-shaped string per line (ghp_ and 36 letters and digits), none of them real. */
const token = (i: number) => `ghp_${String(i).padStart(4, '0')}${'Qz7Wk2Rm9Tb4Yp6Hn3Lc8Vd5Fs1Gj0Xa'.padEnd(32, 'a').slice(0, 32)}`;
/** The visible head of the token the cut lands in: `ghp_` and four more characters, under every token rule's length. */
const VISIBLE = 8;

test('a decision diff past the 8 MiB buffer is redacted before it is cut: no part of a token across the cut is shown', async () => {
  assert.equal(token(0).length, 40, 'a token line is 40 characters (42 as a diff line)');
  const repo = mkdtempSync(join(tmpdir(), 'decision-overflow-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  // big.txt: a pad line, filler up to just before the cut, the token lines, then filler past the buffer. Diff lines
  // are `+` and the line: filler 62 characters, a token 42.
  const before = Math.floor((MAX - 50 * 42) / 62) - 5;
  const after = Math.ceil((BUFFER + 512 * 1024) / 62);
  const file = (pad: number) => [`${'y'.repeat(pad)}`, ...Array(before).fill(FILLER), ...Array.from({ length: TOKENS }, (_, i) => token(i)), ...Array(after).fill(FILLER)].join('\n') + '\n';
  const diffArgs = (head: string) => ['-c', 'core.attributesFile=/dev/null', 'diff', '--no-color', '--text', '--no-textconv', '--no-ext-diff', '--ignore-submodules=none', `${base}..${head}`];
  // First with a one-character pad, to measure the diff's header; then with the pad that puts the cut inside a token,
  // VISIBLE characters in. The line count and the header's length stay the same.
  writeFileSync(join(repo, 'big.txt'), file(1));
  git('add', '-A');
  git('commit', '-q', '-m', 'measure');
  const header = git(...diffArgs('HEAD')).indexOf('\n+y\n') + 1;
  const firstToken = (pad: number) => header + (1 + pad + 1) + before * 62;
  const pad = ((((MAX - VISIBLE - 1 - firstToken(0)) % 42) + 42) % 42) || 42;
  writeFileSync(join(repo, 'big.txt'), file(pad));
  git('add', '-A');
  git('commit', '-q', '-m', 'big');
  const head = git('rev-parse', 'HEAD').trim();

  // The fixture does what it says: git's own output is past the buffer, and the cut lands VISIBLE characters into a token.
  const plain = git(...diffArgs(head));
  assert.ok(plain.length > BUFFER, `the diff (${plain.length}) is past the buffer`);
  const start = plain.lastIndexOf('ghp_', MAX);
  assert.equal(MAX - start, VISIBLE, 'the cut is inside a token');
  assert.match(plain.slice(start, start + 40), /^ghp_[A-Za-z0-9]{36}$/);

  const d = await decisionDiff(repo, base, head);
  assert.ok(d.diff !== null, JSON.stringify(d).slice(0, 300));
  assert.equal((d as { truncated: boolean }).truncated, true);
  assert.ok(d.diff.length <= MAX);
  assert.equal(d.diff.includes('ghp_'), false, `no part of any token is shown; the end: ${JSON.stringify(d.diff.slice(-80))}`);
});
