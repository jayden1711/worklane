import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conflictBrief, conflictFixesUsed, conflictTrigger, conflictWaitReasons, outsideHunks, parseConflicts } from '../src/conflicts.js';
import { abortMerge, changedFiles, mergeBaseInto } from '../src/merge-base.js';

test('only a real conflict starts a fix; still computing re-checks; behind, blocked and the rest never do', () => {
  assert.deepEqual(conflictTrigger({ state: 'open', mergeable: false, mergeableState: 'dirty' }), { act: 'fix' });
  assert.equal(conflictTrigger({ state: 'open', mergeable: null, mergeableState: 'unknown' }).act, 'recheck');
  assert.equal(conflictTrigger({ state: 'open', mergeable: true, mergeableState: 'unknown' }).act, 'recheck');
  for (const s of ['behind', 'blocked', 'unstable', 'clean', 'has_hooks', 'draft']) {
    assert.equal(conflictTrigger({ state: 'open', mergeable: s !== 'blocked', mergeableState: s }).act, 'none', s);
  }
  assert.equal(conflictTrigger({ state: 'open', mergeable: false, mergeableState: 'blocked' }).act, 'none');
  assert.equal(conflictTrigger({ state: 'merged', mergeable: false, mergeableState: 'dirty' }).act, 'none');
});

test('every fix run started on a PR counts toward the cap, including one a restart cut short', () => {
  const ev = [
    { type: 'conflict_fix.started', payload: { number: 7 } },
    { type: 'conflict_fix.finished', payload: { number: 7, outcome: 'interrupted' } },
    { type: 'conflict_fix.started', payload: { number: 8 } },
    { type: 'ci_fix.started', payload: { number: 7 } },
  ];
  assert.equal(conflictFixesUsed(ev, 7), 1);
  assert.equal(conflictFixesUsed(ev, 9), 0);
});

const MERGED = ['a', '<<<<<<< HEAD', 'ours 1', '||||||| base', 'old 1', '=======', 'theirs 1', '>>>>>>> main', 'b', 'c', '<<<<<<< HEAD', 'ours 2', '=======', 'theirs 2', '>>>>>>> main', 'd'].join('\n');

test('conflicted hunks are parsed with both sides and the ancestor (diff3)', () => {
  assert.deepEqual(parseConflicts('src/x.ts', MERGED), [
    { file: 'src/x.ts', line: 2, ours: 'ours 1', theirs: 'theirs 1', base: 'old 1' },
    { file: 'src/x.ts', line: 11, ours: 'ours 2', theirs: 'theirs 2' },
  ]);
  assert.deepEqual(parseConflicts('f', 'no markers'), []);
});

test('the brief carries every hunk and both sides\' intent, and says to change nothing else', () => {
  const b = conflictBrief({
    baseRef: 'main',
    baseSha: 'abcdef1234567890',
    strategy: 'merge',
    hunks: parseConflicts('src/x.ts', MERGED),
    ours: { label: 'this PR (#12, issue #40)', intent: 'Totals ignore zero quantities.' },
    theirs: [{ label: '#15 Add the orders table', intent: 'Orders are stored in their own table.' }],
  });
  for (const s of ['abcdef12', '2 hunk(s) in 1 file(s)', 'BOTH sides', 'Change nothing outside the conflicted hunks', 'Totals ignore zero quantities.', 'Orders are stored in their own table.', 'ours 1', 'theirs 1', 'old 1', 'src/x.ts, line 11']) assert.ok(b.includes(s), s);
});

test('a resolution that only rewrites the conflicted hunks is inside; anything else is named', () => {
  const inside = ['a', 'ours 1 and theirs 1', 'b', 'c', 'both 2', 'd'].join('\n');
  assert.deepEqual(outsideHunks({ 'src/x.ts': MERGED }, { 'src/x.ts': inside }, []), []);
  const editedB = inside.replace('\nb\n', '\nb changed\n');
  assert.deepEqual(outsideHunks({ 'src/x.ts': MERGED }, { 'src/x.ts': editedB }, []), ['src/x.ts (lines outside the conflicted hunks changed)']);
  const extraLine = `${inside}\nnew tail`;
  assert.deepEqual(outsideHunks({ 'src/x.ts': MERGED }, { 'src/x.ts': extraLine }, []), ['src/x.ts (lines outside the conflicted hunks changed)']);
  assert.deepEqual(outsideHunks({ 'src/x.ts': MERGED }, { 'src/x.ts': MERGED }, []), ['src/x.ts (conflict markers left)']);
  assert.deepEqual(outsideHunks({ 'src/x.ts': MERGED }, { 'src/x.ts': null }, ['src/y.ts']), ['src/y.ts (merged cleanly, then changed)', 'src/x.ts (deleted)']);
});

