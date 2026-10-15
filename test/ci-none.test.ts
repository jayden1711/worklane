// #469, owner decision Q2: "No CI" (config.yaml ci: none). A PR is ready when this machine's test runs passed on its
// exact head (every test_run tier's check, read only from the event log) and the evaluator approved it; never from a
// GitHub check of the same name. Offered only where tests.yaml has test_run; refused elsewhere with the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { ciChoiceProblem } from '../src/ci-choice.js';
import { CI_NONE_MAIN_WATCH, headChecks, localRunChecks, requiredFor, testRunCheckNames } from '../src/ci-none.js';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { EventLog } from '../src/events/log.js';
import type { StoredEvent } from '../src/events/types.js';
import { readiness } from '../src/pr-watch.js';
import { FakeRunner } from '../src/runner.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';
import { exampleProject, repoRoot } from './helpers.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const tests = { test_run: TestRunConfig.parse({ tiers: [{ name: 'unit', command: 'npm test', kind: 'fast' }, { name: 'lint', command: 'npm run lint', kind: 'fast' }, { name: 'suite', command: 'npm run all', kind: 'full' }], checks: { unit: 'fast', lint: 'fast' } }) };
const none = { ci: 'none' as const, required_checks: [] as string[] };

/** A scratch event log, and its events as the merge flow reads them. */
function log() {
  const l = new EventLog(join(mkdtempSync(join(tmpdir(), 'ci-none-')), 'events.db'));
  let id = 0;
  const finished = (sha: string, outcome: 'done' | 'error' | 'cancelled' | 'interrupted', results: [string, boolean][]) => {
    const run = `r${++id}`;
    l.append('testrun.queued', { id: run, sha, kind: 'fast', prs: [7], shard: null }, 'alice');
    l.append('testrun.finished', { id: run, sha, kind: 'fast', prs: [7], ok: results.every(([, ok]) => ok), outcome, results: results.map(([tier, ok]) => ({ tier, ok })), detail: '' }, 'alice');
  };
  const queued = (sha: string) => l.append('testrun.queued', { id: `q${++id}`, sha, kind: 'fast', prs: [7], shard: null }, 'alice');
  return { finished, queued, events: (): StoredEvent[] => l.read(0, ['testrun.queued', 'testrun.finished']) };
}

const gh = (name: string, conclusion = 'success') => ({ name, source: 'check_run' as const, status: 'completed', conclusion });
const approved = { head: HEAD, approved: true };

test('No CI: the required checks are every test_run tier\'s check, as the test run names them; elsewhere required_checks', () => {
  assert.deepEqual(testRunCheckNames(tests), ['fast', 'test-run/suite']);
  assert.deepEqual(requiredFor(none, tests), ['fast', 'test-run/suite']);
  assert.deepEqual(requiredFor({ ci: 'github', required_checks: ['ci'] }, tests), ['ci']);
  assert.deepEqual(requiredFor({ required_checks: ['ci'] }, tests), ['ci'], 'absent: github');
});

test("No CI: a test-run check passes only from this instance's log, on exactly this head, with every one of its tiers passed", () => {
  const l = log();
  const ready = () => readiness({ required: ['fast'], checks: headChecks({ project: none, tests, github: [], events: l.events, sha: HEAD }), head: HEAD, evaluated: approved });
  assert.deepEqual(ready().reasons, ['fast: missing']);
  l.finished(OTHER, 'done', [['unit', true], ['lint', true]]);
  assert.deepEqual(ready().reasons, ['fast: missing'], 'another commit\'s run says nothing about this head');
  l.queued(HEAD);
  assert.deepEqual(ready().reasons, ['fast: pending'], 'a run on it, not finished: pending');
  l.finished(HEAD, 'done', [['unit', true], ['lint', false]]);
  assert.deepEqual(ready().reasons, ['fast: fail'], 'one of its tiers failed');
  l.finished(HEAD, 'cancelled', [['unit', true], ['lint', true]]);
  assert.deepEqual(ready().reasons, ['fast: fail'], 'a cancelled run is no verdict');
  l.finished(HEAD, 'done', [['unit', true], ['lint', true]]);
  assert.equal(ready().ready, true, 'its latest run on this head passed every tier');
  l.finished(HEAD, 'error', [['unit', true], ['lint', true]]);
  assert.deepEqual(ready().reasons, ['fast: fail'], 'a run whose setup failed fails its tiers');
});

