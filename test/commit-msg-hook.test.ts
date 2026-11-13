// The commit-msg hook (#1259): the push gate's own message rule (scripts/push-gate.mjs --commit-msg), installed by
// scripts/setup-hooks.mjs, refuses a message the gate would refuse before the commit is made, so none is made that
// would then have to be rewritten. The pre-push gate and CI still judge every pushed commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { repoRoot } from './helpers.js';

const gate = join(repoRoot, 'scripts', 'push-gate.mjs');
/**
 * The gate as setup-hooks installs it for the commit-msg hook (R1260d D1: its --commit-msg mode runs only from there,
 * `<hooks>/commit-msg-gate/scripts/push-gate.mjs`, never from the checkout or the pre-push launcher's temp copy).
 */
const installedGate = (() => {
  const d = join(mkdtempSync(join(tmpdir(), 'hooks-')), 'commit-msg-gate');
  for (const f of ['scripts/push-gate.mjs', 'scripts/lib/denylist.mjs']) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    copyFileSync(join(repoRoot, f), join(d, f));
  }
  return join(d, 'scripts', 'push-gate.mjs');
})();
const installer = join(repoRoot, 'scripts', 'setup-hooks.mjs');
const sized = (n: number) => `Long subject ${'x'.repeat(n - 13)}`;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** The hook's verdict on a message file's text: its exit status and what it said. */
function hook(text: string) {
  const d = mkdtempSync(join(tmpdir(), 'commit-msg-'));
  writeFileSync(join(d, 'COMMIT_EDITMSG'), text);
  const f = join(d, 'COMMIT_EDITMSG');
  // As the installed stub runs it, for an edited message (git's `strip` cleanup).
  return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { encoding: 'utf8', cwd: d, env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'vi', GIT_DIR: join(d, 'no-repo') } });
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
  const missing = join(tmpdir(), 'no-such-message-file');
  const none = spawnSync(process.execPath, [installedGate, '--commit-msg', missing], { encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: missing } });
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
  const hookPath = src.slice(src.indexOf("if (process.argv[2] === '--commit-msg' &&"), src.indexOf("if (process.argv[2] === '--pr-body')"));
  assert.ok(src.includes("const installedCopy = basename(dirname(dirname(fileURLToPath(import.meta.url)))) === 'commit-msg-gate';"), 'the installed copy, by where it runs from (R1260d D1)');
  // R1260af AF2: on the message's bytes, before any decoding (git checks UTF-8 on what it keeps).
  assert.match(hookPath, /asCommitted\(bytes, mode, c, cut\)/, 'the commit-msg path reads the message as git commits it');
  assert.match(hookPath, /readings\.flatMap\(messageShapeProblems\)/, 'and judges each reading by the one rule');
  assert.match(hookPath, /^if \(process\.argv\[2\] === '--commit-msg' && installedCopy && process\.argv\.length === 4 && process\.env\.PUSH_GATE_COMMIT_MSG === process\.argv\[3\]\)/, "only the installed copy, with the stub's marker (R1260a D2, R1260d D1)");
});

