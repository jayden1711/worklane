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
    ['src/guard/chat.ts', "the agents' tool guard"],
    // Out of the guard's import tree since #785, and still locked under parts of their own.
    ['src/events/redact.ts', 'sign-in, credentials or secrets'],
    ['src/agent-settings.ts', 'what an agent run is given'],
    ['src/plugins/approval.ts', 'what an agent run is given'],
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
