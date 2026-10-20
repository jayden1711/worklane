// docs/guardrails.md states what each guardrail guarantees and names the code and the test that hold it;
// docs/security.md names the test that holds each fixed guard gap. These tests read the pages at run time and check
// every reference against the tree: a cited file that was moved or removed, a symbol renamed, a test retitled or
// deleted, or a hold kind the merge decision gained without a docs line fails here, so the pages can't go on citing
// proof that no longer exists (#705).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { instructionEvalReasons, mergeDecision, outsidePlanReasons, type MergeInput, type MergeVerdict } from '../src/merge-policy.js';
import type { LevelResult } from '../src/review.js';
import { repoRoot } from './helpers.js';

const PAGE = 'docs/guardrails.md';
/** Each page, with how many file and test citations it has at least (so a format the patterns stop reading fails). */
const PAGES = [
  { path: PAGE, files: 30, tests: 25 },
  { path: 'docs/security.md', files: 5, tests: 10 },
];
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');
const page = () => read(PAGE);

/** A path the page cites in inline code: `src/x.ts`, `src/x.ts#symbol`, `test/x.test.ts:12` or `:12-30`. */
const CITED = /^((?:src|test|scripts|web|docs|\.github)\/[^\s`#:]+)(?:#([A-Za-z_$][\w$]*))?(?::(\d+)(?:-(\d+))?)?$/;
/** A test cited by name: `test/x.test.ts` › “its exact title”. */
const TEST_CITE = /`(test\/[^`\s]+\.test\.ts)` › “([^”]+)”/g;

function codeSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/** `symbol` is declared in `src`: a function, const, class, type, interface, enum, or a method. */
function declares(src: string, symbol: string): boolean {
  const s = symbol.replace(/\$/g, '\\$');
  return new RegExp(`(?:function\\*?|const|let|var|class|interface|type|enum)\\s+${s}\\b`).test(src) || new RegExp(`^\\s*(?:(?:export|private|protected|public|async|static|readonly|abstract|override)\\s+)*${s}\\s*[(<]`, 'm').test(src);
}

/** `title` is the title of a test() in `src`, in any of the three string quotes, with that quote escaped inside. */
function hasTest(src: string, title: string): boolean {
  return ["'", '"', '`'].some((q) => src.includes(`test(${q}${title.replace(/\\/g, '\\\\').split(q).join(`\\${q}`)}${q}`));
}

test('the guardrails page and the security write-up exist', () => {
  for (const { path } of PAGES) assert.ok(existsSync(join(repoRoot, path)), `${path} is missing`);
});

for (const { path, files: atLeast } of PAGES) test(`every file ${path} cites exists, every symbol it names is declared there, and every line is inside the file`, () => {
  const md = read(path);
  const cited = codeSpans(md).map((s) => CITED.exec(s)).filter((m): m is RegExpExecArray => m !== null);
  // Not vacuous: a change to the citation format that the pattern no longer reads would otherwise pass with nothing checked.
  assert.ok(cited.length >= atLeast, `the page cites at least ${atLeast} files (read ${cited.length})`);
  const missing: string[] = [];
  for (const [span, file, symbol, from, to] of cited) {
    const abs = join(repoRoot, file!);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      missing.push(`${span}: no such file`);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    if (symbol && !declares(src, symbol)) missing.push(`${span}: ${symbol} is not declared in ${file}`);
    const lines = src.split('\n').length;
    for (const n of [from, to]) if (n !== undefined && (Number(n) < 1 || Number(n) > lines)) missing.push(`${span}: line ${n} is outside ${file} (${lines} lines)`);
  }
  // Relative links to other pages resolve too.
  for (const m of md.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    const href = m[1]!;
    if (/^[a-z]+:/i.test(href)) continue;
    if (!existsSync(normalize(join(repoRoot, dirname(path), href)))) missing.push(`link ${href}: no such file`);
  }
  assert.deepEqual(missing, [], 'every reference resolves');
});

for (const { path, tests: atLeast } of PAGES) test(`every test ${path} cites by name is a test of that title in that file`, () => {
  const md = read(path);
  const cites = [...md.matchAll(TEST_CITE)].map((m) => ({ file: m[1]!, title: m[2]! }));
  // Every “ opens a citation the pattern read: a malformed one is an error, never skipped.
  assert.equal((md.match(/“/g) ?? []).length, cites.length, 'every “…” on the page is a test citation in the form `test/x.test.ts` › “title”');
  assert.ok(cites.length >= atLeast, `the page cites at least ${atLeast} tests by name (read ${cites.length})`);
  const missing = cites.filter(({ file, title }) => {
    const abs = join(repoRoot, file);
    return !existsSync(abs) || !hasTest(readFileSync(abs, 'utf8'), title);
  });
  assert.deepEqual(missing, [], 'every cited test exists under its exact title');
});

// Every input set: Required<> makes a new MergeInput or MergeVerdict field a type error here until the test sets it,
// so a new reason can't be added behind an input this test never turns on.
const level: LevelResult = { level: 'L3', reasons: [], categories: { migration: ['db/001.sql'], dependency: ['package.json'] } };
const verdict: Required<MergeVerdict> = { patch_correct: false, test_correct: false, confidence: 'low', confidence_reason: 'unsure', advice: 'look again', unread: ['src/a.ts'], design_change: true, design_reason: 'a new module' };
const everything: Required<MergeInput> = {
  branch: 'feature',
  openedByHarness: false,
  policyOn: false,
  repoOn: false,
  stopped: 'main went red',
  level,
  waitCategories: ['migration'],
  limits: { max_lines: 1, max_files: 1 },
  lines: 2,
  files: 2,
  verdict,
  newTopLevel: ['plugins/'],
  ciFixRuns: 1,
  foreignPush: true,
  pushLimitHit: true,
  instructionEvals: instructionEvalReasons(['roles/worker'], []),
  outsidePlan: outsidePlanReasons({ planFiles: [], level, waitCategories: ['migration'], newTopLevel: ['plugins/'] }),
  claimedProtected: true,
};

test('the hold kinds the guardrails page lists are exactly the reason kinds mergeDecision gives', () => {
  const md = page();
  assert.match(md, /`src\/merge-policy\.ts#mergeDecision`/, 'the page names mergeDecision as the decision');
  const at = md.indexOf('\n### Hold kinds\n');
  assert.ok(at >= 0, 'the page has a "### Hold kinds" section');
  const section = md.slice(at + 1).split(/\n#{1,3} /)[0]!;
  const kinds = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
  assert.ok(kinds.length > 0, 'the section lists hold kinds as table rows starting with `kind`');

  const reasons = new Set([
    ...mergeDecision(everything).reasons,
    ...mergeDecision({ ...everything, verdict: { ...verdict, design_change: undefined } }).reasons,
    ...mergeDecision({ ...everything, verdict: null }).reasons,
  ]);
  const undocumented = [...reasons].filter((r) => !kinds.some((k) => r.startsWith(k)));
  assert.deepEqual(undocumented, [], 'every reason mergeDecision gives starts with a kind the page lists');
  const unused = kinds.filter((k) => ![...reasons].some((r) => r.startsWith(k)));
  assert.deepEqual(unused, [], 'every kind the page lists is one mergeDecision gives');
});
