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
  // WHY: in an old block, narration and length are judged on the new lines only; a long old block is not theirs...
  const grown = src.replace('const x = 1;\n', '// WHY: a new paragraph (#9)\nconst x = 1;\n');
  assert.deepEqual(checkComments('a.ts', grown, new Set([6]), policy), []);
  // WHY: ...and the tag may be the old block's: an untagged line under an old WHY: or #N block passes (owner's call).
  assert.deepEqual(checkComments('a.ts', '// WHY: old\n// an untagged new line\n', new Set([2]), policy), []);
  assert.deepEqual(checkComments('a.ts', '// old, see #5\n// an untagged new line\n', new Set([2]), policy), []);
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

test('heredocs: a run: block\'s heredoc ends at its indented closing word; <<<, $(( << )) and <<\\EOF are read right', () => {
  const untagged = (line: number) => `${line}: no WHY:, INVARIANT: or issue/decision id`;
  const run = ['jobs:', '  a:', '    steps:', '      - run: |', '          cat <<EOF', '          # body, not a comment', '          EOF', '          # after the heredoc', '          make'].join('\n');
  assert.deepEqual(verdict('ci.yml', run), [untagged(8)]);
  const tabs = ['steps:', '  - run: |', '      cat <<-EOF', '      \t# body', '      \tEOF', '      # after'].join('\n');
  assert.deepEqual(verdict('ci.yml', tabs), [untagged(6)]);
  assert.deepEqual(verdict('a.sh', 'grep x <<< hello\n# after a here-string\n'), [untagged(2)]);
  assert.deepEqual(verdict('a.sh', 'y=$(( x << y ))\n(( z = 1 << 2 ))\n# after a shift\n'), [untagged(3)]);
  assert.deepEqual(verdict('a.sh', 'cat <<\\EOF\n# body\nEOF\n# after\n'), [untagged(4)]);
  assert.deepEqual(verdict('a.sh', "cat <<-'EOF'\n\t# body\n\tEOF\n# after\n"), [untagged(4)]);
});

test('#628: quoted <<EOF, CRLF terminators and two heredocs on one line leave the rest of the file checked', () => {
  const untagged = (line: number) => `${line}: no WHY:, INVARIANT: or issue/decision id`;
  assert.deepEqual(verdict('a.sh', 'echo "use <<EOF here"\n# after a quoted <<\n'), [untagged(2)]);
  assert.deepEqual(verdict('a.sh', "echo 'x <<EOF'\n# after\n"), [untagged(2)]);
  assert.deepEqual(verdict('a.sh', 'cat <<EOF\r\n# body\r\nEOF\r\n# after\r\n'), [untagged(4)]);
  const crlfYaml = ['steps:', '  - run: |', '      cat <<EOF', '      # body', '      EOF', '      # after'].join('\r\n');
  assert.deepEqual(verdict('ci.yml', crlfYaml), [untagged(6)]);
  assert.deepEqual(verdict('a.sh', 'cat <<A <<B\n# a body\nA\n# b body\nB\n# after\n'), [untagged(6)]);
  assert.deepEqual(verdict('a.ts', '// eslint complains\n'), [untagged(1)]);
  assert.deepEqual(verdict('a.ts', '/* eslint-env node, browser */\n'), [], 'a real eslint-env list stays exempt');
});

test('#634: $\'…\' escapes, whole-word heredoc delimiters, ${…} and nested $(( )) leave the rest checked; an unclosed opener fails closed', () => {
  const untagged = (...lines: number[]) => lines.map((l) => `${l}: no WHY:, INVARIANT: or issue/decision id`);
  const cases: [string, number[]][] = [
    ["echo $'it\\'s'\n# a\necho ok\n# b\n", [2, 4]],
    ['cat <<END-X\n# body\nEND-X\n# after\n', [4]],
    ['cat <<EOF.txt\n# body\nEOF.txt\n# after\n', [4]],
    ["cat <<'END X'\n# body\nEND X\n# after\n", [4]],
    ['echo ${v:-<<x}\n# after\n', [2]],
    ['y=$(( $((a)) << b ))\n# after\n', [2]],
    ['echo "never closed\n# after\n', [2]],
    ['cat <<NEVER\n# after\n', [2]],
  ];
  for (const [sh, lines] of cases) {
    assert.deepEqual(verdict('a.sh', sh), untagged(...lines), sh);
    const yaml = `steps:\n  - run: |\n${sh
      .trimEnd()
      .split('\n')
      .map((l) => `      ${l}`)
      .join('\n')}\n  - name: next\n`;
    assert.deepEqual(verdict('ci.yml', yaml), untagged(...lines.map((l) => l + 2)), `run: ${sh}`);
  }
  assert.deepEqual(verdict('a.ts', '// eslint warns: unused var\n'), untagged(1));
  assert.deepEqual(verdict('a.ts', '/* eslint quotes: [2, "double"] */\n'), []);
});

test('directives are exempt only in their real syntax; prose that starts like one is judged', () => {
  for (const ok of ['// @ts-expect-error: upstream type', '// eslint-disable-next-line no-console', '/* eslint-disable */', '/* eslint no-console: off */', '/* global window, document: readonly */', '// #region helpers', '// #endregion', '# shellcheck disable=SC2086', '/* istanbul ignore next */', '// prettier-ignore']) {
    assert.deepEqual(verdict(ok.startsWith('#') ? 'a.sh' : 'a.ts', `${ok}\n`), [], ok);
  }
  for (const prose of ['// global state is shared here', '// global counter', '// region where the loop runs', '// eslint is noisy here', '# shellcheck is not installed in CI']) {
    assert.equal(verdict(prose.startsWith('#') ? 'a.sh' : 'a.ts', `${prose}\n`).length, 1, prose);
  }
});

test('the hook and CI agree whatever the git config: diff.mnemonicPrefix and diff.noprefix', () => {
  for (const [key, value] of [['diff.mnemonicPrefix', 'true'], ['diff.noprefix', 'true']] as const) {
    const { dir, git, base } = project();
    git('config', key, value);
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'src', 'old.ts'), '// an old untagged comment\nexport const a = 1;\n// untagged new\n');
    writeFileSync(join(dir, 'b', 'y.ts'), '// untagged in a dir named b\n');
    git('add', '-A');
    const atWrite = [...checkWorkingFile(dir, 'src/old.ts', policy), ...checkWorkingFile(dir, 'b/y.ts', policy)].map((f) => `${f.file}:${f.line}`);
    git('commit', '-q', '-m', 'change');
    const inCi = checkRange(dir, base, 'HEAD', policy).map((f) => `${f.file}:${f.line}`);
    assert.deepEqual(atWrite.sort(), ['b/y.ts:1', 'src/old.ts:3'], key);
    assert.deepEqual(inCi.sort(), atWrite, key);
  }
});

test('the diff parser: added lines per new-side path, deletions and context ignored', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -3,0 +4,3 @@', '+a', '+b', '+++ c', '@@ -9 +11,0 @@', '-c', 'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-z'].join('\n');
  assert.deepEqual([...addedLines(diff)].map(([f, s]) => [f, [...s]]), [['x.ts', [4, 5, 6]]], 'an added line "++ c" is a line, not a path');
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