test('No CI: a GitHub check named like a test-run check counts for nothing, passing or failing; other GitHub checks are left as they are', () => {
  const l = log();
  const spoof = [gh('fast'), gh('test-run/suite'), gh('lint-bot', 'failure')];
  const judged = headChecks({ project: none, tests, github: spoof, events: l.events, sha: HEAD });
  assert.deepEqual(judged, [gh('lint-bot', 'failure')], 'the same-named GitHub checks are gone');
  const r = readiness({ required: requiredFor(none, tests), checks: judged, head: HEAD, evaluated: approved });
  assert.equal(r.ready, false);
  assert.deepEqual(r.reasons, ['fast: missing', 'test-run/suite: missing']);
  // And a red one on GitHub can't block a green local run either: GitHub runs nothing a PR waits on.
  l.finished(HEAD, 'done', [['unit', true], ['lint', true], ['suite', true]]);
  const green = readiness({ required: requiredFor(none, tests), checks: headChecks({ project: none, tests, github: [gh('fast', 'failure')], events: l.events, sha: HEAD }), head: HEAD, evaluated: approved });
  assert.equal(green.ready, true, green.reasons.join('; '));
  // ci: github: GitHub's checks as they are, the log never read.
  let read = 0;
  assert.deepEqual(headChecks({ project: { ci: 'github' }, tests, github: spoof, events: () => (read++, []), sha: HEAD }), spoof);
  assert.equal(read, 0);
});

test('No CI: the evaluator still decides; a passed test run alone is never ready', () => {
  const l = log();
  l.finished(HEAD, 'done', [['unit', true], ['lint', true]]);
  const checks = headChecks({ project: none, tests, github: [], events: l.events, sha: HEAD });
  assert.deepEqual(readiness({ required: ['fast'], checks, head: HEAD, evaluated: null }).reasons, ['no evaluator verdict']);
  assert.match(readiness({ required: ['fast'], checks, head: HEAD, evaluated: { head: OTHER, approved: true } }).reasons.join(), /is not the commit the evaluator approved/);
  assert.match(readiness({ required: ['fast'], checks, head: HEAD, evaluated: { head: HEAD, approved: false } }).reasons.join(), /did not approve/);
  assert.equal(localRunChecks(l.events(), HEAD, { test_run: undefined }).length, 0, 'no test_run: no checks at all');
});

const configFile = (dir: string, f = 'config.yaml') => join(dir, BRAND.configDir, f);
const edit = (dir: string, f: string, change: (t: string) => string) => writeFileSync(configFile(dir, f), change(readFileSync(configFile(dir, f), 'utf8')));
const TEST_RUN = 'test_run:\n  tiers:\n    - { name: unit, command: "npm test", kind: fast }\n';

