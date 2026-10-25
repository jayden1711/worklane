import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const gate = fileURLToPath(new URL('../../scripts/push-gate.mjs', import.meta.url));
const skip = !which('gitleaks') && 'gitleaks not installed';
const sha = (t: string) => execFileSync('node', ['-e', `console.log(require('crypto').createHash('sha256').update(${JSON.stringify(t)}).digest('hex'))`], { encoding: 'utf8' }).trim();

/** A repo with this repo's real patterns, one hashed private term, a bare remote and the pre-push hook. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'pushgate-'));
  const dir = join(base, 'work');
  const remote = join(base, 'remote.git');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git('config', k!, v!);
  const real = JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] };
  writeFileSync(join(dir, '.denylist.json'), JSON.stringify({ hashed: [sha('secretproject'), sha('otherhandle'), sha('zqx'), sha('qzxwvk')], patterns: real.patterns }));
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  mkdirSync(join(dir, '.githooks'));
  writeFileSync(join(dir, '.githooks', 'pre-push'), `#!/bin/sh\nexec node ${JSON.stringify(gate)} "$@"\n`);
  chmodSync(join(dir, '.githooks', 'pre-push'), 0o755);
  git('config', 'core.hooksPath', '.githooks');
  const commit = (file: string, text: string, msg = 'change') => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', msg);
  };
  const push = () => spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], { cwd: dir, encoding: 'utf8' });
  return { dir, git, commit, push };
}

const blocked = [
  ['a hashed private name in a file', 'notes.md', 'deployed by secretproject\n', 'add notes'],
  ['a home directory path', 'notes.md', 'see /Users/ada/work/x\n', 'add notes'],
  ['a Tailscale address', 'notes.md', 'ssh 100.101.102.103\n', 'add notes'],
  ['a MagicDNS host', 'notes.md', 'box.tail1234.ts.net\n', 'add notes'],
  ['an ntfy topic', 'notes.md', 'curl ntfy.sh/my-alerts-x\n', 'add notes'],
  ['an email', 'notes.md', 'mail bob@corp.dev\n', 'add notes'],
  ['a private name in the commit message', 'ok.md', 'fine\n', 'fix the secretproject deploy'],
];

for (const [what, file, text, msg] of blocked) {
  test(`push gate refuses ${what}`, { skip }, () => {
    const r = repo();
    r.commit(file!, text!, msg);
    const p = r.push();
    assert.notEqual(p.status, 0, 'push must be refused');
    assert.match(p.stderr, /push gate: REFUSED/);
    assert.equal(spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: r.dir, encoding: 'utf8' }).stdout, '', 'nothing reached the remote');
  });
}

test('push gate scans a file the pushed .gitattributes marks -diff or binary, even one deleted again before the push (#693)', { skip }, () => {
  for (const mark of ['-diff', 'binary']) {
    const r = repo();
    r.commit('.gitattributes', `*.txt ${mark}\n`, 'attributes');
    r.commit('notes.txt', 'deployed by secretproject\n', 'add notes');
    r.git('rm', '-q', 'notes.txt');
    r.git('commit', '-q', '-m', 'drop notes');
    const p = r.push();
    assert.notEqual(p.status, 0, `${mark}: push must be refused`);
    assert.match(p.stderr, /private details in what would be pushed:[\s\S]*notes\.txt/, mark);
    assert.equal(spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: r.dir, encoding: 'utf8' }).stdout, '', 'nothing reached the remote');
  }
});

test('push gate scans a file holding a NUL byte for denied terms, in the pushed tip and in a file deleted again before the push (#989)', { skip }, () => {
  const blob = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0xff]), Buffer.from('author=SecretProject;'), Buffer.from([0, 1, 2])]);
  for (const keep of [true, false]) {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    writeFileSync(join(r.dir, 'logo.png'), blob);
    r.git('add', 'logo.png');
    r.git('commit', '-q', '-m', 'add logo');
    if (!keep) {
      r.git('rm', '-q', 'logo.png');
      r.git('commit', '-q', '-m', 'drop logo');
    }
    const p = gateRange(r.dir, base);
    assert.notEqual(p.status, 0, `kept=${keep}: refused`);
    assert.match(p.stderr, /logo\.png: denied term "secretproject" in a binary file/, `kept=${keep}`);
    const hook = r.push();
    assert.notEqual(hook.status, 0, `kept=${keep}: the pre-push hook refuses it too`);
    assert.equal(spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: r.dir, encoding: 'utf8' }).stdout, '', 'nothing reached the remote');
  }
});

/** Deterministic bytes that look compressed (a SHA-256 chain), `n` blocks of 32. */
const noise = (n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => createHash('sha256').update(`block ${i}`).digest()));

