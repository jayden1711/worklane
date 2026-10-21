import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load.js';
import type { StoredEvent } from '../src/events/types.js';
import { PolicyFile } from '../src/instance.js';
import { instructionEvalReasons, mergeDecision, waitCategoriesOf, type InstructionEvalResult, type MergeInput } from '../src/merge-policy.js';
import { buildReport } from '../src/reports.js';
import { AGENT_INSTRUCTIONS, computeLevel, DEFAULT_CATEGORIES, LOCKED_CATEGORIES, SELF_MODIFICATION, SELF_MODIFICATION_PARTS, selfModificationPart } from '../src/review.js';
import { execFileSync } from 'node:child_process';
import { globToRegExp } from '../src/guardrails/glob.js';
import { loosenedProblems } from '../src/delegation.js';
import { repoRoot } from './helpers.js';
import { BRAND } from '../src/brand.js';
import { rolePrompt, VERDICT_SCHEMA } from '../src/roles.js';
import { exampleProject } from './helpers.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import * as changes from '../src/coordinator/change-files.js';
import { dirname, join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import type { PullRequest } from '../src/backlog/types.js';
import { ReviewConfig } from '../src/config/schema.js';
import { Coordinator } from '../src/coordinator.js';
import { EventLog } from '../src/events/log.js';
// Read through the namespace, so a module without one of them fails only the test that uses it.
import * as weakening from '../src/merge-policy-weakening.js';
import type { ChangeFile, LockScope } from '../src/review.js';
import { FakeRunner } from '../src/runner.js';
import { parse } from 'yaml';

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

/**
 * Globs the guard names before the repo has a file under them: the owner's own file, written when a study is set up, and
 * the deployment manifests, locked before the first one lands (#703 adds it). Each entry must still
 * match no file, so the first file under it takes the entry out and its glob is checked like the others.
 */
// check-table: never-grow
const NOT_YET_FILES = [`${BRAND.configDir}/experiments.yaml`, 'deploy/**', 'deploy', 'compose.*', 'docker-compose.*', 'dockerfile*', 'Containerfile*'];

test('self-modification: every glob names real engine files (none dead), and the list is the one the owner approved', () => {
  for (const part of SELF_MODIFICATION_PARTS) {
    for (const glob of part.globs) {
      if (NOT_YET_FILES.includes(glob)) assert.ok(!engineFiles.some((f) => globToRegExp(glob).test(f)), `${glob} matches a file now: take it out of NOT_YET_FILES, so the glob is checked like the others`);
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
    ['src/merge-policy-vacuity.ts', 'the merge policy'],
    ['src/vacuity.ts', 'the merge policy'],
    ['src/vacuity-read.ts', 'the merge policy'],
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
    ['test/change-files-renames.test.ts', 'the tests of the harness controls'],
    ['test/push-skill-names.test.ts', 'the tests of the harness controls'],
    ['test/push-skill-links.test.ts', 'the tests of the harness controls'],
    ['test/push-names-plumbing.test.ts', 'the tests of the harness controls'],
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

test('the rename and odd-name tests are locked (#724): a one-line change to test/change-files-renames.test.ts is self-modification, L3, never a tests-only L0', () => {
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const path = 'test/change-files-renames.test.ts';
  const r = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
  assert.deepEqual([r.level, r.categories[SELF_MODIFICATION], selfModificationPart(path)], ['L3', [path], 'the tests of the harness controls']);
  // Under the engine's own review.yaml too: listed in engine-guards.
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  assert.ok(engine.categories['engine-guards']?.includes(path), 'listed in .worklane/review.yaml engine-guards');
  assert.equal(computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, engine).level, 'L3');
});

test('the push limits\' SKILL.md lint tests are locked (#724): a one-line change to either is self-modification, L3, never a tests-only L0', () => {
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  for (const path of ['test/push-skill-names.test.ts', 'test/push-skill-links.test.ts']) {
    const r = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
    assert.deepEqual([r.level, r.categories[SELF_MODIFICATION], selfModificationPart(path)], ['L3', [path], 'the tests of the harness controls'], path);
    assert.ok(engine.categories['engine-guards']?.includes(path), `${path}: listed in .worklane/review.yaml engine-guards`);
    assert.equal(computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, engine).level, 'L3', path);
  }
});

test('the push limits\' plumbing-names tests are locked (#724): a one-line change is self-modification, L3, never a tests-only L0', () => {
  const cfg = ReviewConfig.parse({ version: 1, levels: { L0_auto: { when: ['docs-only', 'tests-only'], max_lines: 200 }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } } });
  const engine = ReviewConfig.parse(parse(readFileSync(join(repoRoot, BRAND.configDir, 'review.yaml'), 'utf8')));
  const path = 'test/push-names-plumbing.test.ts';
  const r = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, cfg);
  assert.deepEqual([r.level, r.categories[SELF_MODIFICATION], selfModificationPart(path)], ['L3', [path], 'the tests of the harness controls']);
  assert.ok(engine.categories['engine-guards']?.includes(path), 'listed in .worklane/review.yaml engine-guards');
  assert.equal(computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, engine).level, 'L3');
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

// WHY: the engine's deployment manifests (deploy/**, e.g. a compose file) set its isolation and exposure: which user it
// runs as, what it mounts, which ports it publishes. Before this, only review.yaml's `deploy-config` held them, so a
// review.yaml without that category would have let the first one merge below the owner. Locked before any exists.
test('regression: a PR touching only deploy/compose.yaml is L3, waits for the owner and never auto-merges (this repo, the example, and a review.yaml that drops it)', () => {
  const path = 'deploy/compose.yaml';
  const own = loadConfig(repoRoot).review!;
  const loose = {
    ...own,
    categories: { 'deploy-config': [] as string[], engine: [] as string[] },
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
    assert.deepEqual(d.why.find((y) => y.category === SELF_MODIFICATION), { category: SELF_MODIFICATION, text: `changes the machine setup: ${path}` }, name);
    // Even a caller that passes no wait categories at all: the floor holds.
    assert.equal(mergeDecision(clean({ level: lvl, lines: 2, waitCategories: [] })).auto, false, `${name}: the floor`);
  }
  // This repo's review.yaml names it too, under engine (an engine that predates the lock reads this file from main).
  assert.deepEqual(computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: undefined }, own).categories.engine, [path]);
  // A managed app's own deploy/ is the app's, not the engine's: no engine lock there, its deploy-config holds as before.
  assert.equal(selfModificationPart(path, 'managed-app'), null);
  const app = computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope: 'managed-app' }, review);
  assert.equal(app.categories[SELF_MODIFICATION], undefined);
  assert.deepEqual(app.categories['deploy-config'], [path]);
  assert.equal(app.level, 'L3');
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
// The rule is the owner's (2026-10-19): line by line, from the diff, with no parser.

/** A test file before a change: two tests, four assertions, one of them awaited, one setup line. */
const MATH_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add, sub } from '../src/math.js';",
  '',
  "test('adds', () => {",
  '  const one = 1;',
  '  assert.equal(add(1, 2), 3);',
  '  assert.deepStrictEqual(',
  '    [add(0, 0), add(1, one)],',
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
/**
 * A lint's allowlist and its rules, each registered by its mark (#869: a lint test's `// lint-test` line, a table's
 * `// check-table: <kind>` line before it), as the real files carry them.
 */
const CLOCK_LINT = "// lint-test\n// check-table: never-grow\nconst ALLOWED: Record<string, number> = {\n  'test/a.test.ts': 1,\n  'test/b.test.ts': 2,\n};\n";
const READER_LINT = '// lint-test\n// check-table: never-shrink\nconst READER_WORDS: Record<string, RegExp> = {\n  numstat: /numstat/g,\n  raw: /--raw\\b/g,\n};\n';
const DELEGATION = "// check-table: never-shrink\nexport const NEVER_LOOSEN = ['money-path', 'migration', 'auth'] as const;\n\nexport const floor = () => new Set<string>([...NEVER_LOOSEN]);\n";
const ESLINT = '{\n  "rules": {\n    "eqeqeq": "error",\n    "no-eval": "error"\n  }\n}\n';

