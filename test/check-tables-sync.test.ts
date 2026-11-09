// #941: six tables were built by code and are now written out as plain data: NEVER_LOOSEN (src/delegation.ts), FLOOR
// (src/merge-policy.ts), SELF_MODIFICATION_PARTS and LOCKED_CATEGORIES (src/review.ts), and BROAD_RULES (src/events/
// redact.ts, and the root updater's generated copy of it). What the build did is checked instead, when each module
// loads (it throws, so the engine never runs on a drifted table): each check is [] on the repo's data, and names a
// drift of each kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
