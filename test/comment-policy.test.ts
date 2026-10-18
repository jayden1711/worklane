import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';
import { addedLines, checkComments, checkRange, checkWorkingFile, formatFindings, policyAt, type CommentPolicy } from '../src/comment-policy.js';
import { CommentPolicyConfig } from '../src/config/schema.js';
import { loadConfig } from '../src/config/load.js';
import { exampleProject } from './helpers.js';

const script = fileURLToPath(new URL('../../scripts/check-comments.mjs', import.meta.url));
const policy: CommentPolicy = { ...CommentPolicyConfig.parse({}), enabled: true };
const allLines = (src: string) => new Set(src.split('\n').map((_, k) => k + 1));
/** The reasons for each refused comment in `src`, every line of it new. */
const verdict = (file: string, src: string, p = policy) => checkComments(file, src, allLines(src), p).map((f) => `${f.line}: ${f.reasons.join('; ')}`);

test('an untagged new comment fails; WHY:, INVARIANT:, an issue id, a decision id or a design-doc section pass', () => {
  assert.deepEqual(verdict('a.ts', 'const x = 1; // the user count\n'), ['1: no WHY:, INVARIANT: or issue/decision id']);
  assert.deepEqual(verdict('a.ts', '// keep the user count\nconst x = 1;\n'), ['1: no WHY:, INVARIANT: or issue/decision id']);
  for (const ok of ['// WHY: the API counts from 1', '// INVARIANT: x is never negative', '// The retry is bounded (#123).', '// Kept for D-12.', '/* see docs/design.md §4 */', '// https://github.com/o/r/issues/77 explains it']) {
    assert.deepEqual(verdict('a.ts', `${ok}\nconst x = 1;\n`), [], ok);
  }
});

test('a tagged narration comment fails, naming the word; the list is the config\'s', () => {
  assert.deepEqual(verdict('a.ts', '// WHY: added X\nconst x = 1;\n'), ['1: narration ("added")']);
  assert.deepEqual(verdict('a.ts', '// #12 per review\n'), ['1: narration ("per review")']);
  assert.deepEqual(verdict('a.ts', '// WHY: Date.now() is wall time, not monotonic\n'), [], 'a method name is not the word');
  assert.deepEqual(verdict('a.ts', '// WHY: added X\n', { ...policy, narration: ['tweaked'] }), []);
});

test('a 6-line comment fails; 4 lines pass; max_lines is the config\'s', () => {
  const block = (n: number) => `// WHY: one\n${Array.from({ length: n - 1 }, (_, k) => `// more ${k}\n`).join('')}const x = 1;\n`;
  assert.deepEqual(verdict('a.ts', block(6)), ['1: 6 lines (at most 4)']);
  assert.deepEqual(verdict('a.ts', block(4)), []);
  assert.deepEqual(verdict('a.ts', block(6), { ...policy, max_lines: 6 }), []);
  assert.deepEqual(verdict('a.ts', `/**\n * WHY: a\n * b\n * c\n * d\n * e\n * f\n */\n`), ['2: 6 lines (at most 4)']);
});

test('untouched old comments never fail: only blocks with an added line are judged', () => {
  const src = '// an old untagged comment\n// that was there before, and long\n// one\n// two\n// three\nconst x = 1;\nconst y = 2;\n';
  assert.deepEqual(checkComments('a.ts', src, new Set([7]), policy), []);
  // WHY: a line added inside an old block changes that block, so the whole block is judged.
  assert.equal(checkComments('a.ts', src, new Set([3]), policy).length, 1);
  assert.deepEqual(checkComments('a.ts', src, new Set(), policy), []);
  // WHY: new lines next to an old block are judged on their own: a long old block is not their fault...
  const grown = src.replace('const x = 1;\n', '// WHY: a new paragraph (#9)\nconst x = 1;\n');
  assert.deepEqual(checkComments('a.ts', grown, new Set([6]), policy), []);
  // INVARIANT: ...but they may not push a block that fit over max_lines.
  const fit = '// WHY: a\n// b\n// c\n// d\n// e\nconst x = 1;\n';
  assert.deepEqual(checkComments('a.ts', fit, new Set([5]), policy).map((f) => f.reasons), [['5 lines with the new ones (at most 4)']]);
});

test('a JSDoc block of only @param/@returns is API documentation and exempt (the proposed default); prose in one is not', () => {
  assert.deepEqual(verdict('a.ts', '/**\n * @param a the first\n * @returns the sum\n */\nexport const f = (a: number) => a;\n'), []);
  assert.deepEqual(verdict('a.ts', '/**\n * Sums things.\n * @param a the first\n */\n'), ['2: no WHY:, INVARIANT: or issue/decision id']);
});

