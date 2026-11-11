// #941: six tables were built by code and are now written out as plain data: NEVER_LOOSEN (src/delegation.ts), FLOOR
// (src/merge-policy.ts), SELF_MODIFICATION_PARTS and LOCKED_CATEGORIES (src/review.ts), and BROAD_RULES (src/events/
// redact.ts, and the root updater's generated copy of it). What the build did is checked instead, when each module
// loads (it throws, so the engine never runs on a drifted table): each check is [] on the repo's data, and names a
// drift of each kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { neverLoosenProblems, NEVER_LOOSEN } from '../src/delegation.js';
import { redactTableProblems } from '../src/events/redact.js';
import { HOOK_IMPORTS } from '../src/hook-imports.js';
import { floorProblems } from '../src/merge-policy.js';
import { GIT_GUARD_PAIRS, gitTableProblems } from '../src/os/git.js';
import { DECISION_RECORD_GLOBS, DECISION_RECORDS_PART, HARNESS_CONFIG, LOCKED_CATEGORIES, lockDataProblems, SELF_MODIFICATION, SELF_MODIFICATION_PARTS, TOOL_GUARD_PART } from '../src/review.js';

/** A deep, mutable copy. */
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('the written-out tables hold what they were built from (#941)', () => {
  assert.deepEqual([neverLoosenProblems(), floorProblems(), lockDataProblems(), redactTableProblems(), gitTableProblems()], [[], [], [], [], []]);
});

test('NEVER_LOOSEN and FLOOR: an odd path or the diff-hiding mark missing is named (#941)', () => {
  assert.deepEqual(neverLoosenProblems(NEVER_LOOSEN.filter((c) => c !== 'confusable-path')), ["NEVER_LOOSEN doesn't hold confusable-path"]);
  assert.deepEqual(floorProblems(['agent-instructions', 'self-modification', 'harness-config']).length, 6);
  assert.ok(floorProblems([]).includes(`FLOOR doesn't hold ${SELF_MODIFICATION}`));
});

test('SELF_MODIFICATION_PARTS and LOCKED_CATEGORIES: each rule of the old build is checked (#941)', () => {
  const parts = copy(SELF_MODIFICATION_PARTS) as { what: string; globs: string[] }[];
  const locked = copy(LOCKED_CATEGORIES) as Record<string, string[]>;
  const guard = parts.find((p) => p.what === TOOL_GUARD_PART)!;
  const lacks = (f: (p: typeof parts, l: typeof locked) => void, word: string) => {
    const [p, l] = [copy(parts), copy(locked)];
    f(p, l);
    assert.ok(lockDataProblems(p, l).some((x) => x.includes(word)), `${word}: ${lockDataProblems(p, l).join(' | ')}`);
  };
  lacks((p) => p[0]!.globs.push(p[1]!.globs[0]!), 'more than one part');
  lacks((p) => p.find((x) => x.what === TOOL_GUARD_PART)!.globs.splice(p.find((x) => x.what === TOOL_GUARD_PART)!.globs.indexOf(HOOK_IMPORTS[0]!), 1), 'HOOK_IMPORTS');
  lacks((p) => p.find((x) => x.what === DECISION_RECORDS_PART)!.globs.pop(), "decision records' part");
  lacks((p) => (p.find((x) => x.what === DECISION_RECORDS_PART)!.what = 'renamed'), "decision records' part");
  lacks((_, l) => delete l[HARNESS_CONFIG], 'keys');
  lacks((_, l) => l[SELF_MODIFICATION]!.pop(), 'self-modification');
  lacks((_, l) => l[HARNESS_CONFIG]!.pop(), 'harness-config');
  assert.ok(guard.globs.length >= HOOK_IMPORTS.length && DECISION_RECORD_GLOBS.length > 0);
});

