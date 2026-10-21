// The engine's public security claims (docs/guardrails.md, docs/security*.md, SECURITY.md), the test that keeps their
// citations true, the adversarial suite of hostile PRs, this file, the engine's container image and its deployment
// files at the top of the repo (a bare deploy path, the compose files; #885) are its own
// controls (#858). Before this, a docs-only or tests-only change to any of them was L0 and could merge by itself on a
// PASS, and the Dockerfile waited only where a review.yaml kept `deploy-config`. Now each is self-modification in the
// engine's repo: L3, never auto-merged, whatever review.yaml says (src/review.ts SELF_MODIFICATION_PARTS). A managed
// app's same-named files keep the categories its own review.yaml gives them, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { mergeDecision, waitCategoriesOf, type MergeInput } from '../src/merge-policy.js';
import { computeLevel, DEFAULT_CATEGORIES, SELF_MODIFICATION, selfModificationPart, type LevelResult, type LockScope } from '../src/review.js';
import { repoRoot } from './helpers.js';

const own = loadConfig(repoRoot).review!;
const example = loadConfig(join(repoRoot, 'examples', 'basic')).review!;
/** The most permissive review.yaml: every category emptied (the built-in ones, the engine's own and the lock's name), nothing at L1 to L3, nothing waits. */
const dropped = {
  ...own,
  categories: Object.fromEntries([...Object.keys(DEFAULT_CATEGORIES), ...Object.keys(own.categories), SELF_MODIFICATION].map((c) => [c, [] as string[]])),
  levels: {
    ...own.levels,
    L1_evaluator: { ...own.levels.L1_evaluator, when: [] as string[] },
    L2_notify: { ...own.levels.L2_notify, when: [] as string[] },
    L3_human: { ...own.levels.L3_human, when: [] as string[] },
  },
  merge: { ...own.merge, wait_categories: [] as string[] },
};
const configs = [['this repo', own], ['the example', example], ['one that drops every category', dropped]] as const;

const levelOf = (path: string, rc: typeof own, scope: LockScope | undefined) => computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope }, rc);

/** A ready PR with everything else clean: the always-PASS evaluator, the switches on, within the limits. */
function decide(level: LevelResult, waitCategories: string[]) {
  const input: MergeInput = {
    branch: 'agent/issue-7',
    openedByHarness: true,
    policyOn: true,
    repoOn: true,
    stopped: null,
    level,
    waitCategories,
    limits: { max_lines: 400, max_files: 10 },
    lines: 2,
    files: 1,
    verdict: { patch_correct: true, test_correct: true, confidence: 'high', design_change: false },
    newTopLevel: [],
    ciFixRuns: 0,
    foreignPush: false,
    pushLimitHit: false,
  };
  return mergeDecision(input);
}

const pages = 'the public security claims';
const tests = 'the tests of the harness controls';
const image = "the engine's container image";
const deploys = "the engine's deployment files";
/** Each path the lock is for, with the part that names it. Some are files the repo has; the rest are new ones under a lock's glob. */
const locked = [
  ['docs/guardrails.md', pages],
  ['docs/security.md', pages],
  ['docs/security-model.md', pages],
  ['SECURITY.md', pages],
  ['test/docs-guardrails.test.ts', tests],
  ['test/adversarial/adversarial.test.ts', tests],
  ['test/adversarial/todo.json', tests],
  ['test/adversarial/controls.json', tests],
  ['test/adversarial/cases/locked-paths.json', tests],
  ['test/adversarial/cases/new-group.json', tests],
  ['test/engine-guard-locks.test.ts', tests],
  ['test/not-yet-files-locks.test.ts', tests],
  ['Dockerfile', image],
  ['Dockerfile.dev', image],
  // None of these is in the repo yet (NOT_YET_FILES in test/merge-policy.test.ts); each is locked before it lands (#885).
  ['dockerfile', image],
  ['Containerfile', image],
  ['Containerfile.dev', image],
  ['deploy', deploys],
  ['compose.yaml', deploys],
  ['compose.yml', deploys],
  ['compose.override.yaml', deploys],
  ['docker-compose.yml', deploys],
  ['docker-compose.prod.yml', deploys],
] as const;
/** The ones the repo has today: each must stay a real file, so a rename can't leave this test checking nothing. */
const present = ['docs/guardrails.md', 'docs/security.md', 'SECURITY.md', 'test/docs-guardrails.test.ts', 'test/adversarial/adversarial.test.ts', 'test/adversarial/todo.json', 'test/adversarial/controls.json', 'test/adversarial/cases/locked-paths.json', 'test/engine-guard-locks.test.ts', 'test/not-yet-files-locks.test.ts', 'Dockerfile'];