test('CRLF files (a repo that keeps them, or a checkout with core.autocrlf): hunks parse the same, and a resolution is judged on its content, not its line endings', () => {
  const crlf = MERGED.replace(/\n/g, '\r\n');
  assert.deepEqual(parseConflicts('src/x.ts', crlf), parseConflicts('src/x.ts', MERGED));
  const inside = ['a', 'ours 1 and theirs 1', 'b', 'c', 'both 2', 'd'].join('\r\n');
  assert.deepEqual(outsideHunks({ 'src/x.ts': crlf }, { 'src/x.ts': inside }, []), [], 'a clean resolution of a CRLF file');
  const lfHunk = inside.replace('ours 1 and theirs 1\r\n', 'ours 1 and theirs 1\n');
  assert.deepEqual(outsideHunks({ 'src/x.ts': crlf }, { 'src/x.ts': lfHunk }, []), [], 'a resolver that wrote its hunk with LF');
  assert.deepEqual(outsideHunks({ 'src/x.ts': crlf }, { 'src/x.ts': inside.replace('\r\nb\r\n', '\r\nb changed\r\n') }, []), ['src/x.ts (lines outside the conflicted hunks changed)']);
  assert.deepEqual(outsideHunks({ 'src/x.ts': crlf }, { 'src/x.ts': inside.replace('both 2', '=======') }, []), ['src/x.ts (conflict markers left)'], 'a marker line ending in \\r is still a marker');
});

test('a fix waits for the owner only for changes outside the hunks, risky categories, or an unsure evaluator', () => {
  const ok = { approved: true, confidence: 'high', bothSidesKept: true };
  assert.deepEqual(conflictWaitReasons({ outside: [], riskCategories: [], evaluator: ok }), []);
  assert.equal(conflictWaitReasons({ outside: ['src/y.ts (merged cleanly, then changed)'], riskCategories: [], evaluator: ok }).length, 1);
  assert.match(conflictWaitReasons({ outside: [], riskCategories: ['migrations'], evaluator: ok })[0]!, /touches migrations/);
  assert.match(conflictWaitReasons({ outside: [], riskCategories: [], evaluator: { ...ok, confidence: 'medium' } })[0]!, /confidence is medium/);
  assert.match(conflictWaitReasons({ outside: [], riskCategories: [], evaluator: { ...ok, bothSidesKept: null } })[0]!, /didn't confirm both sides/);
  assert.match(conflictWaitReasons({ outside: [], riskCategories: [], evaluator: { ...ok, bothSidesKept: false } })[0]!, /lost/);
  assert.match(conflictWaitReasons({ outside: [], riskCategories: [], evaluator: { ...ok, approved: false } })[0]!, /rejected/);
});

const BOT = { name: 'harness-bot', email: 'harness-bot@example.com' };

function repoWith(base: string) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false'); // the same bytes on every runner; CRLF has its own test
  writeFileSync(join(dir, 'a.txt'), base);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  return { dir, g };
}

test('merging the base in: clean merges commit; a conflict reports each file with diff3 markers and what merged cleanly', () => {
  const { dir, g } = repoWith('one\ntwo\nthree\n');
  g('checkout', '-q', '-b', 'pr');
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO from pr\nthree\n');
  g('commit', '-qam', 'pr');
  g('checkout', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\nTWO from main\nthree\n');
  writeFileSync(join(dir, 'b.txt'), 'b changed on main\n');
  g('commit', '-qam', 'main');
  const mainSha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'pr');
  const r = mergeBaseInto(dir, mainSha, 'Merge main', BOT);
  assert.ok('clean' in r && !r.clean);
  if ('clean' in r && !r.clean) {
    assert.deepEqual(Object.keys(r.conflicted), ['a.txt']);
    assert.match(r.conflicted['a.txt']!, /<<<<<<< HEAD\nTWO from pr\n\|\|\|\|\|\|\| [0-9a-f]+\ntwo\n=======\nTWO from main\n>>>>>>> /);
    assert.deepEqual(r.otherFiles, ['b.txt']);
    assert.deepEqual(parseConflicts('a.txt', r.conflicted['a.txt']!).map((h) => [h.ours, h.base, h.theirs]), [['TWO from pr', 'two', 'TWO from main']]);
  }
  abortMerge(dir);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\nTWO from pr\nthree\n', 'abort restores the branch');
  assert.deepEqual(changedFiles(dir, `${mainSha}~1`, mainSha), ['a.txt', 'b.txt']);

  const clean = repoWith('x\n');
  clean.g('checkout', '-q', '-b', 'pr');
  writeFileSync(join(clean.dir, 'a.txt'), 'x\npr\n');
  clean.g('commit', '-qam', 'pr');
  clean.g('checkout', '-q', 'main');
  writeFileSync(join(clean.dir, 'b.txt'), 'main\n');
  clean.g('commit', '-qam', 'main');
  const m = clean.g('rev-parse', 'HEAD');
  clean.g('checkout', '-q', 'pr');
  const ok = mergeBaseInto(clean.dir, m, 'Merge main', BOT);
  assert.ok('clean' in ok && ok.clean);
  if ('clean' in ok && ok.clean) {
    assert.equal(clean.g('rev-list', '--count', '--merges', `${m}..${ok.head}`), '1', 'a merge commit, not a rebase');
    assert.equal(clean.g('log', '-1', '--format=%an <%ae> / %cn <%ce>', ok.head), `${BOT.name} <${BOT.email}> / ${BOT.name} <${BOT.email}>`, "the harness's identity, not the repo's configured one");
  }
});
