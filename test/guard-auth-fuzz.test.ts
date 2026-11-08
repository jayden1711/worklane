// Property-based and fuzz tests for the merge guards and the dashboard's auth rules (docs/testing-in-production.md,
// item b). Each property runs on N inputs from a seeded generator, so a failure names its seed and case, and can be run
// again exactly (GUARD_FUZZ_SEED, GUARD_FUZZ_N for a longer run). No property-test library: the generator is below.
//
// The merge decision is checked against an oracle written from the rule as documented (docs/design.md §10 and
// src/merge-policy.ts's comments), not from its code: it may auto-merge only when NO blocker holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEEDBACK_CHECK_BRANCH_PREFIX, HIGH_RISK_REASON, REVERT_BRANCH_PREFIX, mergeDecision, neverAutoMerge, type MergeInput, type MergeVerdict } from '../src/merge-policy.js';
import { DIFF_HIDING_ATTRIBUTES, LOCKED_CATEGORIES, ODD_PATH_CATEGORIES } from '../src/review.js';
import { defaultBranchRefusal, destinationRef, isDefaultBranchRef } from '../src/push-guard.js';
import { OWNER_DECISIONS, PROXY_HEADERS, breakGlassAllowed, isLoopback, mayAnswerKind, parseCookies, roleFromPermission, validLogin } from '../src/dashboard-auth.js';

const N = Number(process.env.GUARD_FUZZ_N) || 3000;
const SEED = Number(process.env.GUARD_FUZZ_SEED) || 0;

/** mulberry32: a small seeded generator (as test/redact-broad-union.test.ts). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = ReturnType<typeof rng>;
const int = (r: R, n: number) => Math.floor(r() * n);
const pick = <T>(r: R, xs: readonly T[]): T => xs[int(r, xs.length)]!;
const bool = (r: R, p = 0.5) => r() < p;
/** Mostly the value that lets a merge through, sometimes the one that blocks: so both sides are reached often. */
const mostly = <T>(r: R, pass: T, block: T, p = 0.85) => (r() < p ? pass : block);
const ASCII = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./:+@ ;='];
const ODD = ['\0', '\n', '\t', '​', '‮', ' ', 'é', 'а', '%2F', '..', '\\'];
function str(r: R, max = 12): string {
  let s = '';
  for (let n = int(r, max + 1); n > 0; n--) s += bool(r, 0.9) ? pick(r, ASCII) : pick(r, ODD);
  return s;
}

