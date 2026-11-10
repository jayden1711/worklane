// The commit-msg hook (#1259): the push gate's own message rule (scripts/push-gate.mjs --commit-msg), installed by
// scripts/setup-hooks.mjs, refuses a message the gate would refuse before the commit is made, so none is made that
// would then have to be rewritten. The pre-push gate and CI still judge every pushed commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const gate = join(repoRoot, 'scripts', 'push-gate.mjs');
const installer = join(repoRoot, 'scripts', 'setup-hooks.mjs');
const sized = (n: number) => `Long subject ${'x'.repeat(n - 13)}`;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** The hook's verdict on a message file's text: its exit status and what it said. */
function hook(text: string) {
  const d = mkdtempSync(join(tmpdir(), 'commit-msg-'));
  writeFileSync(join(d, 'COMMIT_EDITMSG'), text);
  return spawnSync(process.execPath, [gate, '--commit-msg', join(d, 'COMMIT_EDITMSG')], { encoding: 'utf8' });
}

/** A scratch repo with this repo's denylist patterns, its own author, and no hooks of its own. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'commit-msg-repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']] as const) git('config', k, v);
  const real = JSON.parse(readFileSync(join(repoRoot, '.denylist.json'), 'utf8')) as { patterns: string[] };
  writeFileSync(join(dir, '.denylist.json'), JSON.stringify({ hashed: [sha('secretproject')], patterns: real.patterns }));
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'init');
  return { dir, git };
}

const REFUSED: [string, string, RegExp][] = [
  ['a 181-character subject', sized(181), /the subject is 181 characters, over 180/],
  ['a 213-character subject (#1181, 2026-11-09)', sized(213), /the subject is 213 characters, over 180/],
  ['line 2 not blank', 'Add ok\nbody line\n\nSigned-off-by: Ada <ada@example.com>\n', /line 2 is not blank/],
];
const KEPT: [string, string][] = [
  ['a 180-character subject', `${sized(180)}\n\nSigned-off-by: Ada <ada@example.com>\n`],
  ['a one-line message', 'Add ok\n'],
  ["GitHub's merge commit", 'Merge pull request #12 from a/b\n\nAdd ok\n'],
  ["git's comment lines (stripped before the commit)", 'Add ok\n# Please enter the commit message for your changes.\n#\n# On branch main\n'],
  ['a long line after the scissors (a verbose commit)', `Add ok\n\nbody\n# ------------------------ >8 ------------------------\n${'d'.repeat(300)}\n`],
  ['leading blank lines (stripped)', '\n\nAdd ok\n'],
];

test('the commit-msg hook refuses an over-long subject and a non-blank line 2, and passes a good message (#1259)', () => {
  for (const [what, text, why] of REFUSED) {
    const r = hook(text);
    assert.equal(r.status, 1, `refused: ${what}`);
    assert.match(r.stderr, why, what);
    assert.match(r.stderr, /Nothing was committed; the message is kept in/);
  }
  for (const [what, text] of KEPT) {
    const r = hook(text);
    assert.equal(r.status, 0, `kept: ${what}: ${r.stderr}`);
  }
  const none = spawnSync(process.execPath, [gate, '--commit-msg', join(tmpdir(), 'no-such-message-file')], { encoding: 'utf8' });
  assert.equal(none.status, 1, 'no message file: refused (it fails closed)');
});

test("the commit-msg hook and the push gate refuse a message for the same reason: one rule, the gate's own (#1259)", () => {
  for (const [what, text, why] of REFUSED) {
    const r = repo();
    const base = r.git('rev-parse', 'HEAD');
    writeFileSync(join(r.dir, 'ok.md'), 'fine\n');
    writeFileSync(join(r.dir, '.git', 'MSG'), text);
    r.git('add', 'ok.md');
    r.git('commit', '-q', '--no-verify', '-F', join(r.dir, '.git', 'MSG'));
    const pushed = spawnSync(process.execPath, [gate, '--range', `${base}..HEAD`], { cwd: r.dir, encoding: 'utf8' });
    assert.notEqual(pushed.status, 0, `the gate refuses it: ${what}`);
    assert.match(pushed.stderr, why, `the gate's reason: ${what}`);
    const reason = why.exec(hook(text).stderr)?.[0];
    assert.ok(reason && pushed.stderr.includes(reason), `the same words from both: ${what}`);
  }
  // The code itself: one function holds the rule, and both paths call it (a copy in either would drift).
  const src = readFileSync(gate, 'utf8');
  assert.equal(src.match(/> SUBJECT_MAX\b/g)?.length, 1, 'one length check');
  assert.equal(src.match(/line 2 is not blank/g)?.length, 1, 'one line-2 check');
  const body = (name: string) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));
  assert.match(body('messageShapeProblems'), /> SUBJECT_MAX/);
  assert.match(body('messageShapeProblems'), /line 2 is not blank/);
  assert.match(body('messageShape'), /messageShapeProblems\(message\)/, 'the push path calls it');
  const hookPath = src.slice(src.indexOf("if (process.argv[2] === '--commit-msg')"), src.indexOf("if (process.argv[2] === '--pr-body')"));
  assert.match(hookPath, /messageShapeProblems\(asCommitted\(/, 'the commit-msg path calls it');
});

test('setup-hooks installs the commit-msg hook beside the pre-push hook: a bad message is never committed, a good one is (#1259)', () => {
  const r = repo();
  const install = () => spawnSync(process.execPath, [installer], { cwd: r.dir, encoding: 'utf8' });
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /commit-msg hook installed: .*commit-msg/);
  const hooks = join(r.dir, '.git', 'hooks');
  assert.match(readFileSync(join(hooks, 'commit-msg'), 'utf8'), /^#!\/bin\/sh\n# managed by setup-hooks: commit-msg .*\nexec node "\$\(dirname "\$0"\)\/commit-msg-gate\/scripts\/push-gate\.mjs" --commit-msg "\$1"\n$/);
  assert.equal(readFileSync(join(hooks, 'commit-msg-gate', 'scripts', 'push-gate.mjs'), 'utf8'), readFileSync(gate, 'utf8'), "the gate's own code, not a copy of the rule");
  assert.ok(existsSync(join(hooks, 'commit-msg-gate', 'scripts', 'lib', 'denylist.mjs')), 'with what it imports');
  assert.ok(existsSync(join(hooks, 'pre-push')), 'the pre-push hook stays');
  const head = r.git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'a.md'), 'a\n');
  r.git('add', 'a.md');
  const bad = spawnSync('git', ['commit', '-q', '-m', sized(197)], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'git commit refused');
  assert.match(bad.stderr, /the subject is 197 characters, over 180/);
  assert.equal(r.git('rev-parse', 'HEAD'), head, 'no commit was made');
  const twoLines = spawnSync('git', ['commit', '-q', '-m', 'Add a\nmore'], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(twoLines.status, 0);
  assert.match(twoLines.stderr, /line 2 is not blank/);
  const good = spawnSync('git', ['commit', '-q', '-s', '-m', 'Add a', '-m', 'Why it is added.'], { cwd: r.dir, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.notEqual(r.git('rev-parse', 'HEAD'), head, 'committed');
  // Running it again replaces its own install; another commit-msg hook is refused, and neither hook is touched.
  assert.equal(install().status, 0, 'again');
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\nexit 0\n');
  const prePush = readFileSync(join(hooks, 'pre-push'), 'utf8');
  const foreign = install();
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /is another commit-msg hook/);
  assert.equal(readFileSync(join(hooks, 'commit-msg'), 'utf8'), '#!/bin/sh\nexit 0\n', 'left as it was');
  assert.equal(readFileSync(join(hooks, 'pre-push'), 'utf8'), prePush);
});
