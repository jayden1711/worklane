// lint-test
// #948: one fail-closed workflow reader (src/workflow-read.ts). Each shape `yaml` may read otherwise than GitHub is
// `unsure`; every engine and CI path that parses workflow text uses the reader and fails closed on `unsure`; a scan
// keeps any new one from parsing workflows with `yaml` directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWorkflowText } from '../src/workflow-read.js';
import { workflowCheckNames } from '../src/check-pin-block.js';
import { disabledWorkflowsOf } from '../src/main-watch.js';
import { repoRoot } from './helpers.js';

const guard = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'self-hosted-guard.mjs')).href)) as { workflowProblems: (text: string) => string[] };

const ch = (c: number) => String.fromCharCode(c);
const plain = 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n';
/** A job hidden after a character other readers end a line at, inside a comment. */
const hidden = (c: string) => `on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    # note${c}  sneak:\n    steps: [{ run: "true" }]\n`;

test('a plain workflow reads sure, with its value', () => {
  const r = readWorkflowText(plain);
  assert.equal(r.unsure, null);
  assert.deepEqual(Object.keys((r.value as { jobs: object }).jobs), ['build']);
  assert.equal(readWorkflowText(new TextEncoder().encode(plain)).unsure, null, 'bytes too');
  assert.equal(readWorkflowText(`\ufeff${plain}`).unsure, null, 'a BOM at offset 0');
});

test('every workflow in this repository reads sure', () => {
  const dir = join(repoRoot, '.github', 'workflows');
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) assert.equal(readWorkflowText(readFileSync(join(dir, f))).unsure, null, f);
});

test('each shape GitHub may read otherwise is unsure', () => {
  const cases: [string, string | Uint8Array, string][] = [
    ['a lone CR', hidden('\r'), 'a character outside TAB, LF and printable ASCII'],
    ['NEL', hidden(ch(0x85)), 'a character outside TAB, LF and printable ASCII'],
    ['LS', hidden(ch(0x2028)), 'a character outside TAB, LF and printable ASCII'],
    ['PS', hidden(ch(0x2029)), 'a character outside TAB, LF and printable ASCII'],
    ['a BOM past offset 0', `on: push\n${ch(0xfeff)}jobs: {}\n`, 'a character outside TAB, LF and printable ASCII'],
    ['a NUL', `on: push\njobs: {}\n#${ch(0)}\n`, 'a character outside TAB, LF and printable ASCII'],
    ['bytes that are not UTF-8', new Uint8Array([0x6f, 0x6e, 0x3a, 0x20, 0xff, 0x0a]), 'not UTF-8'],
    ['no parse', 'jobs: [', "the file doesn't parse"],
    ['a duplicate key', 'jobs: {}\njobs: {}\n', "the file doesn't parse"],
    ['%YAML 1.1', `%YAML 1.1\n---\n${plain}`, 'a %YAML or %TAG directive'],
    ['%TAG', `%TAG !e! tag:example.com,2000:\n---\n${plain}`, 'a %YAML or %TAG directive'],
    ['a merge key', 'x: &b { runs-on: ubuntu-latest }\njobs:\n  build:\n    <<: *b\n', 'a merge key'],
    ['a quoted merge key', 'x: &b { runs-on: ubuntu-latest }\njobs:\n  build:\n    "<<": *b\n', 'a merge key'],
    ['an explicit tag', 'jobs:\n  build:\n    timeout-minutes: !!float 22\n', 'an explicit tag'],
    ['a hex number', 'jobs:\n  build:\n    timeout-minutes: 0xffffffff\n', 'a number not in plain decimal'],
    ['a leading-zero number', 'jobs:\n  build:\n    timeout-minutes: 022\n', 'a number not in plain decimal'],
    ['an anchor defined twice', 'a: &n one\nb: &n two\njobs:\n  build:\n    name: *n\n', 'an anchor defined twice'],
    ['a key that is not a string', 'jobs:\n  true:\n    runs-on: x\n', 'a mapping key that is not a string'],
  ];
  for (const [what, text, why] of cases) assert.equal(readWorkflowText(text).unsure, why, what);
});