test('comment markers inside strings, templates and regexes are code; tool directives are not prose', () => {
  const src = [
    "const u = 'http://a.example/x'; const v = \"//b\";",
    'const t = `${u}//c ${`//d`}`;',
    'const r = /a\\//; const s = x / 2 / 3;',
    '// @ts-expect-error: the type is wrong upstream',
    '/* eslint-disable no-console */',
  ].join('\n');
  assert.deepEqual(verdict('a.ts', src), []);
  assert.deepEqual(verdict('ci.yml', 'steps:\n  - uses: actions/checkout@0123abcd # v7.0.1\n'), [], "a pinned action's version label");
});

test('shell and YAML: # comments, not ones in quotes, ${#x}, heredocs or text block scalars; a workflow run: script is shell', () => {
  assert.deepEqual(verdict('a.sh', '#!/bin/sh\necho "# no" \'# no\' ${#arr[@]}\ncat <<EOF\n# no\nEOF\nx=1 # set x\n'), ['6: no WHY:, INVARIANT: or issue/decision id']);
  assert.deepEqual(verdict('a.sh', '# WHY: CI has no tty\nexport TERM=dumb\n'), []);
  const yaml = ['# the jobs', 'jobs:', '  a:', '    steps:', '      - run: |', '          # run it twice', '          make', '      - name: "x # not"', '        body: |', '          ## Heading', '          # also text'].join('\n');
  assert.deepEqual(verdict('ci.yml', yaml), ['1: no WHY:, INVARIANT: or issue/decision id', '6: no WHY:, INVARIANT: or issue/decision id']);
  assert.deepEqual(verdict('notes.md', '<!-- anything -->\n'), [], 'a language it does not know is not checked');
});

test('the diff parser: added lines per new-side path, deletions and context ignored', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,0 +4,2 @@', '+a', '+b', '@@ -9 +10,0 @@', '-c', 'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-z'].join('\n');
  assert.deepEqual([...addedLines(diff)].map(([f, s]) => [f, [...s]]), [['x.ts', [4, 5]]]);
});

/** The example project with the policy on, committed (CI reads the base's config). */
function project() {
  const { dir } = exampleProject();
  appendFileSync(join(dir, BRAND.configDir, 'config.yaml'), 'comment_policy: { enabled: true }\n');
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '-m', 'policy on');
  return { dir, git, base: git('rev-parse', 'HEAD') };
}

test('the write-time check and the CI check give the same verdict on the same change', () => {
  const { dir, git, base } = project();
  writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// WHY: added the b export\nexport const b = 2;\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'go.sh'), '# INVARIANT: runs from the repo root\nx=1 # set x\n');
  writeFileSync(join(dir, 'src', 'fine.ts'), '// WHY: the API counts from 1 (#4)\nexport const c = 1;\n');
  // WHY: checkWorkingFile is what the agents' post-edit hook calls on the uncommitted file (#330 part 2).
  const writeFindings = ['src/old.ts', 'scripts/go.sh', 'src/fine.ts'].map((f) => checkWorkingFile(dir, f, policy));
  assert.deepEqual(writeFindings[2], [], 'a passing file has no findings');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const ciFindings = checkRange(dir, base, 'HEAD', policy);
  const sort = (f: typeof ciFindings) => [...f].sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
  assert.deepEqual(sort(writeFindings.flat()), sort(ciFindings));
  assert.deepEqual(
    ciFindings.map((f) => `${f.file}:${f.line}: ${f.reasons.join('; ')}`).sort(),
    ['scripts/go.sh:2: no WHY:, INVARIANT: or issue/decision id', 'src/old.ts:3: narration ("added")'],
    'the old comment on line 1 is untouched, so never judged',
  );
  const ci = spawnSync('node', [script, '--base', base, '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ci.status, 1, ci.stderr);
  assert.ok(ci.stderr.includes(formatFindings(ciFindings)), ci.stderr);
});

test('off by default: the CI check exits 0 saying it is off', () => {
  const { dir } = exampleProject();
  assert.equal(loadConfig(dir).project.comment_policy.enabled, false);
  writeFileSync(join(dir, 'src', 'x.ts'), '// untagged\nexport const x = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir });
  const ci = spawnSync('node', [script, '--base', 'HEAD~1', '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ci.status, 0, ci.stderr);
  assert.match(ci.stdout, /comment policy: off/);
});

test('CI reads the policy from the base, so a change cannot switch it off for itself; a bad base fails closed', () => {
  const { dir, git, base } = project();
  writeFileSync(join(dir, BRAND.configDir, 'config.yaml'), git('show', `${base}:${BRAND.configDir}/config.yaml`).replace('comment_policy: { enabled: true }', 'comment_policy: { enabled: false }'));
  writeFileSync(join(dir, 'src', 'x.ts'), '// untagged\nexport const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'off and a comment');
  assert.equal(policyAt(dir, base)?.enabled, true);
  const ci = spawnSync('node', [script, '--base', base, '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ci.status, 1, ci.stdout);
  assert.match(ci.stderr, /src\/x\.ts:1: no WHY:/);
  const bad = spawnSync('node', [script, '--base', 'no-such-rev', '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