/** Runs `prop` on N cases, naming the seed and case of the first failure. */
function forAll(name: string, prop: (r: R, i: number) => void) {
  const r = rng(SEED * 1_000_003 + [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
  for (let i = 0; i < N; i++) {
    try {
      prop(r, i);
    } catch (e) {
      throw new Error(`${name}: case ${i} (GUARD_FUZZ_SEED=${SEED}, N=${N}): ${(e as Error).message}`, { cause: e });
    }
  }
}

// ---- The merge decision ----

const FLOOR = [...Object.keys(LOCKED_CATEGORIES), ...ODD_PATH_CATEGORIES, DIFF_HIDING_ATTRIBUTES];
const REPO_WAIT = ['money', 'auth', 'secrets', 'migrations', 'pricing'];
const HARMLESS = ['docs', 'tests', 'app', 'styles'];
const CATEGORIES = [...new Set([...FLOOR, ...REPO_WAIT, ...HARMLESS, 'ci-config', 'dependency'])];

function branch(r: R): string {
  return pick(r, [
    `${REPO_WAIT[0]}-fix`,
    'feature/x',
    'issue-12',
    `${REVERT_BRANCH_PREFIX}abc`,
    `${FEEDBACK_CHECK_BRANCH_PREFIX}1`,
    // Near misses: none is a revert or a feedback check, so none is held for that alone.
    REVERT_BRANCH_PREFIX.slice(0, -1),
    ` ${REVERT_BRANCH_PREFIX}abc`,
    REVERT_BRANCH_PREFIX.toUpperCase() + 'abc',
    `x/${REVERT_BRANCH_PREFIX}abc`,
    str(r),
  ]);
}

function verdict(r: R): MergeVerdict | null {
  if (bool(r, 0.08)) return null;
  return {
    patch_correct: mostly(r, true, false),
    test_correct: mostly(r, true, false),
    confidence: mostly(r, 'high' as const, pick(r, ['medium', 'low'] as const)),
    ...(bool(r, 0.3) ? { confidence_reason: str(r) } : {}),
    ...(bool(r, 0.3) ? { advice: str(r) } : {}),
    ...(bool(r, 0.85) ? {} : { unread: [str(r) || 'a.ts'] }),
    ...(bool(r, 0.9) ? { design_change: mostly(r, false, true) } : {}),
    ...(bool(r, 0.2) ? { design_reason: str(r) } : {}),
  };
}

function mergeInput(r: R): MergeInput {
  const categories: Record<string, string[]> = {};
  for (let n = int(r, 3); n > 0; n--) {
    const c = bool(r, 0.7) ? pick(r, HARMLESS) : pick(r, CATEGORIES);
    (categories[c] ??= []).push(bool(r, 0.9) ? `src/${c}.ts` : str(r) || 'x');
  }
  // An empty list for a category: touched by no file, so it holds nothing.
  if (bool(r, 0.1)) categories[pick(r, CATEGORIES)] = [];
  const max_lines = 1 + int(r, 500);
  const max_files = 1 + int(r, 40);
  return {
    branch: branch(r),
    openedByHarness: mostly(r, true, false),
    policyOn: mostly(r, true, false),
    repoOn: mostly(r, true, false),
    stopped: mostly(r, null as string | null, pick(r, ['', ' ', 'main went red', str(r)])),
    level: { level: pick(r, ['L0', 'L1', 'L2', 'L3'] as const), reasons: [], categories } as MergeInput['level'],
    waitCategories: bool(r, 0.8) ? REPO_WAIT.filter(() => bool(r)) : [],
    limits: { max_lines, max_files },
    lines: mostly(r, int(r, max_lines + 1), max_lines + 1 + int(r, 100)),
    files: mostly(r, int(r, max_files + 1), max_files + 1 + int(r, 10)),
    verdict: verdict(r),
    newTopLevel: mostly(r, [] as string[], [str(r) || 'pkg']),
    ciFixRuns: mostly(r, 0, 1 + int(r, 3)),
    foreignPush: mostly(r, false, true),
    pushLimitHit: mostly(r, false, true),
    ...(bool(r, 0.5) ? { instructionEvals: mostly(r, [] as string[], ['instructions: a case dropped']) } : {}),
    ...(bool(r, 0.5) ? { outsidePlan: mostly(r, [] as string[], ['not in the approved plan: x']) } : {}),
    ...(bool(r, 0.5) ? { claimedProtected: mostly(r, false, true) } : {}),
    ...(bool(r, 0.5) ? { weakening: mostly(r, [] as string[], ['weakens a test']) } : {}),
    ...(bool(r, 0.5) ? { vacuity: mostly(r, [] as string[], ['vacuity: runs no app code']) } : {}),
    ...(bool(r, 0.5) ? { vacuityPending: mostly(r, false, true) } : {}),
  };
}

/** Every blocker that holds, by the documented rule. The decision may auto-merge only when this is empty. */
function blockers(i: MergeInput): string[] {
  const b: string[] = [];
  if (!i.openedByHarness) b.push('not opened by the harness');
  if (i.branch.startsWith(REVERT_BRANCH_PREFIX)) b.push('a revert');
  if (i.branch.startsWith(FEEDBACK_CHECK_BRANCH_PREFIX)) b.push('a feedback check');
  if (!i.policyOn) b.push('policy off');
  if (!i.repoOn) b.push('repo off');
  if (i.stopped !== null) b.push('stopped');
  for (const c of new Set([...i.waitCategories, ...FLOOR])) if (i.level.categories[c]?.length) b.push(`waits on ${c}`);
  if (i.level.categories.dependency?.length) b.push('dependencies');
  if (i.newTopLevel.length) b.push('new top-level');
  if (i.claimedProtected) b.push('claimed protected');
  if (i.weakening?.length) b.push('weakening');
  if (i.vacuity?.length) b.push('vacuity');
  if (i.lines > i.limits.max_lines) b.push('lines');
  if (i.files > i.limits.max_files) b.push('files');
  const v = i.verdict;
  if (!v) b.push('no verdict');
  else {
    if (!v.patch_correct) b.push('patch');
    if (!v.test_correct) b.push('test');
    if (v.confidence !== 'high') b.push('confidence');
    if (v.unread?.length) b.push('unread');
    if (v.design_change !== false) b.push('design');
  }
  if (i.ciFixRuns) b.push('ci fixes');
  if (i.foreignPush) b.push('foreign push');
  if (i.pushLimitHit) b.push('push limit');
  if (i.instructionEvals?.length) b.push('instruction evals');
  if (i.outsidePlan?.length) b.push('outside plan');
  if (i.vacuityPending) b.push('vacuity pending');
  return b;
}

test('merge decision (fuzz): it auto-merges exactly when no documented blocker holds, and it gives a reason whenever it waits', () => {
  let auto = 0;
  forAll('merge oracle', (r) => {
    const i = mergeInput(r);
    const d = mergeDecision(i);
    const b = blockers(i);
    assert.equal(d.auto, b.length === 0, `auto=${d.auto} but blockers=[${b.join(', ')}]; reasons=${JSON.stringify(d.reasons)}; input=${JSON.stringify(i)}`);
    assert.equal(d.auto, d.reasons.length === 0, 'auto exactly when there is no reason');
    if (d.auto) auto++;
  });
  // The generator must reach both sides often enough to mean anything.
  assert.ok(auto > N / 50, `only ${auto} of ${N} cases auto-merged: the generator barely reaches the merge side`);
});

/** One blocker added to an input, each a single field: [what, the changed input]. */
const ADD_ONE: ((i: MergeInput, r: R) => MergeInput)[] = [
  (i) => ({ ...i, openedByHarness: false }),
  (i) => ({ ...i, branch: `${REVERT_BRANCH_PREFIX}${i.branch}` }),
  (i) => ({ ...i, branch: `${FEEDBACK_CHECK_BRANCH_PREFIX}${i.branch}` }),
  (i) => ({ ...i, policyOn: false }),
  (i) => ({ ...i, repoOn: false }),
  (i, r) => ({ ...i, stopped: pick(r, ['', ' ', '\n', 'red']) }),
  (i, r) => ({ ...i, level: { ...i.level, categories: { ...i.level.categories, [pick(r, FLOOR)]: ['x'] } } }),
  (i) => ({ ...i, level: { ...i.level, categories: { ...i.level.categories, dependency: ['package.json'] } } }),
  (i) => ({ ...i, newTopLevel: ['pkg'] }),
  (i) => ({ ...i, claimedProtected: true }),
  (i) => ({ ...i, weakening: ['w'] }),
  (i) => ({ ...i, vacuity: ['v'] }),
  (i) => ({ ...i, lines: i.limits.max_lines + 1 }),
  (i) => ({ ...i, files: i.limits.max_files + 1 }),
  (i) => ({ ...i, verdict: null }),
  (i) => ({ ...i, verdict: { ...i.verdict!, patch_correct: false } }),
  (i) => ({ ...i, verdict: { ...i.verdict!, test_correct: false } }),
  (i, r) => ({ ...i, verdict: { ...i.verdict!, confidence: pick(r, ['medium', 'low'] as const) } }),
  (i) => ({ ...i, verdict: { ...i.verdict!, unread: ['a.ts'] } }),
  (i) => ({ ...i, verdict: { ...i.verdict!, design_change: true } }),
  (i) => {
    const { design_change: _drop, ...v } = i.verdict!;
    return { ...i, verdict: v };
  },
  (i) => ({ ...i, ciFixRuns: 1 }),
  (i) => ({ ...i, foreignPush: true }),
  (i) => ({ ...i, pushLimitHit: true }),
  (i) => ({ ...i, instructionEvals: ['e'] }),
  (i) => ({ ...i, outsidePlan: ['o'] }),
  (i) => ({ ...i, vacuityPending: true }),
];

test('merge decision (property): from any input that merges, adding any one blocker makes it wait (no blocker is ever ignored)', () => {
  let tried = 0;
  forAll('merge monotone', (r) => {
    const i = mergeInput(r);
    if (!mergeDecision(i).auto) return;
    for (const [k, add] of ADD_ONE.entries()) {
      const j = add(i, r);
      const d = mergeDecision(j);
      assert.equal(d.auto, false, `blocker #${k} was ignored: ${JSON.stringify(j)}`);
      assert.ok(d.reasons.length > 0);
      tried++;
    }
  });
  assert.ok(tried > 0, 'some inputs merged, so the blockers were tried');
});

test('merge decision (property): every always-wait category a change touches gives a high-risk reason; neverAutoMerge holds whatever else does', () => {
  forAll('merge high-risk', (r) => {
    const i = mergeInput(r);
    const d = mergeDecision(i);
    for (const c of new Set([...i.waitCategories, ...FLOOR])) {
      if (!i.level.categories[c]?.length) continue;
      assert.ok(d.reasons.some((x) => x.startsWith(`${HIGH_RISK_REASON}${c} (`)), `no high-risk reason for ${c}: ${JSON.stringify(d.reasons)}`);
    }
    const never = neverAutoMerge({ branch: i.branch, openedByHarness: i.openedByHarness });
    for (const n of never) assert.ok(d.reasons.includes(n));
    if (never.length) assert.equal(d.auto, false);
  });
});

// ---- The default-branch push guard ----

test('push guard (fuzz): every refspec that names the default branch, in any form git accepts, is refused and recorded once; no other is', () => {
  forAll('push guard', (r) => {
    const def = pick(r, ['main', 'master', 'trunk', 'release/1.x', 'dev-2']);
    const other = pick(r, [`${def}-x`, `x-${def}`, `${def}/x`, `refs/tags/${def}`, `refs/remotes/origin/${def}`, `refs/heads/${def}x`, def.toUpperCase() === def ? `${def}x` : def.toUpperCase(), 'feature', str(r, 8).replace(/[: ]/g, '') || 'f']);
    const toDefault = bool(r);
    const dst = toDefault ? pick(r, [def, `heads/${def}`, `refs/heads/${def}`]) : other;
    const src = pick(r, ['', 'HEAD:', 'abc123:', `refs/heads/feature:`, ':', 'a:b:']);
    const spec = `${bool(r, 0.3) ? '+' : ''}${src}${dst}`;
    assert.equal(isDefaultBranchRef(spec, def), toDefault, `${JSON.stringify(spec)} against ${def}: ${destinationRef(spec)}`);
    const recorded: string[] = [];
    const directLand = bool(r, 0.2);
    const why = defaultBranchRefusal({ defaultBranch: def, directLand, blocked: (ref) => void recorded.push(ref) }, spec, 'h');
    assert.equal(why !== null, toDefault && !directLand);
    assert.deepEqual(recorded, why ? [`refs/heads/${def}`] : []);
  });
});

// ---- The dashboard's auth rules ----

const ROLES = ['owner', 'writer', 'viewer', null, undefined] as const;
const RANK = (r: (typeof ROLES)[number]) => (r === 'owner' ? 3 : r === 'writer' ? 2 : r === 'viewer' ? 1 : 0);

test('auth (fuzz): only the five exact GitHub permissions give a role; any other value (case, spaces, NUL, prototype names, non-strings) gives none', () => {
  const exact: Record<string, string> = { admin: 'owner', maintain: 'writer', write: 'writer', triage: 'viewer', read: 'viewer' };
  forAll('roleFromPermission', (r) => {
    const base = pick(r, [...Object.keys(exact), 'none', 'Admin', 'ADMIN', '__proto__', 'constructor', 'toString', 'owner', 'writer', '']);
    const p: unknown = pick(r, [base, ` ${base}`, `${base} `, `${base}\0`, `${base}\n`, base.toUpperCase(), str(r), 1, null, undefined, {}, [base], true]);
    assert.equal(roleFromPermission(p), typeof p === 'string' && Object.hasOwn(exact, p) ? exact[p] : null, JSON.stringify(p));
  });
});

test('auth (property): who may answer is monotone in role; a viewer or no role answers nothing; owner kinds are the owners\' unless land goes to writers', () => {
  forAll('mayAnswerKind', (r) => {
    const kind = pick(r, [...OWNER_DECISIONS, 'question', 'retry', 'design', 'LAND', ' plan', 'plan ', '__proto__', str(r, 6)]);
    const approvals = pick(r, [undefined, {}, { land: 'writers' as const }, { land: 'owners' as const }] as const) as Parameters<typeof mayAnswerKind>[2];
    const allowed = ROLES.filter((role) => mayAnswerKind(kind, role, approvals));
    for (const role of allowed) for (const higher of ROLES) if (RANK(higher) > RANK(role)) assert.ok(mayAnswerKind(kind, higher, approvals), `${String(role)} may answer ${kind} but ${String(higher)} may not`);
    assert.ok(!mayAnswerKind(kind, 'viewer', approvals) && !mayAnswerKind(kind, null, approvals) && !mayAnswerKind(kind, undefined, approvals), `a viewer or no role answers ${JSON.stringify(kind)}`);
    assert.ok(mayAnswerKind(kind, 'owner', approvals), 'the owner answers every kind');
    const writer = mayAnswerKind(kind, 'writer', approvals);
    if (kind === 'land' && approvals?.land === 'writers') assert.equal(writer, true);
    else if (OWNER_DECISIONS.has(kind)) assert.equal(writer, false, `a writer answers the owner kind ${kind}`);
  });
});

test('auth (fuzz): break-glass only from loopback (127/8, ::1, IPv4-mapped) and never with any proxy header, whatever its value', () => {
  forAll('breakGlass', (r) => {
    const octet = () => String(int(r, 256));
    const loop = pick(r, [`127.${octet()}.${octet()}.${octet()}`, '::1', `::ffff:127.0.0.${octet()}`, `::FFFF:127.${octet()}.0.1`]);
    const not = pick(r, [`${octet()}.${octet()}.${octet()}.${octet()}`.replace(/^127\./, '10.'), '::2', '0:0:0:0:0:0:0:1', `::ffff:192.0.2.1`, '127.0.0.1.evil', ' 127.0.0.1', '127.0.0.1 ', 'localhost', '', `127.0.0.1\n`, str(r, 10).replace(/^127\./, 'x')]);
    const isLoop = bool(r);
    const addr = isLoop ? loop : not;
    assert.equal(isLoopback(addr), isLoop, JSON.stringify(addr));
    const headers: Record<string, string> = {};
    const viaProxy = bool(r, 0.4);
    if (viaProxy) headers[pick(r, PROXY_HEADERS)] = pick(r, ['', ' ', 'x', '127.0.0.1']);
    if (bool(r, 0.3)) headers['x-other'] = 'y';
    assert.equal(breakGlassAllowed({ headers, socket: { remoteAddress: addr } }), isLoop && !viaProxy);
  });
});

test('auth (fuzz): parseCookies never throws, keeps the first value of a name (a later one never overrides it), and never sets an inherited name', () => {
  forAll('parseCookies', (r) => {
    const pairs: [string, string][] = [];
    for (let n = int(r, 6); n > 0; n--) pairs.push([pick(r, ['__Host-session', '__Host-signin-state', 'a', 'b', '__proto__', 'constructor', str(r, 6).replace(/[;=]/g, '')]), str(r, 10).replace(/;/g, '')]);
    const header = pairs.map(([k, v]) => `${pick(r, ['', ' ', '  '])}${k}=${v}`).join(';');
    const absent = bool(r, 0.05);
    const out = parseCookies(absent ? undefined : header);
    assert.equal(Object.getPrototypeOf(out), Object.prototype, 'the prototype is untouched');
    if (absent) return assert.deepEqual(out, {}, 'no header, no cookies');
    const first = new Map<string, string>();
    for (const [k, v] of pairs) {
      const key = k.trim();
      if (!key || key in {} || first.has(key)) continue;
      first.set(key, v.trim());
    }
    for (const [k, v] of first) if (header.includes(`${k}=`)) assert.equal(out[k], v, `cookie ${JSON.stringify(k)} in ${JSON.stringify(header)}`);
    for (const k of Object.keys(out)) assert.ok(!(k in {}), `an inherited name was set: ${k}`);
  });
  // Any string at all: no throw.
  forAll('parseCookies any', (r) => void parseCookies(str(r, 40)));
});

test('auth (fuzz): validLogin accepts only GitHub-shaped logins: ASCII letters, digits and dashes, starting with a letter or digit, at most 39', () => {
  const shape = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
  forAll('validLogin', (r) => {
    const good = (bool(r) ? 'a' : '7') + 'x-y'.repeat(int(r, 13)).slice(0, int(r, 39));
    const s: unknown = pick(r, [good, `-${good}`, `${good}@x`, `${good}/x`, `${good}.x`, `${good} `, `${good}\n`, `${good}\0`, 'a'.repeat(40), `а${good}`, `${good}​`, str(r, 45), 7, null, undefined, [good]]);
    const ok = validLogin(s);
    assert.equal(ok, typeof s === 'string' && shape.test(s), JSON.stringify(s));
    if (ok) assert.ok((s as string).length <= 39 && /^[\x21-\x7e]+$/.test(s as string), 'only printable ASCII, never a space or a control character');
  });
});