test('setup-hooks installs the commit-msg hook beside the pre-push hook: a bad message is never committed, a good one is (#1259)', () => {
  const r = repo();
  const install = () => spawnSync(process.execPath, [installer], { cwd: r.dir, encoding: 'utf8' });
  const first = install();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /commit-msg hook installed: .*commit-msg/);
  const hooks = join(r.dir, '.git', 'hooks');
  assert.match(readFileSync(join(hooks, 'commit-msg'), 'utf8'), /^#!\/bin\/sh\n# managed by setup-hooks: commit-msg .*\nPUSH_GATE_COMMIT_MSG="\$1" exec node "\$\(dirname "\$0"\)\/commit-msg-gate\/scripts\/push-gate\.mjs" --commit-msg "\$1"\n$/);
  assert.equal(readFileSync(join(hooks, 'commit-msg-gate', 'scripts', 'push-gate.mjs'), 'utf8'), readFileSync(gate, 'utf8'), "the gate's own code, not a copy of the rule");
  assert.ok(existsSync(join(hooks, 'commit-msg-gate', 'scripts', 'lib', 'denylist.mjs')), 'with what it imports');
  assert.ok(existsSync(join(hooks, 'pre-push')), 'the pre-push hook stays');
  assert.match(readFileSync(join(hooks, 'pre-push'), 'utf8'), /exec node "\$\(dirname "\$0"\)\/push-gate-hook\.mjs" --pre-push "\$@"\n$/, 'it marks a push (R1260f F1)');
  const head = r.git('rev-parse', 'HEAD');
  writeFileSync(join(r.dir, 'a.md'), 'a\n');
  r.git('add', 'a.md');
  const bad = spawnSync('git', ['commit', '-q', '-m', sized(197)], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'git commit refused');
  assert.match(bad.stderr, /the subject is 197 characters, over 180/);
  assert.equal(r.git('rev-parse', 'HEAD'), head, 'no commit was made');
  // R1260a/b D1: with -m git keeps a line that starts with #, so a `#NNN: …` subject is the subject.
  const hashed = spawnSync('git', ['commit', '-q', '-m', `#1259: ${sized(190)}`], { cwd: r.dir, encoding: 'utf8' });
  assert.notEqual(hashed.status, 0, 'a #NNN subject over 180: refused');
  assert.match(hashed.stderr, /the subject is 197 characters, over 180/);
  assert.equal(spawnSync('git', ['commit', '-q', '-m', '#1259: short', '-m', sized(190)], { cwd: r.dir, encoding: 'utf8' }).status !== 0, false, 'a short #NNN subject and a long body: committed');
  r.git('reset', '-q', '--soft', 'HEAD~1');
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

const hasGitleaks = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }).status === 0;
const L = 'a'.repeat(200);
/** [name, git config, message file text or null, git commit args (MSG: the file)]. R1260b's msg-mismatch.sh rows. */
type Row = [string, Record<string, string>, string | null, string[], Record<string, string>?];
const ROWS: Row[] = [
  ['ctl-long-subject', {}, null, ['-m', L]],
  ['ctl-ok', {}, null, ['-m', 'Fix the hook', '-m', 'Body.']],
  ['ctl-line2', {}, null, ['-m', 'subj\nline two']],
  ['ctl-editor-strip', {}, 'subj\n#x\n\nbody\n', ['-e', '-F', 'MSG']],
  // -m and -F: git's cleanup is `whitespace`, which keeps a line starting with # (the #1181/#1228 incident's shape).
  ['m-hash-subj-long', {}, null, ['-m', `#1259: ${L}`, '-m', 'Body.']],
  ['m-hash-subj-short', {}, null, ['-m', '#1259: short subject', '-m', L]],
  ['m-hash-line2', {}, null, ['-m', 'subj\n#1259 follow-up']],
  ['F-scissors', {}, 'subj\n# ------------------------ >8 ------------------------\nx\n', ['-F', 'MSG']],
  // core.commentChar and commit.cleanup, from the config the hook can read.
  ['cc-semi-hash-long', { 'core.commentChar': ';', 'commit.cleanup': 'strip' }, `#1259 ${L}\n\nbody\n`, ['-F', 'MSG']],
  ['cc-semi-line2', { 'core.commentChar': ';', 'commit.cleanup': 'strip' }, 'subj\n; a note\n\nbody\n', ['-F', 'MSG']],
  ['cfg-strip-comment', { 'commit.cleanup': 'strip' }, 'subj\n#x\n\nbody\n', ['-F', 'MSG']],
  ['cfg-verbatim', { 'commit.cleanup': 'verbatim' }, 'subj\n#x\n', ['-e', '-F', 'MSG']],
  ['cfg-verbatim-lead', { 'commit.cleanup': 'verbatim' }, '\nsubj\n', ['-F', 'MSG']],
  ['cfg-scissors-unedited', { 'commit.cleanup': 'scissors' }, 'subj\n# ------------------------ >8 ------------------------\nx\n', ['-F', 'MSG']],
  // A BOM or NBSP line is not blank to git.
  ['bom-alone-line1', {}, '﻿\nsubj\n', ['-F', 'MSG']],
  ['nbsp-alone-line1', {}, ' \nsubj\n', ['-F', 'MSG']],
  ['bom-prefix-subj', {}, '﻿subj\n\nbody\n', ['-F', 'MSG']],
  ['crlf', {}, 'subj\r\n\r\nbody\r\n', ['-F', 'MSG']],
  ['crlf-long', {}, `${L}\r\n`, ['-F', 'MSG']],
  ['crlf-verb-line2', {}, 'subj\r\nline2\r\n', ['--cleanup=verbatim', '-F', 'MSG']],
  ['crlf-verb-ok', {}, 'subj\r\n\r\nbody\r\n', ['--cleanup=verbatim', '-F', 'MSG']],
  ['ws-line2', {}, 'subj\n  \t \nbody\n', ['-F', 'MSG']],
  ['ws-line2-verbatim', {}, 'subj\n  \t \nbody\n', ['--cleanup=verbatim', '-F', 'MSG']],
  ['u2028', {}, 'subj second\n', ['-F', 'MSG']],
  ['nbsp-line2', {}, 'subj\n \nbody\n', ['-F', 'MSG']],
  ['cr-only-line2', {}, 'subj\rline2\n', ['-F', 'MSG']],
  // core.commentChar=auto (R1260c D1, R1260d D2): git picks the first of #;@!$%^&|: that starts no line, so a #NNN line
  // is kept when the message has one.
  ['auto-e-hash-long', { 'core.commentChar': 'auto' }, null, ['-e', '-m', `#1259: ${L}`, '-m', 'Body.']],
  ['auto-e-hash-short', { 'core.commentChar': 'auto' }, null, ['-e', '-m', '#1259: short subject', '-m', L]],
  ['auto-e-hash-line2', { 'core.commentChar': 'auto' }, null, ['-e', '-m', 'subj\n#1259 follow-up']],
  ['auto-F-e-hashlong', { 'core.commentChar': 'auto' }, `#1259: ${L}\n\nbody\n`, ['-e', '-F', 'MSG']],
  ['auto-m-hash-long', { 'core.commentChar': 'auto' }, null, ['-m', `#1259: ${L}`]],
  ['auto-e-plain', { 'core.commentChar': 'auto' }, null, ['-e', '-m', 'subj', '-m', 'body']],
  // No help lines to read git's choice from (commit.status=false): both readings, refused if either fails.
  ['auto-nostatus-hash-long', { 'core.commentChar': 'auto', 'commit.status': 'false' }, null, ['-e', '-m', `#1259: ${L}`]],
  ['auto-nostatus-plain', { 'core.commentChar': 'auto', 'commit.status': 'false' }, null, ['-e', '-m', 'subj', '-m', 'body']],
  // A message's own trailing lines with one candidate are no help block (R1260e D1, R1260f F2): no bare line, or none written.
  ['auto-nostatus-semi3', { 'core.commentChar': 'auto', 'commit.status': 'false' }, 'subj\n; a\n; b\n; c\n', ['-e', '-F', 'MSG']],
  ['auto-nostatus-hash3', { 'core.commentChar': 'auto', 'commit.status': 'false' }, 'subj\n#1259\n#1260\n#1261\n', ['-e', '-F', 'MSG']],
  ['auto-cli-nostatus-semi3', { 'core.commentChar': 'auto' }, 'subj\n; a\n; b\n; c\n', ['-e', '--no-status', '-F', 'MSG']],
  ['auto-status-hash3', { 'core.commentChar': 'auto' }, 'subj\n#1259\n#1260\n#1261\n', ['-e', '-F', 'MSG']],
  ['auto-nostatus-hash-block', { 'core.commentChar': 'auto', 'commit.status': 'false' }, `#1259: ${L}\n\n#a\n#b\n#c\n`, ['-e', '-F', 'MSG']],
  // A scissors line the user typed: git cuts only with -v or cleanup=scissors (R1260f F3).
  ['ctl-cc-hash-sciss', {}, 'subj\n# ------------------------ >8 ------------------------\nx\n', ['-e', '-F', 'MSG']],
  ['auto-hash-sciss', { 'core.commentChar': 'auto' }, 'subj\n# ------------------------ >8 ------------------------\nx\n', ['-e', '-F', 'MSG']],
  ['auto-semi-sciss', { 'core.commentChar': 'auto' }, 'subj\n; ------------------------ >8 ------------------------\nx\n', ['-e', '-F', 'MSG']],
  ['sciss-line3', {}, 'subj\n\n# ------------------------ >8 ------------------------\nx\n', ['-e', '-F', 'MSG']],
  ['ctl-verbose', {}, null, ['-e', '-v', '-m', 'subj', '-m', 'body']],
  ['cfg-scissors-edited', { 'commit.cleanup': 'scissors' }, 'subj\n# ------------------------ >8 ------------------------\nx\n', ['-e', '-F', 'MSG']],
  ['auto-e-verbose', { 'core.commentChar': 'auto' }, null, ['-e', '-v', '-m', '#1259: short subject', '-m', 'body']],
  // core.commentString (git 2.45+, whichever of the two is set last; older git reads core.commentChar alone: R1260c D2).
  ['cs-slash-e-long', { 'core.commentString': '//' }, `// note\n${L}\n`, ['-e', '-F', 'MSG']],
  ['cs-slash-e-hash', { 'core.commentString': '//' }, 'subj\n#x\n\nbody\n', ['-e', '-F', 'MSG']],
  ['cs-then-char', { 'core.commentString': '//', 'core.commentChar': ';' }, 'subj\n; note\n\nbody\n', ['-e', '-F', 'MSG']],
  // R1260ac D3, R1260ad D3: a comment string is matched whole: `/x` isn't a `//` comment (git 2.45+).
  ['cs-slash-one', { 'core.commentString': '//' }, `/x ${L}\nsubj\n\nbody\n`, ['-e', '-F', 'MSG']],
  // A --cleanup= on the command line, which no hook can see (stated in CONTRIBUTING): judged by the default mode.
  ['cli-strip-comment', {}, 'subj\n#x\n\nbody\n', ['--cleanup=strip', '-F', 'MSG']],
  ['cli-semi-line2', { 'core.commentChar': ';' }, 'subj\n; a note\n\nbody\n', ['--cleanup=strip', '-F', 'MSG']],
  ['cli-verbatim-lead', {}, '\nsubj\n', ['--cleanup=verbatim', '-F', 'MSG']],
  // R1260i D1, R1260j D1: `auto` in any case.
  ['auto-Auto', { 'core.commentChar': 'Auto' }, '# Fix the thing\n\nLong explanation line one\nline two\n', ['-e', '-F', 'MSG']],
  ['auto-AUTO', { 'core.commentChar': 'AUTO' }, '# Fix the thing\n\nLong explanation line one\nline two\n', ['-e', '-F', 'MSG']],
  ['auto-aUtO-long', { 'core.commentChar': 'aUtO' }, `# Fix the thing\n\n${L}\n`, ['-e', '-F', 'MSG']],
  // R1260i D2: a scissors line at the end with no newline after it isn't git's cut line.
  ['sciss-noeol', { 'commit.cleanup': 'scissors' }, 'Subject\n# ------------------------ >8 ------------------------', ['-e', '-F', 'MSG']],
  ['sciss-noeol-semi', { 'commit.cleanup': 'scissors', 'core.commentChar': ';' }, 'Subject\n; ------------------------ >8 ------------------------', ['-e', '-F', 'MSG']],
  ['ctl-sciss-eol', { 'commit.cleanup': 'scissors' }, 'Subject\n# ------------------------ >8 ------------------------\n', ['-e', '-F', 'MSG']],
  // R1260j D2: a commit encoding other than UTF-8, its log read as UTF-8: 100 two-byte characters are 200 to the gate.
  ['enc-logout', { 'i18n.commitEncoding': 'ISO-8859-1', 'i18n.logOutputEncoding': 'UTF-8' }, `${'\u00e9'.repeat(100)}\n`, ['-F', 'MSG']],
  ['enc-logout-e', { 'i18n.commitEncoding': 'ISO-8859-1', 'i18n.logOutputEncoding': 'UTF-8' }, `${'\u00e9'.repeat(100)}\n`, ['-e', '-F', 'MSG']],
  ['enc-repo', { 'i18n.commitEncoding': 'ISO-8859-1' }, `${'\u00e9'.repeat(100)}\n`, ['-F', 'MSG']],
  // R1260m D1, R1260n D1: a noncharacter is valid UTF-8, but git rewrites its bytes: 61 x U+FDD0 commit as 183.
  ['nonchar-fdd0', {}, `${'\ufdd0'.repeat(61)}\n`, ['-F', 'MSG']],
  // R1260r D1: an empty or blank i18n.commitEncoding: git writes `encoding ` (or `encoding  `), which the gate refuses.
  ['enc-empty', { 'i18n.commitEncoding': '' }, null, ['-m', 'Add a thing']],
  ['enc-blank', { 'i18n.commitEncoding': ' ' }, null, ['-m', 'Add a thing']],
  // R1260r D2: a CR in the identity git writes in the author or committer header, which the gate refuses.
  ['ident-cr-author', {}, null, ['-m', 'Add a thing'], { GIT_AUTHOR_NAME: 'Ada\rEve' }],
  ['ident-cr-committer', {}, null, ['-m', 'Add a thing'], { GIT_COMMITTER_NAME: 'Ada\rEve' }],
  ['ident-utf8-author', {}, null, ['-m', 'Add a thing'], { GIT_AUTHOR_NAME: 'Jos\u00e9 Ni\u00f1o' }],
  ['enc-utf8', {}, `${'\u00e9'.repeat(100)}\n`, ['-F', 'MSG']],
  // R1260j D3: more --cleanup= on the command line, which no hook can see.
  ['cli-strip-F', {}, `# c\n\n${L}\n`, ['--cleanup=strip', '-F', 'MSG']],
  ['cli-strip-m', {}, null, ['--cleanup=strip', '-m', '# c', '-m', L]],
  ['cli-scissors-e', {}, 'subj\n# note\n\nbody\n', ['-e', '--cleanup=scissors', '-F', 'MSG']],
  ['cli-whitespace-e', {}, 'subj\n# note\n\nbody\n', ['-e', '--cleanup=whitespace', '-F', 'MSG']],
  // A GIT_EDITOR=':' the user set (R1260d D3): git edits (-e) and strips; the hook reads git's own "not edited" signal.
  ['user-editor-colon', {}, `# c\n\n${L}\n`, ['-e', '-F', 'MSG'], { GIT_EDITOR: ':' }],
  ['user-colon-l2', {}, 'subj\n# note\n\nbody\n', ['-e', '-F', 'MSG'], { GIT_EDITOR: ':' }],
];
/** The rows the hook can't judge as the gate does: a --cleanup= on the command line (a fix shows up here). */
const CLI_RESIDUAL: Record<string, string> = { 'cli-strip-comment': 'hook=refuse gate=pass', 'cli-semi-line2': 'hook=refuse gate=pass', 'cli-verbatim-lead': 'hook=pass gate=refuse', 'user-editor-colon': 'hook=pass gate=refuse', 'user-colon-l2': 'hook=refuse gate=pass', 'cli-strip-F': 'hook=pass gate=refuse', 'cli-strip-m': 'hook=pass gate=refuse', 'cli-scissors-e': 'hook=pass gate=refuse', 'cli-whitespace-e': 'hook=pass gate=refuse' };

