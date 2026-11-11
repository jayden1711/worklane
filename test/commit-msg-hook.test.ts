// The commit-msg hook (#1259): the push gate's own message rule (scripts/push-gate.mjs --commit-msg), installed by
// scripts/setup-hooks.mjs, refuses a message the gate would refuse before the commit is made, so none is made that
// would then have to be rewritten. The pre-push gate and CI still judge every pushed commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.match(hookPath, /asCommitted\(text, mode, c, cut\)/, 'the commit-msg path reads the message as git commits it');
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
    if (g.status !== 0) assert.match(g.stderr, /subject is not one short line/, `${name}: the gate refused for the message's shape, not something else: ${g.stderr}`);
    const verdict = `hook=${hookOk ? 'pass' : 'refuse'} gate=${g.status === 0 ? 'pass' : 'refuse'}`;
    if (name in CLI_RESIDUAL) assert.equal(verdict, CLI_RESIDUAL[name], `${name}: the stated residual`);
    // R1260g/h: with core.commentChar=auto the hook can't know git's pick, so it judges every reading: it may refuse
    // what git would commit (fail-safe), never pass what the gate refuses.
    else if (hookOk && g.status !== 0) seen.push(`${name}: ${verdict}`);
    else if (!hookOk && g.status === 0 && (cfg['core.commentChar'] ?? '').toLowerCase() !== 'auto' && !cfg['i18n.commitEncoding']) seen.push(`${name}: ${verdict}`);
  }
  assert.deepEqual(seen, [], "every row agrees with the gate, but auto's and a commit encoding's, which may only refuse more");
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
  assert.equal(judge(`${'e'.repeat(100)}\n`).status, 0, 'ASCII: the same in both');
  r.git('config', 'i18n.commitEncoding', 'x-no-such-encoding');
  const unknown = judge('ok\n');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /i18n\.commitEncoding is x-no-such-encoding, which the commit-msg hook can't decode/);
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
