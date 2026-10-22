// The owner's decision diff and a token in UTF-16 (#927 round 9). The diff is read with `--text` (#807 F2: a NUL, or a
// `-diff` attribute, is also how a change hides its lines from review as "binary"), so a binary file's bytes are shown.
// UTF-16 text puts a NUL between ASCII characters, and no redaction rule matched it: the token read whole once the NULs
// were dropped (measured by #927 round 8's second review), where main showed "Binary files differ". The diff is now
// redacted, and shown, as a NUL-free view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionDiff } from '../src/decision-detail.js';

/** GitHub-token-shaped (ghp_ and 36 letters and digits), not a real one. */
const TOKEN = `ghp_${'Utf16Tk9Lm3Qr7Ws2Xv5Zb8Nc4Hd6Jf1Gp0'.padEnd(36, 'a').slice(0, 36)}`;

function utf16(text: string, order: 'le' | 'be'): Buffer {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (order === 'le') return le;
  const be = Buffer.from(le);
  be.swap16();
  return be;
}

for (const order of ['le', 'be'] as const) {
  test(`a token in a UTF-16${order.toUpperCase()} file is not shown in the owner's decision diff`, async () => {
    assert.equal(TOKEN.length, 40);
    const repo = mkdtempSync(join(tmpdir(), `decision-utf16-${order}-`));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(repo, 'notes.txt'), utf16(`notes\ntoken: ${TOKEN}\nend\n`, order));
    git('add', '-A');
    git('commit', '-q', '-m', 'notes');
    const head = git('rev-parse', 'HEAD').trim();
    // The file holds the token's characters with a NUL between them.
    assert.ok(git('show', `${head}:notes.txt`).replace(/\0/g, '').includes(TOKEN));

    const d = await decisionDiff(repo, base, head);
    assert.ok(d.diff !== null, JSON.stringify(d));
    const seen = d.diff.replace(/\0/g, '');
    assert.equal(seen.includes('ghp_'), false, `no part of the token: ${JSON.stringify(seen.slice(0, 400))}`);
    assert.equal(seen.includes(TOKEN.slice(4, 20)), false);
    // The rest of the file still shows: the change isn't hidden as "binary".
    assert.match(seen, /notes/);
  });
}