test("the commit-msg hook and the push gate agree on what git commits, by git's cleanup mode (#1260 R1260a/b D1: msg-mismatch.sh's rows)", { skip: !hasGitleaks && 'gitleaks not installed', timeout: 300_000 }, () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_EDITOR: 'true' };
  delete (env as Record<string, string | undefined>).GIT_DIR;
  const seen: string[] = [];
  for (const [name, cfg, body, args, rowEnv] of ROWS) {
    const a = repo();
    const b = repo();
    for (const [k, v] of Object.entries(cfg)) for (const r of [a, b]) r.git('config', k, v);
    const inst = spawnSync(process.execPath, [installer], { cwd: a.dir, encoding: 'utf8' });
    assert.equal(inst.status, 0, inst.stderr);
    const file = join(a.dir, '..', `${name}.msg`);
    if (body !== null) writeFileSync(file, body);
    const argv = args.map((x) => (x === 'MSG' ? file : x));
    const hookOk = spawnSync('git', ['commit', '-q', '--allow-empty', ...argv], { cwd: a.dir, encoding: 'utf8', env: { ...env, ...rowEnv } }).status === 0;
    const made = spawnSync('git', ['commit', '-q', '--allow-empty', '--no-verify', ...argv], { cwd: b.dir, encoding: 'utf8', env: { ...env, ...rowEnv } });
    assert.equal(made.status, 0, `${name}: git made the commit: ${made.stderr}`);
    const g = spawnSync(process.execPath, [gate, '--range', 'HEAD~1..HEAD'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(b.dir, '.git') } });
    // A commit encoding but UTF-8 is refused outright by the gate (R1260m D2, R1260n D2), as by the hook.
    if (g.status !== 0) assert.match(g.stderr, /subject is not one short line|declares its message encoding as|header has a CR or a NUL|header has bytes that aren't valid UTF-8/, `${name}: the gate refused for the message's shape, its encoding or its header, not something else: ${g.stderr}`);
    const verdict = `hook=${hookOk ? 'pass' : 'refuse'} gate=${g.status === 0 ? 'pass' : 'refuse'}`;
    if (name in CLI_RESIDUAL) assert.equal(verdict, CLI_RESIDUAL[name], `${name}: the stated residual`);
    // R1260g/h: with core.commentChar=auto the hook can't know git's pick, so it judges every reading: it may refuse
    // what git would commit (fail-safe), never pass what the gate refuses.
    else if (hookOk && g.status !== 0) seen.push(`${name}: ${verdict}`);
    else if (!hookOk && g.status === 0 && (cfg['core.commentChar'] ?? '').toLowerCase() !== 'auto' && !cfg['i18n.commitEncoding']) seen.push(`${name}: ${verdict}`);
  }
  assert.deepEqual(seen, [], "every row agrees with the gate, but auto's and a commit encoding's, which may only refuse more");
});

test("every ASCII byte and the non-ASCII spaces: the hook and the gate give the same verdict on what git commits, in each spot where git's whitespace rule decides, as an editor writes it and as -F gives it (#1260 R1260x D1, R1260y/z D1)", { skip: !hasGitleaks && 'gitleaks not installed', timeout: 900_000 }, () => {
  // R1260x D1: the hook took a form feed and a vertical tab for whitespace; git's isspace doesn't. Rather than a second
  // list, every byte goes through both: real commits with the installed hook (a), the same with --no-verify (b), and
  // the gate once over b's commits.
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_EDITOR: 'true' };
  delete (env as Record<string, string | undefined>).GIT_DIR;
  const a = repo();
  const b = repo();
  const inst = spawnSync(process.execPath, [installer], { cwd: a.dir, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const base = b.git('rev-parse', 'HEAD');
  // Every ASCII byte, the non-ASCII spaces, and runs of git's own whitespace (R1260y/z D1: space, tab and CR mixed);
  // and a comment character after leading whitespace, which is no comment to git (R1260aa D1).
  const chars = [...Array(0x80).keys()].map((n) => String.fromCharCode(n)).concat(['\u00a0', '\ufeff', '\u0085', '\u2028', '\u3000', '\u200b', '  ', '\t\t', ' \t', '\t ', ' \r', '\r\r', '\t\r', ' \t\r', '\r \t', '\f ', ' \v', ' #', '\t#', ' ;']);
  const spots: [string, (c: string) => string][] = [
    ['a line before the subject', (c) => `${c}\nAdd a thing\n\nBody\n`],
    ["a 180-character subject's end", (c) => `${'S'.repeat(180)}${c}\n\nBody\n`],
    ['line 2', (c) => `Add a thing\n${c}\nBody\n`],
    ["the body's end", (c) => `Add a thing\n\nBody${c}\n`],
    // R1260ac D1-D3, R1260ad D1: around a comment line and git's scissors line, where only an exact match counts.
    ['before a comment line', (c) => `${c}# note\nAdd a thing\n\nBody\n`],
    ["the scissors line's end", (c) => `Add a thing\n# ------------------------ >8 ------------------------${c}\nmore\n`],
    ['before the scissors line', (c) => `Add a thing\n${c}# ------------------------ >8 ------------------------\nmore\n`],
  ];
  const atScissors = (spot: string) => spot.includes('scissors line');
  // R1260y/z D1: with -F (or -m, or -e with an editor that changes nothing) git cleans the message BEFORE the hook
  // reads it, so the hook's model of git's cleanup only meets unclean text when an editor writes the message. So: an
  // editor that writes it (no -F), under git's strip cleanup and under commit.cleanup=whitespace; and -F, pre-cleaned
  // (git runs the hook with GIT_EDITOR=':', the whitespace mode).
  const file = join(a.dir, '..', 'walk.msg');
  const editor = { GIT_EDITOR: `cp '${file}'` };
  // Every character under the editor's strip; under the other two, those where whitespace or a comment decides
  // (controls, space, DEL, `#`, `;`, the non-ASCII spaces and the runs): a letter reads the same in every mode.
  const decides = (c: string) => [...c].every((x) => x.codePointAt(0)! <= 0x20 || x.codePointAt(0)! >= 0x7f || x === '#' || x === ';');
  const modes: [string, string[], string[], Record<string, string>, (c: string) => boolean][] = [
    ['an editor, strip', [], [], editor, () => true],
    ['an editor, commit.cleanup=whitespace', ['-c', 'commit.cleanup=whitespace'], [], editor, decides],
    ['-F, pre-cleaned', [], ['-F', file], {}, decides],
    ['an editor, commit.cleanup=scissors', ['-c', 'commit.cleanup=scissors'], [], editor, decides],
  ];
  // The scissors spots under the editor's strip and commit.cleanup=scissors, for the characters where whitespace or a
  // comment decides; the scissors mode nowhere else (it reads as whitespace without a scissors line, which the whitespace mode walks:
  // R1260af AF3).
  const runs = (spot: string, mode: string, c: string) =>
    atScissors(spot) ? (mode === 'an editor, strip' || mode.includes('scissors')) && decides(c) : !mode.includes('scissors');
  const cases: { name: string; hookOk: boolean; sha: string | null }[] = [];
  for (const c of chars) {
    for (const [spot, make] of spots) {
      for (const [mode, pre, args, modeEnv, takes] of modes) {
        if (!takes(c) || !runs(spot, mode, c)) continue;
        writeFileSync(file, make(c));
        const name = `${[...c].map((x) => `U+${x.codePointAt(0)!.toString(16).padStart(4, '0')}`).join('+')} at ${spot}, ${mode}`;
        const hookOk = spawnSync('git', [...pre, 'commit', '-q', '--allow-empty', ...args], { cwd: a.dir, env: { ...env, ...modeEnv } }).status === 0;
        const made = spawnSync('git', [...pre, 'commit', '-q', '--allow-empty', '--no-verify', ...args], { cwd: b.dir, env: { ...env, ...modeEnv }, encoding: 'utf8' });
        cases.push({ name, hookOk, sha: made.status === 0 ? b.git('rev-parse', 'HEAD') : null });
      }
    }
  }
  // The gate over b's commits, 40 at a time: one run's list of refused commits can outgrow what it writes before it
  // exits (measured: one run over the walk's 798 commits named 427;
  // #1274, stderr lost at process.exit on macOS), so a long list would read as passes.
  const made = cases.filter((k) => k.sha).map((k) => k.sha!);
  const refused = new Set<string>();
  for (let i = 0; i < made.length; i += 40) {
    const chunk = made.slice(i, i + 40);
    const from = i === 0 ? base : made[i - 1]!;
    const g = spawnSync(process.execPath, [gate, '--range', `${from}..${chunk.at(-1)!}`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(b.dir, '.git') } });
    const named = chunk.filter((x) => g.stderr.includes(x.slice(0, 8)));
    assert.equal(g.status === 0, named.length === 0, `the gate's status matches the commits it names: ${g.stderr.slice(0, 300)}`);
    for (const x of named) refused.add(x);
  }
  const differ: string[] = [];
  for (const k of cases) {
    // git itself won't make it (a NUL): the hook can't have passed it either.
    if (k.sha === null) {
      if (k.hookOk) differ.push(`${k.name}: hook pass, git refused the commit`);
      continue;
    }
    const gateOk = !refused.has(k.sha);
    if (k.hookOk !== gateOk) differ.push(`${k.name}: hook ${k.hookOk ? 'pass' : 'refuse'}, gate ${gateOk ? 'pass' : 'refuse'}`);
  }
  // Every commit git refused has a NUL (under strip, a NUL at the scissors line's end is in a comment line, which git
  // strips, so git commits it: R1260ae D1).
  assert.deepEqual(cases.filter((k) => !k.sha && !k.name.startsWith('U+0000 ')).map((k) => k.name), [], 'git refused only commits with a NUL');
  assert.ok(cases.some((k) => !k.sha), 'and it did refuse some');
  assert.ok(cases.some((k) => !k.hookOk) && cases.some((k) => k.hookOk), 'both verdicts occur');
  assert.deepEqual(differ, [], 'the same verdict for every byte, spot and mode');
});