/**
 * weakeningReasons for a change given as each file's text before and after (null: not there), its lines as a diff
 * gives them; a file there before and not after is deleted.
 */
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
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const files: ChangeFile[] = paths.map((path) => {
    const removed = minus(lines(before[path]), lines(after[path])).filter(Boolean);
    const added = minus(lines(after[path]), lines(before[path])).filter(Boolean);
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  const deleted = new Set(paths.filter((p) => typeof before[p] === 'string' && (after[p] ?? null) === null));
  // A deleted path whose exact text reappears at a new path: a move, as git's blob ids give it (weakeningOf).
  const moved = new Map<string, string>();
  const fresh = paths.filter((p) => (before[p] ?? null) === null && typeof after[p] === 'string');
  for (const p of deleted) {
    const to = fresh.find((q) => after[q] === before[p] && ![...moved.values()].includes(q));
    if (to) moved.set(p, to);
  }
  return weakening.weakeningReasons({ files, deleted, moved, before: (p) => before[p] ?? null, after: (p) => after[p] ?? null, scope });
}
const weakensRaw = weakens;
/** Each reason's kind, without the common start and the places. */
const kinds = (reasons: string[]) => reasons.map((r) => r.slice(weakening.WEAKENING_REASON.length).replace(/ \(.*$/s, ''));
const ASSERTION = 'removes or changes a line with an assertion or a test on it';
const EXPECTED = "removes or changes a line of a test's expected output or fixture";
const DELETED = 'deletes a test file';
const GUARD = 'removes or changes a line of a guard or lint';
const GROWN = 'adds or changes an entry in an allowlist, exception or good-fixture list';
const SHRUNK = "removes or changes an entry in a check's rules or a guard's list";
const GONE = "removes or renames a check's or guard's table";
const ALLOW_FILE = "adds a line to an allowlist file or a package manager's settings file";
const MARKER = 'adds a line with a skip, only or lint or type-check suppression mark';
const UNREADABLE = "can't read a change to check it, so it may weaken a check";

test("weakening (owner's rule, 2026-10-19): a removed or changed line with an assertion or a test on it waits, tests only or with code; added ones don't", () => {
  const only = (t: string, base = MATH_TEST) => kinds(weakens({ 'test/math.test.ts': base }, { 'test/math.test.ts': t }));
  const withCode = (t: string) => kinds(weakens({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': t }));
  for (const [why, t] of [
    ['an assertion removed', MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '')],
    ['an expected value changed', MATH_TEST.replace('assert.equal(sub(3, 1), 2)', 'assert.equal(sub(3, 1), 3)')],
    ['a matcher changed', MATH_TEST.replace('assert.equal(sub(3, 1), 2)', 'assert.ok(sub(3, 1))')],
    ['no longer awaited', MATH_TEST.replace('await assert.rejects', 'assert.rejects')],
    ['a whole test removed', MATH_TEST.replace(/test\('subtracts'[\s\S]*$/, '')],
    ['a test renamed (a changed test line)', MATH_TEST.replace("test('adds'", "test('adds two numbers'")],
  ] as [string, string][]) {
    assert.deepEqual(only(t), [ASSERTION], `tests only: ${why}`);
    assert.deepEqual(withCode(t), [ASSERTION], `with code: ${why}`);
  }
  // Pure additions pass: an assertion, a test, a test file.
  assert.deepEqual(only(MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '  assert.equal(add(1, 2), 3);\n  assert.equal(typeof add(1, 2), "number");\n')), []);
  assert.deepEqual(only(`${MATH_TEST}test('multiplies', () => {\n  assert.equal(add(2, 2), 4);\n});\n`), []);
  assert.deepEqual(weakens({}, { 'test/sum.test.ts': MATH_TEST }), []);
  // Named gaps: a line with neither on it is no assertion line (a setup line, the actual's input, an expected value
  // on a line of its own), and an inserted line that makes an assertion conditional or unreachable is an addition.
  assert.deepEqual(only(MATH_TEST.replace('const one = 1;', 'const one = 2;')), []);
  assert.deepEqual(only(MATH_TEST.replace('    [0, 2],', '    [0, 2].slice(0, 0),')), []);
  assert.deepEqual(only(MATH_TEST.replace('  const one = 1;\n', '  const one = 1;\n  return;\n')), []);
});

test('weakening: the assertion and test words of the other languages the rule names', () => {
  const change = (path: string, was: string, now: string) => kinds(weakens({ [path]: was }, { [path]: now }));
  for (const [path, was, now] of [
    ['tests/test_math.py', 'def test_add():\n    assert add(1, 2) == 3\n', 'def test_add():\n    assert add(1, 2) == 4\n'],
    ['tests/test_math.py', 'class TestMath(TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n', 'class TestMath(TestCase):\n    def test_add(self):\n        self.assertTrue(add(1, 2))\n'],
    ['tests/test_math.py', 'def test_add():\n    assert add(1, 2) == 3\n\ndef test_sub():\n    assert sub(3, 1) == 2\n', 'def test_add():\n    assert add(1, 2) == 3\n'],
    ['pkg/math_test.go', 'func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatalf("add")\n\t}\n}\n', 'func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Logf("add")\n\t}\n}\n'],
    ['pkg/math_test.go', 'func TestAdd(t *testing.T) {\n\trequire.Equal(t, 3, Add(1, 2))\n}\n', 'func TestAdd(t *testing.T) {\n\trequire.NotNil(t, Add(1, 2))\n}\n'],
    ['src/math.test.rs', '#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 3);\n}\n', '#[test]\nfn adds() {\n    assert_eq!(add(1, 2), 4);\n}\n'],
    ['src/test/MathTest.java', 'class MathTest {\n  @Test\n  void adds() {}\n}\n', 'class MathTest {\n  void adds() {}\n}\n'],
    ['web/src/math.test.tsx', "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n", "it('adds', () => {\n  expect(add(1, 2)).toBeTruthy();\n});\n"],
    ['test/math.spec.js', "describe('math', () => {\n  it('adds', () => add(1, 2).should.equal(3));\n});\n", "describe('math', () => {\n  it('adds', () => add(1, 2));\n});\n"],
    // Round 4's review: every language whose test files are read as code has its words.
    ['tests/MathTests.cs', 'public class MathTests {\n  [Fact]\n  public void Adds() {\n    Assert.Equal(3, Add(1, 2));\n  }\n}\n', 'public class MathTests {\n  [Fact]\n  public void Adds() {\n  }\n}\n'],
    ['tests/MathTests.cs', 'public class MathTests {\n  [Fact]\n  public void Adds() {}\n}\n', 'public class MathTests {\n  public void Adds() {}\n}\n'],
    ['tests/MathTests.cs', 'public class MathTests {\n  [Theory]\n  public void Adds() {}\n}\n', 'public class MathTests {\n  public void Adds() {}\n}\n'],
    ['Tests/MathTests.swift', 'func testAdd() {\n  XCTAssertEqual(add(1, 2), 3)\n}\n', 'func testAdd() {\n}\n'],
    ['test/math_test.rb', "it 'adds' do\n  _(add(1, 2)).must_equal 3\nend\n", "it 'adds' do\nend\n"],
    ['test/math_test.rb', 'def test_nil\n  refute_nil add(1, 2)\nend\n', 'def test_nil\nend\n'],
    ['test/cli.bats', '@test "adds" {\n  run add 1 2\n  [ "$output" = 3 ]\n}\n', '@test "adds" {\n  run add 1 2\n}\n'],
    ['test/cli.bats', '@test "adds" {\n  true\n}\n', 'true\n'],
    // Test folders at any depth (mocha's default `test/` naming has no `.test.` suffix).
    ['packages/x/test/math.js', "it('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\n", "it('adds', () => {\n});\n"],
    ['packages/x/spec/math.js', "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n", "it('adds', () => {\n});\n"],
  ] as [string, string, string][]) assert.deepEqual(change(path, was, now), [ASSERTION], `${path}: ${now}`);
  // A shell test file isn't read by words: every removed line waits, as an expected output's.
  assert.deepEqual(change('test/cli.sh', '[ "$(add 1 2)" = 3 ]\n', 'true\n'), [EXPECTED]);
  // Nested fixtures are expected outputs.
  assert.deepEqual(change('packages/x/test/fixtures/expected.json', '{ "total": 3 }\n', '{ "total": 4 }\n'), [EXPECTED]);
  // Rust's inline `#[cfg(test)]` tests in src/ aren't a test path: a named gap.
  assert.deepEqual(change('src/lib.rs', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(add(1, 2), 3);\n    }\n}\n', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n    }\n}\n'), []);
  // Go's own comparison line has none of the words: a named gap (its t.Fatal line is held).
  assert.deepEqual(change('pkg/math_test.go', 'func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n', 'func TestAdd(t *testing.T) {\n\tif Add(1, 2) != 4 {\n\t\tt.Fatal("add")\n\t}\n}\n'), []);
  // A word that only holds one of them is no assertion: `.test(` on a regex is held (it reads as a test call), `latest.` isn't.
  assert.deepEqual(change('test/a.test.ts', "test('a', () => {\n  const latest = runs.latest.id;\n});\n", "test('a', () => {\n  const latest = runs.latest.at;\n});\n"), []);
  // A sentence that ends on `it.` or `test.` is no `it.skip` (#653 and #610 held on one at first, measured).
  assert.deepEqual(change('test/a.test.ts', '// they read it, and never run it.\n// so it passes the test.\nx();\n', 'x();\n'), []);
});

test('weakening: a deleted test file waits; a pure rename does not, unless it leaves the test paths or its runner suffix, or edits the file; an added one does not', () => {
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null })), [DELETED, ASSERTION]);
  // The same text at a new test path with the same runner suffix: a rename (#783's deliverable, owner's decision 1).
  assert.deepEqual(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST }), []);
  assert.deepEqual(weakens({ 'test/unit/math.test.ts': MATH_TEST, 'test/unit/sum.test.ts': `${MATH_TEST}\n` }, { 'test/unit/math.test.ts': null, 'test/unit/sum.test.ts': null, 'test/core/math.test.ts': MATH_TEST, 'test/core/sum.test.ts': `${MATH_TEST}\n` }), [], 'a folder of tests moved');
  // Round 5's review: a rename passes only within one runner's naming, under the same test-folder root, never into a
  // fixtures, snapshots, testdata or docs folder.
  const PY = 'def test_add():\n    assert add(1, 2) == 3\n';
  const JAVA = 'class MathTest {\n  @Test\n  void adds() { assertEquals(3, add(1, 2)); }\n}\n';
  const RB = "describe 'math' do\n  it 'adds' do\n    expect(add(1, 2)).to eq(3)\n  end\nend\n";
  const moved = (from: string, to: string, text: string) => kinds(weakens({ [from]: text }, { [from]: null, [to]: text }));
  for (const [from, to, text] of [
    ['tests/test_sum.py', 'tests/test_total.py', PY],
    ['src/test/java/MathTest.java', 'src/test/java/SumTest.java', JAVA],
    ['spec/math_spec.rb', 'spec/sum_spec.rb', RB],
    ['pkg/math_test.go', 'pkg/sum_test.go', 'func TestAdd(t *testing.T) {\n\tt.Fatal("x")\n}\n'],
    ['web/src/a.test.tsx', 'web/src/b.test.tsx', MATH_TEST],
  ] as [string, string, string][]) assert.deepEqual(moved(from, to, text), [], `${from} -> ${to}`);
  for (const [from, to, text] of [
    ['tests/test_math.py', 'tests/math.py', PY],
    ['tests/test_math.py', 'tests/math_helpers.py', PY],
    ['src/test/java/MathTest.java', 'src/test/java/MathCase.java', JAVA],
    ['spec/math_spec.rb', 'spec/math.rb', RB],
    ['test/x.test.ts', 'scripts/x.test.ts', MATH_TEST],
    ['test/x.test.ts', 'docs/x.test.ts', MATH_TEST],
    ['test/x.test.ts', 'test/fixtures/x.test.ts', MATH_TEST],
    ['test/x.test.ts', 'test/__snapshots__/x.test.ts', MATH_TEST],
    // Round 6's review: folders runners skip.
    ['test/x.test.ts', 'test/node_modules/x.test.ts', MATH_TEST],
    ['test/x.test.ts', 'test/.old/x.test.ts', MATH_TEST],
    ['test/x.test.ts', 'test/__mocks__/x.test.ts', MATH_TEST],
    // Round 7's review: a leading-dot file name, as a dot folder (tsc and the dist/test glob skip it).
    ['test/x.test.ts', 'test/.x.test.ts', MATH_TEST],
    ['test/unit/fixtures/a.json', 'test/core/fixtures/a.json', '{ "a": 1 }\n'],
  ] as [string, string, string][]) assert.ok(moved(from, to, text).includes(DELETED), `${from} -> ${to}: ${moved(from, to, text).join(' | ')}`);
  // A guard, lint, allowlist or table file is never rename-exempt, even inside the test paths.
  for (const [from, to, text] of [
    ['tests/conftest.py', 'tests/old/conftest.py', 'def pytest_configure(config):\n    config.option.strict = True\n'],
    ['test/tsconfig.json', 'test/old/tsconfig.json', '{\n  "compilerOptions": { "strict": true }\n}\n'],
    ['test/jest.config.js', 'test/old/jest.config.js', 'module.exports = { testMatch: ["**/*.test.js"] };\n'],
    ['test/brand.test.ts', 'test/brand-name.test.ts', `// lint-test\n${MATH_TEST}`],
    ['test/isolate.ts', 'test/isolate-old.ts', 'export const isolate = true;\n'],
    ['test/no-clock-helpers.test.ts', 'test/no-clock-helpers2.test.ts', CLOCK_LINT],
  ] as [string, string, string][]) assert.ok(moved(from, to, text).includes(GUARD) || moved(from, to, text).includes(GONE), `${from} -> ${to}: ${moved(from, to, text).join(' | ')}`);
  // Not a rename: the text edited, another runner suffix, out of the test paths.
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST.replace('3);', '4);') })), [DELETED, ASSERTION]);
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/math.spec.ts': MATH_TEST })), [DELETED, ASSERTION]);
  assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'src/math-check.ts': MATH_TEST })), [DELETED, ASSERTION]);
  // A test helper with no assertion on any line: deleting it is deleting a test file all the same.
  assert.deepEqual(kinds(weakens({ 'test/numbers.ts': 'export const two = 2;\n' }, { 'test/numbers.ts': null })), [DELETED]);
  assert.deepEqual(weakens({}, { 'test/numbers.ts': 'export const two = 2;\n' }), []);
});

test("weakening: a snapshot, an expected output or a fixture waits on any line removed or changed, tests only too; a line added doesn't", () => {
  for (const [path, was, now] of [
    ['src/__snapshots__/view.test.ts.snap', 'exports[`renders 1`] = `"<b>3</b>"`;\n', 'exports[`renders 1`] = `"<b>4</b>"`;\n'],
    ['test/fixtures/expected.json', '{ "total": 3 }\n', '{ "total": 4 }\n'],
    ['test/fixtures/cli/build.jsonl', '{"type":"done"}\n{"type":"exit","code":0}\n', '{"type":"done"}\n'],
    ['test/fixtures/plugins/server.js', 'process.stdout.write("ready");\n', 'process.stdout.write("");\n'],
    ['pkg/testdata/out.golden', 'total 3\n', 'total 4\n'],
    ['test/cli.stdout', 'ok 3\n', 'ok 4\n'],
  ] as [string, string, string][]) {
    assert.deepEqual(kinds(weakens({ [path]: was }, { [path]: now })), [EXPECTED], path);
    assert.deepEqual(weakens({ [path]: was }, { [path]: `${was}more\n` }), [], `${path}: added only`);
  }
});