test('check-pin-block: a workflow GitHub may read otherwise gives no names, its reason listed', () => {
  const files = { '.github/workflows/a.yml': hidden(ch(0x2028)), '.github/workflows/b.yml': plain };
  const { byName, unmapped } = workflowCheckNames({ files, skipped: [] });
  assert.deepEqual([...byName.keys()], ['build'], 'only b.yml names build');
  assert.deepEqual([...byName.get('build')!], ['.github/workflows/b.yml']);
  assert.deepEqual(unmapped, [{ where: '.github/workflows/a.yml', why: 'a character outside TAB, LF and printable ASCII' }]);
});

test('main-watch: a disabled workflow GitHub may read otherwise is said to post nothing by its jobs', () => {
  const at = (text: string) => disabledWorkflowsOf([{ name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'disabled_manually' }], () => text);
  assert.equal(at(plain)('build')?.name, 'Nightly', 'control: the plain file posts build');
  assert.equal(at(hidden(ch(0x2028)))('build'), null);
  assert.equal(at(`%YAML 1.1\n---\n${plain}`)('build'), null);
});

test('self-hosted guard: a workflow GitHub may read otherwise is itself a problem', () => {
  assert.deepEqual(guard.workflowProblems(plain), [], 'control');
  // GitHub may read the LS as a line break: then `runs-on` is a self-hosted label this check never sees.
  const sneaky = `on: pull_request\njobs:\n  j:\n    steps: [{ run: "true" }]\n    # x${ch(0x2028)}    runs-on: [self-hosted, box]\n    runs-on: ubuntu-latest\n`;
  assert.deepEqual(guard.workflowProblems(sneaky), ['(file): a character outside TAB, LF and printable ASCII; GitHub may read it otherwise than this check']);
  assert.match(guard.workflowProblems('x: &b { runs-on: [self-hosted] }\njobs:\n  j:\n    <<: *b\n')[0] ?? '', /a merge key/);
});

/** Every .ts/.mjs/.js file under `dir`, repo-relative. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(repoRoot, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|mjs|js)$/.test(e)) out.push(rel);
  }
  return out;
}

/** Why a file's text breaks the one-reader rule, or null. */
function readerProblem(rel: string, text: string): string | null {
  if (rel === 'src/workflow-read.ts') return null;
  const namesWorkflows = /\.github\/workflows|workflow file/.test(text);
  if (!namesWorkflows) return null;
  const usesYaml = /from\s+['"]yaml['"]/.test(text);
  const usesReader = /\breadWorkflowText\b/.test(text);
  if (usesYaml && !usesReader) return 'parses YAML and names workflow files, but never through readWorkflowText (src/workflow-read.ts)';
  if (usesReader && !/\bunsure\b/.test(text)) return 'calls readWorkflowText but never reads its `unsure`';
  return null;
}

test('scan: every src/ and scripts/ file that parses YAML and names workflow files reads them through readWorkflowText', () => {
  const bad = [...filesUnder('src'), ...filesUnder('scripts')]
    .map((rel) => [rel, readerProblem(rel, readFileSync(join(repoRoot, rel), 'utf8'))] as const)
    .filter(([, p]) => p !== null)
    .map(([rel, p]) => `${rel}: ${p}`);
  assert.deepEqual(bad, []);
  assert.ok(filesUnder('src').length > 50 && filesUnder('scripts').length > 10, 'the scan saw the trees');
  for (const rel of ['src/check-pin-block.ts', 'src/main-watch.ts', 'scripts/ci/self-hosted-guard.mjs']) {
    assert.match(readFileSync(join(repoRoot, rel), 'utf8'), /\breadWorkflowText\b/, `${rel} uses the reader`);
  }
});

test('scan fail-without: a direct yaml parse of a workflow file, or an unread unsure, is caught', () => {
  assert.match(readerProblem('src/x.ts', "import { parse } from 'yaml';\nparse(read('.github/workflows/ci.yml'));\n") ?? '', /never through readWorkflowText/);
  assert.match(readerProblem('src/x.ts', "import { readWorkflowText } from './workflow-read.js';\n// a workflow file\nreadWorkflowText(t).value;\n") ?? '', /never reads its `unsure`/);
  assert.equal(readerProblem('src/x.ts', "import { parse } from 'yaml';\nparse(config);\n"), null, 'yaml elsewhere is fine');
});
