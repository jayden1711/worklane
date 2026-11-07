// docs/guardrails.md states what each guardrail guarantees and names the code and the test that hold it;
// docs/security.md names the test that holds each fixed guard gap. These tests read the pages at run time and check
// every reference against the tree: a cited file that was moved or removed, a symbol renamed, a test retitled or
// deleted, a test cited in a form the check can't read, or a hold kind the merge decision gained without a docs line
// fails here, so the pages can't go on citing proof that no longer exists (#705).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';
import { instructionEvalReasons, mergeDecision, outsidePlanReasons, type MergeInput, type MergeVerdict } from '../src/merge-policy.js';
import { weakeningReasons } from '../src/merge-policy-weakening.js';
import { vacuityCheck } from '../src/merge-policy-vacuity.js';
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
/** A test cited by name: `test/x.test.ts` › “its exact title”, on one line. */
const TEST_CITE = /`(test\/[^`\s]+\.test\.ts)` › “([^”\n]+)”/g;
/** A test file named, then a quote or an arrow of any kind: a test citation, whatever its form. */
const LOOKS_CITED = /`test\/[^`\s]+\.test\.ts`[ \t]*[:,—–-]?[ \t]*["'‘’“”„«»›>]/g;

function codeSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

/**
 * The names `src` declares at its top level (functions, variables, classes, interfaces, types, enums) and the members
 * of its top-level classes: what `file#symbol` may cite. A local inside a function body isn't one, so a citation
 * means the code it names.
 */
function citableNames(src: string): Set<string> {
  const file = ts.createSourceFile('cited.ts', src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names = new Set<string>();
  const add = (n: ts.Node | undefined) => {
    if (n && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteral(n))) names.add(n.text);
  };
  for (const s of file.statements) {
    if (ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) add(s.name);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) add(d.name);
    else if (ts.isClassDeclaration(s)) {
      add(s.name);
      for (const m of s.members) add(m.name);
    }
  }
  return names;
}

/** Every file, symbol, line or link `md` (the page at `path`) cites that doesn't resolve, and how many it read. */
function fileCitationProblems(md: string, path: string): { read: number; missing: string[] } {
  const cited = codeSpans(md).map((s) => CITED.exec(s)).filter((m): m is RegExpExecArray => m !== null);
  const missing: string[] = [];
  for (const [span, file, symbol, from, to] of cited) {
    const abs = join(repoRoot, file!);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      missing.push(`${span}: no such file`);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    if (symbol && !citableNames(src).has(symbol)) missing.push(`${span}: ${symbol} is not declared at the top level of ${file}, nor a member of a top-level class there`);
    const lines = src.split('\n').length;
    for (const n of [from, to]) if (n !== undefined && (Number(n) < 1 || Number(n) > lines)) missing.push(`${span}: line ${n} is outside ${file} (${lines} lines)`);
  }
  // Relative links to other pages resolve too.
  for (const m of md.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    const href = m[1]!;
    if (/^[a-z]+:/i.test(href)) continue;
    if (!existsSync(normalize(join(repoRoot, dirname(path), href)))) missing.push(`link ${href}: no such file`);
  }
  return { read: cited.length, missing };
}

/**
 * The tests `md` cites by name, and every place that names or quotes a test outside the one form the check reads: a
 * “ or › outside a citation, or a test file followed by any other quote or arrow. Such a citation would go unchecked,
 * so it is an error, never skipped.
 */
function testCitations(md: string): { cites: { file: string; title: string }[]; unread: string[] } {
  const found = [...md.matchAll(TEST_CITE)];
  const spans = found.map((m) => [m.index, m.index + m[0].length] as const);
  const near = (i: number) => JSON.stringify(md.slice(Math.max(0, i - 30), i + 70));
  const unread: string[] = [];
  for (const m of md.matchAll(/[“›]/g)) if (!spans.some(([a, b]) => m.index >= a && m.index < b)) unread.push(`${m[0]} outside a citation: ${near(m.index)}`);
  for (const m of md.matchAll(LOOKS_CITED)) if (!spans.some(([a]) => a === m.index)) unread.push(`a test cited in a form the check can't read: ${near(m.index)}`);
  return { cites: found.map((m) => ({ file: m[1]!, title: m[2]! })), unread };
}

/** `title` is the title of a test() in `src`, in any of the three string quotes, with that quote escaped inside. */
function hasTest(src: string, title: string): boolean {
  return ["'", '"', '`'].some((q) => src.includes(`test(${q}${title.replace(/\\/g, '\\\\').split(q).join(`\\${q}`)}${q}`));
}

test('the guardrails page and the security write-up exist', () => {
  for (const { path } of PAGES) assert.ok(existsSync(join(repoRoot, path)), `${path} is missing`);
});

for (const { path, files: atLeast } of PAGES) test(`every file ${path} cites exists, every symbol it names is declared there, and every line is inside the file`, () => {
  const { read: n, missing } = fileCitationProblems(read(path), path);
  // Not vacuous: a change to the citation format that the pattern no longer reads would otherwise pass with nothing checked.
  assert.ok(n >= atLeast, `the page cites at least ${atLeast} files (read ${n})`);
  assert.deepEqual(missing, [], 'every reference resolves');
});

for (const { path, tests: atLeast } of PAGES) test(`every test ${path} cites by name is a test of that title in that file`, () => {
  const { cites, unread } = testCitations(read(path));
  assert.deepEqual(unread, [], 'every test citation on the page is in the form `test/x.test.ts` › “title”');
  assert.ok(cites.length >= atLeast, `the page cites at least ${atLeast} tests by name (read ${cites.length})`);
  const missing = cites.filter(({ file, title }) => {
    const abs = join(repoRoot, file);
    return !existsSync(abs) || !hasTest(readFileSync(abs, 'utf8'), title);
  });
  assert.deepEqual(missing, [], 'every cited test exists under its exact title');
});

test('a test cited in any other form is an error, not skipped: straight or single quotes, a colon, no ›, an open “', () => {
  const md = page();
  const first = [...md.matchAll(TEST_CITE)][0]!;
  const [whole, file, title] = first;
  for (const other of [
    `\`${file}\` › "${title}"`,
    `\`${file}\` › '${title}'`,
    `\`${file}\`: “${title}”`,
    `\`${file}\` “${title}”`,
    `\`${file}\` > "${title}"`,
    `\`${file}\` › “${title}"`,
  ]) {
    assert.ok(testCitations(md.replace(whole, other)).unread.length > 0, `${other.slice(0, 70)}: caught`);
  }
  assert.deepEqual(testCitations(md).unread, [], 'the page as it is has none');
});

test('file#symbol cites a top-level declaration or a member of a top-level class, never a local inside a function', () => {
  const policy = read('src/merge-policy.ts');
  assert.ok(/const reasons\b/.test(policy), 'the fixture: mergeDecision keeps a local named reasons');
  const names = citableNames(policy);
  assert.ok(names.has('mergeDecision') && names.has('waitCategoriesOf') && names.has('HIGH_RISK_REASON'));
  assert.ok(!names.has('reasons'), 'a local const inside mergeDecision is not citable');
  assert.ok(citableNames(read('src/coordinator/merge-flow.ts')).has('mergeOrWait'), 'a method of a top-level class is');
  const { missing } = fileCitationProblems(`\`src/merge-policy.ts#reasons\``, PAGE);
  assert.equal(missing.length, 1, 'citing the local fails');
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
  // A change that takes an assertion out of a test: the #783 hold, from its own function.
  weakening: weakeningReasons({ files: [{ path: 'test/a.test.ts', added: 0, removed: 1, addedLines: [], removedLines: ['  assert.ok(x);'] }], deleted: new Set(), before: () => null, after: () => null, scope: undefined }),
  // A change to app code with no test: the #784 hold, from its own function.
  vacuity: vacuityCheck({ cfg: { test_globs: ['test/**'], assertion_pattern: 'assert', app_paths: ['src/**'], dynamic: true }, runOne: 'node --test {file}', changed: ['src/a.ts'], atHead: () => 'x', runs: { started: 0, last: null } }).reasons,
  // Its run still to come: a `design:` reason too, given only when nothing else holds (merge-policy-vacuity.test.ts).
  vacuityPending: true,
};

/** The two switch reasons have no colon and share this kind. */
const SWITCH_KIND = 'auto-merge is off';
/** A reason's kind, exactly: its text through the first colon, or the switches' fixed text; otherwise the whole reason. */
function kindOf(reason: string): string {
  return /^[^:]*:/.exec(reason)?.[0] ?? (reason.startsWith(`${SWITCH_KIND} `) ? SWITCH_KIND : reason);
}

/** The kinds every reason mergeDecision gives, with every input on. */
function reasonKinds(): Map<string, string> {
  const reasons = [
    ...mergeDecision(everything).reasons,
    ...mergeDecision({ ...everything, verdict: { ...verdict, design_change: undefined } }).reasons,
    ...mergeDecision({ ...everything, verdict: null }).reasons,
  ];
  return new Map(reasons.map((r) => [kindOf(r), r]));
}

/** The kinds the page's "### Hold kinds" table lists, or null when it has no such section. */
function listedKinds(md: string): string[] | null {
  const at = md.indexOf('\n### Hold kinds\n');
  if (at < 0) return null;
  const section = md.slice(at + 1).split(/\n#{1,3} /)[0]!;
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]!);
}

/** Reasons whose kind the page doesn't list, and listed kinds no reason has: compared exactly, never by prefix. */
function holdKindProblems(md: string): { undocumented: string[]; unused: string[] } {
  const listed = listedKinds(md) ?? [];
  const given = reasonKinds();
  return {
    undocumented: [...given].filter(([k]) => !listed.includes(k)).map(([, r]) => r),
    unused: listed.filter((k) => !given.has(k)),
  };
}

test('the hold kinds the guardrails page lists are exactly the reason kinds mergeDecision gives', () => {
  const md = page();
  // Set isn't on: a list input that is empty (an empty literal, or a helper that stopped giving a reason for its
  // fixture) gives no reason, so a kind behind it would go unseen.
  for (const [k, v] of Object.entries(everything)) if (Array.isArray(v)) assert.ok(v.length > 0, `the ${k} input is on (non-empty)`);
  assert.match(md, /`src\/merge-policy\.ts#mergeDecision`/, 'the page names mergeDecision as the decision');
  const kinds = listedKinds(md);
  assert.ok(kinds, 'the page has a "### Hold kinds" section');
  assert.ok(kinds.length > 0, 'the section lists hold kinds as table rows starting with `kind`');
  const { undocumented, unused } = holdKindProblems(md);
  assert.deepEqual(undocumented, [], 'every reason mergeDecision gives has a kind the page lists');
  assert.deepEqual(unused, [], 'every kind the page lists is one mergeDecision gives');
});

test('a short kind can not stand in for others: doubt: listed as d, with design: removed, fails', () => {
  const md = page();
  const shortened = md.replace('| `doubt:` |', '| `d` |').replace(/^\| `design:` \|.*\n/m, '');
  assert.notEqual(shortened, md, 'the fixture changed the page');
  const { undocumented, unused } = holdKindProblems(shortened);
  assert.ok(undocumented.some((r) => r.startsWith('doubt: ')) && undocumented.some((r) => r.startsWith('design: ')), `doubt: and design: reasons are undocumented (${undocumented.length})`);
  assert.deepEqual(unused, ['d']);
  assert.equal(kindOf('auto-merge is off for this repo (review.yaml merge.auto)'), SWITCH_KIND);
  assert.equal(kindOf('a new reason with no colon'), 'a new reason with no colon', 'a new reason with no colon is its own kind, so it fails until listed');
});
