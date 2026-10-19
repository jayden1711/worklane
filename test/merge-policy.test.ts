import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { PolicyFile } from '../src/instance.js';
import { instructionEvalReasons, mergeDecision, waitCategoriesOf, type InstructionEvalResult, type MergeInput } from '../src/merge-policy.js';
import { buildReport } from '../src/reports.js';
import { AGENT_INSTRUCTIONS, computeLevel, DEFAULT_CATEGORIES, LOCKED_CATEGORIES, SELF_MODIFICATION, SELF_MODIFICATION_PARTS } from '../src/review.js';
import { execFileSync } from 'node:child_process';
import { globToRegExp } from '../src/guardrails/glob.js';
import { loosenedProblems } from '../src/delegation.js';
import { repoRoot } from './helpers.js';
import { BRAND } from '../src/brand.js';
import { rolePrompt, VERDICT_SCHEMA } from '../src/roles.js';
import { exampleProject } from './helpers.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
import { CHECK_TABLES, checkShapedTables, NOT_A_CHECK, tableEntries, testFacts, weakeningOf, weakeningReasons, WEAKENING_REASON } from '../src/merge-policy-weakening.js';
// Read through the namespace, so a module without one of them fails only the test that uses it.
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile, LockScope } from '../src/review.js';
import { FakeRunner } from '../src/runner.js';

const cfg = loadConfig(exampleProject().dir);
const review = cfg.review!;
const level = (paths: string[]) => computeLevel({ files: paths.map((path) => ({ path, added: 1, removed: 0 })), labels: [], moneyPaths: [], scope: undefined }, review);

/** A change the policy merges: everything clean. Each test turns one thing. */
function clean(over: Partial<MergeInput> = {}): MergeInput {
  return {
    branch: `${BRAND.cli}/issue-7`,
    openedByHarness: true,
    policyOn: true,
    repoOn: true,
    stopped: null,
    level: level(['src/price.js']),
    waitCategories: [...review.levels.L3_human.when, 'ci-config'],
    limits: { max_lines: 400, max_files: 10 },
    lines: 12,
    files: 1,
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false },
    newTopLevel: [],
    ciFixRuns: 0,
    foreignPush: false,
    pushLimitHit: false,
    ...over,
  };
}

test('merge policy: a clean change merges', () => {
  assert.deepEqual(mergeDecision(clean()), { auto: true, reasons: [], why: [] });
});

test('merge policy: a revert the harness opened never auto-merges, however clean', () => {
  for (const branch of [`${BRAND.cli}/revert-pr-12`, `${BRAND.cli}/revert-0123456789ab`]) {
    const d = mergeDecision(clean({ branch }));
    assert.equal(d.auto, false, branch);
    assert.match(d.reasons.join(), /never auto-merged: a revert the harness opened/);
  }
});

test("merge policy: a PR the harness didn't open (a person's, a bot's) never auto-merges, however green", () => {
  const d = mergeDecision(clean({ openedByHarness: false, branch: 'feature/totals' }));
  assert.equal(d.auto, false);
  assert.deepEqual(d.reasons, ['never auto-merged: the harness did not open this PR; a person merges it']);
});

test('merge policy: the kill switch, the repo switch and a stop each make every PR wait', () => {
  assert.deepEqual(mergeDecision(clean({ policyOn: false })).reasons, ['auto-merge is off for this instance (policy.yaml auto_merge)']);
  assert.deepEqual(mergeDecision(clean({ repoOn: false })).reasons, ['auto-merge is off for this repo (review.yaml merge.auto)']);
  assert.match(mergeDecision(clean({ stopped: 'main went red after #4' })).reasons.join(), /auto-merge is stopped: main went red after #4/);
});

test("regression: a change to the agents' role prompts, skills, AGENTS.md or any CLAUDE.md never auto-merges, whatever review.yaml tries", () => {
  // A review.yaml that tries to drop it: the category redefined to nothing, no harness-config at L3, no waits.
  const loose = {
    ...review,
    categories: { [AGENT_INSTRUCTIONS]: [] as string[], 'harness-config': [] as string[] },
    levels: { ...review.levels, L3_human: { ...review.levels.L3_human, when: [] as string[] } },
    merge: { ...review.merge, wait_categories: [] as string[] },
  };
  for (const path of [`${BRAND.configDir}/roles/worker.md`, `${BRAND.configDir}/skills/x/SKILL.md`, 'AGENTS.md', 'CLAUDE.md', 'web/CLAUDE.md']) {
    const lvl = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, loose);
    assert.deepEqual(lvl.categories[AGENT_INSTRUCTIONS], [path], path);
    const d = mergeDecision(clean({ level: lvl, waitCategories: waitCategoriesOf(loose) }));
    assert.equal(d.auto, false, path);
    assert.match(d.reasons.join(), new RegExp(`high-risk: ${AGENT_INSTRUCTIONS}`), path);
  }
  // Other files don't land in the category (only the root AGENTS.md counts).
  for (const path of ['src/a.ts', 'docs/AGENTS.md']) assert.equal(computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, loose).categories[AGENT_INSTRUCTIONS], undefined, path);
});