test('weakening: a guard or lint file waits on any line removed or changed, a line added (with no mark) does not; the engine-only ones stand aside in an app repo', () => {
  for (const path of [
    `${BRAND.configDir}/review.yaml`, `${BRAND.configDir}/config.yaml`, `${BRAND.configDir}/tests.yaml`, '.github/workflows/ci.yml', '.github/actions/setup/action.yml', '.husky/pre-commit',
    'tsconfig.json', 'eslint.config.js', '.eslintrc.json', 'vitest.config.ts', 'jest.config.js', 'cypress.config.ts', '.lintstagedrc.json', '.semgrep.yml', '.rubocop.yml', 'deno.json',
    'mypy.ini', '.pre-commit-config.yaml', '.github/CODEOWNERS', `${BRAND.configDir}/checks/lint.mjs`, 'scripts/ci/affected.mjs', 'src/push-guard.ts', 'test/pipefail.test.ts',
  ]) {
    // A lint test is one by its mark (#869).
    const lint = path === 'test/pipefail.test.ts' ? '// lint-test\n' : '';
    for (const scope of [undefined, 'managed-app'] as const) {
      const engineOnly = scope && /^(?:src|scripts|test)\//.test(path);
      assert.deepEqual(kinds(weakens({ [path]: `${lint}one\ntwo\n` }, { [path]: `${lint}one\n` }, scope)), engineOnly ? [] : [GUARD], `${path} ${String(scope)}`);
      assert.deepEqual(kinds(weakens({ [path]: `${lint}one\ntwo\n` }, { [path]: `${lint}one\nthree\n` }, scope)), engineOnly ? [] : [GUARD], `${path} ${String(scope)}: changed`);
    }
    assert.deepEqual(weakens({ [path]: `${lint}one\n` }, { [path]: `${lint}one\ntwo\n` }), [], `${path}: added`);
  }
  // A rule taken out of a lint's config.
  assert.deepEqual(kinds(weakens({ '.eslintrc.json': ESLINT }, { '.eslintrc.json': ESLINT.replace('    "eqeqeq": "error",\n', '') })), [GUARD]);
  assert.deepEqual(weakens({ '.eslintrc.json': ESLINT }, { '.eslintrc.json': ESLINT.replace('    "eqeqeq": "error",\n', '    "eqeqeq": "error",\n    "no-var": "error",\n') }), []);
});

test('weakening: a registered table waits on an entry added to an allowlist, or taken out of a rule list or a guard list, and on the table gone; the other way round it does not', () => {
  /** weakens, with each file holding the other tables registered for it (one it can't find makes the change wait). */
  const tablesOf = (files: Record<string, string | null>) =>
    Object.fromEntries(Object.entries(files).map(([p, t]) => [p, t === null ? t : `${t}${weakening.CHECK_TABLES.filter((x) => x.path === p && !t.includes(` ${x.table} `) && !t.includes(` ${x.table}:`) && !t.includes(`"${x.table}"`)).map((x) => `\nconst ${x.table} = [];\n`).join('')}`]));
  const weakens = (before: Record<string, string | null>, after: Record<string, string | null>) => weakensRaw(tablesOf(before), tablesOf(after));
  // An allowlist grown, or a count raised (test/no-clock-helpers.test.ts is a lint test too: its removed line waits).
  assert.deepEqual(kinds(weakens({ 'test/no-clock-helpers.test.ts': CLOCK_LINT }, { 'test/no-clock-helpers.test.ts': CLOCK_LINT.replace("  'test/b.test.ts': 2,\n", "  'test/b.test.ts': 2,\n  'test/c.test.ts': 1,\n") })), [GROWN]);
  assert.deepEqual(kinds(weakens({ 'test/no-clock-helpers.test.ts': CLOCK_LINT }, { 'test/no-clock-helpers.test.ts': CLOCK_LINT.replace("'test/b.test.ts': 2", "'test/b.test.ts': 3") })), [GROWN, GUARD]);
  // An entry added after the last one (its comma added to the line before) is one entry added.
  const last = "// check-table: never-grow\nexport const LOCK_SCOPE_GOOD = [\n  'a'\n];\n";
  assert.deepEqual(kinds(weakens({ 'test/review.test.ts': last }, { 'test/review.test.ts': last.replace("  'a'\n", "  'a',\n  'b'\n") })), [GROWN]);
  // A rule list shrunk: in a lint test, and in a test that isn't one (a bad-fixture list).
  assert.deepEqual(kinds(weakens({ 'test/change-files-renames.test.ts': READER_LINT }, { 'test/change-files-renames.test.ts': READER_LINT.replace('  raw: /--raw\\b/g,\n', '') })), [SHRUNK, GUARD]);
  assert.deepEqual(weakens({ 'test/change-files-renames.test.ts': READER_LINT }, { 'test/change-files-renames.test.ts': READER_LINT.replace('  raw: /--raw\\b/g,\n', '  raw: /--raw\\b/g,\n  stat: /--stat/g,\n') }), []);
  const bad = "// check-table: never-shrink\nconst NAMES_BAD = [\n  '',\n  '../up',\n];\n";
  assert.deepEqual(kinds(weakens({ 'test/add-project.test.ts': bad }, { 'test/add-project.test.ts': bad.replace("  '../up',\n", '') })), [SHRUNK]);
  assert.deepEqual(kinds(weakens({ 'test/add-project.test.ts': bad }, { 'test/add-project.test.ts': bad.replace('];', '].slice(1);') })), [SHRUNK]);
  const both = `${bad}const REPOS_BAD = [];\n`;
  assert.deepEqual(kinds(weakensRaw({ 'test/add-project.test.ts': both }, { 'test/add-project.test.ts': both.replace('NAMES_BAD', 'NAMES_ODD') })), [GONE]);
  // A guard's list: its file is a guard file too.
  // (a one-line table: its declaring line changed, so it waits as unreadable, round 6)
  assert.deepEqual(kinds(weakens({ 'src/delegation.ts': DELEGATION }, { 'src/delegation.ts': DELEGATION.replace("'money-path', ", '') })), [UNREADABLE, GUARD]);
  // The commands that run the checks: a script changed waits; a script added, or a dependency bumped, doesn't.
  const pkg = '{\n  "scripts": {\n    "test": "node --test",\n    "lint": "eslint ."\n  },\n  "dependencies": {\n    "a": "1.0.0"\n  }\n}\n';
  assert.deepEqual(kinds(weakens({ 'package.json': pkg }, { 'package.json': pkg.replace('"node --test"', '"true"') })), [SHRUNK]);
  assert.deepEqual(weakens({ 'package.json': pkg }, { 'package.json': pkg.replace('"a": "1.0.0"', '"a": "1.1.0"').replace('"test": "node --test",', '"test": "node --test",\n    "fmt": "prettier .",') }), []);
  // The owner's accepted false hold: a line that names the linter (`eslint `) is a mark.
  assert.deepEqual(kinds(weakens({ 'package.json': pkg }, { 'package.json': pkg.replace('"lint": "eslint ."', '"lint": "eslint .",\n    "fmt": "prettier ."') })), [MARKER]);
  // Round 4's review: the reader fails closed, never reads around a trick. A decoy declaration (in a comment) before
  // the table, an entry or a comment at column 0 inside it: the change waits.
  const allowed = "// check-table: never-grow\nconst ALLOWED = [\n  'a',\n];\nconst BAD_SHAPE = [];\n";
  const decoy = `/*\nconst ALLOWED = [\n  'a',\n];\n*/\n${allowed}`;
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': decoy }, { 'test/instance-name.test.ts': decoy.replace("];\nconst BAD_SHAPE", "  'b',\n];\nconst BAD_SHAPE") })), [UNREADABLE], 'a decoy, then an entry added');
  const names = "/*\nconst NAMES_BAD = [\n  '',\n  '../up',\n];\n*/\n// check-table: never-shrink\nconst NAMES_BAD = [\n  '',\n  '../up',\n];\nconst REPOS_BAD = [];\n";
  assert.deepEqual(kinds(weakensRaw({ 'test/add-project.test.ts': names }, { 'test/add-project.test.ts': names.replace("  '../up',\n];\nconst REPOS_BAD", "];\nconst REPOS_BAD") })), [UNREADABLE], 'a decoy, then an entry removed');
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': allowed }, { 'test/instance-name.test.ts': allowed.replace("  'a',\n", "  'a',\n'b',\n") })), [UNREADABLE], 'an entry at column 0');
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': allowed }, { 'test/instance-name.test.ts': allowed.replace("  'a',\n", "  'a',\n// fine\n  'b',\n") })), [UNREADABLE], 'a comment at column 0');
  // Round 5's review: a decoy copy in a comment above, the real declaration made unreadable to a narrow reader (`var`,
  // two spaces), and an entry added. `const`, `let` and `var` with any spacing declare a table, and a declaring line
  // the change removes or changes makes it wait.
  for (const real of ['var ALLOWED = [', 'const  ALLOWED = [', 'let\tALLOWED = [']) {
    const head = `/*\nconst ALLOWED = [\n  'a',\n];\n*/\n${real}\n  'a',\n  'b',\n];\nconst BAD_SHAPE = [];\n`;
    assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': allowed }, { 'test/instance-name.test.ts': head })), [UNREADABLE], `decoy + ${real}`);
    assert.ok(weakensRaw({ 'test/instance-name.test.ts': allowed }, { 'test/instance-name.test.ts': allowed.replace('const ALLOWED = [', real) }).length, `${real} alone`);
  }
  const spaced = "// check-table: never-grow\nvar  ALLOWED = [\n  'a',\n];\nconst BAD_SHAPE = [];\n";
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': spaced }, { 'test/instance-name.test.ts': spaced.replace("  'a',\n", "  'a',\n  'b',\n") })), [GROWN], '`var` with two spaces is read');
  // A one-line table is one line; its entries changing is a change.
  // Round 6's review: a declaring line that opens no bracket (its list on the next line) isn't a one-line table: the
  // change waits.
  // Round 7's review: a declaring line whose brackets balance but hold no list after the `=` (a type, a comment, an
  // empty constructor), with the list on the next lines: unreadable, the change waits.
  // Round 8's review: a bracket in a comment opens nothing, even with the list on the next line at the same indent.
  const commented = "// check-table: never-grow\nconst ALLOWED = // see [docs]\n[\n  'a',\n];\nconst BAD_SHAPE = [];\n";
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': commented }, { 'test/instance-name.test.ts': commented.replace("  'a',\n", "  'a',\n  'b',\n") })), [UNREADABLE], 'a bracket in a comment');
  const inString = "// check-table: never-grow\nconst ALLOWED = ['// not a comment', 'a'];\nconst BAD_SHAPE = [];\n";
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': inString }, { 'test/instance-name.test.ts': `${inString}// a note\n` })), [], 'a // inside a string is no comment');
  // Round 8's review: a registered allowlist grown by a line outside its literal (index assignment, Object.assign,
  // .push, .add, a spread declared again) waits: in a registered table's file, an added line that names the table
  // outside the table's own lines.
  const clock = "// check-table: never-grow\nconst ALLOWED: Record<string, number> = {\n  'test/a.test.ts': 1,\n};\nconst files = ['x'];\n";
  for (const line of ["ALLOWED['test/c.test.ts'] = 1;", "Object.assign(ALLOWED, { 'test/c.test.ts': 1 });", "(ALLOWED as unknown as string[]).push('test/c.test.ts');", "new Set(Object.keys(ALLOWED)).add('test/c.test.ts');", "const ALLOWED_TOO = { ...ALLOWED, 'test/c.test.ts': 1 };"]) {
    assert.deepEqual(kinds(weakensRaw({ 'test/no-clock-helpers.test.ts': clock }, { 'test/no-clock-helpers.test.ts': `${clock}${line}\n` })), ['changes a check\'s or guard\'s table outside its own list'], line);
  }
  for (const path of ['test/change-files-renames.test.ts', 'test/no-wall-clock-durations.test.ts']) {
    const table = path.includes('renames') ? 'OUTSIDE_THE_HELPER' : 'ALLOWED';
    const others = weakening.CHECK_TABLES.filter((x) => x.path === path && x.table !== table).map((x) => `const ${x.table} = [];\n`).join('');
    const text = `// check-table: never-grow\nconst ${table} = {\n  a: 1,\n};\n${others}`;
    assert.ok(kinds(weakensRaw({ [path]: text }, { [path]: `${text}${table}.b = 2;\n` })).includes("changes a check's or guard's table outside its own list"), path);
  }
  // Round 9's review: a name built at run time (`eval('ALL' + 'OWED')`, `Function(...)`) isn't matched by the
  // identifier, so in a registered table's file an added `eval(` or `Function(` line waits.
  // (round 10's review: as whole words, so `eval (` with a space waits too)
  for (const line of ["eval('ALL' + 'OWED')['test/c.test.ts'] = 1;", "eval ('ALL' + 'OWED')['test/c.test.ts'] = 1;", "new Function('t', 't.x = 1')(globalThis);", "Function('return this')().ALLOWED_X = 1;"]) {
    // A line naming the global object waits a second way too (#886's round 5: a global binding can hide a table).
    const global = line.includes('globalThis') ? ["adds a line that could hide a check's table from the line reader, an escaped name, a name on the next line or a global binding"] : [];
    assert.deepEqual(kinds(weakensRaw({ 'test/no-clock-helpers.test.ts': clock }, { 'test/no-clock-helpers.test.ts': `${clock}${line}\n` })), ['changes a check\'s or guard\'s table outside its own list', ...global], line);
  }
  // An added line inside the table's own literal is read as an entry, not as a use.
  assert.deepEqual(kinds(weakensRaw({ 'test/no-clock-helpers.test.ts': clock }, { 'test/no-clock-helpers.test.ts': clock.replace("  'test/a.test.ts': 1,\n", "  'test/a.test.ts': 1,\n  'test/b.test.ts': 1,\n") })), [GROWN]);
  for (const decl of ['const ALLOWED: string[] =\n  [', 'const ALLOWED = // see [docs]\n  [', 'const ALLOWED = new Set()\n  .add(']) {
    const close = decl.endsWith('(') ? '  );' : '  ];';
    const text = `// check-table: never-grow\n${decl}\n    'a',\n${close}\nconst BAD_SHAPE = [];\n`;
    assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': text }, { 'test/instance-name.test.ts': text.replace("    'a',\n", "    'a',\n    'b',\n") })), [UNREADABLE], decl);
  }
  const split = "// check-table: never-grow\nconst ALLOWED:\n  string[] = [\n  'a',\n];\nconst BAD_SHAPE = [];\n";
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': split }, { 'test/instance-name.test.ts': split.replace("  'a',\n", "  'a',\n  'b',\n") })), [UNREADABLE], 'a declaration with its bracket on the next line');
  const one = "// check-table: never-grow\nconst ALLOWED = ['a'];\nconst BAD_SHAPE = [];\n";
  // Since round 6 its declaring line changing makes it wait as unreadable (a decoy can't stand in for it).
  assert.deepEqual(kinds(weakensRaw({ 'test/instance-name.test.ts': one }, { 'test/instance-name.test.ts': one.replace("['a']", "['a', 'b']") })), [UNREADABLE]);
  // A table only after the change is new (a new lint and its allowlist): nothing to loosen. On neither side: nothing
  // to read (the backstop test keeps every registered table on the default branch).
  assert.deepEqual(weakensRaw({ 'test/slot-dir-writes.test.ts': 'const x = 1;\n' }, { 'test/slot-dir-writes.test.ts': "const x = 1;\nconst REVIEWED = {\n  'src/a.ts': 1,\n};\n" }), []);
  assert.deepEqual(weakensRaw({ 'test/add-project.test.ts': 'const x = 1;\n' }, { 'test/add-project.test.ts': 'const x = 1;\nconst y = 2;\n' }), []);
});