/** The gate over one commit adding `file` with `bytes`. */
function gateBinary(file: string, bytes: Buffer) {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, file), bytes);
  r.git('add', file);
  r.git('commit', '-q', '-m', `add ${file}`);
  return gateRange(r.dir, base);
}

/** Compressed-looking bytes with "author: secretproject" in a text run. */
const tagged = () => Buffer.concat([noise(64), Buffer.from([0xfe, 0]), Buffer.from('author: secretproject'), Buffer.from([0, 0xff]), noise(64)]);

test('push gate scans a binary that is only in the pushed tip\'s tree, not in any pushed commit (#989)', { skip }, () => {
  const r = repo();
  writeFileSync(join(r.dir, 'image.png'), tagged());
  r.git('add', 'image.png');
  r.git('commit', '-q', '-m', 'add image');
  const base = r.git('rev-parse', 'HEAD');
  r.commit('ok.md', 'fine\n', 'clean');
  const p = gateRange(r.dir, base);
  assert.notEqual(p.status, 0, 'refused');
  assert.match(p.stderr, /[0-9a-f]{8} image\.png: denied term "secretproject" in a binary file/);
});

test('push gate applies .denylist-allow to a binary: an entry for its path lets it through, one for another path does not (#989)', { skip }, () => {
  for (const [glob, ok] of [['image.png', true], ['other.png', false]] as const) {
    const r = repo();
    r.commit('.denylist-allow', `${glob} secretproject\n`, 'allow');
    const base = r.git('rev-parse', 'HEAD');
    writeFileSync(join(r.dir, 'image.png'), tagged());
    r.git('add', 'image.png');
    r.git('commit', '-q', '-m', 'add image');
    const p = gateRange(r.dir, base);
    if (ok) assert.equal(p.status, 0, `${glob}: ${p.stderr}`);
    else {
      assert.notEqual(p.status, 0, `${glob}: refused`);
      assert.match(p.stderr, /image\.png: denied term "secretproject" in a binary file/, glob);
    }
  }
});

test('push gate allows a binary file whose bytes only look like a denylist pattern: binaries are scanned for hashed terms only (#989)', { skip }, () => {
  const p = gateBinary('data.bin', Buffer.concat([Buffer.from([0, 0x7f]), Buffer.from(` ${['D', '123'].join('')} ${[10, 1, 2, 3].join('.')} `), Buffer.from([0])]));
  assert.equal(p.status, 0, p.stderr);
});

test('push gate allows a short denied term that compressed bytes hold only by chance (#989)', { skip }, () => {
  // Between non-printable bytes, and in a short run of symbols: what a 3-letter term looks like in a compressed image.
  const p = gateBinary('image.png', Buffer.concat([noise(64), Buffer.from([0x9c]), Buffer.from('zqx'), Buffer.from([0x01, 0]), noise(64), Buffer.from([0xfe]), Buffer.from('#zqx]'), Buffer.from([0x02]), noise(64)]));
  assert.equal(p.status, 0, p.stderr);
});

