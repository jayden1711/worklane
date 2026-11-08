// #973: planner and plan-reviewer runs loaded their checkout's project-level agent instructions and config
// (`--setting-sources project`): CLAUDE.md and .claude/ there need one review, and a setup step can leave them in the
// checkout, so their text reached every planner as instructions. Those runs now load no setting source at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliArgs, NO_PROJECT_SOURCE_ROLES, type RunRequest } from '../src/runner.js';
import { repoRoot } from './helpers.js';

const req = (role: string): RunRequest => ({ role, prompt: 'p', cwd: '/tmp/x', model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000 });
const sourcesOf = (args: string[]) => {
  const i = args.indexOf('--setting-sources');
  assert.ok(i >= 0, 'every run names its setting sources');
  return args[i + 1];
};

test('#973: a planner or plan-reviewer run loads no setting source: no project instructions, settings or hooks from its checkout', () => {
  for (const role of ['planner', 'plan-reviewer']) assert.equal(sourcesOf(cliArgs(req(role), { hooks: {} })), '', role);
});

test('#973: every other run still loads its project settings, as before', () => {
  for (const role of ['worker', 'reviewer', 'researcher', 'goal-planner']) assert.equal(sourcesOf(cliArgs(req(role))), 'project', role);
});

test('#973: the planners the coordinator runs are exactly the roles that load no project source', () => {
  // The coordinator's plan runs (src/coordinator/decisions.ts planRun) take one of these two roles.
  const src = readFileSync(join(repoRoot, 'src', 'coordinator', 'decisions.ts'), 'utf8');
  assert.match(src, /role: 'planner' \| 'plan-reviewer' = 'planner'/);
  assert.deepEqual([...NO_PROJECT_SOURCE_ROLES].sort(), ['plan-reviewer', 'planner']);
});