test('weakening: an allowlist file waits on any line added; one taken out does not', () => {
  assert.deepEqual(kinds(weakens({ '.denylist-allow': 'a\n' }, { '.denylist-allow': 'a\nb\n' })), [ALLOW_FILE]);
  assert.deepEqual(kinds(weakens({ '.gitleaksignore': 'a\n' }, { '.gitleaksignore': 'a\nb\n' }, 'managed-app')), [ALLOW_FILE]);
  assert.deepEqual(weakens({ '.denylist-allow': 'a\nb\n' }, { '.denylist-allow': 'a\n' }), []);
  // Round 9's review: `.npmrc` sets what install and every npm script run under (`script-shell=`, `ignore-scripts=`):
  // a guard file, and any line added to it waits too, in every repo.
  for (const scope of [undefined, 'managed-app'] as const) {
    // (round 10's review: yarn's and bun's settings files too)
    for (const path of ['.npmrc', 'web/.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.bunfig.toml']) {
      assert.deepEqual(kinds(weakens({ [path]: 'fund=false\n' }, { [path]: 'fund=false\nscript-shell=true\n' }, scope)), [ALLOW_FILE], `${path} ${String(scope)}: a line added`);
      assert.deepEqual(kinds(weakens({ [path]: 'fund=false\nengine-strict=true\n' }, { [path]: 'fund=false\n' }, scope)), [GUARD], `${path} ${String(scope)}: a line removed`);
    }
    // pnpm-workspace.yaml: a guard file where a removed or changed line waits; ordinary PRs add packages there, so an
    // added line doesn't (an added pnpm script setting is a named gap).
    const ws = "packages:\n  - 'web'\nonlyBuiltDependencies:\n  - esbuild\n";
    assert.deepEqual(kinds(weakens({ 'pnpm-workspace.yaml': ws }, { 'pnpm-workspace.yaml': ws.replace("  - esbuild\n", '') }, scope)), [GUARD], `pnpm-workspace.yaml ${String(scope)}: a line removed`);
    assert.deepEqual(weakens({ 'pnpm-workspace.yaml': ws }, { 'pnpm-workspace.yaml': ws.replace("  - 'web'\n", "  - 'web'\n  - 'docs-site'\n") }, scope), [], `pnpm-workspace.yaml ${String(scope)}: a package added`);
  }
});

