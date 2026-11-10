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
  const f = join(d, 'COMMIT_EDITMSG');
  // As the installed stub runs it, for an edited message (git's `strip` cleanup).
  return spawnSync(process.execPath, [gate, '--commit-msg', f], { encoding: 'utf8', cwd: d, env: { ...process.env, PUSH_GATE_COMMIT_MSG: f, GIT_EDITOR: 'vi', GIT_DIR: join(d, 'no-repo') } });
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
  const none = spawnSync(process.execPath, [gate, '--commit-msg', missing], { encoding: 'utf8', env: { ...process.env, PUSH_GATE_COMMIT_MSG: missing } });
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
  assert.match(hookPath, /messageShapeProblems\(asCommitted\(/, 'the commit-msg path calls it');
  assert.match(hookPath, /^if \(process\.argv\[2\] === '--commit-msg' && process\.argv\.length === 4 && process\.env\.PUSH_GATE_COMMIT_MSG === process\.argv\[3\]\)/, 'only with the stub\'s marker (R1260a D2)');
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
type Row = [string, Record<string, string>, string | null, string[]];
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
  // A --cleanup= on the command line, which no hook can see (stated in CONTRIBUTING): judged by the default mode.
  ['cli-strip-comment', {}, 'subj\n#x\n\nbody\n', ['--cleanup=strip', '-F', 'MSG']],
  ['cli-semi-line2', { 'core.commentChar': ';' }, 'subj\n; a note\n\nbody\n', ['--cleanup=strip', '-F', 'MSG']],
  ['cli-verbatim-lead', {}, '\nsubj\n', ['--cleanup=verbatim', '-F', 'MSG']],
];
/** The rows the hook can't judge as the gate does: a --cleanup= on the command line (a fix shows up here). */
const CLI_RESIDUAL: Record<string, string> = { 'cli-strip-comment': 'hook=refuse gate=pass', 'cli-semi-line2': 'hook=refuse gate=pass', 'cli-verbatim-lead': 'hook=pass gate=refuse' };

test("the commit-msg hook and the push gate agree on what git commits, by git's cleanup mode (#1260 R1260a/b D1: msg-mismatch.sh's rows)", { skip: !hasGitleaks && 'gitleaks not installed', timeout: 300_000 }, () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_EDITOR: 'true' };
  delete (env as Record<string, string | undefined>).GIT_DIR;
  const seen: string[] = [];
  for (const [name, cfg, body, args] of ROWS) {
    const a = repo();
    const b = repo();
    for (const [k, v] of Object.entries(cfg)) for (const r of [a, b]) r.git('config', k, v);
    const inst = spawnSync(process.execPath, [installer], { cwd: a.dir, encoding: 'utf8' });
    assert.equal(inst.status, 0, inst.stderr);
    const file = join(a.dir, '..', `${name}.msg`);
    if (body !== null) writeFileSync(file, body);
    const argv = args.map((x) => (x === 'MSG' ? file : x));
    const hookOk = spawnSync('git', ['commit', '-q', '--allow-empty', ...argv], { cwd: a.dir, encoding: 'utf8', env }).status === 0;
    const made = spawnSync('git', ['commit', '-q', '--allow-empty', '--no-verify', ...argv], { cwd: b.dir, encoding: 'utf8', env });
    assert.equal(made.status, 0, `${name}: git made the commit: ${made.stderr}`);
    const g = spawnSync(process.execPath, [gate, '--range', 'HEAD~1..HEAD'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(b.dir, '.git') } });
    if (g.status !== 0) assert.match(g.stderr, /subject is not one short line/, `${name}: the gate refused for the message's shape, not something else: ${g.stderr}`);
    const verdict = `hook=${hookOk ? 'pass' : 'refuse'} gate=${g.status === 0 ? 'pass' : 'refuse'}`;
    if (name in CLI_RESIDUAL) assert.equal(verdict, CLI_RESIDUAL[name], `${name}: the stated residual`);
    else if (hookOk !== (g.status === 0)) seen.push(`${name}: ${verdict}`);
  }
  assert.deepEqual(seen, [], 'every row the hook can see agrees with the gate');
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
});