test('push gate refuses a denied term in a text run inside a binary file: a short term in a run of 8 or more, one of 6 letters or more anywhere, UTF-16LE too (#989)', { skip }, () => {
  const cases = [
    ['a short term in a run of text', Buffer.from('built by zqx'), 'zqx'],
    ['a 6-letter term alone between non-printable bytes', Buffer.from('qzxwvk'), 'qzxwvk'],
    ['a term in UTF-16LE text', Buffer.from('author: secretproject', 'utf16le'), 'secretproject'],
    ['a short term in UTF-16LE text', Buffer.from('built by zqx', 'utf16le'), 'zqx'],
  ] as const;
  for (const [what, text, term] of cases) {
    const p = gateBinary('image.png', Buffer.concat([noise(64), Buffer.from([0xfe, 0]), text, Buffer.from([0, 0xff]), noise(64)]));
    assert.notEqual(p.status, 0, `${what}: refused`);
    assert.match(p.stderr, new RegExp(`image\\.png: denied term "${term}" in a binary file`), what);
  }
});

/** `text` between non-printable bytes that are not NUL, in compressed-looking bytes holding a NUL elsewhere. */
const unfenced = (text: Buffer) => Buffer.concat([Buffer.from([0]), noise(64), Buffer.from([0xfe]), text, Buffer.from([0xff]), noise(64)]);

test('push gate pins the binary run minimum: a short term in an ASCII run of exactly 8 is refused, of exactly 7 allowed (#1057)', { skip }, () => {
  const eight = gateBinary('image.png', unfenced(Buffer.from('made zqx')));
  assert.notEqual(eight.status, 0, 'a run of 8: refused');
  assert.match(eight.stderr, /image\.png: denied term "zqx" in a binary file/);
  const seven = gateBinary('image.png', unfenced(Buffer.from('mad zqx')));
  assert.equal(seven.status, 0, `a run of 7: allowed\n${seven.stderr}`);
});

test('push gate refuses a short term in a short ASCII run with a NUL on both sides, and allows one with a NUL on one side only (#1057)', { skip }, () => {
  for (const text of ['zqx', 'a zqx', 'zqx.ok']) {
    const p = gateBinary('data.bin', Buffer.concat([noise(64), Buffer.from([0xfe, 0]), Buffer.from(text), Buffer.from([0, 0xff]), noise(64)]));
    assert.notEqual(p.status, 0, `\\0${text}\\0: refused`);
    assert.match(p.stderr, /data\.bin: denied term "zqx" in a binary file/, text);
  }
  for (const [before, after] of [[0, 0x01], [0x01, 0]]) {
    const p = gateBinary('data.bin', Buffer.concat([noise(64), Buffer.from([0xfe, before!]), Buffer.from('zqx'), Buffer.from([after!, 0xff]), noise(64)]));
    assert.equal(p.status, 0, `NUL on one side (${before}, ${after}): allowed\n${p.stderr}`);
  }
});

test('push gate refuses a denied term in UTF-16BE text inside a binary file, also when no NUL follows its last letter (#1057)', { skip }, () => {
  const be = (s: string) => Buffer.from(s, 'utf16le').swap16();
  for (const [text, term] of [['author: secretproject', 'secretproject'], ['built by zqx', 'zqx']] as const) {
    const p = gateBinary('image.png', unfenced(be(text)));
    assert.notEqual(p.status, 0, `${text}: refused`);
    assert.match(p.stderr, new RegExp(`image\\.png: denied term "${term}" in a binary file`), text);
  }
});

test('push gate reads an added line starting "++ /dev/null" or "++ b/<path>" as content, in a file deleted again before the push (#1057)', { skip }, () => {
  for (const header of ['++ /dev/null', '++ b/package-lock.json']) {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    r.commit('notes.md', `intro\n${header}\ndeployed by secretproject\n`, 'add notes');
    r.git('rm', '-q', 'notes.md');
    r.git('commit', '-q', '-m', 'drop notes');
    const p = gateRange(r.dir, base);
    assert.notEqual(p.status, 0, `${header}: refused`);
    assert.match(p.stderr, /notes\.md:\d+: denied term "secretproject"/, header);
  }
});