test("weakening (owner's rule, 2026-10-19): an added line with a skip, only or suppression mark waits, in a test, a config or a source; an ordinary added line or a doc does not", () => {
  const MARKERS = weakening.MARKERS ?? [];
  // The owner's list, at least.
  for (const m of ['.only(', 'test.only', 'it.only', 'describe.only', 'fit(', 'fdescribe(', '.skip(', 'skip:', 't.skip', 'test.skip', 'it.skip', 'xit(', 'xdescribe(', '@pytest.mark.skip', '@unittest.skip', 't.Skip(', 'eslint-disable', 'eslint ', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'NOLINT', 'noqa', 'type: ignore', '#[allow(', '#[expect(', 'swiftlint:disable', 'rubocop:disable', 'rubocop:todo', 'nolint', 'istanbul ignore', 'c8 ignore']) {
    assert.ok(MARKERS.some((x) => m.includes(x)), `${m} is a marker`);
  }
  // Round 4's review: the common "similar" forms, measured passing then.
  for (const line of [
    't.Skipf("slow")', 't.SkipNow()', 'self.skipTest("slow")', 'raise unittest.SkipTest("slow")', 'np = pytest.importorskip("numpy")', '#[ignore]', '@Disabled', '@Ignore',
    "describe.skipIf(isWin)('x', () => {", "describe.skip.each(rows)('x', () => {", 'test.runIf(false)("x", () => {', "xcontext('x', () => {", 'pending();', 'throw XCTSkip("slow")',
    '[Fact(Skip = "slow")]', '[Fact(Skip="slow")]', '#pragma warning disable CS0168', '@Suppress("UNCHECKED_CAST")', '// @phpstan-ignore-next-line', '/** @psalm-suppress InvalidReturnType */',
    'x = eval(s)  # pylint:disable=eval-used', 'x = f()  # type:ignore', "  xit 'adds' do", "  skip 'later'", "\tskip 'later'", "xit 'adds' do",
  ]) {
    assert.deepEqual(kinds(weakens({ 'test/a.test.ts': 'one\n' }, { 'test/a.test.ts': `one\n${line}\n` })), [MARKER], line);
  }
  // RSpec's bare `xit`/`skip` need a non-identifier character before them.
  for (const line of ['  exit 0', 'const skipped = 1;', '  # it skips nothing', "  this.skipper = 'x'"]) {
    assert.deepEqual(weakens({ 'test/a.test.ts': 'one\n' }, { 'test/a.test.ts': `one\n${line}\n` }), [], line);
  }
  // A mark can't hide beside a line that isn't text: a NUL, a literal U+FFFD, or a byte that isn't UTF-8 (read as U+FFFD).
  for (const odd of ['const z = "\0";', 'const z = "�";', 'const z = "caf�";']) {
    assert.deepEqual(kinds(weakens({ 'app/a.js': 'one\n' }, { 'app/a.js': `one\n// eslint-disable-next-line\n${odd}\n` })), [UNREADABLE, MARKER], odd);
    assert.deepEqual(kinds(weakens({ 'app/a.js': 'one\n' }, { 'app/a.js': `one\n${odd}\n` })), [UNREADABLE], `${odd} alone: a source that isn't text waits`);
  }
  // A test file under docs/ is a test file: its marks are read.
  assert.deepEqual(kinds(weakens({ 'docs/examples/a.test.js': 'one\n' }, { 'docs/examples/a.test.js': "one\ntest.only('x', () => {});\n" })), [MARKER]);
  for (const m of MARKERS) {
    for (const path of ['src/a.ts', 'test/math.test.ts', '.github/workflows/ci.yml', 'tools/a.py', 'Cargo.toml']) {
      assert.deepEqual(kinds(weakens({ [path]: 'one\n' }, { [path]: `one\nrun(x); ${m} y\n` })), [MARKER], `${path}: ${m}`);
    }
  }
  // Round 3's: a skip in a top-level hook, an outer t.skip() from a new subtest, a new test.only, clang-tidy and ESLint's forms.
  for (const line of ['beforeEach((t) => t.skip());', "  await t.test('setup', () => { t.skip(); });", "test.only('new', () => {", 'int x = f(); // NOLINTNEXTLINE(bugprone-*)', '/* eslint no-eval: "warn" */', '/* eslint no-eval: ["off"] */']) {
    assert.deepEqual(kinds(weakens({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': `${MATH_TEST}${line}\n` })), [MARKER], line);
  }
  // Ordinary added lines pass.
  for (const line of ['export const total = (a: number, b: number) => a + b;', "test('multiplies', () => {", '  assert.equal(add(2, 2), 4);', '});', '// says why', 'if (!ready) return null;', "describe('only adds', () => {", 'const skipped = list.filter(Boolean).length;', 'x = 1  # a comment']) {
    assert.deepEqual(weakens({ 'test/math.test.ts': MATH_TEST, 'src/a.ts': 'one\n' }, { 'test/math.test.ts': `${MATH_TEST}${line}\n`, 'src/a.ts': `one\n${line}\n` }), [], line);
  }
  // A doc that names a mark adds none.
  assert.deepEqual(weakens({ 'README.md': '# x\n' }, { 'README.md': '# x\nAdd `// eslint-disable-next-line` only with a reason; `# noqa` too.\n' }), []);
  assert.deepEqual(weakens({ 'docs/lint.md': '# x\n' }, { 'docs/lint.md': '# x\n- `// @ts-ignore`: never; use `@ts-expect-error` with why.\n' }), []);
});

test('weakening: a test-selection declaration (`// runtime-import:`, src/testrun/affected.ts) added or changed waits, in any file but docs; taken out it does not', () => {
  const decl = '  // runtime-import: src/watchdog/index.ts';
  const body = (d: string) => `function watchdog() {\n  const f = path.join(OPT, 'current', 'dist', 'src', 'watchdog', 'index.js');\n${d}\n  return import(require('node:url').pathToFileURL(f).href);\n}\n`;
  const bare = body('').replace('\n\n', '\n');
  for (const path of ['scripts/up.cjs', 'src/x/y.ts', 'lib/loader.mjs', 'scripts/machine/worklane-update.cjs', 'test/a.test.ts']) {
    assert.deepEqual(kinds(weakens({ [path]: bare }, { [path]: body(decl) })), [MARKER], `${path}: added`);
    assert.deepEqual(kinds(weakens({ [path]: body(decl) }, { [path]: body('  // runtime-import: src/cli.ts') })).filter((k) => k !== GUARD), [MARKER], `${path}: changed to another file`);
  }
  // The routes the review measured past the selector's own check: each needs an added declaration, so each waits.
  const routes: Record<string, string> = {
    'a decoy literal beside a wrong declaration (A)': body("  const decoy = 'dist/src/cli.js';\n  // runtime-import: src/cli.ts"),
    'a declaration inside a multi-line template literal (B)': body('  const s = `\n  // runtime-import: src/cli.ts\n  `; void s;'),
    'a top-level arrow with no block around it (C)': "const f = path.join(OPT, 'dist', 'src', 'watchdog', 'index.js');\n// runtime-import: src/cli.ts\nconst w = () => import(require('node:url').pathToFileURL(f).href);\n",
  };
  for (const [what, after] of Object.entries(routes)) assert.deepEqual(kinds(weakens({ 'scripts/up.cjs': bare }, { 'scripts/up.cjs': after })), [MARKER], what);
  // Taken out, the import is unresolved again and its tests run on every change: no wait. A doc naming it adds none.
  assert.deepEqual(weakens({ 'src/x/y.ts': body(decl) }, { 'src/x/y.ts': bare }), []);
  assert.deepEqual(weakens({ 'docs/selection.md': '# x\n' }, { 'docs/selection.md': '# x\n- `// runtime-import: src/x.ts` declares it.\n' }), []);
});

test("weakening: bounded and fail closed: too many changed characters, a diff that doesn't match its counts, a file that isn't text, a table file it can't read, a git failure", () => {
  const one = (f: Partial<ChangeFile>, before: (p: string) => string | null = () => null) =>
    kinds(weakening.weakeningReasons({ files: [{ path: 'test/math.test.ts', added: 0, removed: 0, addedLines: [], removedLines: [], ...f }], deleted: new Set(), before, after: () => null, scope: undefined }));
  const MAX = weakening.MAX_CHANGED_CHARS;
  assert.ok(Number.isFinite(MAX), 'MAX_CHANGED_CHARS is a number');
  assert.deepEqual(one({ added: 1, addedLines: ['x'.repeat(MAX + 1)] }), [UNREADABLE], 'over the cap');
  assert.deepEqual(one({ added: 1, addedLines: ['x'.repeat(MAX - 10)] }), [], 'under it');
  assert.deepEqual(one({ added: 5, addedLines: ['x'] }), [UNREADABLE], 'cut short');
  assert.deepEqual(one({ added: 1, addedLines: ['a\0b'] }), [UNREADABLE], 'a NUL');
  assert.deepEqual(one({ removed: 1, removedLines: ['a\uFFFDb'] }), [UNREADABLE], 'not UTF-8');
  // An image or other asset outside the files it checks has no marks to read.
  assert.deepEqual(kinds(weakening.weakeningReasons({ files: [{ path: 'web/logo.png', added: 1, removed: 0, addedLines: ['\0PNG skip: '] , removedLines: [] }], deleted: new Set(), before: () => null, after: () => null, scope: undefined })), []);
  // Over the cap is known before any file is read: four files each a quarter of it and a bit, one reason.
  const quarter = 'x'.repeat(Math.ceil(MAX / 4) + 1);
  const four = Array.from({ length: 4 }, (_, k): ChangeFile => ({ path: `.github/workflows/w${k}.yml`, added: 0, removed: 1, addedLines: [], removedLines: [quarter] }));
  const over = weakening.weakeningReasons({ files: four, deleted: new Set(), before: () => null, after: () => null, scope: undefined });
  assert.deepEqual(kinds(over), [UNREADABLE]);
  assert.match(over[0]!, /pass 4000000 characters/);
  const boom = () => {
    throw new Error('no blob');
  };
  assert.deepEqual(kinds(weakening.weakeningReasons({ files: [{ path: 'package.json', added: 1, removed: 1, addedLines: ['x'], removedLines: ['y'] }], deleted: new Set(), before: boom, after: boom, scope: undefined })), [UNREADABLE]);
  const r = weakening.weakeningOf(exampleProject().dir, 'no-such-rev', 'HEAD', [{ path: 'test/math.test.ts', added: 1, removed: 1, addedLines: ['x'], removedLines: ['y'] }], undefined, 'HEAD');
  assert.equal(r.length, 1);
  assert.match(r[0]!, /^design: may weaken a check: the check for a removed or weakened test, lint or guard could not run/);
  // The patterns are linear: substrings, and one regex of literal alternatives with no quantifier.
  assert.doesNotMatch(weakening.CHECK_LINE.source.replaceAll('(?<!', '').replaceAll('(?:', ''), /[*+?{]/);
});

test('weakening: weakeningOf reads the deleted paths from git and never a table file over its cap', () => {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'add-project.test.ts'), `// check-table: never-shrink\nconst NAMES_BAD = [\n  '',\n];\n${'// pad\n'.repeat(Math.ceil(weakening.MAX_TABLE_FILE / 7))}`);
  writeFileSync(join(dir, 'test', 'old.test.ts'), 'export const two = 2;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'big');
  const base = g('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'test', 'add-project.test.ts'), "// check-table: never-shrink\nconst NAMES_BAD = [\n  '',\n];\n");
  g('rm', '-q', 'test/old.test.ts');
  g('commit', '-q', '-am', 'small');
  const head = g('rev-parse', 'HEAD');
  const r = weakening.weakeningOf(dir, base, head, [
    { path: 'test/add-project.test.ts', added: 0, removed: 1, addedLines: [], removedLines: ['// pad'] },
    { path: 'test/old.test.ts', added: 0, removed: 1, addedLines: [], removedLines: ['export const two = 2;'] },
  ], undefined, base);
  assert.deepEqual(kinds(r), [UNREADABLE, DELETED]);
  assert.match(r[0]!, /over 500000: not read/);
});

test('weakening (round 6 review): only a regular file can be a pure rename; a symlink moved deeper, its link text kept, waits', () => {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(join(dir, 'test', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'test', 'real.test.ts'), MATH_TEST);
  writeFileSync(join(dir, 'test', 'plain.test.ts'), `${MATH_TEST}\n`);
  symlinkSync('real.test.ts', join(dir, 'test', 'link.test.ts'));
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD');
  // The link keeps its text (`real.test.ts`), so one level down it now points at a new, empty test.
  g('mv', 'test/link.test.ts', 'test/sub/link.test.ts');
  writeFileSync(join(dir, 'test', 'sub', 'real.test.ts'), "import { test } from 'node:test';\n");
  g('mv', 'test/plain.test.ts', 'test/sum.test.ts');
  g('add', '-A');
  g('commit', '-q', '-m', 'moved');
  const head = g('rev-parse', 'HEAD');
  const moves = changes.exactMoves(dir, base, head);
  assert.equal(moves.get('test/plain.test.ts'), 'test/sum.test.ts', 'a regular file is paired');
  assert.equal(moves.has('test/link.test.ts'), false, 'a symlink is not');
  const r = weakening.weakeningOf(dir, base, head, changes.changeFiles(dir, base, head), undefined, base);
  assert.ok(kinds(r).includes(DELETED), r.join(' | '));
  assert.ok(r.some((x) => x.includes('test/link.test.ts')), r.join(' | '));
  assert.ok(!r.some((x) => x.includes('plain.test.ts') || x.includes('sum.test.ts')), r.join(' | '));
});

test('weakening: the merge decision waits on it whatever the level, so it still holds if a lock is ever narrowed', () => {
  const reason = `${weakening.WEAKENING_REASON}${ASSERTION} (test/a.test.ts: "assert.ok(x)")`;
  assert.deepEqual(mergeDecision(clean({ level: level(['test/a.test.ts']), weakening: [reason] })), { auto: false, reasons: [reason], why: [] });
  assert.deepEqual(mergeDecision(clean({ weakening: [] })), { auto: true, reasons: [], why: [] });
});

// ---- Backstops (lints that read the repo), beside the merge-time check above: they keep its registries whole.

/** Tables in test/ and scripts/ that look like a check's but hold no check, each with why. Never grows without the owner (its mark). */
// check-table: never-grow
const NOT_A_CHECK: readonly { path: string; table: string; why: string }[] = [
  { path: 'scripts/rename.mjs', table: 'SKIP', why: 'the files the product-rename tool leaves alone; it checks nothing' },
  { path: 'test/decision-fixture.ts', table: 'OWNER_ONLY', why: 'marker strings a decision card shows only the owner; no rule' },
  { path: 'test/decision-fixture.ts', table: 'WRITERS_ONLY', why: 'marker strings a decision card shows writers; no rule' },
  { path: 'test/loop-control.test.ts', table: 'WORDS', why: 'words a scripted agent writes; no rule' },
];

/** Tests that list `src/` or `scripts/` files but aren't lint tests, each with why. Never grows without the owner (its mark). */
// check-table: never-grow
const NOT_A_LINT: readonly { path: string; why: string }[] = [
  { path: 'test/avatars.test.ts', why: 'the avatar suite; one test walks web/src' },
  { path: 'test/bench.test.ts', why: 'the bench suite; one test reads scripts/bench for a word' },
  { path: 'test/feature-map.test.ts', why: "the feature map's suite: it lists web/src/pages to match the map, no rule over code" },
  { path: 'test/merge-policy.test.ts', why: "this hold's own tests: locked (the tests of the harness controls)" },
  { path: 'test/package-files.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/push-check.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/push-gate-hook.test.ts', why: 'locked (the tests of the harness controls)' },
  { path: 'test/review.test.ts', why: 'locked (the tests of the harness controls); its lock-scope lint tables are registered' },
  { path: 'test/web-render.test.ts', why: 'the web render suite; one test walks web/src' },
];

/** The words in a table's name that say it allows, exempts, skips or rules something. */
const CHECK_TABLE_NAME = /ALLOW|EXEMPT|EXCEPT|SKIP|OUTSIDE|IGNORE|KNOWN|REVIEWED|PERMIT|BASELINE|LEGACY|WAIVE|NOT_YET|ONLY|GOOD|BAD|RULES|WORDS|PATTERNS|DENY|BANNED|FORBIDDEN|NEVER|GUARD/;
const TABLE_DECL = /^(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]*)\b[^=\n]*=\s*(?:\[|\{|new (?:Set|Map)\()/gm;
/** A file's top-level tables whose name says they allow, exempt, skip or rule something. A word list, not a proof. */
const checkShapedTables = (text: string): string[] => [...text.matchAll(TABLE_DECL)].map((m) => m[1]!).filter((n) => CHECK_TABLE_NAME.test(n));
/** A test that lists `src/` or `scripts/` files (readdir, glob, a walk, `git ls-files`). A word list, not a proof. */
const LISTS_SOURCES = /(?:\b(?:readdir|opendir|glob)(?:Sync)?|\bwalk\w*)\s*\([^\n]*['"`/](?:src|scripts)\b|ls-files[^\n]*\b(?:src|scripts)\b/;

/** Every file under `dirs` whose name matches `re`, from the top of the repo, fixtures and node_modules left out. */
function repoFiles(dirs: string[], re: RegExp): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(repoRoot, d), { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'fixtures' && e.name !== 'node_modules') walk(join(d, e.name));
      } else if (re.test(e.name)) files.push(join(d, e.name).split('\\').join('/'));
    }
  };
  for (const d of dirs) walk(d);
  return files;
}

/** A file's marks (#869), as the hold reads them; none from a module that has no reader for them. */
const marksOf = (text: string): { tables: { table: string; kind: weakening.TableKind }[]; lint: boolean; problems: string[] } =>
  weakening.registrationsOf?.(text) ?? { tables: [], lint: false, problems: [] };
/** Whether a path is one a mark is read in (JS and TS). */
const markable = (p: string) => (weakening.MARKABLE ?? /\.[cm]?[jt]sx?$/).test(p);
/** A folder the backstops don't scan: fixtures and node_modules (as repoFiles). */
const unscanned = (p: string) => /(?:^|\/)(?:fixtures|node_modules)\//.test(p);

/**
 * What the backstops find wrong with the registries, for a repo given as its files (path to text). Tables: each
 * registered table (the central list's, and every `// check-table: <kind>` mark's, #869) is found where it is
 * registered; an allowlist's name is marked never-grow (a rule list's name may carry either mark); every
 * mark is well formed and stands right before a declaration; every check-shaped table in test/ and scripts/ is
 * registered or in NOT_A_CHECK. Lints: every test that lists src/ or scripts/ files is a lint test (`// lint-test`, or
 * the central list) or in NOT_A_LINT. `listing` is the tests that list sources.
 */
function registryProblems(texts: ReadonlyMap<string, string>): { tables: string[]; lints: string[]; listing: string[] } {
  const tables: string[] = [];
  const lints: string[] = [];
  const registered: { path: string; table: string; kind: string }[] = [...weakening.CHECK_TABLES];
  const lintTests = new Set<string>(weakening.LINT_TESTS);
  for (const [path, text] of texts) {
    if (!markable(path)) continue;
    const marks = marksOf(text);
    for (const p of marks.problems) tables.push(`${path}: ${p}`);
    for (const t of marks.tables) registered.push({ path, ...t });
    if (marks.lint) lintTests.add(path);
  }
  for (const t of registered) {
    const text = texts.get(t.path);
    if (text === undefined) {
      tables.push(`${t.path} is not a real file`);
      continue;
    }
    // An allowlist's name is never-grow (#869). A rule list's name may carry either mark: its floor holds it on
    // shrinking whatever the mark says, and a never-grow mark adds a growth hold (a mark only adds).
    const allow = weakening.ALLOW_NAMED?.test(t.table);
    if (allow && t.kind !== 'never-grow') tables.push(`${t.path} ${t.table}: its name says it allows or exempts something, so it is never-grow`);
    let read: string[] | null;
    try {
      read = weakening.tableLines(text, t.table);
    } catch (e) {
      tables.push(`${t.path} ${t.table}: ${(e as Error).message}`);
      continue;
    }
    if (!read?.length) {
      tables.push(`${t.path} ${t.table} is not found`);
      continue;
    }
    if (read.length !== 1) continue;
    // A one-line table holds its whole list on that line: a bracket after its `=` (or its key's `:`), every bracket
    // closed, and the next line no deeper (round 7's review).
    const lines = text.split('\n');
    const at = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+${t.table}|"${t.table}"\\s*:)(?![\\w$])`).test(l));
    const line = lines[at]!;
    // Comments stripped first (round 8's review): a bracket in a comment opens nothing.
    const code = line.trimStart().startsWith('"') ? line : weakening.withoutComments(line);
    const value = code.slice(code.search(/=(?!>)|":/) + 1);
    const count = (s: string, set: string) => [...s].filter((c) => set.includes(c)).length;
    if (!(count(value, '[({') > 0 && count(value, '[({') === count(value, '])}'))) tables.push(`${t.path} ${t.table}: its list is not on its declaring line`);
    const next = lines.slice(at + 1).find((l) => l.trim());
    const indent = (l: string) => l.length - l.trimStart().length;
    if (!(next === undefined || indent(next) <= indent(line))) tables.push(`${t.path} ${t.table}: something of it is on the next line`);
  }
  const named = new Set(registered.map((t) => `${t.path} ${t.table}`));
  const notChecks = new Set(NOT_A_CHECK.map((t) => `${t.path} ${t.table}`));
  const scanned = [...texts.keys()].filter((f) => /^(?:test|scripts)\/.*\.(?:ts|mjs|cjs|js)$/.test(f) && !unscanned(f));
  const found = scanned.flatMap((f) => checkShapedTables(texts.get(f)!).map((n) => `${f} ${n}`));
  for (const k of found) if (!named.has(k) && !notChecks.has(k)) tables.push(`${k}: register it with a \`// check-table: <kind>\` line right before it (never-grow for an allowlist or good fixtures, never-shrink for rules or bad fixtures), or say why it is no check in NOT_A_CHECK`);
  for (const k of notChecks) if (!found.includes(k) || named.has(k)) tables.push(`${k}: NOT_A_CHECK names only a check-shaped table that isn't registered`);
  const listing = [...texts.keys()].filter((f) => /^test\/.*\.test\.ts$/.test(f) && !unscanned(f) && LISTS_SOURCES.test(texts.get(f)!));
  for (const f of listing) if (!lintTests.has(f) && !NOT_A_LINT.some((x) => x.path === f)) lints.push(`${f}: give it a \`// lint-test\` line (it checks a rule over those files), or add it to NOT_A_LINT with why`);
  for (const x of NOT_A_LINT) if (!listing.includes(x.path) || lintTests.has(x.path)) lints.push(`${x.path}: NOT_A_LINT names only a listing test that isn't a lint test`);
  for (const p of lintTests) if (!texts.has(p)) lints.push(`${p} is not a real file`);
  return { tables, lints, listing };
}

/** The repo's files the backstops read: test/ and scripts/ (as repoFiles walks them), every JS or TS file git tracks, and each central table's file. */
function repoTexts(): Map<string, string> {
  const paths = new Set([...repoFiles(['test', 'scripts'], /\.(?:ts|mjs|cjs|js)$/), ...engineFiles.filter(markable), ...weakening.CHECK_TABLES.map((t) => t.path), ...weakening.LINT_TESTS]);
  return new Map([...paths].filter((p) => existsSync(join(repoRoot, p))).map((p) => [p, readFileSync(join(repoRoot, p), 'utf8')]));
}

test('weakening backstop: each registered table is found where it is registered, and every check-shaped table in test/ and scripts/ is registered or says why not', () => {
  assert.deepEqual(registryProblems(repoTexts()).tables, []);
});

test('weakening backstop: every test that lists src/ or scripts/ files is a registered lint test or says why it is not', () => {
  const found = registryProblems(repoTexts());
  assert.ok(found.listing.length > 10, `${found.listing.length} tests list sources`);
  assert.deepEqual(found.lints, []);
});

/**
 * The merge decision for a PR that turns `base` files into `head` ones (null: deleted), as merge-flow makes it, in a
 * real repo, with an approving evaluator and a review.yaml where only secrets wait.
 */
function decideChange(base: Record<string, string>, head: Record<string, string | Buffer | null>) {
  const dir = exampleProject().dir;
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (files: Record<string, string | Buffer | null>) => {
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
  // The default branch on its remote, at the base (claimed at its tip): the merge decision fetches its tip and reads
  // the checks it registers (#869).
  execFileSync('git', ['init', '-q', '--bare', join(dir, '..', 'origin.git')], { stdio: 'ignore' });
  g('remote', 'add', 'origin', join(dir, '..', 'origin.git'));
  g('push', '-q', 'origin', `${before}:refs/heads/main`);
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
const reasonFor = (kind: string, path: string, line: string) => `${weakening.WEAKENING_REASON}${kind} (${path}: ${JSON.stringify(line)})`;

test('acceptance (#783): a PR that deletes an assertion waits for the owner, with its code change or without one', () => {
  const head = MATH_TEST.replace('  assert.equal(add(1, 2), 3);\n', '');
  const why = reasonFor(ASSERTION, 'test/math.test.ts', 'assert.equal(add(1, 2), 3);');
  // With the code change, #784's hold too: the example project's test globs (test/**/*.test.js) match no test here.
  assert.deepEqual(decideChange({ 'src/math.ts': MATH, 'test/math.test.ts': MATH_TEST }, { 'src/math.ts': MATH_CHANGED, 'test/math.test.ts': head }), { auto: false, reasons: [why, "design: vacuity: it changes app code (src/math.ts) and no test: it adds or changes none, and its task's done_when names none"], why: [] });
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': head }), { auto: false, reasons: [why], why: [] });
});

test('acceptance (#783): a PR that adds .skip to a test waits for the owner', () => {
  const d = decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': MATH_TEST.replace("test('adds'", "test.skip('adds'") });
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes(reasonFor(MARKER, 'test/math.test.ts', "test.skip('adds', () => {")), d.reasons.join(' | '));
});

test('acceptance (#783): a PR that adds a lint allowlist or exception entry waits for the owner, though it changes only a test', () => {
  const d = decideChange({ 'test/no-clock-helpers.test.ts': CLOCK_LINT }, { 'test/no-clock-helpers.test.ts': CLOCK_LINT.replace("  'test/b.test.ts': 2,\n", "  'test/b.test.ts': 2,\n  'test/c.test.ts': 1,\n") });
  assert.deepEqual(d, { auto: false, reasons: [reasonFor(GROWN, 'test/no-clock-helpers.test.ts', "ALLOWED: 'test/c.test.ts': 1")], why: [] });
});

test('acceptance (#783): a PR that weakens a guard file waits for the owner, on its own reason beside any lock', () => {
  const d = decideChange({ 'src/delegation.ts': DELEGATION }, { 'src/delegation.ts': DELEGATION.replace("'money-path', ", '') });
  assert.equal(d.auto, false);
  assert.ok(d.reasons.includes(reasonFor(GUARD, 'src/delegation.ts', "export const NEVER_LOOSEN = ['money-path', 'migration', 'auth'] as const;")), d.reasons.join(' | '));
  // A lint's config no lock names: this hold alone stops it.
  const e = decideChange({ '.eslintrc.json': ESLINT }, { '.eslintrc.json': ESLINT.replace('    "eqeqeq": "error",\n', '') });
  assert.deepEqual(e, { auto: false, reasons: [reasonFor(GUARD, '.eslintrc.json', '"eqeqeq": "error",')], why: [] });
});

test('acceptance (#783): a PR that only adds tests does not wait', () => {
  const more = `${MATH_TEST}test('multiplies', () => {\n  assert.equal(add(2, 2), 4);\n});\n`;
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': more, 'test/sub.test.ts': MATH_TEST }), { auto: true, reasons: [], why: [] });
});

test('acceptance (#783): a PR that only renames a test file or a test folder (same content) does not wait; a rename with an edit does', () => {
  const pure = { auto: true, reasons: [], why: [] };
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST }), pure);
  assert.deepEqual(decideChange({ 'test/unit/math.test.ts': MATH_TEST, 'test/unit/sum.test.ts': `${MATH_TEST}\n` }, { 'test/unit/math.test.ts': null, 'test/unit/sum.test.ts': null, 'test/core/math.test.ts': MATH_TEST, 'test/core/sum.test.ts': `${MATH_TEST}\n` }), pure);
  // A rename that takes a test out of what its runner runs (round 5's review) waits, through real git.
  for (const to of ['scripts/math.test.ts', 'test/fixtures/math.test.ts', 'test/math-check.ts']) {
    const d = decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, [to]: MATH_TEST });
    assert.equal(d.auto, false, to);
    assert.ok(d.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${DELETED}`)), `${to}: ${d.reasons.join(' | ')}`);
  }
  const edited = decideChange({ 'test/math.test.ts': MATH_TEST }, { 'test/math.test.ts': null, 'test/sum.test.ts': MATH_TEST.replace('assert.equal(sub(3, 1), 2)', 'assert.equal(sub(3, 1), 3)') });
  assert.equal(edited.auto, false);
  assert.ok(edited.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${DELETED}`)), edited.reasons.join(' | '));
});