test('regression: a change to the security pages, their citations test, the adversarial suite or the Dockerfile is L3, self-modification and never auto-merges (this repo, the example, and a review.yaml that drops every category)', () => {
  for (const path of present) assert.ok(existsSync(join(repoRoot, path)), `${path} is a real file`);
  for (const [path, what] of locked) {
    assert.equal(selfModificationPart(path), what, path);
    for (const [name, rc] of configs) {
      const at = `${path} under ${name}`;
      const lvl = levelOf(path, rc, undefined);
      assert.equal(lvl.level, 'L3', `${at}: ${lvl.reasons.join(' | ')}`);
      assert.deepEqual(lvl.categories[SELF_MODIFICATION], [path], at);
      const d = decide(lvl, waitCategoriesOf(rc));
      assert.equal(d.auto, false, at);
      assert.ok(d.reasons.includes(`high-risk: ${SELF_MODIFICATION} (${path})`), `${at}: ${d.reasons.join(' | ')}`);
      assert.deepEqual(d.why.find((y) => y.category === SELF_MODIFICATION), { category: SELF_MODIFICATION, text: `changes ${what}: ${path}` }, at);
      // Even a caller that passes no wait categories at all: the floor holds.
      assert.equal(decide(lvl, []).auto, false, `${at}: the floor`);
      // The engine's scope said out loud is the same as left out.
      assert.deepEqual(levelOf(path, rc, 'engine'), lvl, `${at}: engine scope`);
    }
  }
  // The globs name these files only: a neighbour of each is no part of the lock.
  for (const path of ['docs/guide.md', 'docs/securityx.txt', 'docs/design/security.md', 'README.md', 'test/totals.test.ts', 'test/adversarial.test.ts', 'sub/Dockerfile', 'composer.json', 'sub/Containerfile', 'apps/x/compose.yaml', 'apps/x/deploy', 'deploy.md', 'deployment.yaml', 'Deploy', 'compose', 'docker-compose']) assert.equal(selfModificationPart(path), null, path);
});

test("a managed app's same-named files are unchanged: no engine lock, the categories its review.yaml gives them", () => {
  // As measured on main before the lock, under the example review.yaml in a managed app's repo.
  const before: Record<string, [string, string[]]> = {
    'docs/guardrails.md': ['L0', ['docs']],
    'docs/security.md': ['L0', ['docs']],
    'docs/security-model.md': ['L0', ['docs']],
    'SECURITY.md': ['L0', ['docs']],
    'test/docs-guardrails.test.ts': ['L0', ['tests']],
    'test/adversarial/adversarial.test.ts': ['L0', ['tests']],
    'test/adversarial/todo.json': ['L0', ['tests']],
    'test/adversarial/controls.json': ['L0', ['tests']],
    'test/adversarial/cases/locked-paths.json': ['L0', ['tests']],
    'test/adversarial/cases/new-group.json': ['L0', ['tests']],
    'test/engine-guard-locks.test.ts': ['L0', ['tests']],
    'test/not-yet-files-locks.test.ts': ['L0', ['tests']],
    Dockerfile: ['L3', ['app-non-money', 'deploy-config']],
    'Dockerfile.dev': ['L1', ['app-non-money']],
    dockerfile: ['L1', ['app-non-money']],
    Containerfile: ['L1', ['app-non-money']],
    'Containerfile.dev': ['L1', ['app-non-money']],
    deploy: ['L1', ['app-non-money']],
    'compose.yaml': ['L1', ['app-non-money']],
    'compose.yml': ['L1', ['app-non-money']],
    'compose.override.yaml': ['L1', ['app-non-money']],
    'docker-compose.yml': ['L1', ['app-non-money']],
    'docker-compose.prod.yml': ['L1', ['app-non-money']],
  };
  assert.deepEqual(Object.keys(before).sort(), locked.map(([p]) => p).sort(), 'every locked path is checked here');
  for (const [path, [level, categories]] of Object.entries(before)) {
    assert.equal(selfModificationPart(path, 'managed-app'), null, path);
    const app = levelOf(path, example, 'managed-app');
    assert.equal(app.level, level, path);
    assert.deepEqual(Object.keys(app.categories).sort(), categories, path);
    assert.equal(levelOf(path, dropped, 'managed-app').categories[SELF_MODIFICATION], undefined, `${path}: no engine lock under any review.yaml`);
  }
});

test("this repo's review.yaml holds each of them, and the engine's deployment files at the top of the repo, under engine-guards (an engine that predates the lock reads it from main)", () => {
  // A bare `deploy` (a file, or a symlink to anywhere), the compose files and the Dockerfiles at the top of the repo
  // set how the engine runs, as deploy/** does: the user, the mounts, the ports.
  const deployment = ['deploy', 'compose.yaml', 'compose.yml', 'compose.override.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'Dockerfile.dev', 'dockerfile', 'Containerfile'];
  for (const path of [...locked.map(([p]) => p), ...deployment]) {
    const lvl = levelOf(path, own, undefined);
    assert.equal(lvl.level, 'L3', `${path}: ${lvl.reasons.join(' | ')}`);
    assert.deepEqual(lvl.categories['engine-guards'], [path], path);
    const d = decide(lvl, waitCategoriesOf(own));
    assert.equal(d.auto, false, path);
    assert.ok(d.reasons.includes(`high-risk: engine-guards (${path})`), `${path}: ${d.reasons.join(' | ')}`);
  }
  assert.ok(own.levels.L3_human.when.includes('engine-guards') && own.merge.wait_categories.includes('engine-guards'));
});