test('push gate refuses, by name, a commit diff or a tip file over its read limit rather than failing without one (#1057)', { skip }, () => {
  const r = repo();
  const before = r.git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'big.bin'), Buffer.alloc(257 * 1024 * 1024));
  r.git('add', 'big.bin');
  r.git('commit', '-q', '-m', 'add big');
  const added = r.git('rev-parse', 'HEAD');
  r.commit('ok.md', 'fine\n', 'clean');
  const inCommit = gateRange(r.dir, before);
  assert.notEqual(inCommit.status, 0, 'refused');
  assert.match(inCommit.stderr, new RegExp(`commit ${added.slice(0, 8)}'s diff is over the gate's 256 MiB read limit`));
  const inTree = gateRange(r.dir, added);
  assert.notEqual(inTree.status, 0, 'refused');
  assert.match(inTree.stderr, /[0-9a-f]{8} big\.bin is over the gate's 256 MiB read limit/);
});

test('push gate allows a clean push; the author\'s own sign-off is not a leak; placeholders are fine', { skip }, () => {
  const r = repo();
  r.commit('docs.md', 'paths like /home/example/x and /Users/you/x are placeholders; 192.0.2.5 is documentation\n', 'Add docs\n\nSigned-off-by: Ada <ada@example.com>');
  const p = r.push();
  assert.equal(p.status, 0, p.stderr);
});

test('push gate refuses a committed secret (gitleaks)', { skip }, () => {
  const r = repo();
  r.commit('config.js', `const key = "AKIA${'Z'.repeat(4)}${'Q7W2E9R4T6Y8'}";\nconst secret = "${'wJalrXUtnFEMI/K7MDENG/bPxRfiCY'}EXAMPLEKEY";\n`, 'add config');
  const p = r.push();
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /gitleaks found a secret/);
});

test('push gate fails closed: no gitleaks, no push', { skip: process.platform === 'win32' && 'PATH surgery is POSIX-only here' }, () => {
  const r = repo();
  r.commit('ok.md', 'fine\n', 'fine');
  const node = process.execPath;
  const p = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feature'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PATH: [join(node, '..'), '/usr/bin', '/bin'].join(delimiter) } });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /gitleaks could not run/);
});

test('push gate --range checks exactly the given commits (CI mode)', { skip }, () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('notes.md', 'deployed by secretproject\n');
  const p = spawnSync('node', [gate, '--range', `${base}..HEAD`], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /denied term "secretproject"/);
  assert.equal(spawnSync('node', [gate, '--range', 'nonsense..HEAD'], { cwd: r.dir, encoding: 'utf8' }).status, 1, 'an unresolvable range refuses');
});

// #603: a message whose line 2 isn't blank makes git read the whole first paragraph as the subject (two PRs shipped
// 295- and 617-character subjects that way), and an over-long subject is a paragraph too. Fixing either after a push
// takes a force-push, so the gate refuses them before they leave.
const sized = (n: number) => `Long subject ${'x'.repeat(n - 13)}`;

test('push gate refuses a message with no blank line after the subject, naming the commit and its line 1 (range and hook)', { skip }, () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('ok.md', 'fine\n', 'Add ok\nbody line\n\nSigned-off-by: Ada <ada@example.com>');
  const short = r.git('rev-parse', '--short=8', 'HEAD');
  const p = gateRange(r.dir, base);
  assert.notEqual(p.status, 0, 'refused');
  assert.match(p.stderr, new RegExp(`${short}: line 2 is not blank`));
  assert.match(p.stderr, /line 1: Add ok\n/);
  assert.match(p.stderr, /reword it before pushing/i);
  assert.match(p.stderr, /owner's OK to force-push/);
  const hook = r.push();
  assert.notEqual(hook.status, 0, 'the pre-push hook refuses it too');
  assert.match(hook.stderr, /line 2 is not blank/);
  assert.equal(spawnSync('git', ['ls-remote', 'origin', 'refs/heads/feature'], { cwd: r.dir, encoding: 'utf8' }).stdout, '', 'nothing reached the remote');
});