test('BROAD_RULES, the dashboard key and the glued prefixes: a drift is named (#941)', () => {
  const p = { re: { source: 'wld_[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])', flags: 'g' }, rep: 'wld_[REDACTED]' };
  const b = { re: { source: 'x', flags: 'g' }, mask: '$1 {mask}' };
  const rules = [p, { re: b.re, rep: '$1 [REDACTED]' }];
  assert.deepEqual(redactTableProblems([p], [b], rules, ['wld_']), []);
  assert.deepEqual(redactTableProblems([p], [b], rules.slice(0, 1), ['wld_']), ["BROAD_RULES isn't PATTERNS' rules then BROAD's"]);
  assert.deepEqual(redactTableProblems([p], [b], [p, { re: b.re, rep: '$1 {mask}' }], ['wld_']), ["BROAD_RULES isn't PATTERNS' rules then BROAD's"]);
  assert.deepEqual(redactTableProblems([{ ...p, re: { source: 'x', flags: 'g' } }], [], [{ ...p, re: { source: 'x', flags: 'g' } }], ['wld_']), ["PATTERNS' first isn't the dashboard key's"]);
  assert.deepEqual(redactTableProblems([p], [], [p], ['ghp_']), ["GLUED_PREFIXES doesn't end with DASHBOARD_KEY_PREFIX"]);
});

test("GIT_GUARD_PAIRS: a key set twice is refused (git takes a key's last value), however it is cased; so is a pattern REFUSED_KEYS lists twice (#941, R1184l)", () => {
  assert.deepEqual(gitTableProblems([...GIT_GUARD_PAIRS, ['core.fsmonitor', '/tmp/x']]), ['GIT_GUARD_PAIRS sets core.fsmonitor more than once']);
  assert.deepEqual(gitTableProblems([...GIT_GUARD_PAIRS, ['Credential.Helper', '!x']]), ['GIT_GUARD_PAIRS sets Credential.Helper more than once']);
  assert.deepEqual(gitTableProblems(GIT_GUARD_PAIRS, [[/^a$/, 'x'], [/^a$/, 'y']]), ['REFUSED_KEYS lists ^a$ more than once']);
});

test("GIT_GUARD_PAIRS may not set a key REFUSED_KEYS names: include.path or includeIf reads another file in after the guard's keys (#941, R1184m 2)", () => {
  assert.deepEqual(gitTableProblems([...GIT_GUARD_PAIRS, ['include.path', '/tmp/evil.gitconfig']]), ['GIT_GUARD_PAIRS sets include.path, which reads another file in as config']);
  assert.equal(gitTableProblems([...GIT_GUARD_PAIRS, ['includeIf.gitdir:/x/.path', '/tmp/e']]).length, 1);
  assert.equal(gitTableProblems([...GIT_GUARD_PAIRS, ['url.https://evil/.insteadOf', 'https://github.com/']]).length, 1);
});

test("every replacer the redaction data names is in REPLACERS, in the module and in the updater's copy, where the hold reads it (#941, R1184r D1)", async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { replacerLines } = await import('../src/merge-policy-weakening.js');
  const { repoRoot } = await import('./helpers.js');
  const { BRAND } = await import('../src/brand.js');
  const data = readFileSync(join(repoRoot, 'src', 'events', 'redact.tables.json'), 'utf8');
  const names = [...new Set([...data.matchAll(/"replacer": "(\w+)"/g)].map((m) => m[1]!))];
  assert.deepEqual(names.sort(), ['basic', 'jsonKey', 'orphanEnd', 'stripe']);
  for (const file of [join('src', 'events', 'redact.ts'), join('scripts', 'machine', `${BRAND.cli}-update.cjs`)]) {
    const block = replacerLines(readFileSync(join(repoRoot, file), 'utf8')).join('\n');
    assert.ok(block, `${file}: the hold finds its REPLACERS block`);
    for (const n of names) assert.ok(new RegExp(`^\\s*${n}\\b`, 'm').test(block), `${file}: REPLACERS holds ${n}`);
  }
});

/**
 * The names REPLACERS's literal defines, read with TypeScript's parser, and what it holds that isn't a plain named
 * property (R1184t D1: a spread, a computed or quoted key, an accessor, or a name defined twice can replace a replacer
 * the data names while each name still starts a line of the block).
 */