test("git commit -v (on the command line or by commit.verbose) is recognised by git's own verbose block, in every cleanup mode, verbatim included; --no-verbose writes none, so both readings are judged; a typed copy of the block without -v is the stated residual (#1260 R1260af AF1, AF2, R1260ag, R1260ah", { skip: !hasGitleaks && 'gitleaks not installed', timeout: 300_000 }, () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com' };
  delete (env as Record<string, string | undefined>).GIT_DIR;
  // An editor that types the message on git's line 1 and leaves the rest (help, scissors line, diff), as a person does.
  const editor = (msg: string) => ({ GIT_EDITOR: `f() { printf '%s' '${msg}' | cat - "$1" > "$1.n" && mv "$1.n" "$1"; }; f` });
  // An editor that writes the message, then keeps git's buffer only from its scissors line down (a verbatim user drops
  // git's help lines above it, or they are committed: R1260ah).
  const dropHelp = (msg: string) => ({ GIT_EDITOR: `f() { { printf '%s\\n' '${msg}'; awk 'k || /^# -+ >8 -+$/ { k = 1; print }' "$1"; } > "$1.n" && mv "$1.n" "$1"; }; f` });
  const run = (cfg: Record<string, string>, staged: Buffer, msg: string, args: string[], ed = editor) => {
    const a = repo();
    const b = repo();
    for (const [k, v] of Object.entries(cfg)) for (const r of [a, b]) r.git('config', k, v);
    assert.equal(spawnSync(process.execPath, [installer], { cwd: a.dir, encoding: 'utf8' }).status, 0);
    for (const r of [a, b]) {
      writeFileSync(join(r.dir, 'f.txt'), staged);
      r.git('add', 'f.txt');
    }
    const e = { ...env, ...ed(msg) };
    const hook = spawnSync('git', ['commit', '-q', ...args], { cwd: a.dir, encoding: 'utf8', env: e });
    const made = spawnSync('git', ['commit', '-q', '--no-verify', ...args], { cwd: b.dir, encoding: 'utf8', env: e });
    assert.equal(made.status, 0, `git made the commit: ${made.stderr}`);
    const g = spawnSync(process.execPath, [gate, '--range', 'HEAD~1..HEAD'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(b.dir, '.git') } });
    return { verdict: `hook=${hook.status === 0 ? 'pass' : 'refuse'} gate=${g.status === 0 ? 'pass' : 'refuse'}`, stored: b.git('log', '-1', '--format=%B'), hook: hook.stderr };
  };
  const text = Buffer.from('hello\n');
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const nonchar = Buffer.from('a \ufdd0 b\n', 'utf8');
  // AF1: a one-line message under commit.verbose, in each cleanup mode: git cuts at its scissors line, and so does the hook.
  // Under whitespace cleanup git keeps comment lines, so its own help lines above the cut are committed as text: line 2
  // isn't blank, and hook and gate both refuse (they agree). Under scissors cleanup git writes the cut line first, so
  // its help is below it and goes with the cut.
  for (const [cleanup, want] of [[null, 'hook=pass gate=pass'], ['strip', 'hook=pass gate=pass'], ['whitespace', 'hook=refuse gate=refuse'], ['scissors', 'hook=pass gate=pass']] as const) {
    const cfg = { 'commit.verbose': 'true', ...(cleanup ? { 'commit.cleanup': cleanup } : {}) };
    const r = run(cfg, text, 'Add a thing', []);
    assert.equal(r.verdict, want, `commit.verbose, cleanup ${cleanup ?? 'default'}: ${r.hook}`);
    if (want === 'hook=pass gate=pass') assert.equal(r.stored.trim(), 'Add a thing', 'git committed the one line');
  }
  assert.equal(run({ 'commit.verbose': '1' }, text, 'Add a thing', []).verdict, 'hook=pass gate=pass', 'commit.verbose as a count');
  // AF2: a diff below the cut that isn't UTF-8, or holds a noncharacter: git drops it, and so does the hook.
  for (const [what, staged] of [['Latin-1 bytes', latin1], ['a noncharacter', nonchar]] as const) {
    const r = run({ 'commit.verbose': 'true' }, staged, 'Add a thing\n\nWhy it is added.', []);
    assert.equal(r.verdict, 'hook=pass gate=pass', `a diff with ${what}: ${r.hook}`);
  }
  // -v on the command line: the hook recognises git's own verbose block (its scissors line and two fixed help lines), so
  // it cuts there as git does: a one-line message, and a diff that isn't UTF-8, pass hook and gate alike.
  const cli = run({}, text, 'Add a thing', ['-v']);
  assert.equal(cli.verdict, 'hook=pass gate=pass', `command-line -v, a one-line message: ${cli.hook}`);
  assert.equal(cli.stored.trim(), 'Add a thing');
  assert.equal(run({}, latin1, 'Add a thing\n\nWhy it is added.', ['-v']).verdict, 'hook=pass gate=pass', 'command-line -v, a Latin-1 diff');
  // R1260ah D1: commit.cleanup=verbatim with -v or commit.verbose: git still cuts at its scissors line, and so does the
  // hook; without either, git writes no scissors line and the message is its own.
  for (const [what, cfg, args] of [['-v', { 'commit.cleanup': 'verbatim' }, ['-v']], ['commit.verbose', { 'commit.cleanup': 'verbatim', 'commit.verbose': 'true' }, []], ['neither', { 'commit.cleanup': 'verbatim' }, []]] as const) {
    const r = run(cfg, text, 'Add a thing', [...args], dropHelp);
    assert.equal(r.verdict, 'hook=pass gate=pass', `verbatim, ${what}: ${r.hook}`);
    assert.equal(r.stored.trim(), 'Add a thing', `verbatim, ${what}: git committed the one line`);
  }
  assert.equal(run({ 'commit.cleanup': 'verbatim' }, latin1, 'Add a thing\n\nWhy it is added.', ['-v'], dropHelp).verdict, 'hook=pass gate=pass', 'verbatim, -v, a Latin-1 diff');
  // R1260ag D2: commit.verbose with --no-verbose writes no block and git doesn't cut: a typed scissors line is a comment,
  // so the line after it is line 2, for the hook as for the gate.
  const scissorsLine = '# ------------------------ >8 ------------------------';
  const noVerbose = run({ 'commit.verbose': 'true' }, text, `Add a thing\n${scissorsLine}\nline two`, ['--no-verbose']);
  assert.equal(noVerbose.verdict, 'hook=refuse gate=refuse', `commit.verbose with --no-verbose and a typed scissors line: they agree (${noVerbose.hook})`);
  // The converse, stated: commit.verbose and a scissors line typed where git's block isn't (an editor that replaced git's
  // buffer, or -m): git cuts there and the gate passes, but the hook, seeing no block, judges both readings and refuses.
  // The hook can't tell this from --no-verbose (R1260ag D2), so one of the two is a stated case.
  const typedOnly = run({ 'commit.verbose': 'true' }, text, '', ['-m', `Add a thing\n${scissorsLine}\nline two`]);
  assert.equal(typedOnly.verdict, 'hook=refuse gate=pass', 'commit.verbose, a typed scissors line and no git block: the stated refusal');
  // The stated residual: the same three lines typed by hand into a commit made without -v read as verbose: the hook cuts
  // there, git doesn't, and the gate refuses the line below them as line 2.
  const block = '# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\n# Everything below it will be ignored.';
  const typed = run({}, text, `Add a thing\n${block}\nline two\n`, []);
  assert.equal(typed.verdict, 'hook=pass gate=refuse', `a typed copy of git's verbose block: the stated residual (${typed.stored.split('\n').slice(0, 2).join(' / ')})`);
});