test('push gate refuses a subject over 180 characters (200 refused, 181 refused) and allows 180 and 100', { skip }, () => {
  for (const [n, ok] of [[200, false], [181, false], [180, true], [100, true]] as const) {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    r.commit('ok.md', 'fine\n', `${sized(n)}\n\nSigned-off-by: Ada <ada@example.com>`);
    assert.equal(r.git('log', '-1', '--format=%s').length, n);
    const p = gateRange(r.dir, base);
    if (ok) assert.equal(p.status, 0, `${n}: ${p.stderr}`);
    else {
      assert.notEqual(p.status, 0, `${n} characters refused`);
      assert.match(p.stderr, new RegExp(`${r.git('rev-parse', '--short=8', 'HEAD')}: the subject is ${n} characters, over 180`));
      assert.match(p.stderr, new RegExp(`line 1: ${sized(n)}\\n`));
    }
  }
});

test('push gate allows a GitHub merge commit, a one-line message, and a subject with only a sign-off after the blank line', { skip }, () => {
  const m = merged('Merge pull request #12 from someone/feat/x\n\nA pull request title').run();
  assert.equal(m.status, 0, m.stderr);
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('a.md', 'fine\n', 'Add a');
  r.commit('b.md', 'fine\n', 'Add b\n\nSigned-off-by: Ada <ada@example.com>');
  r.commit('c.md', 'fine\n', 'Add c\n\nWhy it changed.\nOn two lines.\n\nSigned-off-by: Ada <ada@example.com>');
  const p = gateRange(r.dir, base);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(r.push().status, 0);
});