function replacerProblems(text: string, file: string): { names: string[]; problems: string[] } {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const names: string[] = [];
  const problems: string[] = [];
  let found = 0;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'REPLACERS') {
      found++;
      const init = n.initializer;
      const lit = init && ts.isCallExpression(init) && init.arguments.length === 1 && ts.isObjectLiteralExpression(init.arguments[0]!) ? init.arguments[0] : undefined;
      if (!lit) problems.push(`${file}: REPLACERS is not Object.freeze({ ... })`);
      else
        for (const p of lit.properties) {
          const line = src.getLineAndCharacterOfPosition(p.getStart(src)).line + 1;
          const name = (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) ? p.name.text : undefined;
          if (name === undefined) problems.push(`${file}:${line}: not a plain named property (${p.getText(src).slice(0, 50)})`);
          else if (names.includes(name)) problems.push(`${file}:${line}: ${name} defined twice`);
          else names.push(name);
        }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  if (found !== 1) problems.push(`${file}: REPLACERS declared ${found} times`);
  return { names, problems };
}

test("REPLACERS is plain named properties, each defined once, in the module and the updater's copy, and holds at run time just the names it defines (#941, R1184t D1)", async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { REPLACER_NAMES } = await import('../src/events/redact.js');
  const { repoRoot } = await import('./helpers.js');
  const { BRAND } = await import('../src/brand.js');
  for (const file of [join('src', 'events', 'redact.ts'), join('scripts', 'machine', `${BRAND.cli}-update.cjs`)]) {
    const { names, problems } = replacerProblems(readFileSync(join(repoRoot, file), 'utf8'), file);
    assert.deepEqual(problems, [], file);
    assert.deepEqual([...REPLACER_NAMES].sort(), [...names].sort(), `${file}: the run-time names are the names the block defines`);
  }
  // The shapes it refuses: T2a and T2b (a new key, then a spread), a computed key, a quoted key, an accessor, a twin.
  const block = (props: string) => `const REPLACERS = Object.freeze({\n  stripe: (m) => m,\n${props}\n});\n`;
  for (const [label, props] of [
    ['T2a', "  zz: (m) => m, ...({ stripe: (m) => m }),"],
    ['T2b', "  zz(m) { return m; }, ...({ stripe: (m) => m }),"],
    ['V1a', "  zz: (m) => m + '(', ...({ stripe: (m) => m }), yy: (m) => m + ')',"],
    ['W1a', '  zz: (m) => m, // note\u2028  ...({ stripe: (m) => m }),'],
    ['computed', "  ['basic']: (m) => m,"],
    ['quoted', "  'basic': (m) => m,"],
    ['accessor', '  get basic() { return (m) => m; },'],
    ['twice', '  stripe: (m) => m.slice(1),'],
  ] as const) assert.ok(replacerProblems(block(props), 'x.js').problems.length > 0, label);
  assert.deepEqual(replacerProblems(block('  zz: (m) => m,\n  orphanEnd,\n  basic(m) { return m; },'), 'x.js').problems, [], 'the control');
});

test('the freeze hook and the tests that pin the tables and the copy lock are self-modification and engine guards: never a tests-only change (#941, R1184ak D1-D2)', async () => {
  const { globMatches } = await import('../src/confusables.js');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { repoRoot } = await import('./helpers.js');
  const guards = readFileSync(join(repoRoot, '.worklane', 'review.yaml'), 'utf8');
  const locked = (p: string) => LOCKED_CATEGORIES[SELF_MODIFICATION]!.some((g) => globMatches(g, p));
  const part = SELF_MODIFICATION_PARTS.find((x) => x.what === 'the tests of the harness controls')!;
  for (const p of ['test/table-freeze.ts', 'test/table-freeze.test.ts', 'test/table-copies.test.ts', 'test/check-tables.test.ts', 'test/check-tables-sync.test.ts', 'test/merge-policy-data-attacks.test.ts', 'test/merge-policy-data-tables.test.ts']) {
    assert.ok(locked(p), `${p}: self-modification`);
    assert.ok(part.globs.some((g) => globMatches(g, p)), `${p}: in the harness controls' tests part`);
    assert.ok(guards.split('\n').includes(`    - ${p}`), `${p}: an engine guard in .worklane/review.yaml`);
  }
  // Control: an unrelated test file is in none of them.
  assert.ok(!locked('test/zz-unrelated.test.ts') && !guards.includes('test/zz-unrelated.test.ts'));
});
