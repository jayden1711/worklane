import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { checkOutput, PREDATES_TITLE } from '../src/testrun/checks.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost } from '../src/testrun/host.js';
import { oldHeadFailure, referencedPaths } from '../src/testrun/predates.js';
import { runTestRun, type TestRunDeps } from '../src/testrun/run.js';
import { exampleProject } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();

/**
 * The example repo with an old head (its first commit, a PR's head) and a newer main whose test_run (and a script
 * its command calls) came after it. The run's config is passed in, as the coordinator holds it.
 */
function rig(testRun: unknown) {
  const p = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: p.dir, encoding: 'utf8' }).trim();
  const old = git('rev-parse', 'HEAD');
  mkdirSync(join(p.dir, '.worklane', 'checks'), { recursive: true });
  writeFileSync(join(p.dir, '.worklane', 'checks', 'scan.sh'), 'echo scan ok\n');
  writeFileSync(join(p.dir, '.worklane', 'tests.yaml'), `${readFileSync(join(p.dir, '.worklane', 'tests.yaml'), 'utf8')}test_run:\n  tiers:\n    - { name: scan, command: "bash .worklane/checks/scan.sh", kind: fast }\n`);
  git('add', '.worklane');
  git('commit', '-q', '-m', 'test_run: a scan tier');
  const config = git('rev-parse', 'HEAD');
  // A later commit on main that doesn't touch test_run: the config's commit stays the one before.
  writeFileSync(join(p.dir, 'later.txt'), 'later\n');
  git('add', 'later.txt');
  git('commit', '-q', '-m', 'later');
  const main = git('rev-parse', 'HEAD');
  const base = mkdtempSync(join(tmpdir(), 'tr-predates-'));
  const slots = join(base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const log = new EventLog(join(base, 'events.db'));
  const mark = join(base, 'ran');
  const parsed = TestRunConfig.parse({ ...(testRun as object), env: { MARK: mark } });
  const deps: TestRunDeps = { config: parsed, host: localHost(join(base, 'host')), repo: p.dir, log, actor: 'test', logDir: join(base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50 };
  return { dir: p.dir, old, config, main, deps, mark };
}

test('an old head missing a script its tier calls: the tier is not run, and the check says the PR predates the config', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  const r = rig({ tiers: [{ name: 'scan', command: 'echo ran >> "$MARK"; bash .worklane/checks/scan.sh', kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.old, kind: 'fast', prs: [3] });
  assert.equal(res.ok, false);
  const t = res.tiers[0]!;
  assert.deepEqual(t.predates, { configCommit: r.config, what: "`.worklane/checks/scan.sh` is not in this PR's head", notRun: true });
  assert.equal(existsSync(r.mark), false, 'the tier was not run');
  const out = checkOutput(res, res.tiers, 'failure');
  assert.equal(out.title, PREDATES_TITLE);
  assert.match(out.summary, new RegExp(`doesn't contain \`${r.config}\``));
  assert.match(out.summary, /- scan: `\.worklane\/checks\/scan\.sh` is not in this PR's head \(not run\)/);
  assert.match(out.summary, /merge main into the branch \(for a Dependabot PR, comment `@dependabot rebase`\)/);
  // The same tier on main's head (which has the config's commit) runs and passes.
  const now = await runTestRun(r.deps, { repo: r.dir, sha: r.main, kind: 'fast', prs: [3] });
  assert.equal(now.ok, true, JSON.stringify(now.tiers));
  assert.equal(now.tiers[0]!.predates, undefined);
  assert.equal(readFileSync(r.mark, 'utf8'), 'ran\n');
});

test('an old head whose runner rejects an option the config passes (exit 2): predates; on an up-to-date head, a plain failure', { skip: !hasPerl && 'perl' }, async () => {
  const command = `node -e "console.error('Unknown argument: changed-files'); process.exit(2)" -- --changed-files=x`;
  const r = rig({ tiers: [{ name: 'fast', command, kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.old, kind: 'fast', prs: [4] });
  const t = res.tiers[0]!;
  assert.equal(t.ok, false);
  assert.deepEqual(t.predates, { configCommit: r.config, what: 'its test runner rejects `--changed-files`', notRun: false });
  const out = checkOutput(res, res.tiers, 'failure');
  assert.equal(out.title, PREDATES_TITLE);
  assert.match(out.summary, /- fast: its test runner rejects `--changed-files`\n/);
  assert.match(out.summary, /Unknown argument: changed-files/, 'with its last lines');
  const now = await runTestRun(r.deps, { repo: r.dir, sha: r.main, kind: 'fast', prs: [4] });
  assert.equal(now.tiers[0]!.predates, undefined);
  assert.equal(checkOutput(now, now.tiers, 'failure').title, 'Failed');
});

test('a plain failure: a regular failed check whose summary has the tier\'s last lines, stdout and stderr, redacted', { skip: !hasPerl && 'perl' }, async () => {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const command = `for i in $(seq 1 40); do echo "line $i"; done; sleep 0.3; echo "to stderr" >&2; sleep 0.3; echo "token ${token}"; exit 1`;
  const r = rig({ tiers: [{ name: 'unit', command, kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.old, kind: 'fast', prs: [5] });
  assert.equal(res.ok, false);
  assert.equal(res.tiers[0]!.predates, undefined, 'an ordinary failure, even on an old head');
  const out = checkOutput(res, res.tiers, 'failure', 'https://dash.example.test/test-runs');
  assert.equal(out.title, 'Failed');
  assert.match(out.summary, /- failed: unit \(/);
  assert.match(out.summary, /\*\*unit\*\*, its last lines of output \(redacted\):\n\n```\n/);
  assert.match(out.summary, /line 40\nto stderr\ntoken gh\*_\[REDACTED\]\n```/);
  assert.match(out.summary, /\nline 13\n/);
  assert.doesNotMatch(out.summary, /\nline 12\n/, 'only the last 30 lines');
  assert.ok(!out.summary.includes(token), 'the secret is masked');
  assert.match(out.summary, /\n\nFull logs: \[the instance's dashboard\]\(https:\/\/dash\.example\.test\/test-runs\)$/);
});

test('a passing tier: its check\'s summary has its last lines too', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig({ tiers: [{ name: 'unit', command: 'echo "ok 1 - adds"; echo "# pass 1"', kind: 'fast' }] });
  const res = await runTestRun(r.deps, { repo: r.dir, sha: r.main, kind: 'fast', prs: [6] });
  assert.equal(res.ok, true, JSON.stringify(res.tiers));
  const out = checkOutput(res, res.tiers, 'success');
  assert.equal(out.title, 'Passed');
  assert.match(out.summary, /- passed: unit \(/);
  assert.match(out.summary, /```\nok 1 - adds\n# pass 1\n```/);
  assert.match(out.summary, /Full logs are on the instance's dashboard\.$/);
});

test('which paths a command names, and which failures mean an old head', () => {
  assert.deepEqual(referencedPaths(`bash .worklane/checks/x.sh && node ./scripts/plan.mjs {changed_files} --out=a/b /usr/bin/env $HOME/x src/*.ts https://e.test/a ../up/x "scripts/q.sh"`), ['.worklane/checks/x.sh', 'scripts/plan.mjs', 'scripts/q.sh']);
  assert.equal(oldHeadFailure('bash .worklane/checks/x.sh', 127, 'bash: .worklane/checks/x.sh: No such file or directory\n'), "`.worklane/checks/x.sh` is not in this PR's head");
  assert.equal(oldHeadFailure('bash .worklane/checks/x.sh', 127, 'foo: command not found\n'), null, '127 for something else');
  assert.equal(oldHeadFailure('npm test -- --changed-files=f', 2, "error: unknown option '--changed-files'\n"), 'its test runner rejects `--changed-files`');
  assert.equal(oldHeadFailure('npm test -- --changed-files=f', 2, 'Unknown option `--changedFiles`\n'), 'its test runner rejects `--changed-files`');
  assert.equal(oldHeadFailure('npm test -- --changed-files=f', 2, 'Unknown option --other\n'), null, 'an option the command does not pass');
  assert.equal(oldHeadFailure('npm test -- --changed-files=f', 1, "error: unknown option '--changed-files'\n"), null, 'only exit 2');
});