test('push gate judges only the pushed range: a malformed message already on the remote does not refuse a later push', { skip }, () => {
  const r = repo();
  r.commit('old.md', 'fine\n', 'Old\nrun-on line');
  assert.equal(spawnSync('git', ['push', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/main'], { cwd: r.dir, encoding: 'utf8' }).status, 0);
  const base = r.git('rev-parse', 'HEAD');
  r.commit('new.md', 'fine\n', 'New');
  assert.equal(gateRange(r.dir, base).status, 0);
  const hook = r.push();
  assert.equal(hook.status, 0, hook.stderr);
});

/** The gate over base..HEAD with GITHUB_REPOSITORY set to `ghRepo`, or unset (CI sets the real one). */
function gateRange(dir: string, base: string, ghRepo?: string) {
  const env = { ...process.env };
  delete env.GITHUB_REPOSITORY;
  if (ghRepo) env.GITHUB_REPOSITORY = ghRepo;
  return spawnSync('node', [gate, '--range', `${base}..HEAD`], { cwd: dir, encoding: 'utf8', env });
}

/** A real merge commit on main with message `msg`, the way GitHub's merge button makes one. */
function merged(msg: string) {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('ok.md', 'fine\n', 'fine');
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-ff', 'topic', '-m', msg);
  return { ...r, run: (ghRepo?: string) => gateRange(r.dir, base, ghRepo) };
}

// "secretproject" (a hashed denied term) plays the repo owner's handle; "otherhandle" is another denied handle.
const own = 'secretproject/repo';

test('push gate allows the repo owner in GitHub\'s merge subject (owner from GITHUB_REPOSITORY)', { skip }, () => {
  const p = merged('Merge pull request #12 from secretproject/feat/x\n\nApproved.').run(own);
  assert.equal(p.status, 0, p.stderr);
});

test('push gate takes the repo owner from the origin URL when GITHUB_REPOSITORY is unset', { skip }, () => {
  const r = merged('Merge pull request #12 from secretproject/feat/x');
  r.git('remote', 'set-url', 'origin', 'https://github.com/secretproject/repo.git');
  assert.equal(r.run().status, 0);
  r.git('remote', 'set-url', 'origin', 'ssh://git@github.com/secretproject/repo.git');
  assert.equal(r.run().status, 0);
});

test('push gate still refuses the owner\'s handle anywhere else in a merge message', { skip }, () => {
  const p = merged('Merge pull request #12 from secretproject/feat/x\n\nThanks secretproject.').run(own);
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /COMMIT_MSG:3: denied term "secretproject"/);
  assert.doesNotMatch(p.stderr, /COMMIT_MSG:1:/);
});

test('push gate refuses a different denied owner, another denied term in the subject, or no known owner', { skip }, () => {
  const other = merged('Merge pull request #12 from otherhandle/feat/x').run(own);
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /COMMIT_MSG:1: denied term "otherhandle"/);
  const branch = merged('Merge pull request #12 from secretproject/fix-otherhandle').run(own);
  assert.notEqual(branch.status, 0);
  assert.match(branch.stderr, /COMMIT_MSG:1: denied term "otherhandle"/);
  const unknown = merged('Merge pull request #12 from secretproject/feat/x').run();
  assert.notEqual(unknown.status, 0, 'a local origin names no owner, so nothing is allowed');
  assert.match(unknown.stderr, /COMMIT_MSG:1: denied term "secretproject"/);
});

test('push gate allows the owner only in a real merge commit with the exact subject', { skip }, () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('ok.md', 'fine\n', 'Merge pull request #12 from secretproject/feat/x');
  assert.notEqual(gateRange(r.dir, base, own).status, 0, 'a plain commit wearing the merge subject gets no allowance');
  assert.notEqual(merged('Merge pull request #12 from secretproject/feat/x by hand').run(own).status, 0, 'only the exact GitHub subject');
});

/** A GitHub squash merge: author is the owner's display name, committer is GitHub, body carries the branch's sign-offs. */
function squashed(body: string) {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'ok.md'), 'fine\n');
  r.git('add', 'ok.md');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.com' };
  execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: r.dir, input: body, env });
  return gateRange(r.dir, base, own);
}

// "secretproject" plays the owner's handle in the sign-offs; the commit's own author name is a different display name.
const squashBody = (signOff: string) => `Add ok (#12)\n\n* first step\n\n${signOff}\n\n* second step\n\n${signOff}\n`;

test('push gate allows a squash merge whose sign-offs carry the commit\'s own email under the owner\'s handle', { skip }, () => {
  const p = squashed(squashBody('Signed-off-by: secretproject <ada@example.com>'));
  assert.equal(p.status, 0, p.stderr);
});

test('push gate still scans a sign-off with a different email, and only that one', { skip }, () => {
  const p = squashed('Add ok (#12)\n\n* first step\n\nSigned-off-by: secretproject <ada@example.com>\n\n* second step\n\nSigned-off-by: secretproject <someone@example.com>\n');
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /COMMIT_MSG:9: denied term "secretproject"/);
  assert.doesNotMatch(p.stderr, /COMMIT_MSG:5:/, 'the own-email sign-off is not a hit');
});

test('push gate still refuses the owner\'s handle in prose next to an own sign-off', { skip }, () => {
  const p = squashed('Add ok (#12)\n\nThanks secretproject.\n\nSigned-off-by: secretproject <ada@example.com>\n');
  assert.notEqual(p.status, 0);
  assert.match(p.stderr, /COMMIT_MSG:3: denied term "secretproject"/);
  assert.doesNotMatch(p.stderr, /COMMIT_MSG:5:/);
});