test('ci: none is refused without tests.yaml test_run (the fix: the starter CI), and with required_checks; with test_run it loads and is a choice', () => {
  const bare = exampleProject().dir;
  edit(bare, 'config.yaml', (t) => `${t}\nci: none\n`);
  assert.throws(() => loadConfig(bare), (e: unknown) => e instanceof ConfigInvalid && /config\.yaml.*ci.*judges PRs by this machine's test runs.*add the starter CI/s.test((e as Error).message));
  const both = exampleProject().dir;
  edit(both, 'config.yaml', (t) => `${t}\nci: none\nrequired_checks: [ci]\n`);
  edit(both, 'tests.yaml', (t) => `${t}\n${TEST_RUN}`);
  assert.throws(() => loadConfig(both), /ci: none takes no required_checks/);
  const ok = exampleProject().dir;
  edit(ok, 'config.yaml', (t) => `${t}\nci: none\n`);
  edit(ok, 'tests.yaml', (t) => `${t}\n${TEST_RUN}`);
  const cfg = loadConfig(ok);
  assert.equal(cfg.project.ci, 'none');
  assert.equal(ciChoiceProblem(cfg.project), null, 'an explicit choice: no config problem');
  assert.deepEqual(requiredFor(cfg.project, cfg.tests), ['test-run/unit']);
  // A config without the key loads as before (github).
  assert.equal(loadConfig(exampleProject().dir).project.ci, undefined);
});

test("the coordinator under No CI: ready only on its own log's test run of the exact head, never on GitHub's same-named check; the main watch says what No CI means", () => {
  const f = fixture();
  f.cfg.project.land_mode = 'pr';
  f.cfg.project.ci = 'none';
  f.cfg.tests.test_run = tests.test_run;
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { prPollMs: 0 });
  f.log.append('eval.verdict', { issue: 1, head: HEAD, patch_hash: 'x', patch_correct: true, test_correct: true, confidence: 'high', advice: '' }, 'alice');
  const spoof = [gh('fast'), gh('test-run/suite')];
  const r1 = c.prReadiness(1, HEAD, spoof);
  assert.equal(r1.ready, false);
  assert.deepEqual(r1.reasons, ['fast: missing', 'test-run/suite: missing']);
  f.log.append('testrun.finished', { id: 'r1', sha: HEAD, kind: 'fast', prs: [1], ok: true, outcome: 'done', results: [{ tier: 'unit', ok: true }, { tier: 'lint', ok: true }], detail: '' }, 'alice');
  // Batching's except (the full checks come from the batch), as the PR watch passes it.
  assert.equal(c.prReadiness(1, HEAD, [], ['test-run/suite']).ready, true);
  assert.deepEqual(c.prReadiness(1, HEAD, []).reasons, ['test-run/suite: missing'], 'the full tier is still required outside a batch');
  assert.match(CI_NONE_MAIN_WATCH, /main watch can't judge merges by checks/);
});

test('the main watch is off under No CI, and says what that means', async () => {
  const { MainWatch } = await import('../src/main-watch.js');
  const modes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'mw-'));
  const w = new MainWatch({ stateFile: join(dir, 'main-watch.json'), branch: 'main', required: () => [], offWhy: () => CI_NONE_MAIN_WATCH, api: { protection: async () => 'none' } as never, git: {} as never, harnessMerge: () => null, mode: (mode: string, detail: string) => void modes.push(`${mode}: ${detail}`) } as never);
  await (w as unknown as { step: () => Promise<void> }).step();
  assert.deepEqual(modes, [`off: ${CI_NONE_MAIN_WATCH}`]);
});

test('the event log the No CI tiers are read from is out of the agent user\'s reach, as the setup scripts make it (the CI job add-project (real systemd) proves it on a real host)', () => {
  const read = (f: string) => readFileSync(join(repoRoot, 'scripts', 'setup', f), 'utf8');
  // The coordinator's home, which holds its instance state and events.db: 0700, its own.
  assert.match(read('lib.sh'), /ensure_user\(\) \{[\s\S]*?chmod 0700 "\$\(home_of "\$1"\)"/);
  const instance = read('instance.sh');
  assert.match(instance, /coord="wl-\$name" agent="wl-\$name-agent"/);
  // The agent shares the work group with the coordinator, never the coordinator's own group.
  assert.doesNotMatch(instance, /ensure_member "\$agent" "\$coord"|ensure_member "\$\{?agent\}?" "wl-\$name"\s/);
  // The coordinator's service writes as its own user and group, nobody else's.
  const service = read('service.sh');
  assert.match(service, /^User=\$coord$/m);
  assert.match(service, /^Group=\$coord$/m);
  assert.match(service, /^UMask=0007$/m);
  // No setup script grants the agent user or the work group any ACL anywhere.
  for (const f of ['add-project.sh', 'dashboards.sh', 'dashboard.sh', 'instance.sh', 'service.sh', 'credentials.sh', 'checkout.sh', 'machine.sh']) {
    for (const line of read(f).split('\n').filter((l) => /setfacl -m/.test(l))) assert.doesNotMatch(line, /\$agent|-agent|\$work|-work/, `${f}: ${line.trim()}`);
  }
});