test("core.commentChar=auto: the hook can't know git's pick (git takes it from the message before the editor ran), so it judges every reading and refuses when any fails (#1260 R1260g D1, R1260h D1-D3)", () => {
  const r = repo();
  r.git('config', 'core.commentChar', 'auto');
  const judge = (text: string) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, text);
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git') } }).status;
  };
  const help = (c: string) => `${c} Please enter the commit message for your changes. Lines starting\n${c} with '${c}' will be ignored, and an empty message aborts the commit.\n${c}\n${c} On branch main\n`;
  const L = 'a'.repeat(200);
  // Refused: a reading git may commit fails, whichever it picks.
  for (const [what, text] of [
    ['g D1 / h D1: an edited message, no help block', 'subj\n#1259 x\n\n#\n#1260 a\n#1261 b\n'],
    ['h D2: a typed ; block and scissors line above -v', `Subject\n;\n\n;a\n;\n;b\n; ------------------------ >8 ------------------------\n`],
    ['h D3: the message\'s own bare-char block, status off', 'subj\n#1259 x\n\n#\n#1260 a\n#1261 b\n'],
    ['a ; line over a long line: a git that picks ; commits it as the subject', `; x\n\n${L}\n`],
    ['issue lines under the subject', 'subj\n#1259\n#1260\n#1261\n'],
    ["2.56's layout: # help under a # line (refused though 2.56 commits subj: fail-safe)", `subj\n#1259 follow-up\n\n${help('#')}`],
    ['a long #NNN subject', `#1259: ${L}\n\nBody.\n\n${help(';')}`],
    ['an empty template edited on line 1 (the help lines read as text in one reading: stated)', `subj\n${help('#')}`],
  ] as const) assert.equal(judge(text), 1, `refused: ${what}`);
  // R1260ac D2, R1260ad D2: each of git's ten candidates, on line 1 and after blank lines: a reading where git picked it
  // strips the line and commits the long one as the subject.
  for (const c of '#;@!$%^&|:') {
    assert.equal(judge(`${c} x\n\n${L}\n`), 1, `refused: ${c} on line 1 over a long line`);
    assert.equal(judge(`\n\n${c} x\n\n${L}\n`), 1, `refused: ${c} after blank lines, over a long line`);
  }
  // Kept: every reading passes.
  for (const [what, text] of [
    ['a plain message', 'subj\n\nbody\n'],
    ['a plain message under the help block', `subj\n\nbody\n\n${help('#')}`],
    ['a # block after a blank line', 'subj\n\n#1259\n#1260\n'],
    ['a short #NNN subject, then a blank line', `#1259: short subject\n\nbody\n\n${help(';')}`],
    ['-v: the help and git scissors line below a blank line', `subj\n\nbody\n\n${help('#')}# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+x\n`],
  ] as const) assert.equal(judge(text), 0, `kept: ${what}`);
  // R1260h D2: with a set character too, a typed scissors line above git's (-v): strip mode can't tell, so it judges
  // the uncut reading too, where x is line 2.
  r.git('config', 'core.commentChar', '#');
  assert.equal(judge('subj\n# ------------------------ >8 ------------------------\nx\n\n# ------------------------ >8 ------------------------\ndiff\n'), 1, 'a typed scissors line: x may be line 2');
});

test("git-independent: auto in any case, git's cut-line match, and a commit encoding's two decodings (#1260 R1260i D1, D2, R1260j D1, D2)", () => {
  const r = repo();
  const judge = (text: string | Buffer, env: Record<string, string> = {}) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, text);
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git'), ...env } });
  };
  for (const v of ['Auto', 'AUTO', 'aUtO']) {
    r.git('config', 'core.commentChar', v);
    assert.equal(judge('# Fix the thing\n\nLong explanation line one\nline two\n').status, 1, `${v}: every reading, the heading stripped in one`);
  }
  r.git('config', '--unset', 'core.commentChar');
  r.git('config', 'commit.cleanup', 'scissors');
  assert.equal(judge('Subject\n# ------------------------ >8 ------------------------').status, 1, 'no newline after it: no cut, so line 2');
  assert.equal(judge('Subject\n# ------------------------ >8 ------------------------\n').status, 0, 'with the newline: cut');
  r.git('config', '--unset', 'commit.cleanup');
  r.git('config', 'i18n.commitEncoding', 'ISO-8859-1');
  assert.equal(judge(`${'é'.repeat(100)}\n`).status, 1, 'Latin-1: 200 characters to the gate');
  assert.equal(judge(`${'e'.repeat(100)}\n`).status, 1, 'any message under a commit encoding but UTF-8: refused (R1260k D3, R1260l D1)');
  r.git('config', 'i18n.commitEncoding', 'x-no-such-encoding');
  const unknown = judge('ok\n');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /i18n\.commitEncoding is x-no-such-encoding: set i18n\.commitEncoding to UTF-8 or unset it/);
});