// #576: the repo's attribution is the DCO sign-off only. No Co-Authored-By trailer (whatever the address, even the
// commit's own, which the email scan drops) and no vendor "Generated with" line, in a commit or in a PR body.
const vendorAddress = ['noreply', 'anthropic.com'].join('@');
const attributed = [
  ["a Co-Authored-By trailer with the commit's own email", 'Add ok\n\nCo-Authored-By: Ada <ada@example.com>\nSigned-off-by: Ada <ada@example.com>', 3],
  ['a Co-authored-by trailer with no address', 'Add ok\n\nCo-authored-by: Someone', 3],
  ["a coding agent's no-reply attribution trailer", `Add ok\n\nSigned-off-by: Ada <ada@example.com>\nCo-Authored-By: Claude Opus <${vendorAddress}>`, 4],
  ['a "Generated with Claude Code" line', 'Add ok\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nSigned-off-by: Ada <ada@example.com>', 3],
] as const;

for (const [what, msg, line] of attributed) {
  test(`push gate refuses ${what}: the repo's attribution is the DCO sign-off only`, { skip }, () => {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    r.commit('ok.md', 'fine\n', msg);
    const p = gateRange(r.dir, base);
    assert.notEqual(p.status, 0, 'refused');
    assert.match(p.stderr, new RegExp(`COMMIT_MSG:${line}: vendor attribution`));
    assert.match(p.stderr, /attribution is the DCO sign-off \(git commit -s\) only/);
    const hook = r.push();
    assert.notEqual(hook.status, 0, 'the pre-push hook refuses it too');
    assert.match(hook.stderr, /vendor attribution/);
  });
}

test('push gate allows attribution named in prose, not as a trailer or a "Generated with" line', { skip }, () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.commit('ok.md', 'fine\n', 'Refuse attribution trailers\n\nThe gate refuses a Co-Authored-By: trailer and a Generated with Claude Code line.\n\nSigned-off-by: Ada <ada@example.com>');
  const p = gateRange(r.dir, base);
  assert.equal(p.status, 0, p.stderr);
});

/** The gate's PR-body check over an event payload whose pull_request.body is `body` (as CI's $GITHUB_EVENT_PATH). */
function prBody(body: string | null, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pushgate-pr-'));
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { number: 1, body } }));
  return spawnSync(process.execPath, [gate, '--pr-body'], { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, GITHUB_EVENT_PATH: event, ...env } });
}

test('push gate --pr-body refuses a PR body with vendor attribution, allows one without, and fails closed', () => {
  for (const body of ['Intent.\r\n\r\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\r\n', 'Intent.\n\nCo-Authored-By: Someone']) {
    const p = prBody(body);
    assert.equal(p.status, 1, JSON.stringify(body));
    assert.match(p.stderr, /PR_BODY:3: vendor attribution/);
    assert.match(p.stderr, /attribution is the DCO sign-off \(git commit -s\) only/);
  }
  for (const body of ['**Intent:** refuse a Generated with Claude Code line.\n\nCloses #1', '', null]) assert.equal(prBody(body).status, 0, JSON.stringify(body));
  const unset = prBody('fine', { GITHUB_EVENT_PATH: '' });
  assert.equal(unset.status, 1, 'no event payload: refused, never skipped');
  assert.match(unset.stderr, /GITHUB_EVENT_PATH/);
});

test("CI runs the PR-body check on every PR and every body edit, reading the body from the event payload, never from an expression in the shell line", () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'new-deps.yml'), 'utf8')) as { on: { pull_request: { types: string[] } }; jobs: Record<string, { steps: { run?: string }[] }> };
  assert.ok(wf.on.pull_request.types.includes('edited'), 'an edited body is checked again');
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => /node scripts\/push-gate\.mjs --pr-body\b/.test(s.run ?? ''));
  assert.equal(steps.length, 1);
  assert.doesNotMatch(steps[0]!.run!, /\$\{\{/, 'no expression interpolated into the shell (script injection)');
});