/** The engine's own files, as git tracks them. */
const engineFiles = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Files the guard names before the repo has one (the owner's own file, written when a study is set up): exact paths only. */
const NOT_YET_FILES = [`${BRAND.configDir}/experiments.yaml`];

test('self-modification: every glob names real engine files (none dead), and the list is the one the owner approved', () => {
  for (const part of SELF_MODIFICATION_PARTS) {
    for (const glob of part.globs) {
      if (NOT_YET_FILES.includes(glob)) assert.ok(!engineFiles.includes(glob), `${glob} exists now: take it out of NOT_YET_FILES, so the glob is checked like the others`);
      else assert.ok(engineFiles.some((f) => globToRegExp(glob).test(f)), `${part.what}: ${glob} matches no file in the repo`);
    }
  }
  assert.deepEqual(LOCKED_CATEGORIES[SELF_MODIFICATION], SELF_MODIFICATION_PARTS.flatMap((p) => p.globs));
  // The files the guard is for, each landing in the part that names it.
  const part = (path: string) => SELF_MODIFICATION_PARTS.find((p) => p.globs.some((g) => globToRegExp(g).test(path)))?.what;
  for (const [path, what] of [
    ['src/merge-policy.ts', 'the merge policy'],
    ['src/coordinator/merge-flow.ts', 'the merge policy'],
    ['src/pr-rules.ts', 'the merge policy'],
    ['src/main-watch.ts', 'the main watch'],
    ['src/push-guard.ts', 'the push guard'],
    ['src/updates.ts', 'the updater'],
    [`scripts/machine/${BRAND.cli}-update.cjs`, 'the updater'],
    [`${BRAND.configDir}/review.yaml`, 'the review levels'],
    ['src/review.ts', 'the review levels'],
    [`${BRAND.configDir}/guardrails.yaml`, 'the guardrails'],
    ['src/guardrails/engine.ts', 'the guardrails'],
    ['scripts/setup/machine.sh', 'the machine setup'],
    ['scripts/machine/worklane-machine.cjs'.replace('worklane', BRAND.cli), 'the machine setup'],
    ['.github/workflows/ci.yml', 'the CI workflows'],
    ['.github/release-signers', 'who may sign a release'],
    ['scripts/verify-release-tag.mjs', 'who may sign a release'],
    ['src/dashboard-auth.ts', 'sign-in, credentials or secrets'],
    ['src/github-app.ts', 'sign-in, credentials or secrets'],
    ['src/console/secrets.ts', 'sign-in, credentials or secrets'],
    ['src/console/terminal-devices.ts', 'sign-in, credentials or secrets'],
    ['src/setup/app-manifest.ts', 'sign-in, credentials or secrets'],
    ['src/decide.ts', 'who may approve'],
    ['src/intake/people.ts', 'who may approve'],
    ['src/machine-owners.ts', 'who may approve'],
    ['src/roles.ts', 'the evaluator and the agent runner'],
    ['src/coordinator.ts', 'the evaluator and the agent runner'],
    ['src/runner.ts', 'the evaluator and the agent runner'],
    ['src/sandbox.ts', 'the sandbox and test runs'],
    ['src/testrun/affected.ts', 'the sandbox and test runs'],
    ['src/hook.ts', "the agents' tool guard"],
    ['src/hook-imports.ts', "the agents' tool guard"],
    ['src/hook-main.ts', "the agents' tool guard"],
    ['src/install.ts', "the agents' tool guard's hook commands"],
    ['src/instance.ts', "the agents' tool guard's hook commands"],
    ['src/config/load.ts', "the agents' tool guard"],
    ['src/events/redact.ts', "the agents' tool guard"],
    ['src/managed-apps.ts', 'where the self-modification locks apply'],
    ['scripts/setup/managed-apps.sh', 'the machine setup'],
    ['scripts/push-gate.mjs', 'the push gate, denylist and secret scan'],
    ['scripts/push-gate-hook.mjs', 'the push gate, denylist and secret scan'],
    ['scripts/check-denylist.mjs', 'the push gate, denylist and secret scan'],
    ['scripts/lib/denylist.mjs', 'the push gate, denylist and secret scan'],
    ['scripts/check-dco.mjs', 'the push gate, denylist and secret scan'],
    ['.denylist.json', 'the push gate, denylist and secret scan'],
    ['.denylist-allow', 'the push gate, denylist and secret scan'],
    ['.gitleaks.toml', 'the push gate, denylist and secret scan'],
    ['.githooks/pre-push', 'the push gate, denylist and secret scan'],
    ['test/review.test.ts', 'the tests of the harness controls'],
    ['test/merge-policy.test.ts', 'the tests of the harness controls'],
    ['test/guardrails.test.ts', 'the tests of the harness controls'],
    ['test/push-check.test.ts', 'the tests of the harness controls'],
    ['test/main-watch.test.ts', 'the tests of the harness controls'],
    ['test/denylist.test.ts', 'the tests of the harness controls'],
    ['test/push-gate.test.ts', 'the tests of the harness controls'],
    ['test/package-files.test.ts', 'the tests of the harness controls'],
    ['test/managed-apps.test.ts', 'the tests of the harness controls'],
    ['docs/releasing.md', 'the release procedure and the design rules'],
    ['docs/design.md', 'the release procedure and the design rules'],
    ['src/coordinator/base.ts', 'the coordinator'],
    ['src/coordinator/decisions.ts', 'the coordinator'],
    ['src/coordinator/merge-flow.ts', 'the merge policy'],
    [`${BRAND.configDir}/experiments.yaml`, 'the experiment studies'],
  ] as const) {
    if (!NOT_YET_FILES.includes(path)) assert.ok(engineFiles.includes(path), `${path} is a real file`);
    assert.equal(part(path), what, path);
  }
  // Nothing else in the engine falls in it by accident.
  for (const path of ['src/dashboard.ts', 'src/experiments/study.ts', 'web/src/pages/Waiting.tsx', 'test/helpers.ts', 'test/dashboard.test.ts', 'docs/notes-for-the-test.md', 'README.md', 'scripts/release.mjs']) assert.equal(part(path), undefined, path);
});

test('regression: a change to the evaluator, the sandbox, the denylist, a guard test or the release rules waits for the owner, even a tests-only or docs-only one, whatever review.yaml tries', () => {
  // The review.yaml of a repo that lists none of them (no `engine` category, nothing at L3, nothing waiting).
  const loose = {
    ...review,
    categories: {} as Record<string, string[]>,
    levels: { ...review.levels, L2_notify: { ...review.levels.L2_notify, when: [] as string[] }, L3_human: { ...review.levels.L3_human, when: [] as string[] } },
    merge: { ...review.merge, wait_categories: [] as string[] },
  };
  const waits = (path: string, what: string) => {
    const lvl = computeLevel({ files: [{ path, added: 2, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, loose);
    assert.equal(lvl.level, 'L3', `${path}: always L3`);
    const d = mergeDecision(clean({ level: lvl, waitCategories: waitCategoriesOf(loose), lines: 3, files: 1 }));
    assert.equal(d.auto, false, path);
    assert.deepEqual(d.why.find((y) => y.category === SELF_MODIFICATION), { category: SELF_MODIFICATION, text: `changes ${what}: ${path}` }, path);
  };
  // A tests-only change to a test that holds a control: L0 and merged by the harness before these were named.
  for (const path of ['test/review.test.ts', 'test/merge-policy.test.ts', 'test/denylist.test.ts', 'test/push-gate.test.ts', 'test/package-files.test.ts', 'test/guardrails.test.ts', 'test/push-check.test.ts', 'test/main-watch.test.ts', 'test/managed-apps.test.ts']) waits(path, 'the tests of the harness controls');
  // The denylist's data and the release rules: one file of each, as the owner asked.
  waits('.denylist.json', 'the push gate, denylist and secret scan');
  waits('.gitleaks.toml', 'the push gate, denylist and secret scan');
  waits('docs/releasing.md', 'the release procedure and the design rules');
  waits('docs/design.md', 'the release procedure and the design rules');
  // The rest of the coordinator, and a study's definition (a file the repo doesn't have until a study is set up).
  waits('src/coordinator/decisions.ts', 'the coordinator');
  waits('src/coordinator/fix-runs.ts', 'the coordinator');
  waits(`${BRAND.configDir}/experiments.yaml`, 'the experiment studies');
  // Another test, and another doc, still merge on their own.
  for (const path of ['test/dashboard.test.ts', 'docs/notes-for-the-test.md']) {
    const lvl = computeLevel({ files: [{ path, added: 2, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, loose);
    assert.equal(lvl.level, 'L0', path);
    assert.equal(mergeDecision(clean({ level: lvl, waitCategories: waitCategoriesOf(loose), lines: 3, files: 1 })).auto, true, path);
  }
});

test('regression: a harness PR touching any self-modification file waits for the owner at L3 and never auto-merges, whatever review.yaml tries', () => {
  // A review.yaml that tries to drop it: the category redefined to nothing, nothing at L3 or waiting, no limits worth the name.
  const loose = {
    ...review,
    categories: { [SELF_MODIFICATION]: [] as string[], engine: [] as string[] },
    levels: { ...review.levels, L2_notify: { ...review.levels.L2_notify, when: [] as string[] }, L3_human: { ...review.levels.L3_human, when: [] as string[] } },
    merge: { ...review.merge, wait_categories: [] as string[] },
  };
  let n = 0;
  for (const part of SELF_MODIFICATION_PARTS) {
    for (const glob of part.globs) {
      for (const path of engineFiles.filter((f) => globToRegExp(glob).test(f))) {
        // The first part that matches names it (scripts/machine's updater is the updater, not machine setup).
        const what = SELF_MODIFICATION_PARTS.find((p) => p.globs.some((g) => globToRegExp(g).test(path)))!.what;
        const lvl = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, loose);
        assert.deepEqual(lvl.categories[SELF_MODIFICATION], [path], path);
        assert.equal(lvl.level, 'L3', `${path}: always L3`);
        const d = mergeDecision(clean({ level: lvl, waitCategories: waitCategoriesOf(loose) }));
        assert.equal(d.auto, false, path);
        assert.ok(d.reasons.includes(`high-risk: ${SELF_MODIFICATION} (${path})`), `${path}: ${d.reasons.join(' | ')}`);
        assert.deepEqual(d.why.find((y) => y.category === SELF_MODIFICATION), { category: SELF_MODIFICATION, text: `changes ${what}: ${path}` }, path);
        // Even a caller that passes no wait categories at all: the floor holds.
        assert.equal(mergeDecision(clean({ level: lvl, waitCategories: [] })).auto, false, `${path}: the floor`);
        n++;
      }
    }
  }
  assert.ok(n >= 40, `${n} files checked`);
  // review.yaml can't loosen it either (gradual delegation).
  assert.deepEqual(loosenedProblems({ ...review, merge: { ...review.merge, loosened: [SELF_MODIFICATION] } }), [`merge.loosened: ${SELF_MODIFICATION} is high-risk or a safety floor and can never be loosened`]);
});

test('regression: a PR touching only .github/release-signers is L3, waits for the owner and never auto-merges (this repo, the example, and a review.yaml that drops it)', () => {
  const path = '.github/release-signers';
  const own = loadConfig(repoRoot).review!;
  const loose = {
    ...own,
    categories: { 'release-signing': [] as string[], 'release-config': [] as string[], engine: [] as string[], 'ci-config': [] as string[] },
    levels: { ...own.levels, L3_human: { ...own.levels.L3_human, when: [] as string[] } },
    merge: { ...own.merge, wait_categories: [] as string[] },
  };
  for (const [name, rc] of [['this repo', own], ['the example', review], ['loosened', loose]] as const) {
    const lvl = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, rc);
    assert.equal(lvl.level, 'L3', name);
    assert.deepEqual(lvl.categories[SELF_MODIFICATION], [path], name);
    const d = mergeDecision(clean({ level: lvl, lines: 2, waitCategories: waitCategoriesOf(rc) }));
    assert.equal(d.auto, false, name);
    assert.ok(d.reasons.includes(`high-risk: ${SELF_MODIFICATION} (${path})`), `${name}: ${d.reasons.join(' | ')}`);
    assert.deepEqual(d.why.find((y) => y.category === SELF_MODIFICATION), { category: SELF_MODIFICATION, text: `changes who may sign a release: ${path}` }, name);
  }
  // This repo's review.yaml names it too, at L3 and waiting.
  const lvl = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, own);
  assert.deepEqual(lvl.categories['release-signing'], [path]);
  assert.deepEqual(lvl.categories['release-config'], [path]);
  assert.ok(own.levels.L3_human.when.includes('release-signing') && own.merge.wait_categories.includes('release-signing'));
});

test('merge policy: why a high-risk PR waits, plainly, naming the category and its first file', () => {
  const d = mergeDecision(clean({ level: level(['src/merge-policy.ts', 'src/review.ts', 'db/migrations/002.sql']), waitCategories: waitCategoriesOf(review) }));
  assert.deepEqual(d.why.filter((y) => y.category !== 'engine'), [
    { category: 'migration', text: 'changes a database migration: db/migrations/002.sql' },
    { category: SELF_MODIFICATION, text: 'changes the merge policy: src/merge-policy.ts and 1 more' },
  ]);
  const custom = computeLevel({ files: [{ path: 'src/price.js', added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, { ...review, categories: { pricing: ['src/price.js'] } });
  assert.deepEqual(mergeDecision(clean({ level: custom, waitCategories: ['pricing'] })).why, [{ category: 'pricing', text: 'touches pricing: src/price.js' }]);
  assert.deepEqual(mergeDecision(clean()).why, [], 'nothing high-risk: nothing to say');
});

test('merge policy: high-risk paths wait (L3 categories, CI config, and the repo’s own categories)', () => {
  for (const [path, cat] of [
    ['.worklane/config.yaml', 'harness-config'],
    ['.claude/settings.json', 'harness-config'],
    ['.github/dependabot.yml', 'ci-config'],
    ['.github/workflows/ci.yml', 'deploy-config'],
    ['src/auth/login.js', 'auth'],
    ['db/migrations/002.sql', 'migration'],
    ['config/credentials.json', 'secrets'],
  ] as const) {
    const d = mergeDecision(clean({ level: level([path]) }));
    assert.equal(d.auto, false, path);
    assert.match(d.reasons.join(), new RegExp(`high-risk: ${cat} \\(${path.replace(/\./g, '\\.')}`), path);
  }
  const custom = computeLevel({ files: [{ path: 'src/price.js', added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, { ...review, categories: { pricing: ['src/price.js'] } });
  assert.match(mergeDecision(clean({ level: custom, waitCategories: ['pricing'] })).reasons.join(), /high-risk: pricing \(src\/price\.js\)/);
});

test('merge policy: anything deleting data waits', () => {
  const l = computeLevel({ files: [{ path: 'src/cleanup.js', added: 1, removed: 0, addedLines: ['db.exec("DELETE FROM orders")'] }], labels: [], moneyPaths: [], scope: undefined }, review);
  assert.match(mergeDecision(clean({ level: l })).reasons.join(), /high-risk: deletes-data/);
});

test("merge policy: design-level waits: the evaluator's flag is binding, dependencies and new top-level modules are seen in code", () => {
  assert.match(mergeDecision(clean({ verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: true, design_reason: 'new CLI flag' } })).reasons.join(), /design: the evaluator flagged a design change: new CLI flag/);
  for (const p of ['package.json', 'pyproject.toml', 'requirements-dev.txt', 'sub/Cargo.toml']) assert.match(mergeDecision(clean({ level: level([p]) })).reasons.join(), /design: dependency manifests change/, p);
  assert.match(mergeDecision(clean({ newTopLevel: ['plugins/'] })).reasons.join(), /design: new top-level module \(plugins\/\)/);
});

test('merge policy: big changes wait, by lines or files; at the limit they merge', () => {
  assert.equal(mergeDecision(clean({ lines: 400, files: 10 })).auto, true);
  assert.deepEqual(mergeDecision(clean({ lines: 401 })).reasons, ['big: 401 changed lines (over 400)']);
  assert.deepEqual(mergeDecision(clean({ files: 11 })).reasons, ['big: 11 files (over 10)']);
});

test('merge policy: any doubt waits', () => {
  const v = { patch_correct: true, test_correct: true, confidence: 'high' as const, design_change: false };
  const cases: [Partial<MergeInput>, RegExp][] = [
    [{ verdict: null }, /no evaluator verdict/],
    [{ verdict: { ...v, confidence: 'medium' } }, /evaluator confidence medium/],
    [{ verdict: { ...v, patch_correct: false } }, /did not approve the patch/],
    [{ verdict: { ...v, test_correct: false } }, /doubts the test/],
    [{ verdict: { ...v, unread: ['src/a.js'] } }, /did not read src\/a\.js/],
    [{ verdict: { patch_correct: true, test_correct: true, confidence: 'high' } }, /gave no design-change answer/],
    [{ ciFixRuns: 1 }, /1 CI fix run\(s\) on this PR/],
    [{ foreignPush: true }, /someone other than the harness pushed/],
    [{ pushLimitHit: true }, /hit a push limit/],
  ];
  for (const [over, re] of cases) {
    const d = mergeDecision(clean(over));
    assert.equal(d.auto, false, String(re));
    assert.match(d.reasons.join(), re);
  }
});

test('instruction evals: a drop waits with the per-case diff; a cap hit, an error or no eval waits; a clean eval does not', () => {
  const r = (over: Partial<InstructionEvalResult>): InstructionEvalResult => ({ target: 'skill triage', base: { passed: 3, total: 3 }, result: { passed: 3, total: 3 }, dropped: false, incomplete: false, changes: [], cost_usd: 1.2, ...over });
  assert.deepEqual(instructionEvalReasons(['skill triage'], [r({})]), []);
  const drop = instructionEvalReasons(['skill triage'], [r({ result: { passed: 2, total: 3 }, dropped: true, changes: [{ id: '1', title: 'Alert', base: 'pass', head: 'pass' }, { id: '2', title: 'Handoff', base: 'pass', head: 'fail' }] })]);
  assert.deepEqual(drop, ['eval: skill triage scored lower, 3/3 → 2/3 (~$1.20):\n  - case 2 "Handoff": pass → fail']);
  assert.match(instructionEvalReasons(['skill triage'], [r({ incomplete: true })]).join(), /incomplete: the cost cap was reached \(~\$1\.20\)/);
  assert.match(instructionEvalReasons(['skill triage'], [r({ error: 'no eval cases (x)' })]).join(), /was not evaluated: no eval cases \(x\)/);
  assert.deepEqual(instructionEvalReasons(['AGENTS.md'], []), ['eval: AGENTS.md changed but was not evaluated']);
  const d = mergeDecision(clean({ instructionEvals: drop }));
  assert.equal(d.auto, false);
  assert.deepEqual(d.reasons, drop);
});

test('the kill switch defaults to off in an instance policy', () => {
  assert.equal(PolicyFile.parse({ version: 1, budget: { daily_usd: 5 } }).auto_merge, false);
});

test("the evaluator must answer design_change, and is told it's binding", () => {
  assert.ok((VERDICT_SCHEMA.required as readonly string[]).includes('design_change'));
  assert.match(rolePrompt('/nonexistent', 'evaluator-verdict'), /design_change: .*binding/);
});

const ev = (id: number, type: string, payload: object, ts: string): StoredEvent => ({ id, ts, type, payload, instance: 'i', source: 'coordinator' }) as unknown as StoredEvent;

test("report: the spend line is labelled as the CLI's estimate, not billed money", () => {
  const now = new Date('2026-10-10T18:05:00Z');
  const r = buildReport([ev(1, 'run.cost', { issue: 1, role: 'worker', model: 'm', usd: 1.5, turns: 3 }, '2026-10-10T17:00:00Z')], cfg, { since: new Date('2026-10-10T08:00:00Z'), now, slot: '18:00' });
  assert.match(r.markdown, /\*\*Spend\*\* \(the CLI's cost estimate, not billed money\): ~\$1\.50 since the last report/);
});

test('report: the daily digest lists the last 24 h of auto-merges with links, once a day; a stop is always shown', () => {
  const merged = ev(1, 'merge.done', { issue: 3, number: 9, head: 'a'.repeat(40), sha: 'b'.repeat(40), url: 'https://example.com/pull/9', title: 'Fix totals' }, '2026-10-10T02:00:00Z');
  const old = ev(2, 'merge.done', { issue: 4, number: 7, head: 'a'.repeat(40), sha: 'c'.repeat(40), url: 'https://example.com/pull/7', title: 'Old' }, '2026-10-08T02:00:00Z');
  const now = new Date('2026-10-10T08:05:00Z');
  const first = buildReport([old, merged], cfg, { since: new Date('2026-10-09T18:00:00Z'), now, slot: cfg.project.reports.times[0]! }).markdown;
  assert.match(first, /\*\*Auto-merged, last 24 h\*\* \(1\)\n- \[#9\]\(https:\/\/example\.com\/pull\/9\) Fix totals `bbbbbbbb`/);
  assert.doesNotMatch(first, /#7/);
  const second = buildReport([merged], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown;
  assert.doesNotMatch(second, /Auto-merged/, 'once a day');
  const stopped = ev(3, 'merge.stopped', { reason: 'main went red after #9', number: 9, sha: 'b'.repeat(40), revert: null }, '2026-10-10T12:00:00Z');
  assert.match(buildReport([merged, stopped], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown, /\*\*Auto-merge stopped\*\*: main went red after #9/);
  const resumed = ev(4, 'merge.resumed', { detail: 'cleared' }, '2026-10-10T13:00:00Z');
  assert.doesNotMatch(buildReport([merged, stopped, resumed], cfg, { since: now, now: new Date('2026-10-10T18:05:00Z'), slot: '18:00' }).markdown, /Auto-merge stopped/);
});

test("the engine's own review.yaml already holds every self-modification file, without the code's floor (an engine that predates a part reads this file from main)", () => {
  const own = loadConfig(repoRoot).review!;
  // The categories the engine's config makes wait, as an older engine (which lacks the newest parts) would apply them.
  const waiting = [...new Set([...own.levels.L3_human.when, ...own.merge.wait_categories, 'ci-config'])].filter((c) => c !== SELF_MODIFICATION);
  const globs = (c: string) => (own.categories[c] ?? DEFAULT_CATEGORIES[c] ?? []).map((g) => globToRegExp(g));
  const unheld = engineFiles.filter((f) => SELF_MODIFICATION_PARTS.some((p) => p.globs.some((g) => globToRegExp(g).test(f))) && !waiting.some((c) => globs(c).some((re) => re.test(f))));
  assert.deepEqual(unheld, [], 'files the code locks that this repo\'s review.yaml leaves to auto-merge: list them in a category under L3_human and merge.wait_categories');
});

test("regression: a tests-only change to the tests' own machine, the slot-write check or a tool-guard denial test, or a docs-only change to an architecture doc, waits for the owner in the engine's own review.yaml (engine-guards)", () => {
  const own = loadConfig(repoRoot).review!;
  for (const path of [
    'test/isolate.ts',
    'test/isolate.test.ts',
    'test/slot-dir-writes.test.ts',
    'test/slot-path.test.ts',
    'test/eval-roles.test.ts',
    'test/research.test.ts',
    'test/discord-chat.test.ts',
    'test/experiments-coordinator.test.ts',
    'test/intake-coordinator.test.ts',
    'test/domain-runner.test.ts',
    // The architecture docs (docs/design/**): the owner asked that they always wait for the owner (#698).
    'docs/design/product-architecture.md',
  ]) {
    // Every entry is a real file, so a rename can't leave a dead entry.
    assert.ok(engineFiles.includes(path), `${path} is a real file`);
    const lvl = computeLevel({ files: [{ path, added: 1, removed: 0 }], labels: [], moneyPaths: [], scope: undefined }, own);
    assert.equal(lvl.level, 'L3', `${path}: ${lvl.reasons.join(' | ')}`);
    assert.deepEqual(lvl.categories['engine-guards'], [path], path);
    const d = mergeDecision(clean({ level: lvl, lines: 1, files: 1, waitCategories: waitCategoriesOf(own) }));
    assert.equal(d.auto, false, path);
    assert.ok(d.reasons.includes(`high-risk: engine-guards (${path})`), `${path}: ${d.reasons.join(' | ')}`);
  }
});

// ---- A change that removes or weakens a test, a lint or a guard waits for the owner (#783)

/** A test file before a change: two tests, four assertions, one of them awaited. */
const MATH_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add, sub } from '../src/math.js';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(1, 2), 3);',
  '  assert.deepStrictEqual(',
  '    [add(0, 0), add(1, 1)],',
  '    [0, 2],',
  '  );',
  '});',
  '',
  "test('subtracts', async () => {",
  "  await assert.rejects(sub('x', 1), /not a number/);",
  '  assert.equal(sub(3, 1), 2);',
  '});',
  '',
].join('\n');
const MATH = 'export const add = (a: number, b: number) => a + b;\nexport const sub = (a: number, b: number) => a - b;\n';
/** The code, changed: a change to the test alongside it is one that also changes code. */
const MATH_CHANGED = MATH.replace('a - b', 'b - a');
/** A lint's allowlist and its rules, under the names the registry reads (CHECK_TABLES). */
const CLOCK_LINT = "const ALLOWED: Record<string, number> = {\n  'test/a.test.ts': 1,\n  'test/b.test.ts': 2,\n};\n";
const READER_LINT = 'const READER_WORDS: Record<string, RegExp> = {\n  numstat: /numstat/g,\n  raw: /--raw\\b/g,\n};\n';
const DELEGATION = "export const NEVER_LOOSEN = ['money-path', 'migration', 'auth'] as const;\n\nexport const floor = () => new Set<string>([...NEVER_LOOSEN]);\n";
const ESLINT = '{\n  "rules": {\n    "eqeqeq": "error",\n    "no-eval": "error"\n  }\n}\n';

/** weakeningReasons for a change given as each file's text before and after (null: not there), its lines as a diff gives them. */
function weakens(before: Record<string, string | null>, after: Record<string, string | null>, scope?: LockScope): string[] {
  const lines = (t: string | null | undefined) => (t ?? '').split('\n');
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const files: ChangeFile[] = [...new Set([...Object.keys(before), ...Object.keys(after)])].map((path) => {
    const removed = minus(lines(before[path]), lines(after[path])).filter(Boolean);
    const added = minus(lines(after[path]), lines(before[path])).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  return weakeningReasons({ files, before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope });
}
/** Each reason's kind, without the common start and the places. */
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(WEAKENING_REASON.length).replace(/ \(.*$/s, ''));
const ASSERTION = 'removes or changes a test assertion';
const SKIP = 'adds a skip, todo or only to a test, or changes how an existing test runs';

test('weakening: with code changed too, an assertion removed, loosened, widened, unawaited, made conditional, unreachable or swallowed holds', () => {
  const change = (t: string) => kinds(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': t }));
  for (const [why, t] of [
    ['removed', MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '')],
    ['strict to loose', MATH_TEST.replace('assert.equal(sub(3, 1), 2)', 'assert.ok(sub(3, 1))')],
    ['an expected value widened, on a line of its own', MATH_TEST.replace('    [0, 2],', '    [0, 2].slice(0, 0),')],
    ['no longer awaited', MATH_TEST.replace('await assert.rejects', 'assert.rejects')],
    ['made conditional', MATH_TEST.replace('  assert.equal(add(1, 2), 3);', '  if (process.env.NEVER) {\n    assert.equal(add(1, 2), 3);\n  }')],
    ['made unreachable', MATH_TEST.replace('  assert.equal(add(1, 2), 3);', '  return;\n  assert.equal(add(1, 2), 3);')],
    ['its failure swallowed', MATH_TEST.replace('  assert.equal(add(1, 2), 3);', '  try {\n    assert.equal(add(1, 2), 3);\n  } catch {}')],
    ['moved into a function nothing calls', MATH_TEST.replace('  assert.equal(add(1, 2), 3);', '  const later = () => assert.equal(add(1, 2), 3);')],
  ]) assert.deepEqual(change(t!), [ASSERTION], why);
  // A whole test removed: its title and its assertions.
  assert.deepEqual(change(MATH_TEST.replace(/test\('subtracts'[\s\S]*$/, '')), ['removes or renames a test', ASSERTION]);
  // A local helper that asserts counts as an assertion: a call to it removed holds.
  const helper = `${MATH_TEST}\nfunction sums(n: number) {\n  assert.equal(add(n, 0), n);\n}\ntest('sums', () => {\n  sums(4);\n});\n`;
  assert.deepEqual(kinds(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': helper }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': helper.replace('  sums(4);\n', '') })), [ASSERTION]);
});

test('weakening: a rename the code makes too, applied in its assertions, is no change; a rename only in the test, or of what an assertion checks with, is', () => {
  // `total`, `isSum`: plain names that only start like a matcher (toBe, isTrue).
  const RENAMED = MATH.replaceAll('add', 'total').replaceAll('sub', 'isSum');
  const renamedTest = MATH_TEST.replaceAll('add(', 'total(').replaceAll('sub(', 'isSum(').replace('{ add, sub }', '{ total, isSum }');
  assert.deepEqual(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': RENAMED, 'test/math.test.ts': renamedTest }), []);
  // The code doesn't rename it (a code change elsewhere): the test's call now names something else.
  assert.deepEqual(kinds(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': renamedTest })), [ASSERTION]);
  // `equal` to `ok` is never a rename, whatever the code does.
  const swap = MATH.replace('export const add', 'export const ok = 1;\nexport const add').replace('a - b', 'b - a');
  assert.deepEqual(kinds(weakens({ 'src/math.ts': MATH.replace('export const add', 'export const equal = 1;\nexport const add'), 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': swap, 'test/math.test.ts': MATH_TEST.replace('assert.equal(sub(3, 1), 2)', 'assert.ok(sub(3, 1), 2)') })), [ASSERTION]);
});

test('weakening: in a change of tests only, fewer assertions or tests hold; a reworded assertion does not (the issue: changed ones wait when code changes too)', () => {
  const only = (t: string) => kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': t }));
  assert.deepEqual(only(MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '')), [ASSERTION]);
  assert.deepEqual(only(MATH_TEST.replace(/test\('subtracts'[\s\S]*$/, '')), ['removes or renames a test', ASSERTION]);
  assert.deepEqual(only(MATH_TEST.replace('assert.equal(add(1, 2), 3)', 'assert.equal(add(2, 1), 3)')), []);
  assert.deepEqual(only(MATH_TEST.replace("test('adds'", "test('adds two numbers'")), []);
});

test('weakening: a skip, todo or only on an existing test holds, so does a skipped describe around it or a changed skip condition; a new test with its own skip does not', () => {
  const only = (t: string, base = MATH_TEST) => kinds(weakens({ 'test/math.test.ts': base }, { 'test/math.test.ts': t }));
  for (const t of [
    MATH_TEST.replace("test('adds'", "test.skip('adds'"),
    MATH_TEST.replace("test('adds'", "test.only('adds'"),
    MATH_TEST.replace("test('adds'", "test.todo('adds'"),
    MATH_TEST.replace("test('adds', () =>", "test('adds', { skip: true }, () =>"),
    MATH_TEST.replace("test('adds'", "describe.skip('math', () => {\ntest('adds'").replace(/\n$/, '\n});\n'),
  ]) assert.deepEqual(only(t), [SKIP], t);
  const posix = MATH_TEST.replace("test('adds', () =>", "const posix = { skip: process.platform === 'win32' && 'POSIX' };\ntest('adds', posix, () =>");
  assert.deepEqual(only(posix.replace("process.platform === 'win32' && 'POSIX'", 'true'), posix), [SKIP], 'the condition of an options const an existing test uses');
  // A new test with a platform skip of its own, with or without a code change: nothing existing runs less.
  const added = `${MATH_TEST}test('multiplies', { skip: process.platform !== 'linux' && 'Linux only' }, () => {\n  assert.equal(add(2, 2), 4);\n});\n`;
  assert.deepEqual(only(added), []);
  assert.deepEqual(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': added }), []);
});

test('weakening: a deleted test file holds unless the change adds the same text as a test file in its folder; a rename out of the runner or the folder holds', () => {
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null })), ['deletes a test file', 'removes or renames a test', ASSERTION]);
  assert.deepEqual(weakens({ 'test/math.test.ts': MATH_TEST, 'test/sum.test.ts': null }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST }), []);
  assert.ok(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/math.tset.ts': MATH_TEST })).includes('deletes a test file'), 'out of the names the runner runs');
  assert.ok(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/old/math.test.ts': MATH_TEST })).includes('deletes a test file'), 'into another folder');
});

test('weakening: adding tests, assertions or a test file holds nothing, with or without a code change', () => {
  const more = MATH_TEST.replace('  assert.equal(sub(3, 1), 2);', '  assert.equal(sub(3, 1), 2);\n  assert.equal(sub(1, 1), 0);');
  assert.deepEqual(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': more }), []);
  assert.deepEqual(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': more }), []);
  assert.deepEqual(weakens({ 'src/math.ts': MATH }, { 'src/math.ts': MATH_CHANGED, 'test/new.test.ts': MATH_TEST }), []);
});

test('weakening: an entry added to a lint allowlist holds, and so does a raised count; one taken out does not', () => {
  const lint = (t: string) => weakens({ 'test/no-clock-helpers.test.ts': CLOCK_LINT }, { 'test/no-clock-helpers.test.ts': t });
  assert.deepEqual(lint(CLOCK_LINT.replace("  'test/b.test.ts': 2,\n", "  'test/b.test.ts': 2,\n  'test/c.test.ts': 1,\n")), [
    `${WEAKENING_REASON}adds or changes an entry in an allowlist, exception or good-fixture list (test/no-clock-helpers.test.ts: "ALLOWED: 'test/c.test.ts'.1")`,
  ]);
  assert.deepEqual(kinds(lint(CLOCK_LINT.replace("'test/a.test.ts': 1", "'test/a.test.ts': 3"))), ['adds or changes an entry in an allowlist, exception or good-fixture list']);
  assert.deepEqual(lint(CLOCK_LINT.replace("  'test/a.test.ts': 1,\n", '')), []);
  // Renamed or gone: the table can't be read, so it holds.
  assert.deepEqual(kinds(lint(CLOCK_LINT.replace('const ALLOWED', 'const ALLOWED_NOW'))), ["removes or renames a check's or guard's table"]);
});

test("weakening: a rule taken out of a lint's rules or a guard's list holds; a rule added does not", () => {
  const rules = (t: string) => kinds(weakens({ 'test/change-files-renames.test.ts': READER_LINT }, { 'test/change-files-renames.test.ts': t }));
  assert.deepEqual(rules(READER_LINT.replace('  raw: /--raw\\b/g,\n', '')), ["removes or changes an entry in a check's rules or a guard's list"]);
  assert.deepEqual(rules(READER_LINT.replace('  raw: /--raw\\b/g,\n', '  raw: /--raw\\b/g,\n  stat: /--stat\\b/g,\n')), []);
  // A guard file: its table's entry, and the line it was on.
  assert.deepEqual(kinds(weakens({ 'src/delegation.ts': DELEGATION }, { 'src/delegation.ts': DELEGATION.replace("'money-path', ", '') })), ["removes or changes an entry in a check's rules or a guard's list", 'removes or changes code in a guard or lint']);
  // package.json scripts: a lint dropped from the test command holds; a new script does not.
  const pkg = (scripts: Record<string, string>) => `${JSON.stringify({ name: 'x', scripts }, null, 2)}\n`;
  const was = pkg({ test: 'node --test && npm run lint', lint: 'eslint .' });
  assert.deepEqual(kinds(weakens({ 'package.json': was }, { 'package.json': pkg({ test: 'node --test', lint: 'eslint .' }) })), ["removes or changes an entry in a check's rules or a guard's list"]);
  assert.deepEqual(weakens({ 'package.json': was }, { 'package.json': pkg({ test: 'node --test && npm run lint', lint: 'eslint .', fmt: 'prettier .' }) }), []);
});

test('weakening: a guard line removed or made conditional holds, a line only added does not; a lint config rule removed or an allowlist file grown holds in every repo', () => {
  const guard = 'export function guard(ref: string) {\n  if (ref === MAIN) return refuse(ref);\n  return ok();\n}\n';
  assert.deepEqual(weakens({ 'src/push-guard.ts': guard }, { 'src/push-guard.ts': guard.replace('ref === MAIN)', 'ref === MAIN && !process.env.LET_ME)') }), [
    `${WEAKENING_REASON}removes or changes code in a guard or lint (src/push-guard.ts: "if (ref === MAIN) return refuse(ref);"; src/push-guard.ts: "if (ref === MAIN && !process.env.LET_ME) return refuse(ref);")`,
  ]);
  // Made conditional by a line only added before it (an early return): holds too.
  assert.deepEqual(weakens({ 'src/push-guard.ts': guard }, { 'src/push-guard.ts': guard.replace('  if (ref === MAIN)', '  if (process.env.LET_ME) return ok();\n  if (ref === MAIN)') }), [
    `${WEAKENING_REASON}removes or changes code in a guard or lint (src/push-guard.ts: "if (process.env.LET_ME) return ok();")`,
  ]);
  assert.deepEqual(weakens({ 'src/push-guard.ts': guard }, { 'src/push-guard.ts': guard.replace('  return ok();', '  refuseDetached(ref);\n  return ok();') }), []);
  for (const scope of [undefined, 'managed-app'] as const) {
    assert.deepEqual(weakens({ '.eslintrc.json': ESLINT }, { '.eslintrc.json': ESLINT.replace('    "eqeqeq": "error",\n', '') }, scope), [
      `${WEAKENING_REASON}removes or changes code in a guard or lint (.eslintrc.json: "\\"eqeqeq\\": \\"error\\",")`,
    ], String(scope));
    assert.deepEqual(kinds(weakens({ '.gitleaksignore': 'a1b2c3:src/x.ts:generic-api-key:3\n' }, { '.gitleaksignore': 'a1b2c3:src/x.ts:generic-api-key:3\nd4e5f6:src/y.ts:generic-api-key:9\n' }, scope)), ['adds an entry to an allowlist file'], String(scope));
  }
  // A managed app's own src/review.ts is its own code, not the engine's guard (as the locks stand aside there).
  assert.deepEqual(weakens({ 'src/review.ts': guard }, { 'src/review.ts': guard.replace('  if (ref === MAIN) return refuse(ref);\n', '') }, 'managed-app'), []);
});

test("weakening (adversarial pass): an assertion called by another name, a shadowed or patched assert, a loose assert import, a process exit, a lint test's own logic, an entry behind a spread, a runner config", () => {
  const only = (t: string, base = MATH_TEST, path = 'test/math.test.ts') => kinds(weakens({ [path]: base }, { [path]: t }));
  // Another name for an assertion: an alias, a named import, a destructured one. Removing a call holds.
  const aliased = MATH_TEST.replace("import assert from 'node:assert/strict';", "import { strict as A } from 'node:assert';").replaceAll('assert.', 'A.');
  assert.deepEqual(only(aliased.replace('  A.equal(add(1, 2), 3);\n', ''), aliased), [ASSERTION]);
  const destructured = `${MATH_TEST}const { equal: same } = assert;\ntest('same', () => {\n  same(add(2, 2), 4);\n});\n`;
  assert.deepEqual(only(destructured.replace('  same(add(2, 2), 4);\n', ''), destructured), [ASSERTION]);
  // What the assertions call, changed in an existing file: holds whatever else the change does.
  const binding = "changes what an existing test file's assertions call: an assert import, or a name that shadows or patches one";
  assert.deepEqual(only(MATH_TEST.replace("'node:assert/strict'", "'node:assert'")), [binding], 'strict to loose equality');
  assert.deepEqual(only(MATH_TEST.replace("import { add, sub } from '../src/math.js';", "import { add, sub } from '../src/math.js';\nassert.equal = () => {};")), [binding], 'patched');
  assert.deepEqual(only(MATH_TEST.replace("import assert from 'node:assert/strict';", "import real from 'node:assert/strict';\nconst assert = { ...real, equal() {} };")), [binding], 'shadowed');
  assert.deepEqual(only(`${MATH_TEST}process.exitCode = 0;\nprocess.exit(0);\n`), ['makes an existing test file exit or abort the process']);
  // A lint test's own logic beside its table (its rule widened): holds; an allowlist entry taken out still doesn't.
  const lint = `${CLOCK_LINT}const READ = /Date\\.now\\(\\)/;\ntest('no clock', () => {\n  assert.deepEqual(found(READ, ALLOWED), []);\n});\n`;
  assert.deepEqual(only(lint.replace('/Date\\.now\\(\\)/', '/Date\\.never\\(\\)/'), lint, 'test/no-clock-helpers.test.ts'), ['removes or changes code in a guard or lint']);
  assert.deepEqual(only(lint.replace("  'test/a.test.ts': 1,\n", ''), lint, 'test/no-clock-helpers.test.ts'), []);
  // An entry added behind a spread or a name of another const in the same file.
  const spread = "const MORE = { 'test/x.test.ts': 1 };\nconst ALLOWED: Record<string, number> = {\n  ...MORE,\n  'test/a.test.ts': 1,\n};\n";
  assert.deepEqual(kinds(weakens({ 'test/no-clock-helpers.test.ts': spread }, { 'test/no-clock-helpers.test.ts': spread.replace("{ 'test/x.test.ts': 1 }", "{ 'test/x.test.ts': 1, 'test/y.test.ts': 9 }") })), ['adds or changes an entry in an allowlist, exception or good-fixture list', 'removes or changes code in a guard or lint']);
  // The test runner's and coverage's config, in every repo.
  for (const scope of [undefined, 'managed-app'] as const) {
    assert.deepEqual(kinds(weakens({ 'vitest.config.ts': "export default { test: { include: ['**/*.test.ts'] } };\n" }, { 'vitest.config.ts': "export default { test: { include: ['src/a.test.ts'] } };\n" }, scope)), ['removes or changes code in a guard or lint'], String(scope));
    assert.deepEqual(kinds(weakens({ 'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n' }, { 'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n' }, scope)), ['removes or changes code in a guard or lint'], String(scope));
  }
});

test('weakening (round 2, #1, #10): a skip in an existing test body, a generator body, a test put behind a condition, or an options const changed holds, tests only too', () => {
  const only = (t: string, base = MATH_TEST) => kinds(weakens({ 'test/math.test.ts': base }, { 'test/math.test.ts': t }));
  const withT = MATH_TEST.replace("test('adds', () => {", "test('adds', (t) => {");
  for (const [why, t] of [
    ['t.skip() in the body', withT.replace("test('adds', (t) => {", "test('adds', (t) => {\n  t.skip('later');")],
    ['t.todo() in the body', withT.replace("test('adds', (t) => {", "test('adds', (t) => {\n  t.todo();")],
    ['a generator body never runs', MATH_TEST.replace("test('adds', () => {", "test('adds', function* () {")],
    ['behind an if', MATH_TEST.replace("test('adds',", "if (process.env.FULL) test('adds',")],
    ['led by &&', MATH_TEST.replace("test('adds',", "process.env.FULL && test('adds',")],
  ] as const) assert.deepEqual(only(t, why === 't.skip() in the body' || why === 't.todo() in the body' ? withT : MATH_TEST), [SKIP], why);
  const mocha = "describe('math', function () {\n  it('adds', function () {\n    assert.equal(add(1, 2), 3);\n  });\n});\n";
  assert.deepEqual(only(mocha.replace("it('adds', function () {", "it('adds', function () {\n    this.skip();"), mocha), [SKIP], 'this.skip()');
  // A timeout raised through an options const an existing test uses.
  const opts = MATH_TEST.replace("test('adds', () =>", "const OPTS = { timeout: 1000 };\ntest('adds', OPTS, () =>");
  assert.deepEqual(only(opts.replace('timeout: 1000', 'timeout: 600000'), opts), [SKIP]);
});

test('weakening (round 2, #2): a "rename" from a comment or a string, to a name the old assertion had, or with the old name still used, is a changed assertion', () => {
  const src = 'export const f = (x: number) => x;\n// wanted: the value f gives back\n';
  const t = "import assert from 'node:assert/strict';\nimport { f } from '../src/f.js';\ntest('f', () => {\n  const got = f(1);\n  const wanted = 1;\n  assert.equal(got, wanted);\n});\n";
  const swapped = t.replace('assert.equal(got, wanted)', 'assert.equal(got, got)');
  assert.deepEqual(kinds(weakens({ 'src/f.ts': src, 'test/f.test.ts': t }, { 'src/f.ts': src.replace('// wanted', '// got'), 'test/f.test.ts': swapped })), [ASSERTION], 'from a comment');
  const code = 'export const f = (x: number) => x;\nexport const wanted = 1;\n';
  assert.deepEqual(kinds(weakens({ 'src/f.ts': code, 'test/f.test.ts': t }, { 'src/f.ts': code.replace('const wanted', 'const got'), 'test/f.test.ts': swapped })), [ASSERTION], 'to a name it already had');
});

test('weakening (round 2, #3): a test file renamed in its folder with the same text but another runner suffix holds', () => {
  for (const to of ['test/math.spec.ts', 'test/math.test.mts', 'test/math.test.js', 'test/math.test.tsx']) {
    assert.ok(kinds(weakens({ 'test/math.test.ts': MATH_TEST, [to]: null }, { 'test/math.test.ts': null, [to]: MATH_TEST })).includes('deletes a test file'), to);
  }
});

test('weakening (round 2, #4): a lint test\'s rule loosened holds, registered or by its shape; the registered ones read as lints', () => {
  const lint = "import { readdirSync, readFileSync } from 'node:fs';\nimport { repoRoot } from './helpers.js';\nconst files = readdirSync(join(repoRoot, 'scripts'));\ntest('pipefail', () => {\n  const bad = files.filter((f) => /shell:\\s*true|\\bexecSync\\(/.test(read(f)));\n  assert.deepEqual(bad, []);\n});\n";
  const loose = lint.replace('/shell:\\s*true|\\bexecSync\\(/', '/shell:\\s*true/');
  assert.deepEqual(kinds(weakens({ 'test/pipefail.test.ts': lint }, { 'test/pipefail.test.ts': loose })), ['removes or changes code in a guard or lint'], 'registered');
  assert.deepEqual(kinds(weakens({ 'test/other-lint.test.ts': lint }, { 'test/other-lint.test.ts': loose })), ['removes or changes code in a guard or lint'], 'by its shape');
  assert.ok(weakening.LINT_TESTS?.length, 'LINT_TESTS registers the lint tests');
  for (const p of weakening.LINT_TESTS) {
    assert.ok(existsSync(join(repoRoot, p)), `${p} is a real file`);
    assert.ok(weakening.lintShaped(readFileSync(join(repoRoot, p), 'utf8')), `${p} reads as a lint`);
  }
});

test('weakening (round 2, #5): a registered table narrowed by a call on its literal or where it is used holds', () => {
  const bad = "export const LOCK_SCOPE_BAD: string[] = [\n  'a',\n  'b',\n];\n";
  assert.deepEqual(kinds(weakens({ 'test/review.test.ts': bad }, { 'test/review.test.ts': bad.replace('];', '].slice(1);') })), ["removes or changes an entry in a check's rules or a guard's list"]);
  const paths = 'export const GUARDRAIL_PATHS = [/^src\\/guardrails\\//, /^src\\/hook\\.ts$/];\n';
  assert.deepEqual(kinds(weakens({ 'scripts/lib/changelog.mjs': paths }, { 'scripts/lib/changelog.mjs': paths.replace('];', '].filter((re) => !re.test("src/hook.ts"));') })), ["removes or changes an entry in a check's rules or a guard's list"]);
  const use = `${paths}export const isGuardrail = (f) => GUARDRAIL_PATHS.some((re) => re.test(f));\n`;
  const TOUCHED = "narrows, changes or declares again a check's or guard's table where it is used";
  assert.deepEqual(kinds(weakens({ 'scripts/lib/changelog.mjs': use }, { 'scripts/lib/changelog.mjs': use.replace('GUARDRAIL_PATHS.some', 'GUARDRAIL_PATHS.slice(1).some') })), [TOUCHED]);
  // Adversarial pass, round 2: grown by a mutation after its literal, or shadowed by a second declaration.
  const allowed = "export const ALLOWED_UP_TO = { checks: 'write' };\n";
  assert.deepEqual(kinds(weakens({ 'scripts/setup/app-permissions.mjs': allowed }, { 'scripts/setup/app-permissions.mjs': `${allowed}Object.assign(ALLOWED_UP_TO, { contents: 'write' });\n` })), [TOUCHED]);
  assert.deepEqual(kinds(weakens({ 'scripts/lib/changelog.mjs': use }, { 'scripts/lib/changelog.mjs': `${use}function check(f) {\n  const GUARDRAIL_PATHS = [];\n  return GUARDRAIL_PATHS.some((re) => re.test(f));\n}\n` })), [TOUCHED]);
});

test('weakening (adversarial pass, round 2): an expected value changed in a const, a case table shrunk, a lint walking with readdir, a skip line inserted in a lint, more configs and markers', () => {
  const code = { before: { 'src/math.ts': MATH }, after: { 'src/math.ts': MATH_CHANGED } };
  // An expected value kept in a const the assertion names: changing it changes the assertion (with code changed).
  const viaConst = MATH_TEST.replace('  assert.equal(add(1, 2), 3);', '  const EXPECTED = 3;\n  assert.equal(add(1, 2), EXPECTED);');
  assert.deepEqual(kinds(weakens({ ...code.before, 'test/math.test.ts': viaConst }, { ...code.after, 'test/math.test.ts': viaConst.replace('EXPECTED = 3', 'EXPECTED = add(1, 2)') })), [ASSERTION]);
  // A table that drives the tests, shrunk: the tests it makes run differently, tests only too.
  const cases = `${MATH_TEST}const CASES = [[1, 2], [2, 4]];\nfor (const [x, y] of CASES) {\n  test(\`doubles \${x}\`, () => {\n    assert.equal(add(x, x), y);\n  });\n}\n`;
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': cases }, { 'test/math.test.ts': cases.replace('[[1, 2], [2, 4]]', '[[1, 2]]') })), [SKIP]);
  // A lint that walks with fs.promises.readdir, its rule loosened; a registered lint with a file skipped by an inserted line.
  const walker = "import { readdir } from 'node:fs/promises';\nimport { repoRoot } from './helpers.js';\ntest('no eval', async () => {\n  for (const f of await readdir(join(repoRoot, 'src'))) assert.doesNotMatch(read(f), /\\beval\\(/);\n});\n";
  assert.deepEqual(kinds(weakens({ 'test/no-eval.test.ts': walker }, { 'test/no-eval.test.ts': walker.replace('/\\beval\\(/', '/\\beval\\(\\)/') })), ['removes or changes code in a guard or lint']);
  const pipefail = "import { readdirSync } from 'node:fs';\nimport { repoRoot } from './helpers.js';\nconst files = readdirSync(join(repoRoot, 'scripts'));\nfor (const f of files) {\n  test(f, () => assert.doesNotMatch(read(f), /shell:\\s*true/));\n}\n";
  assert.deepEqual(kinds(weakens({ 'test/pipefail.test.ts': pipefail }, { 'test/pipefail.test.ts': pipefail.replace('for (const f of files) {', "for (const f of files) {\n  if (f.includes('legacy')) continue;") })), ['removes or changes code in a guard or lint']);
  // More configs a check reads, and more inline markers.
  for (const [path, was, now] of [
    ['.husky/pre-commit', 'npm run lint\n', 'npm run lint || true\n'],
    ['.pre-commit-config.yaml', 'repos:\n  - repo: local\n', 'repos:\n  - repo: local\nexclude: ^legacy/\n'],
    ['mypy.ini', '[mypy]\nstrict = True\n', '[mypy]\nstrict = True\nignore_errors = True\n'],
  ] as [string, string, string][]) assert.deepEqual(kinds(weakens({ [path]: was }, { [path]: now })), ['removes or changes code in a guard or lint'], path);
  assert.deepEqual(kinds(weakens({ 'tools/a.py': 'x = 1\n' }, { 'tools/a.py': `x = eval(s)  # pylint: ${'disable'}=eval-used\n` })), ['adds an inline lint or type-check suppression']);
  assert.deepEqual(kinds(weakens({ 'src/lib.rs': 'fn a() {}\n' }, { 'src/lib.rs': '#[allow(dead_code)]\nfn a() {}\n' })), ['adds an inline lint or type-check suppression']);
});

test('weakening (round 2, #6, #7): config.yaml and tests.yaml are guards; any line added to a config guard file holds, in every repo', () => {
  const GUARD = 'removes or changes code in a guard or lint';
  for (const scope of [undefined, 'managed-app'] as const) {
    const cases: [string, string, string][] = [
      [`${BRAND.configDir}/config.yaml`, 'required_checks:\n  - ci\n  - lint\n', 'required_checks:\n  - ci\n'],
      [`${BRAND.configDir}/tests.yaml`, 'tiers:\n  - name: unit\n  - name: e2e\n', 'tiers:\n  - name: unit\n'],
      ['tsconfig.json', '{\n  "include": ["src"]\n}\n', '{\n  "include": ["src"],\n  "exclude": ["src/legacy"]\n}\n'],
      ['eslint.config.js', 'export default [\n  { rules: { eqeqeq: "error" } },\n];\n', 'export default [\n  { ignores: ["src/legacy/**"] },\n  { rules: { eqeqeq: "error" } },\n];\n'],
      ['.eslintrc.json', '{\n  "rules": {}\n}\n', '{\n  "ignorePatterns": ["src/legacy"],\n  "rules": {}\n}\n'],
      ['vitest.config.ts', 'export default { test: {} };\n', 'export default { test: {\n  exclude: ["src/a.test.ts"],\n} };\n'],
      ['jest.config.js', 'module.exports = {};\n', 'module.exports = {\n  testPathIgnorePatterns: ["a"],\n  passWithNoTests: true,\n};\n'],
      ['.gitleaks.toml', '[extend]\nuseDefault = true\n', '[extend]\nuseDefault = true\n[allowlist]\npaths = ["src/keys"]\n'],
      ['.github/workflows/ci.yml', 'jobs:\n  lint:\n    runs-on: ubuntu-latest\n', "jobs:\n  lint:\n    if: github.actor == 'nobody'\n    runs-on: ubuntu-latest\n"],
    ];
    for (const [path, was, now] of cases) assert.deepEqual(kinds(weakens({ [path]: was }, { [path]: now }, scope)), [GUARD], `${path} ${String(scope)}`);
  }
});

test('weakening (round 2, #8): a file over SIZE_CAP holds unread, before any parse', () => {
  assert.ok(Number.isFinite(weakening.SIZE_CAP), 'SIZE_CAP is a number');
  const big = `${MATH_TEST}${'// pad\n'.repeat(Math.ceil(weakening.SIZE_CAP / 7))}`;
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': big })), ["can't read a file to check it, so it may weaken a check"]);
});

test('weakening (round 2, #9): a doc that names a suppression is no suppression', () => {
  assert.deepEqual(weakens({ 'README.md': '# x\n' }, { 'README.md': '# x\nAdd `// eslint-disable-next-line` only with a reason; `# noqa` too.\n' }), []);
  assert.deepEqual(weakens({ 'docs/lint.md': '# x\n' }, { 'docs/lint.md': '# x\n- `// @ts-ignore`: never; use `@ts-expect-error` with why.\n' }), []);
});

test("weakening: an inline lint or type-check suppression added holds; one in a string (a lint's own fixture) or a word that only starts like one does not", () => {
  const app = 'export const x = 1;\n';
  assert.deepEqual(kinds(weakens({ 'src/a.ts': app }, { 'src/a.ts': `${['// @ts', 'expect-error'].join('-')}: upstream\n${app}` })), ['adds an inline lint or type-check suppression']);
  assert.deepEqual(kinds(weakens({ 'tools/a.py': 'x = 1\n' }, { 'tools/a.py': `x = eval(s)  # ${'noqa'}\n` })), ['adds an inline lint or type-check suppression']);
  assert.deepEqual(weakens({ 'test/lint.test.ts': MATH_TEST }, { 'test/lint.test.ts': `${MATH_TEST}const fixture = '// ${['@ts', 'ignore'].join('-')}';\n` }), []);
  assert.deepEqual(weakens({ 'src/a.ts': app }, { 'src/a.ts': `// the file noseccomp turns it off\n${app}` }), []);
});

test("weakening: fails closed: a file it can't read, a test file it can't parse after the change, or a git failure each hold", () => {
  const files: ChangeFile[] = [{ path: 'test/math.test.ts', added: 1, removed: 1, addedLines: ['x'], removedLines: ['y'] }];
  const boom = () => {
    throw new Error('no blob');
  };
  assert.deepEqual(kinds(weakeningReasons({ files, before: boom, after: () => MATH_TEST, scope: undefined })), ["can't read a file to check it, so it may weaken a check"]);
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': `${MATH_TEST}const s = \`never closed\n` })), ["can't read a file to check it, so it may weaken a check"]);
  const r = weakeningOf(exampleProject().dir, 'no-such-rev', 'HEAD', files, undefined);
  assert.equal(r.length, 1);
  assert.match(r[0]!, /^design: may weaken a check: the check for a removed or weakened test, lint or guard could not run/);
});

test("weakening: the merge decision waits on it whatever the level, so it still holds if a lock is ever narrowed", () => {
  const reason = `${WEAKENING_REASON}${ASSERTION} (test/a.test.ts: "assert.ok(x)")`;
  assert.deepEqual(mergeDecision(clean({ level: level(['test/a.test.ts']), weakening: [reason] })), { auto: false, reasons: [reason], why: [] });
  assert.deepEqual(mergeDecision(clean({ weakening: [] })), { auto: true, reasons: [], why: [] });
});

test('weakening registry: each table names a real one that reads, every check-shaped table in test/ and scripts/ is registered, and every test file here parses', () => {
  for (const t of CHECK_TABLES) {
    assert.ok(existsSync(join(repoRoot, t.path)), `${t.path} is a real file`);
    const entries = tableEntries(t.path, readFileSync(join(repoRoot, t.path), 'utf8'), t.table);
    assert.ok(entries?.length, `${t.path} ${t.table} reads as a table with entries`);
  }
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(repoRoot, d), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'fixtures') walk(join(d, e.name));
      } else if (/\.(?:ts|mjs|cjs|js)$/.test(e.name)) files.push(join(d, e.name));
    }
  };
  walk('test');
  walk('scripts');
  const named = new Set(CHECK_TABLES.map((t) => `${t.path} ${t.table}`));
  const notChecks = new Set(NOT_A_CHECK.map((t) => `${t.path} ${t.table}`));
  const found = files.flatMap((f) => checkShapedTables(readFileSync(join(repoRoot, f), 'utf8')).map((n) => `${f.split('\\').join('/')} ${n}`));
  assert.deepEqual(found.filter((k) => !named.has(k) && !notChecks.has(k)), [], 'register each in CHECK_TABLES (never-grow for an allowlist or good fixtures, never-shrink for rules or bad fixtures), or say why it is no check in NOT_A_CHECK');
  for (const k of notChecks) assert.ok(found.includes(k) && !named.has(k), `${k}: NOT_A_CHECK names only a check-shaped table that isn't registered`);
  // A test file the hold can't parse would hold every change to it: none here.
  const unreadable = files.filter((f) => f.startsWith('test') && !testFacts(readFileSync(join(repoRoot, f), 'utf8')).ok);
  assert.deepEqual(unreadable, []);
});

/**
 * The merge decision for a PR that turns `base` files into `head` ones (null: deleted), as merge-flow makes it, in a
 * real repo, with an approving evaluator and a review.yaml where only secrets wait.
 */
function decideChange(base: Record<string, string>, head: Record<string, string | null>) {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string | null>) => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) g('rm', '-q', '--', p);
      else {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), t);
      }
    }
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', 'step');
    return g('rev-parse', 'HEAD');
  };
  const before = commit(base);
  const after = commit(head);
  const cfg = loadConfig(dir);
  cfg.project.land_mode = 'pr';
  cfg.review = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: [] }, L1_evaluator: { when: ['app-non-money'] }, L2_notify: { when: [] }, L3_human: { when: ['secrets'] } } });
  const log = new EventLog(join(dir, '..', 'events.db'));
  const n = 7;
  log.append('issue.claimed', { issue: n, instance: 'i', lease: 'a'.repeat(40), base: before, owner: 'example-owner' }, 'i');
  log.append('pr.opened', { issue: n, number: 9, url: 'u', head: after, draft: false }, 'i');
  log.append('eval.verdict', { issue: n, head: after, patch_hash: 'h', patch_correct: true, test_correct: true, confidence: 'high', advice: '', design_change: false }, 'i');
  const c = new Coordinator({ cfg, log, backlog: new FileBacklog(join(dir, '..', 'b.json')), runner: new FakeRunner(() => ({})), repo: dir, instance: 'i', stateDir: join(dir, '..', 'state'), autoMerge: () => true });
  const pr: PullRequest = { number: 9, url: 'u', head: 'b', base: 'main', headSha: after, draft: false, state: 'open', title: 't', mergeable: true, mergeableState: 'clean' };
  return c.mergeDecisionFor(n, 9, pr);
}

test('acceptance (#783): a PR that deletes an assertion waits for the owner, with its code change or without one', () => {
  const head = MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '');
  const why = `${WEAKENING_REASON}${ASSERTION} (test/math.test.ts: "assert.equal(add(1,2),3)")`;
  assert.deepEqual(decideChange({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': head }), { auto: false, reasons: [why], why: [] });
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': head }), { auto: false, reasons: [why], why: [] });
});

test('acceptance (#783): a PR that adds .skip to a test waits for the owner', () => {
  const d = decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': MATH_TEST.replace("test('adds'", "test.skip('adds'") });
  assert.deepEqual(d, { auto: false, reasons: [`${WEAKENING_REASON}${SKIP} (test/math.test.ts: "'adds'")`], why: [] });
});

test("acceptance (#783): a PR that adds a lint allowlist or exception entry waits for the owner, though it changes only a test", () => {
  const d = decideChange({ 'test/no-clock-helpers.test.ts': CLOCK_LINT }, { 'test/no-clock-helpers.test.ts': CLOCK_LINT.replace("  'test/b.test.ts': 2,\n", "  'test/b.test.ts': 2,\n  'test/c.test.ts': 1,\n") });
  assert.deepEqual(d, { auto: false, reasons: [`${WEAKENING_REASON}adds or changes an entry in an allowlist, exception or good-fixture list (test/no-clock-helpers.test.ts: "ALLOWED: 'test/c.test.ts'.1")`], why: [] });
});

test('acceptance (#783): a PR that weakens a guard file waits for the owner, on its own reason beside any lock', () => {
  const d = decideChange({ 'src/delegation.ts': DELEGATION }, { 'src/delegation.ts': DELEGATION.replace("'money-path', ", '') });
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes(`${WEAKENING_REASON}removes or changes an entry in a check's rules or a guard's list (src/delegation.ts: "NEVER_LOOSEN: 'money-path'")`), d.reasons.join(' | '));
  assert.ok(d.reasons.some((r) => r.startsWith(`${WEAKENING_REASON}removes or changes code in a guard or lint (src/delegation.ts: `)), d.reasons.join(' | '));
  // A lint's config no lock names: this hold alone stops it.
  const e = decideChange({ '.eslintrc.json': ESLINT }, { '.eslintrc.json': ESLINT.replace('    "eqeqeq": "error",\n', '') });
  assert.deepEqual(e, { auto: false, reasons: [`${WEAKENING_REASON}removes or changes code in a guard or lint (.eslintrc.json: "\\"eqeqeq\\": \\"error\\",")`], why: [] });
});

test('acceptance (#783): a PR that only adds tests, or renames a test file with the same text, does not wait', () => {
  const more = `${MATH_TEST}test('multiplies', { skip: process.platform !== 'linux' && 'Linux only' }, () => {\n  assert.equal(add(2, 2), 4);\n});\n`;
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': more, 'test/sub.test.ts': MATH_TEST }), { auto: true, reasons: [], why: [] });
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST }), { auto: true, reasons: [], why: [] });
});