test('the hook fails closed on a comment setting or an encoding it would have to model; the gate reads the raw commit, whatever the log settings (#1260 R1260k D1-D3, R1260l D1, D2)', (t) => {
  const r = repo();
  const judge = (text: string | Buffer) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, text);
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git') } });
  };
  // k D1, D2: a comment setting that isn't auto or printable ASCII with no whitespace.
  // R1260u D2: whether git itself accepts the value depends on its version (before 2.45, any core.commentChar but one
  // ASCII character is a fatal config error for every git, `git commit` included). Where git refuses it, the hook
  // refuses with git's own error (R1260s D2) and no commit could be made anyway.
  const gitAccepts = () => spawnSync('git', ['-C', r.dir, 'var', 'GIT_AUTHOR_IDENT'], { stdio: 'ignore' }).status === 0;
  for (const v of ['a\nb', 'é', '�', 'a b', '\t']) {
    r.git('config', 'core.commentChar', v);
    const got = judge('subj\n\nbody\n');
    assert.equal(got.status, 1, `refused: ${JSON.stringify(v)}`);
    assert.match(got.stderr, gitAccepts() ? /commit refused: core\.commentChar or core\.commentString is .*, which the commit-msg hook won't model/ : /commit refused: git could not read/, JSON.stringify(v));
  }
  for (const v of ['#', ';', '//', 'Auto']) {
    r.git('config', 'core.commentChar', v);
    const got = judge('subj\n\nbody\n');
    if (gitAccepts()) assert.equal(got.status, 0, `kept: ${v}`);
    else assert.match(got.stderr, /commit refused: git could not read/, `git itself refuses ${v} here: the hook says so`);
  }
  r.git('config', '--unset', 'core.commentChar');
  // k D3, l D1: a commit encoding but UTF-8, and a message that isn't UTF-8.
  for (const enc of ['ISO-8859-1', 'BIG5-HKSCS', 'latin1']) {
    r.git('config', 'i18n.commitEncoding', enc);
    const got = judge('subj\n\nbody\n');
    assert.equal(got.status, 1, `refused: ${enc}`);
    assert.match(got.stderr, /set i18n\.commitEncoding to UTF-8 or unset it/);
  }
  for (const enc of ['UTF-8', 'utf8', 'Utf-8']) {
    r.git('config', 'i18n.commitEncoding', enc);
    assert.equal(judge('subj\n\nbody\n').status, 0, `kept: ${enc}`);
  }
  r.git('config', '--unset', 'i18n.commitEncoding');
  // R1260r D1: set but empty, or blank.
  for (const v of ['', ' ']) {
    r.git('config', 'i18n.commitEncoding', v);
    const got = judge('subj\n\nbody\n');
    assert.equal(got.status, 1, `refused: i18n.commitEncoding=${JSON.stringify(v)}`);
    assert.match(got.stderr, /set i18n\.commitEncoding to UTF-8 or unset it/);
  }
  r.git('config', '--unset', 'i18n.commitEncoding');
  // R1260r D2: the identity git would write, from the environment or the config.
  const withEnv = (env: Record<string, string>) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, 'subj\n\nbody\n');
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git'), ...env } });
  };
  for (const [what, env, who] of [['author name', { GIT_AUTHOR_NAME: 'Ada\rEve' }, 'GIT_AUTHOR_IDENT'], ['committer name', { GIT_COMMITTER_NAME: 'Ada\rEve' }, 'GIT_COMMITTER_IDENT']] as const) {
    const got = withEnv(env);
    const writes = /\r/.test(spawnSync('git', ['-C', r.dir, 'var', who], { encoding: 'latin1', env: { ...process.env, GIT_DIR: join(r.dir, '.git'), ...env } }).stdout);
    assert.equal(got.status, writes ? 1 : 0, `${what}: ${writes ? 'refused' : 'kept, git drops the CR'}`);
    if (writes) assert.match(got.stderr, /identity git would write holds a CR or a NUL/, what);
  }
  assert.equal(withEnv({ GIT_AUTHOR_NAME: 'Jos\u00e9 Ni\u00f1o' }).status, 0, 'a UTF-8 name: kept');
  r.git('config', 'user.name', 'Ada\rEve');
  // R1260u D2: whether git writes the CR depends on its version (2.39 turns a configured name's CR into a space): the
  // hook refuses exactly when the identity git would write holds one.
  const written = spawnSync('git', ['-C', r.dir, 'var', 'GIT_AUTHOR_IDENT'], { encoding: 'latin1', env: { ...process.env, GIT_DIR: join(r.dir, '.git') } }).stdout;
  assert.equal(withEnv({}).status, /\r/.test(written) ? 1 : 0, `user.name with a CR: ${/\r/.test(written) ? 'refused, git writes it' : 'kept, git drops it'}`);
  // Invalid UTF-8 can't pass through the environment (node writes it as UTF-8): written into the config as bytes.
  r.git('config', '--unset', 'user.name');
  appendFileSync(join(r.dir, '.git', 'config'), Buffer.concat([Buffer.from('[user]\n\tname = A'), Buffer.from([0xe9]), Buffer.from('\n')]));
  // R1260s N1: git rewrites an identity that isn't UTF-8 itself (verify_utf8), so the gate never sees it: kept.
  assert.equal(withEnv({}).status, 0, 'user.name in Latin-1: kept (git rewrites it)');
  r.git('config', 'user.name', 'Ada');
  const bad = judge(Buffer.from([0x73, 0x75, 0x62, 0x6a, 0xff, 0x0a]));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /the message is not valid UTF-8/);
  // l D2: the gate reads the raw commit object as UTF-8, whatever log.showSignature or i18n.logOutputEncoding say at
  // push time; and (R1260m D2, R1260n D2) refuses a commit whose encoding header isn't UTF-8, never decoding it.
  const g = repo();
  const base = g.git('rev-parse', 'HEAD');
  writeFileSync(join(g.dir, 'ok.md'), 'x\n');
  g.git('add', 'ok.md');
  g.git('commit', '-q', '--no-verify', '-m', 'é'.repeat(181));
  const gate1 = (cfg: string[]) => spawnSync(process.execPath, [gate, '--range', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git'), GIT_CONFIG_COUNT: String(cfg.length / 2), ...Object.fromEntries(cfg.flatMap((x, i) => (i % 2 ? [] : [[`GIT_CONFIG_KEY_${i / 2}`, x], [`GIT_CONFIG_VALUE_${i / 2}`, cfg[i + 1]!]]))) } });
  for (const cfg of [[], ['i18n.logOutputEncoding', 'ISO-8859-1'], ['i18n.logOutputEncoding', 'UTF-8'], ['log.showSignature', 'true']]) {
    const got = gate1(cfg);
    assert.notEqual(got.status, 0, `refused under ${cfg.join('=') || 'no setting'}`);
    assert.match(got.stderr, /the subject is 181 characters, over 180/, `as stored, 181 UTF-8 characters: ${cfg.join('=')}`);
  }
  // A signed commit (ssh, where ssh-keygen is here) with log.showSignature on: the signature isn't the message.
  if (spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error) return t.diagnostic('no ssh-keygen: the signed case not run');
  const key = join(g.dir, '..', 'k');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const s1 = g.git('rev-parse', 'HEAD');
  writeFileSync(join(g.dir, 'ok2.md'), 'y\n');
  g.git('add', 'ok2.md');
  g.git('-c', 'gpg.format=ssh', '-c', `user.signingkey=${key}`, 'commit', '-q', '--no-verify', '-S', '-m', 'Add ok2');
  const signed = spawnSync(process.execPath, [gate, '--range', `${s1}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'log.showSignature', GIT_CONFIG_VALUE_0: 'true' } });
  assert.doesNotMatch(signed.stderr, /subject is not one short line|line 2 is not blank/, `a signed commit's message as stored: ${signed.stderr}`);
});

test('a noncharacter is refused by the hook, as git rewrites it; a commit whose encoding header is not UTF-8 is refused by the gate, never decoded (#1260 R1260m D1, D2, R1260n D1, D2)', () => {
  const r = repo();
  const judge = (text: string) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, text);
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git') } });
  };
  for (const [what, text] of [['61 x U+FDD0', `${'﷐'.repeat(61)}\n`], ['U+FDEF', 'subj ﷯\n'], ['U+FFFE', 'subj ￾\n'], ['U+FFFF', 'subj\n\nbody ￿\n'], ['U+1FFFE', 'subj \u{1fffe}\n'], ['U+10FFFF', 'subj \u{10ffff}\n']] as const) {
    const got = judge(text);
    assert.equal(got.status, 1, `refused: ${what}`);
    assert.match(got.stderr, /a Unicode noncharacter/, what);
  }
  for (const [what, text] of [['U+FDCF', 'subj ﷏\n'], ['U+FDF0', 'subj ﷰ\n'], ['U+FFFD', 'subj �\n'], ['U+FFFC', 'subj ￼\n'], ['U+1FFFD', 'subj \u{1fffd}\n']] as const) assert.equal(judge(text).status, 0, `kept: ${what}`);
  // The gate: an encoding header other than UTF-8, in any spelling, is refused before any check reads the message.
  const g = repo();
  const gateOn = (base: string) => spawnSync(process.execPath, [gate, '--range', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git') } });
  for (const enc of ['unicodefeff', 'iso-10646-ucs-2', 'unicode', 'UTF-16', 'ISO-8859-1', 'x-no-such-encoding']) {
    for (const [what, args] of [['ufeff-attr-even', ['-m', 'Add a file', '-m', 'Body.', '-m', 'Co-Authored-By: Someone <noreply@example.com>\nxx']], ['ufeff-line2', ['-m', 'Subject\nnot blank']]] as const) {
      const base = g.git('rev-parse', 'HEAD');
      g.git('-c', `i18n.commitEncoding=${enc}`, 'commit', '-q', '--allow-empty', '--no-verify', ...args);
      const got = gateOn(base);
      assert.notEqual(got.status, 0, `refused: ${enc} ${what}`);
      assert.match(got.stderr, new RegExp(`declares its message encoding as "${enc}": the gate reads UTF-8 messages only`), `${enc} ${what}`);
    }
  }
  // UTF-8 in any spelling is read and judged as usual: the shape check sees it.
  for (const enc of ['UTF-8', 'utf8', 'Utf-8']) {
    const base = g.git('rev-parse', 'HEAD');
    g.git('-c', `i18n.commitEncoding=${enc}`, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'Subject\nnot blank');
    const got = gateOn(base);
    assert.match(got.stderr, /line 2 is not blank/, `judged: ${enc}`);
  }
});

test("the gate reads a commit's header block strictly, as git splits it: a CR-hidden decoy, a NUL, invalid UTF-8, two encoding headers or any value but UTF-8 is refused; a UTF-8 author name is read (#1260 R1260p D1)", () => {
  const g = repo();
  const gateOn = (base: string) => spawnSync(process.execPath, [gate, '--range', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git') } });
  /** A commit made with plumbing (as a revert or a rebase pick is: no commit-msg hook), its header lines as given. */
  const craft = (headers: string[], msg: string, literally = false, name = 'Ada') => {
    const base = g.git('rev-parse', 'HEAD');
    // Each string's characters are bytes (latin1): a UTF-8 name is passed as its bytes.
    const text = [`tree ${g.git('rev-parse', 'HEAD^{tree}')}`, `parent ${base}`, `author ${name} <ada@example.com> 1700000000 -0100`, `committer ${name} <ada@example.com> 1700000000 -0100`, ...headers].join('\n') + `\n\n${msg}`;
    const made = spawnSync('git', ['hash-object', '-t', 'commit', ...(literally ? ['--literally'] : []), '-w', '--stdin'], { cwd: g.dir, input: Buffer.from(text, 'latin1'), encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    g.git('update-ref', 'HEAD', made.stdout.trim());
    return base;
  };
  // UTF-7 for `Co`: git log shows `Co-Authored-By: …` under `encoding UTF-7`; the raw bytes match no attribution pattern.
  const utf7 = 'Add a thing\n\n+AEMAbw--Authored-By: Someone <noreply@example.com>\n';
  for (const [what, headers, msg, why, literally] of [
    ['decoy-attr: an extra header hiding `encoding utf8` behind a CR', ['x-note a\rencoding utf8', 'encoding UTF-7'], utf7, /declares its message encoding as "UTF-7"/, false],
    ['decoy-gpgsig-cont: the decoy in a signature continuation', ['gpgsig -----BEGIN PGP SIGNATURE-----', ' \rencoding utf8', ' -----END PGP SIGNATURE-----', 'encoding UTF-7'], utf7, /declares its message encoding as "UTF-7"/, false],
    ['the real one first, then the decoy', ['encoding UTF-7', 'x-note a\rencoding utf8'], utf7, /declares its message encoding as "UTF-7"/, false],
    ['two encoding headers', ['encoding UTF-8', 'encoding UTF-8'], 'Add a thing\n', /has 2 encoding headers/, false],
    ['encoding utf8 (not exactly UTF-8)', ['encoding utf8'], 'Add a thing\n', /declares its message encoding as "utf8"/, false],
    ['an extra space', ['encoding  UTF-8'], 'Add a thing\n', /declares its message encoding as " UTF-8"/, false],
    ['an empty value', ['encoding '], 'Add a thing\n', /declares its message encoding as ""/, false],
    ['a NUL in a header', ['x-note a\0b'], 'Add a thing\n', /header has a CR or a NUL/, true],

    ['an encoding header in UTF-8 but not ASCII', [`encoding ${Buffer.from('UTF\u20118', 'utf8').toString('latin1')}`], 'Add a thing\n', /declares its message encoding as/, false],
  ] as const) {
    const got = gateOn(craft([...headers], msg, literally));
    assert.notEqual(got.status, 0, `refused: ${what}`);
    assert.match(got.stderr, why, what);
  }
  // Accepted and judged: no header, and `encoding UTF-8` in any case.
  for (const headers of [[], ['encoding UTF-8'], ['encoding utf-8']]) {
    const got = gateOn(craft(headers, 'Subject\nnot blank\n'));
    assert.match(got.stderr, /line 2 is not blank/, `judged: ${headers.join() || 'no header'}`);
  }
  // R1260t D1: a CR or Latin-1 bytes in a line git reads no meaning from (a merged signed tag's `mergetag`
  // continuation, an extra header `--amend` carries) is kept, as on main; in an author line it is refused.
  for (const headers of [['mergetag object 0000000000000000000000000000000000000000', ' type commit', ' tag v1', ' tagger Ada <ada@example.com> 1700000000 -0100', ' ', ' Release 1\rnotes'], ['x-tool a\rb'], ['x-note caf\u00e9']]) {
    const got = gateOn(craft(headers, 'Subject\nnot blank\n'));
    assert.doesNotMatch(got.stderr, /header has/, `kept: ${JSON.stringify(headers)}`);
    assert.match(got.stderr, /line 2 is not blank/, `judged: ${JSON.stringify(headers)}`);
  }
  assert.match(gateOn(craft([], 'Add a thing\n', false, 'Ada\rEve')).stderr, /header has a CR or a NUL/, 'a CR in the author line: refused');
  assert.match(gateOn(craft([], 'Add a thing\n', false, 'caf\u00e9')).stderr, /header has bytes that aren't valid UTF-8/, 'Latin-1 bytes in the author line: refused');
  // A non-ASCII author and committer name in UTF-8 is read, and the message judged as any other.
  for (const name of ['Jos\u00e9 Ni\u00f1o', '\u5f20\u4f1f']) {
    const got = gateOn(craft([], 'Subject\nnot blank\n', false, Buffer.from(name, 'utf8').toString('latin1')));
    assert.doesNotMatch(got.stderr, /header has/, `read: ${name}`);
    assert.match(got.stderr, /line 2 is not blank/, `judged: ${name}`);
  }
});

test("the hook reads git's config as git commit does, and a git call that fails refuses; a merged signed tag's message with a CR passes hook and gate (#1260 R1260s D1, D2, R1260t D1, D2)", { skip: !hasGitleaks && 'gitleaks not installed' }, (t) => {
  const r = repo();
  const judge = (env: Record<string, string>) => {
    const f = join(r.dir, '.git', 'COMMIT_EDITMSG');
    writeFileSync(f, 'Add a thing\n');
    return spawnSync(process.execPath, [installedGate, '--commit-msg', f], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git'), ...env } });
  };
  // s D1: GIT_CONFIG is `git config`'s alone; the hook still reads the repo's config, as git commit does.
  r.git('config', 'i18n.commitEncoding', 'ISO-8859-1');
  const hidden = judge({ GIT_CONFIG: '/dev/null' });
  assert.equal(hidden.status, 1, 'GIT_CONFIG set: the repo config is still read');
  assert.match(hidden.stderr, /i18n\.commitEncoding is ISO-8859-1/);
  r.git('config', '--unset', 'i18n.commitEncoding');
  // s D2 = t D2: a GIT_CONFIG_COUNT git accepts but the runner refuses ('', '01', '+1'): refused, naming git's failure.
  for (const count of ['', '01', '+1']) {
    const got = judge({ GIT_CONFIG_COUNT: count });
    assert.equal(got.status, 1, `GIT_CONFIG_COUNT=${JSON.stringify(count)}: refused`);
    assert.match(got.stderr, /git could not read its config/);
  }
  // A missing identity is git commit's own refusal: the hook lets it through to git.
  const noIdent = spawnSync(process.execPath, [installedGate, '--commit-msg', join(r.dir, '.git', 'COMMIT_EDITMSG')], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: join(r.dir, '.git', 'COMMIT_EDITMSG'), GIT_EDITOR: 'true', GIT_DIR: join(r.dir, '.git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: join(r.dir, '..'), EMAIL: '', GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: '', GIT_COMMITTER_EMAIL: '' } });
  assert.doesNotMatch(noIdent.stderr, /git could not read the (author|committer) identity/, `no identity: left to git: ${noIdent.stderr}`);
  // t D1: a signed tag whose message holds a CR, merged with --no-ff through the installed hook: hook and gate pass.
  if (spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error) return t.diagnostic('no ssh-keygen: the signed-tag merge not run');
  const g = repo();
  assert.equal(spawnSync(process.execPath, [installer], { cwd: g.dir, encoding: 'utf8' }).status, 0);
  const key = join(g.dir, '..', 'k');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  for (const [k, v] of [['gpg.format', 'ssh'], ['user.signingkey', key]] as const) g.git('config', k, v);
  // An allowed-signers file, for when git checks the tag's signature at the merge.
  writeFileSync(join(g.dir, '..', 'signers'), `ada@example.com ${readFileSync(`${key}.pub`, 'utf8')}`);
  g.git('config', 'gpg.ssh.allowedSignersFile', join(g.dir, '..', 'signers'));
  const base = g.git('rev-parse', 'HEAD');
  g.git('checkout', '-q', '-b', 'side');
  g.git('commit', '-q', '--allow-empty', '-m', 'Side change');
  g.git('tag', '-s', 'v1', '-m', 'Release 1\rnotes');
  g.git('checkout', '-q', 'main');
  g.git('commit', '-q', '--allow-empty', '-m', 'Main change');
  const merged = spawnSync('git', ['merge', '-q', '--no-ff', '--no-edit', 'v1'], { cwd: g.dir, encoding: 'utf8' });
  assert.equal(merged.status, 0, `the hook let the merge through: ${merged.stderr}`);
  assert.match(g.git('cat-file', 'commit', 'HEAD'), /^mergetag /m, 'the merge carries the signed tag');
  assert.match(g.git('cat-file', 'commit', 'HEAD'), / Release 1\rnotes/, "its message's CR is in the merge's header");
  const gated = spawnSync(process.execPath, [gate, '--range', `${base}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git') } });
  assert.equal(gated.status, 0, `the gate passes it, as main's did: ${gated.stderr}`);
  // R1260u D1, R1260v D1, a stated residual: a NUL in a signed tag's message. git's own fsck calls it nulInHeader in the
  // merge, and an origin with receive.fsckObjects refuses it, so the gate refuses it too; the hook can't see a mergetag.
  const msgFile = join(g.dir, '..', 'tag-msg');
  writeFileSync(msgFile, Buffer.from('Release 2\n\nNo\0tes\n', 'latin1'));
  const base2 = g.git('rev-parse', 'HEAD');
  g.git('checkout', '-q', 'side');
  g.git('commit', '-q', '--allow-empty', '-m', 'Side change 2');
  const tagged = spawnSync('git', ['tag', '-s', 'v2', '-F', msgFile], { cwd: g.dir, encoding: 'utf8' });
  g.git('checkout', '-q', 'main');
  if (tagged.status !== 0) return t.diagnostic(`git refused a NUL in a tag message here: ${tagged.stderr}`);
  // With its own message (-m), as R1260u merged it: by default git puts the tag's message into the merge's, and refuses
  // the NUL there itself.
  const merged2 = spawnSync('git', ['merge', '-q', '--no-ff', '-m', 'Merge tag v2', 'v2'], { cwd: g.dir, encoding: 'utf8' });
  assert.equal(merged2.status, 0, `the hook passes the merge (it can't see a mergetag): ${merged2.stderr}`);
  if (!g.git('cat-file', 'commit', 'HEAD').includes('\0')) return t.diagnostic("this git didn't carry the NUL into the mergetag");
  const gated2 = spawnSync(process.execPath, [gate, '--range', `${base2}..HEAD`], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(g.dir, '.git') } });
  assert.notEqual(gated2.status, 0, 'the gate refuses it, as git fsck does (the stated residual)');
  assert.match(gated2.stderr, /header has a CR or a NUL/);
});

test('a remote named --commit-msg is judged as a push, never as a message (#1260 R1260a D2)', () => {
  const r = repo();
  const base = r.git('rev-parse', 'HEAD');
  r.git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'Add x', '-m', 'Co-Authored-By: Someone <noreply@example.com>');
  const tip = r.git('rev-parse', 'HEAD');
  // A gitfile: a repo location git accepts as the remote's URL, and a one-line message that passes the shape rule.
  const url = join(r.dir, '..', 'gitfile');
  writeFileSync(url, `gitdir: ${join(r.dir, '..', 'sink.git')}\n`);
  const prePush = (extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [gate, '--commit-msg', url], { cwd: repoRoot, encoding: 'utf8', input: `refs/heads/leak ${tip} refs/heads/leak ${'0'.repeat(40)}\n`, env: { ...process.env, GIT_DIR: join(r.dir, '.git'), ...extra } });
  void base;
  const p = prePush();
  assert.notEqual(p.status, 0, `the push is judged, and refused: ${p.stderr}`);
  assert.match(p.stderr, /vendor attribution/);
  assert.notEqual(prePush({ PUSH_GATE_COMMIT_MSG: 'something else' }).status, 0, 'a marker naming another file: still a push');
  // R1260d D1: the marker naming the URL itself, as a pusher's environment can: the gate isn't the installed copy, so
  // it is still a push, judged and refused.
  const matching = prePush({ PUSH_GATE_COMMIT_MSG: url });
  assert.notEqual(matching.status, 0, `a matching marker from the pusher's environment: still a push: ${matching.stderr}`);
  assert.match(matching.stderr, /vendor attribution/);
  // And the pre-push launcher refuses a remote whose name reads as an option before any gate runs.
  const launcher = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'push-gate-hook.mjs'), '--commit-msg', url], { cwd: r.dir, encoding: 'utf8', input: '', env: { ...process.env, PUSH_GATE_COMMIT_MSG: url } });
  assert.equal(launcher.status, 1, launcher.stderr);
  assert.match(launcher.stderr, /a remote named "--commit-msg": a name that starts with '-' reads as an option/);
  // R1260f F1: with the stub's --pre-push, every name that reads as an option is refused before any dispatch.
  for (const name of ['--print-gate-files', '--range', '--commit-msg', '-x']) {
    const p = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'push-gate-hook.mjs'), '--pre-push', name, name === '--range' ? 'HEAD..HEAD' : url], { cwd: r.dir, encoding: 'utf8', input: '' });
    assert.equal(p.status, 1, `refused: a remote named ${name}: ${p.stdout}${p.stderr}`);
    assert.match(p.stderr, /a name that starts with '-' reads as an option/);
    assert.doesNotMatch(p.stdout, /"code"/, 'no file list printed');
  }
  // And the gate, given `--`, takes what follows as a remote's name: `-- --range HEAD..HEAD` is a push, judged.
  const ended = spawnSync(process.execPath, [gate, '--', '--range', 'HEAD..HEAD'], { cwd: repoRoot, encoding: 'utf8', input: `refs/heads/leak ${tip} refs/heads/leak ${'0'.repeat(40)}\n`, env: { ...process.env, GIT_DIR: join(r.dir, '.git') } });
  assert.notEqual(ended.status, 0, `judged as a push: ${ended.stderr}`);
  assert.match(ended.stderr, /vendor attribution/);
  // `-- <remote>`: the remote's name, so what it already has isn't judged again (the refused commit is on origin; a
  // clean one on top is pushed). Without `--` read as such, `--` would be the name, and the old commit refused.
  if (hasGitleaks) {
    r.git('update-ref', 'refs/remotes/origin/main', tip);
    r.git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'Add y');
    const top = r.git('rev-parse', 'HEAD');
    const onto = spawnSync(process.execPath, [gate, '--', 'origin', url], { cwd: repoRoot, encoding: 'utf8', input: `refs/heads/leak ${top} refs/heads/leak ${'0'.repeat(40)}\n`, env: { ...process.env, GIT_DIR: join(r.dir, '.git') } });
    assert.equal(onto.status, 0, `only what origin hasn't: ${onto.stderr}`);
  }
  const src = readFileSync(join(repoRoot, 'scripts', 'push-gate-hook.mjs'), 'utf8');
  assert.match(src, /if \(k\.toUpperCase\(\) === 'PUSH_GATE_COMMIT_MSG'\) delete env\[k\];/, "the launcher never hands the marker on");
});