test('acceptance (#783): a mark beside a byte that is not UTF-8 waits for the owner (it is never skipped as an asset)', () => {
  const d = decideChange({ 'app/a.js': 'one\n' }, { 'app/a.js': Buffer.concat([Buffer.from('one\n// @ts-nocheck\nconst s = "caf'), Buffer.from([0xe9]), Buffer.from('";\n')]) });
  assert.equal(d.auto, false);
  assert.ok(d.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${MARKER}`)), d.reasons.join(' | '));
});

// ---- A check registers itself where it is declared (#869): a `// check-table: <kind>` line right before a table, a
// `// lint-test` line in a lint test. Adding one needs no edit to a locked file; taking one away, or loosening one,
// waits for the owner. The fixtures spell the marks with `\n` escapes, so no line of this file is a mark by accident.

const REG_GONE = 'removes or changes the mark that registers a check, a check-table or lint-test line';
/** A new allowlist, registered by its mark. */
const NEW_TABLE = "// check-table: never-grow\nconst NEW_ALLOWED = [\n  'src/a.ts',\n];\n";
/** A new lint test with its allowlist: it walks src/ and fails on a file its allowlist doesn't name. */
const NEW_LINT = `// lint-test\nimport { readdirSync } from 'node:fs';\n\n${NEW_TABLE}\nfor (const f of readdirSync('src')) if (!NEW_ALLOWED.includes(f)) throw new Error(f);\n`;
const grownTable = (t: string) => t.replace("  'src/a.ts',\n", "  'src/a.ts',\n  'src/b.ts',\n");

test('registration (#869): a marked table is held by its mark, from the text before the change; adding a marked table or lint test never waits', () => {
  const p = 'test/new.test.ts';
  const change = (was: string | null, now: string | null, scope?: LockScope) => kinds(weakens({ [p]: was }, { [p]: now }, scope));
  assert.deepEqual(change(NEW_TABLE, grownTable(NEW_TABLE)), [GROWN], 'an entry added to a marked allowlist');
  assert.deepEqual(change(NEW_TABLE, NEW_TABLE.replace("  'src/a.ts',\n", '')), [], 'an entry taken out of it tightens');
  // Adding a check: a new marked table, a new lint test, a mark put on a table that had none.
  assert.deepEqual(change('const x = 1;\n', `const x = 1;\n${NEW_TABLE}`), []);
  assert.deepEqual(weakens({}, { 'test/new-lint.test.ts': NEW_LINT }), []);
  assert.deepEqual(change(NEW_TABLE.replace('// check-table: never-grow\n', ''), NEW_TABLE), []);
  // A lint test is a guard file by its mark: any line taken out of it waits.
  const lint = '// lint-test\nconst files = 1;\nrun(files);\n';
  assert.deepEqual(change(lint, lint.replace('run(files);\n', '')), [GUARD]);
  assert.deepEqual(change(lint, `${lint}run(files + 1);\n`), [], 'a line added to a lint test');
  // Engine-only paths stand aside in a managed app's repo, as the central list's did; a mark elsewhere holds there too.
  assert.deepEqual(change(NEW_TABLE, grownTable(NEW_TABLE), 'managed-app'), []);
  assert.deepEqual(kinds(weakens({ 'lib/rules.ts': NEW_TABLE }, { 'lib/rules.ts': grownTable(NEW_TABLE) }, 'managed-app')), [GROWN]);
});

test("registration (#869): removing a mark, changing its kind, detaching it, or deleting a marked table or lint test waits for the owner", () => {
  const p = 'test/new.test.ts';
  const change = (was: string | null, now: string | null) => kinds(weakens({ [p]: was }, { [p]: now }));
  assert.deepEqual(change(NEW_TABLE, NEW_TABLE.replace('// check-table: never-grow\n', '')), [REG_GONE], 'the mark removed');
  assert.deepEqual(change(NEW_TABLE, NEW_TABLE.replace('never-grow', 'never-shrink')), [REG_GONE], 'never-grow changed to never-shrink');
  assert.deepEqual(change(NEW_TABLE, NEW_TABLE.replace('const NEW_ALLOWED', '/** why */\nconst NEW_ALLOWED')), [REG_GONE], 'a line put between the mark and its table');
  // Then the next change grows it: the default branch still has the mark right before it, so it waits.
  assert.deepEqual(change(NEW_TABLE, grownTable(NEW_TABLE).replace('// check-table: never-grow\n', '')), [REG_GONE, GROWN], 'the mark removed and the table grown');
  assert.deepEqual(change(NEW_TABLE, 'const x = 1;\n'), [GONE], 'the marked table deleted');
  assert.deepEqual(change(NEW_TABLE, NEW_TABLE.replace('NEW_ALLOWED', 'NEW_ALLOWED_TOO')), [GONE], 'the marked table renamed');
  assert.deepEqual(change(NEW_TABLE, null), [DELETED, GONE], 'its file deleted');
  // The lint mark.
  assert.deepEqual(change(NEW_LINT, NEW_LINT.replace('// lint-test\n', '')), [REG_GONE, GUARD], 'the lint-test line removed');
  assert.deepEqual(change(NEW_LINT, NEW_LINT.replace('// lint-test\n', '// lint-test: off\n')), [REG_GONE, GUARD], 'the lint-test line changed');
  // A lint test or a marked table's file is never a pure rename.
  for (const text of [NEW_LINT, NEW_TABLE]) assert.ok(kinds(weakens({ [p]: text }, { [p]: null, 'test/renamed.test.ts': text })).includes(DELETED), text);
});

test("registration (#869): a table's name sets its floor: an allowlist's name holds growth and a rule list's name holds shrinking, whatever its mark says; a mark only adds", () => {
  const p = 'test/new.test.ts';
  const change = (was: string, now: string) => kinds(weakens({ [p]: was }, { [p]: now }));
  const table = (kind: string, name: string) => `// check-table: ${kind}\nconst ${name} = [\n  'a',\n  'b',\n];\n`;
  const grow = (t: string) => t.replace("  'b',\n", "  'b',\n  'c',\n");
  const shrink = (t: string) => t.replace("  'b',\n", '');
  // An allowlist marked never-shrink: its growth still waits, and so does its shrinking (the mark adds that).
  assert.deepEqual(change(table('never-shrink', 'NEW_ALLOWED'), grow(table('never-shrink', 'NEW_ALLOWED'))), [GROWN]);
  assert.deepEqual(change(table('never-shrink', 'NEW_ALLOWED'), shrink(table('never-shrink', 'NEW_ALLOWED'))), [SHRUNK]);
  // A rule list marked never-grow: its shrinking still waits, and so does its growth.
  assert.deepEqual(change(table('never-grow', 'NEW_RULES'), shrink(table('never-grow', 'NEW_RULES'))), [SHRUNK]);
  assert.deepEqual(change(table('never-grow', 'NEW_RULES'), grow(table('never-grow', 'NEW_RULES'))), [GROWN]);
  // A name of both kinds is held both ways.
  assert.deepEqual(change(table('never-grow', 'GOOD_WORDS'), shrink(table('never-grow', 'GOOD_WORDS'))), [SHRUNK]);
  assert.deepEqual(change(table('never-shrink', 'GOOD_WORDS'), grow(table('never-shrink', 'GOOD_WORDS'))), [GROWN]);
  // A name of neither kind: its mark alone.
  assert.deepEqual(change(table('never-grow', 'NEW_PATHS'), shrink(table('never-grow', 'NEW_PATHS'))), []);
  assert.deepEqual(change(table('never-shrink', 'NEW_PATHS'), grow(table('never-shrink', 'NEW_PATHS'))), []);
  // The name words are the backstop's check-shaped words: the allowlist ones and the rule ones, none in both. ONLY
  // stays in neither: FIRST_TIME_ONLY is an allowlist and MAKER_ONLY a guard's list.
  const words = (re: RegExp | undefined) => (re?.source ?? '').split('|').filter(Boolean);
  const allow = words(weakening.ALLOW_NAMED);
  const rule = words(weakening.RULE_NAMED);
  assert.deepEqual([...allow, ...rule, 'ONLY'].sort(), words(CHECK_TABLE_NAME).sort());
});

test('registration backstop (#869): a new allowlist and a new lint test pass with their marks and fail without them; a mark against its name, malformed or with no table after it fails', () => {
  const repo = repoTexts();
  const withFile = (path: string, text: string) => registryProblems(new Map([...repo, [path, text]]));
  const p = 'test/new-lint.test.ts';
  // With its marks: nothing to fix, and no locked file edited.
  const marked = withFile(p, NEW_LINT);
  assert.deepEqual([marked.tables, marked.lints], [[], []]);
  assert.ok(marked.listing.includes(p), 'it lists the sources');
  const bare = withFile(p, NEW_LINT.replace('// lint-test\n', '').replace('// check-table: never-grow\n', ''));
  assert.deepEqual(bare.tables.filter((x) => x.startsWith(`${p} NEW_ALLOWED`)).length, 1, bare.tables.join(' | '));
  assert.deepEqual(bare.lints.filter((x) => x.startsWith(p)).length, 1, bare.lints.join(' | '));
  // A kind against its name: an allowlist's name marked never-shrink.
  const against = withFile(p, NEW_LINT.replace('never-grow', 'never-shrink'));
  assert.ok(against.tables.some((x) => x.includes('NEW_ALLOWED: its name says it allows')), against.tables.join(' | '));
  // A mark that isn't one, or with no declaration on the next line: it would register nothing.
  for (const odd of ['// check-table: never-grwo', '//check-table: never-grow', '/* check-table: never-grow */', '// check-table:never-grow', '// lint-test: rules', '//lint-test']) {
    const r = withFile(p, NEW_LINT.replace('// check-table: never-grow', odd));
    assert.ok(r.tables.some((x) => x.startsWith(`${p}: `)), `${odd}: ${r.tables.join(' | ')}`);
  }
  const orphan = withFile(p, NEW_LINT.replace('const NEW_ALLOWED', '/** why */\nconst NEW_ALLOWED'));
  assert.ok(orphan.tables.some((x) => x.startsWith(`${p}: `)), orphan.tables.join(' | '));
});

test("registration backstop (#869): a mark only adds to its name's floor: a rule-named table registers with either mark, a name of both kinds registers as never-grow, and each is held on shrinking whatever its mark", () => {
  const repo = repoTexts();
  const p = 'test/new-rules.test.ts';
  const problems = (text: string) => registryProblems(new Map([...repo, [p, text]])).tables;
  const table = (kind: string, name: string) => `// check-table: ${kind}\nconst ${name} = [\n  'a',\n  'b',\n];\n`;
  const grow = (t: string) => t.replace("  'b',\n", "  'b',\n  'c',\n");
  const shrink = (t: string) => t.replace("  'b',\n", '');
  const change = (was: string, now: string) => kinds(weakens({ [p]: was }, { [p]: now }));
  // A rule list's name: either mark registers it. Marked never-grow (an allowlist of accepted rules), it is held both ways.
  for (const name of ['SELECTION_RULES', 'NEW_RULES', 'X_GUARD']) {
    for (const kind of ['never-grow', 'never-shrink']) {
      const t = table(kind, name);
      assert.deepEqual(problems(t), [], `${name} marked ${kind} registers`);
      assert.deepEqual(change(t, shrink(t)), [SHRUNK], `${name} marked ${kind}, shrunk`);
    }
    assert.deepEqual(change(table('never-grow', name), grow(table('never-grow', name))), [GROWN], `${name} marked never-grow, grown`);
  }
  // A name of both kinds: marked never-grow it registers, and it is held both ways. Marked never-shrink, the allowlist
  // name's rule (#869's acceptance) still fails it, and the hold still holds it both ways.
  for (const name of ['KNOWN_BAD', 'ALLOWED_WORDS', 'SKIP_RULES', 'GUARD_EXCEPTIONS']) {
    const t = table('never-grow', name);
    assert.deepEqual(problems(t), [], `${name} marked never-grow registers`);
    assert.deepEqual(change(t, shrink(t)), [SHRUNK], `${name} marked never-grow, shrunk`);
    assert.deepEqual(change(t, grow(t)), [GROWN], `${name} marked never-grow, grown`);
    const s = table('never-shrink', name);
    assert.ok(problems(s).some((x) => x.includes(`${name}: its name says it allows`)), `${name} marked never-shrink: ${problems(s).join(' | ')}`);
    assert.deepEqual([change(s, shrink(s)), change(s, grow(s))], [[SHRUNK], [GROWN]], `${name} marked never-shrink`);
  }
});

test('acceptance (#869): through the merge decision, a new marked allowlist and lint test merge; growing it, or taking its mark away, waits for the owner', () => {
  const p = 'test/new-lint.test.ts';
  assert.deepEqual(decideChange({ 'test/math.test.ts': MATH_TEST }, { [p]: NEW_LINT }), { auto: true, reasons: [], why: [] });
  assert.deepEqual(decideChange({ [p]: NEW_LINT }, { [p]: grownTable(NEW_LINT) }), { auto: false, reasons: [reasonFor(GROWN, p, "NEW_ALLOWED: 'src/b.ts'")], why: [] });
  const unmarked = decideChange({ [p]: NEW_LINT }, { [p]: NEW_LINT.replace('// check-table: never-grow\n', '') });
  assert.equal(unmarked.auto, false);
  assert.ok(unmarked.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${REG_GONE}`)), unmarked.reasons.join(' | '));
  const unlinted = decideChange({ [p]: NEW_LINT }, { [p]: NEW_LINT.replace('// lint-test\n', '') });
  assert.equal(unlinted.auto, false);
  assert.ok(unlinted.reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${REG_GONE}`)), unlinted.reasons.join(' | '));
});

/**
 * Every registration before the marks (main at 41f6dd42, #869): CHECK_TABLES and LINT_TESTS as they were, the queue's
 * and the owner's lines included. Each is still registered, with the same kind, by its mark or the central list.
 * Taking one out loosens this test.
 */
// check-table: never-shrink
const REGISTERED_BEFORE_MARKS: readonly { path: string; table?: string; kind: string }[] = [
  { path: 'test/change-files-renames.test.ts', table: 'OUTSIDE_THE_HELPER', kind: 'never-grow' },
  { path: 'test/no-clock-helpers.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/no-wall-clock-durations.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/instance-name.test.ts', table: 'ALLOWED', kind: 'never-grow' },
  { path: 'test/five-part-issues.test.ts', table: 'GOOD', kind: 'never-grow' },
  { path: 'test/plugin-inspect.test.ts', table: 'GOOD', kind: 'never-grow' },
  { path: 'scripts/setup/app-permissions.mjs', table: 'ALLOWED_UP_TO', kind: 'never-grow' },
  { path: 'test/slot-path.test.ts', table: 'SLOT_SOURCES', kind: 'never-grow' },
  { path: 'test/slot-dir-writes.test.ts', table: 'REVIEWED', kind: 'never-grow' },
  { path: 'test/review.test.ts', table: 'LOCK_SCOPE_GOOD', kind: 'never-grow' },
  { path: 'test/merge-policy.test.ts', table: 'NOT_YET_FILES', kind: 'never-grow' },
  { path: 'test/merge-policy.test.ts', table: 'NOT_A_CHECK', kind: 'never-grow' },
  { path: 'test/merge-policy.test.ts', table: 'NOT_A_LINT', kind: 'never-grow' },
  { path: 'test/review-packet.test.ts', table: 'PACKET_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'RAW_READS_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'JUDGED_CASTS_ALLOWED', kind: 'never-grow' },
  { path: 'test/raw-check-reads.ts', table: 'MAKERS_ALLOWED', kind: 'never-grow' },
  { path: 'test/owner-terminal-rerun.test.ts', table: 'FIRST_TIME_ONLY', kind: 'never-grow' },
  { path: 'scripts/lib/denylist.mjs', table: 'SKIP', kind: 'never-grow' },
  { path: 'src/guardrails/engine.ts', table: 'AGENT_EDITABLE', kind: 'never-grow' },
  { path: 'scripts/bench/pins.ts', table: 'SELECTION_RULES', kind: 'never-grow' },
  { path: 'test/change-files-renames.test.ts', table: 'READER_WORDS', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'LOCK_SCOPE_BAD', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_MODULES', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_ENTRIES', kind: 'never-shrink' },
  { path: 'test/review.test.ts', table: 'GUARD_TREE', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'SLOT_NAMES', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'WRITE_CALLS', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'CHMOD_BY_NAME', kind: 'never-shrink' },
  { path: 'test/slot-dir-writes.test.ts', table: 'FD_WRITES', kind: 'never-shrink' },
  { path: 'test/slot-path.test.ts', table: 'MAKER_ONLY', kind: 'never-shrink' },
  { path: 'test/child-process.test.ts', table: 'SPECIFIERS', kind: 'never-shrink' },
  { path: 'test/child-process.test.ts', table: 'BINDINGS', kind: 'never-shrink' },
  { path: 'test/child-process.test.ts', table: 'WORKER_SPECIFIERS', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'NAMES_BAD', kind: 'never-shrink' },
  { path: 'test/add-project.test.ts', table: 'REPOS_BAD', kind: 'never-shrink' },
  { path: 'test/instance-name.test.ts', table: 'BAD_SHAPE', kind: 'never-shrink' },
  { path: 'scripts/lib/changelog.mjs', table: 'GUARDRAIL_PATHS', kind: 'never-shrink' },
  { path: 'test/machine-path-writes.test.ts', table: 'GUARD', kind: 'never-shrink' },
  { path: 'test/runner-golden.test.ts', table: 'GUARD', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'SELF_MODIFICATION_PARTS', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'LOCKED_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ODD_PATH_CATEGORIES', kind: 'never-shrink' },
  { path: 'src/review.ts', table: 'ALWAYS_L3', kind: 'never-shrink' },
  { path: 'src/merge-policy.ts', table: 'FLOOR', kind: 'never-shrink' },
  { path: 'src/hook-imports.ts', table: 'HOOK_IMPORTS', kind: 'never-shrink' },
  { path: 'src/delegation.ts', table: 'NEVER_LOOSEN', kind: 'never-shrink' },
  { path: 'src/guardrails/engine.ts', table: 'BUILTIN_PROTECTED', kind: 'never-shrink' },
  { path: `scripts/machine/${BRAND.cli}-machine.cjs`, table: 'POLICY_ONLY', kind: 'never-shrink' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_RULES', kind: 'never-shrink' },
  { path: 'scripts/push-gate-hook.mjs', table: 'GATE_CODE', kind: 'never-shrink' },
  { path: 'scripts/push-gate.mjs', table: 'ATTRIBUTION', kind: 'never-shrink' },
  { path: 'package.json', table: 'scripts', kind: 'never-shrink' },
  { path: 'test/pipefail.test.ts', kind: 'lint' },
  { path: 'test/brand.test.ts', kind: 'lint' },
  { path: 'test/testrun-gpu.test.ts', kind: 'lint' },
  { path: 'test/boundaries.test.ts', kind: 'lint' },
  { path: 'test/web-key-in-url.test.ts', kind: 'lint' },
  { path: 'test/child-process.test.ts', kind: 'lint' },
  { path: 'test/self-hosted-guard.test.ts', kind: 'lint' },
  { path: 'test/package-deps.test.ts', kind: 'lint' },
  { path: 'test/no-clock-helpers.test.ts', kind: 'lint' },
  { path: 'test/no-wall-clock-durations.test.ts', kind: 'lint' },
  { path: 'test/change-files-renames.test.ts', kind: 'lint' },
  { path: 'test/slot-dir-writes.test.ts', kind: 'lint' },
  { path: 'test/slot-path.test.ts', kind: 'lint' },
  { path: 'test/claude-credential-guard.test.ts', kind: 'lint' },
  { path: 'test/download-retry.test.ts', kind: 'lint' },
  { path: 'test/owner-terminal-removed.test.ts', kind: 'lint' },
  { path: 'test/policy-edit.test.ts', kind: 'lint' },
  { path: 'test/testrun-measure.test.ts', kind: 'lint' },
  { path: 'test/update-helpers.test.ts', kind: 'lint' },
  { path: 'test/web-buttons.test.ts', kind: 'lint' },
  { path: 'test/superfan.test.ts', kind: 'lint' },
  { path: 'test/claude-accounts-retired.test.ts', kind: 'lint' },
];

test('registration (#869): every check registered before the marks is still registered, with the same kind (none lost in the move)', () => {
  const now = new Set<string>([...weakening.CHECK_TABLES.map((t) => `${t.path} ${t.table} ${t.kind}`), ...weakening.LINT_TESTS.map((p) => `${p} lint`)]);
  for (const [path, text] of repoTexts()) {
    if (!markable(path)) continue;
    const marks = marksOf(text);
    for (const t of marks.tables) now.add(`${path} ${t.table} ${t.kind}`);
    if (marks.lint) now.add(`${path} lint`);
  }
  assert.equal(REGISTERED_BEFORE_MARKS.length, 75, 'the 53 tables and 22 lint tests main registered');
  const lost = REGISTERED_BEFORE_MARKS.map((r) => (r.table === undefined ? `${r.path} lint` : `${r.path} ${r.table} ${r.kind}`)).filter((k) => !now.has(k));
  assert.deepEqual(lost, []);
});

/**
 * The same registrations, through the hold itself: for each, the change it holds (a line taken out of a never-shrink
 * table, a line put into a never-grow one, a line taken out of a lint test) gives a reason naming it. Each kind it is
 * held by is tried: its old kind, and its name's floor (a rule list's name holds it on shrinking).
 */
test('registration (#869): every check registered before the marks is still held by the hold itself: its table shrunk or grown, or a line taken out of its lint test, waits, naming it', () => {
  const texts = repoTexts();
  const notHeld: string[] = [];
  const reasonsFor = (path: string, was: string, now: string) => weakens({ [path]: was }, { [path]: now });
  const names = (reasons: string[], kind: string, what: string) => reasons.some((r) => r.startsWith(`${weakening.WEAKENING_REASON}${kind} (`) && r.includes(what));
  for (const r of REGISTERED_BEFORE_MARKS) {
    const text = texts.get(r.path);
    if (text === undefined) {
      notHeld.push(`${r.path}: not read`);
      continue;
    }
    const lines = text.split('\n');
    if (r.table === undefined) {
      // A lint test: its last line of code taken out waits as a guard's line.
      let k = lines.length - 1;
      while (k > 0 && (!lines[k]!.trim() || lines[k]!.trim() === weakening.LINT_MARK)) k--;
      const now = lines.filter((_, j) => j !== k).join('\n');
      if (!names(reasonsFor(r.path, text, now), GUARD, `${r.path}: `)) notHeld.push(`${r.path} lint`);
      continue;
    }
    const head = new RegExp(`^(?:export\\s+)?(?:(?:const|let|var)\\s+${r.table}|"${r.table}"\\s*:)(?![\\w$])`);
    const at = lines.findIndex((l) => head.test(l.trimStart()));
    const table = at === -1 ? null : weakening.tableLines(text, r.table);
    if (!table?.length) {
      notHeld.push(`${r.path} ${r.table}: not found`);
      continue;
    }
    const deep = (l: string) => l.trim() !== '' && l.length - l.trimStart().length > lines[at]!.length - lines[at]!.trimStart().length;
    for (const kind of weakening.heldKinds(r.table, r.kind as weakening.TableKind)) {
      let now: string;
      let expect: string;
      if (table.length === 1) {
        // A one-line table: its declaring line changed waits, naming the table. Grown: an entry put first. Shrunk: its
        // first entry taken out (to its first comma, or the whole list).
        const line = lines[at]!;
        const eq = line.search(/=(?!>)|":/);
        const open = line.slice(eq).search(/[[{(]/) + eq;
        const comma = line.indexOf(',', open);
        const end = comma === -1 ? line.search(/[\]})][^\]})]*$/) : comma + 1;
        const changed = kind === 'never-grow' ? `${line.slice(0, open + 1)}'held-probe', ${line.slice(open + 1)}` : `${line.slice(0, open + 1)}${line.slice(end).trimStart()}`;
        if (changed === line) notHeld.push(`${r.path} ${r.table}: the probe changed nothing`);
        now = lines.map((l, j) => (j === at ? changed : l)).join('\n');
        expect = UNREADABLE;
      } else if (kind === 'never-grow') {
        const pad = ' '.repeat(lines[at]!.length - lines[at]!.trimStart().length + 2);
        now = [...lines.slice(0, at + 1), `${pad}'held-probe',`, ...lines.slice(at + 1)].join('\n');
        expect = GROWN;
      } else {
        const k = lines.findIndex((l, j) => j > at && deep(l));
        now = lines.filter((_, j) => j !== k).join('\n');
        expect = SHRUNK;
      }
      if (!names(reasonsFor(r.path, text, now), expect, `${r.table}: `)) notHeld.push(`${r.path} ${r.table} ${kind}`);
    }
  }
  assert.deepEqual(notHeld, []);
});
