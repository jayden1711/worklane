import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

const batch = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'batch.mjs')).href)) as { SLOW_JOBS: Record<string, string[]>; SLOW_WORKFLOW: string };

const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');

/** The default list as lib.sh declares it, read from the text (no bash needed). */
function defaults(): string[] {
  const m = readFileSync(lib, 'utf8').match(/^UPDATE_DEFAULT_CHECKS=\((.*)\)$/m);
  assert.ok(m, 'lib.sh declares UPDATE_DEFAULT_CHECKS');
  return [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

/** A branch filter pattern (GitHub's glob: `*` within a path segment, `**` across them) matching a branch name. */
const branchMatches = (pattern: string, branch: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.')}$`).test(branch);

type PushFilter = { branches?: string[]; 'branches-ignore'?: string[]; tags?: string[]; 'tags-ignore'?: string[] } | null;

/**
 * Whether a workflow's `on:` runs it on a push to `branch`. A bare `push` runs on every branch; a push with tag
 * filters and no branch filter runs on those tags only, never a branch; otherwise branches / branches-ignore decide.
 */
function pushRunsOn(on: unknown, branch = 'main'): boolean {
  if (on === 'push') return true;
  if (Array.isArray(on)) return on.includes('push');
  if (!on || typeof on !== 'object' || !('push' in on)) return false;
  const push = (on as { push: PushFilter }).push;
  if (!push) return true;
  if (push.branches) return push.branches.filter((p) => !p.startsWith('!')).some((p) => branchMatches(p, branch)) && !push.branches.filter((p) => p.startsWith('!')).some((p) => branchMatches(p.slice(1), branch));
  if (push['branches-ignore']) return !push['branches-ignore'].some((p) => branchMatches(p, branch));
  return !(push.tags || push['tags-ignore']);
}

test('which push triggers run on a push to main', () => {
  assert.equal(pushRunsOn('push'), true);
  assert.equal(pushRunsOn(['push', 'pull_request']), true);
  assert.equal(pushRunsOn({ push: null }), true);
  assert.equal(pushRunsOn({ push: { branches: ['main'] } }), true);
  assert.equal(pushRunsOn({ push: { branches: ['release/*'] } }), false);
  assert.equal(pushRunsOn({ push: { branches: ['**'] } }), true);
  assert.equal(pushRunsOn({ push: { branches: ['*', '!main'] } }), false);
  assert.equal(pushRunsOn({ push: { 'branches-ignore': ['main'] } }), false);
  assert.equal(pushRunsOn({ push: { 'branches-ignore': ['dependabot/**'] } }), true);
  assert.equal(pushRunsOn({ push: { paths: ['src/**'] } }), true);
  // Tags only: a tag push, never a branch push.
  assert.equal(pushRunsOn({ push: { tags: ['v*'] }, workflow_dispatch: null }), false);
  assert.equal(pushRunsOn({ push: { 'tags-ignore': ['v*'] } }), false);
  // Tags and branches: the branch filter decides.
  assert.equal(pushRunsOn({ push: { tags: ['v*'], branches: ['main'] } }), true);
  assert.equal(pushRunsOn({ pull_request: null }), false);
});

type Step = { run?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: string | string[]; strategy?: { matrix?: Record<string, unknown[]> }; steps?: Step[] };
/**
 * both: every PR and every run of its workflow on main. pr-only: never on main. slow: a ci-slow.yml job, run when
 * the scope job lists its key: every job in each batch on main (a dispatch with job=all), on a PR only sometimes.
 */
type Tier = 'both' | 'pr-only' | 'slow';
/** push: every push to main runs it. batch: each batch on main does (ci-slow.yml, dispatched on main by ci-batch.yml). */
type Check = { name: string; key: string; file: string; tier: Tier; push: boolean; batch: boolean; pr: boolean };

const PR_ONLY = /^github\.event_name == 'pull_request'$/;
/** ci-slow.yml's jobs: each runs when the scope job (scripts/ci/slow-jobs.sh) lists its own key. */
const SLOW = /^\$\{\{ !cancelled\(\) && contains\(needs\.scope\.outputs\.run, ' ([a-z0-9-]+) '\) \}\}$/;
/** A summary job runs whatever its needs did, so a failed, cancelled or skipped need fails it rather than skipping it. */
const ALWAYS = /^\$\{\{ always\(\) \}\}$/;
/**
 * Not checks anything requires: ci-slow.yml's scope job (which slow jobs a run runs) and ci-batch.yml's own run
 * (it starts the batches; its check lands on main's tip and never fails, scripts/ci/batch.mjs).
 */
const HELPERS: Record<string, string> = { 'ci-slow.yml': 'scope', 'ci-batch.yml': 'batch' };
/**
 * ci.yml's unit test shards, each with the summary job that gates them. The shards are left out of the updater's
 * list and the required checks on purpose: the summary, under the required name test (ubuntu-latest, <node>), is
 * green only when all of its shards are, so requiring the shards as well would add names to keep in step and no gate.
 */
const SHARDS: Record<string, string> = { 'test-shard-22': 'test-22', 'test-shard-24': 'test-24' };

function tier(file: string, key: string, job: Job): Tier {
  if (!job.if) return 'both';
  if (PR_ONLY.test(job.if)) return 'pr-only';
  const slow = SLOW.exec(job.if);
  if (slow) {
    assert.equal(file, batch.SLOW_WORKFLOW, `${file} ${key}: the slow jobs are ci-slow.yml's, the workflow a batch runs`);
    assert.equal(slow[1], key, `${file} ${key}: runs when the scope job lists its own key`);
    assert.deepEqual(([] as string[]).concat(job.needs ?? []), ['scope'], `${file} ${key}: a slow job needs the scope job`);
    return 'slow';
  }
  if (ALWAYS.test(job.if)) {
    assert.ok(Object.values(SHARDS).includes(key), `${file} ${key}: always() is for the shard summary jobs only`);
    return 'both';
  }
  return assert.fail(`${file} ${key}: an if: this test doesn't know (${job.if}); say whether it runs on main and on PRs`);
}

/**
 * Every check run the workflows create, with when: job names, matrix jobs expanded as GitHub names them (the values
 * appended, unless the name uses matrix expressions itself).
 */
function checks(): Check[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const out: Check[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')) as { on?: unknown; jobs?: Record<string, Job> };
    const on = wf.on as Record<string, { branches?: string[] } | null> | string[] | undefined;
    const push = pushRunsOn(wf.on);
    // Every pull request: a pull_request trigger without a paths filter (one with paths runs on some PRs only).
    const prOn = Array.isArray(on) ? on.includes('pull_request') : !!on && 'pull_request' in on;
    const prFilter = !Array.isArray(on) && on && typeof on === 'object' ? (on as Record<string, { paths?: string[] } | null>).pull_request : null;
    const pr = prOn && !prFilter?.paths;
    // A batch: the workflow ci-batch.yml dispatches on main (test/ci-batch.test.ts: only ever on the default branch).
    const batched = f === batch.SLOW_WORKFLOW && !Array.isArray(on) && !!on && 'workflow_dispatch' in on;
    // A workflow that runs neither on a push to main, nor on every PR, nor as a batch (tags only, paths-filtered PRs,
    // ci-batch.yml's schedule) creates no check any of the lists holds.
    if (!push && !pr && !batched) continue;
    for (const [key, job] of Object.entries(wf.jobs ?? {})) {
      if (HELPERS[f] === key) continue;
      const t = tier(f, key, job);
      const name = job.name ?? key;
      const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([k]) => k !== 'include' && k !== 'exclude');
      let combos: string[][] = [[]];
      for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, String(v)]));
      for (const c of combos) {
        const vars = Object.fromEntries(axes.map(([k], i) => [k, c[i]!]));
        const named = name.includes('${{')
          ? name.replace(/\$\{\{ matrix\.([a-z]+) \}\}/g, (_, k: string) => vars[k] ?? assert.fail(`${f} ${key}: no matrix.${k}`))
          : c.length ? `${name} (${c.join(', ')})` : name;
        assert.doesNotMatch(named, /\$\{\{/, `${f} ${key}: a name expression this test doesn't expand`);
        out.push({ name: named, key, file: f, tier: t, push: !!push && t !== 'slow', batch: batched && t !== 'pr-only', pr });
      }
    }
  }
  return out;
}

/** Every check run a push to main creates, but the shards (their summary jobs gate them). */
const pushChecks = () => checks().filter((c) => c.push && c.tier !== 'pr-only' && !(c.key in SHARDS)).map((c) => c.name).sort();
/** Every check run each batch on main creates (on main's newest commit, at most every 30 minutes). */
const batchChecks = () => checks().filter((c) => c.batch).map((c) => c.name).sort();
/** Every check run every pull request creates, but the shards (their summary jobs gate them). */
const prChecks = () => checks().filter((c) => c.pr && c.tier !== 'slow' && !(c.key in SHARDS)).map((c) => c.name).sort();

const SLOW_CHECKS = ['bootstrap (macos-latest)', 'bootstrap (ubuntu-latest)', 'bootstrap (windows-wsl)', 'test-run sandbox (real systemd)', 'add-project (real systemd)', 'Claude sign-in probe (real users)'];

test('the updater\'s default required checks are exactly what a batched main commit gets: every push\'s checks and the batch\'s', () => {
  assert.deepEqual([...defaults()].sort(), [...pushChecks(), ...batchChecks()].sort());
  assert.equal(defaults().length, 13);
  assert.deepEqual(batchChecks(), [...SLOW_CHECKS].sort(), 'a batch runs every slow job, and only those');
  for (const x of SLOW_CHECKS) {
    assert.ok(!pushChecks().includes(x), `${x}: not on every push to main, only in a batch`);
    assert.equal(checks().find((c) => c.name === x)?.tier, 'slow', `${x}: batched on main, on a PR only when it touches what it tests`);
    assert.ok(defaults().includes(x), `${x} gates the updater: a PR may not have run it`);
  }
  for (const x of pushChecks()) assert.ok(!batchChecks().includes(x), `${x}: one source of truth on a main commit`);
  assert.ok(!defaults().includes('dco'), 'dco runs on pull requests only, so on main it is always skipped');
  for (const [f, key] of Object.entries(HELPERS)) {
    const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', f), 'utf8')) as { jobs: Record<string, Job> };
    const name = wf.jobs[key]?.name ?? key;
    assert.ok(!defaults().includes(name), `${f} ${key}: a helper, not something the updater requires`);
  }
});

test('a batch runs every slow job: scope lists every slow job\'s key for a dispatch with job=all, one key for job=<key>', { skip: process.platform === 'win32' && 'bash' }, () => {
  const keys = [...new Set(checks().filter((c) => c.tier === 'slow').map((c) => c.key))].sort();
  assert.deepEqual(keys, Object.keys(batch.SLOW_JOBS).sort(), 'batch.mjs knows every slow job, by the key a dispatch names');
  for (const k of keys) assert.deepEqual(checks().filter((c) => c.key === k).map((c) => c.name).sort(), [...batch.SLOW_JOBS[k]!].sort(), `${k}: the check runs batch.mjs bisects`);
  const scope = (env: Record<string, string>) => {
    const r = spawnSync('bash', [join(repoRoot, 'scripts', 'ci', 'slow-jobs.sh')], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    const line = r.stdout.split('\n').find((l) => l.startsWith('run='));
    return { status: r.status, keys: line ? line.slice(4).trim().split(/\s+/).filter(Boolean).sort() : null, err: r.stderr };
  };
  assert.deepEqual(scope({ EVENT: 'workflow_dispatch', JOB: 'all', SHA: 'a'.repeat(40) }).keys, keys);
  assert.deepEqual(scope({ EVENT: 'workflow_dispatch', JOB: '', SHA: 'a'.repeat(40) }).keys, keys, 'no job given: all of them');
  for (const k of keys) assert.deepEqual(scope({ EVENT: 'workflow_dispatch', JOB: k, SHA: 'b'.repeat(40), WANT_SHA: 'b'.repeat(40) }).keys, [k]);
  const wrongSha = scope({ EVENT: 'workflow_dispatch', JOB: keys[0]!, SHA: 'b'.repeat(40), WANT_SHA: 'c'.repeat(40) });
  assert.equal(wrongSha.status, 1, 'a bisect step on another commit than it asked for runs nothing');
  assert.match(wrongSha.err, /asked to test c{40}, but this run is on b{40}/);
  assert.equal(scope({ EVENT: 'workflow_dispatch', JOB: 'nope', SHA: 'a'.repeat(40) }).status, 1);
  assert.equal(scope({ EVENT: 'push', SHA: 'a'.repeat(40) }).status, 1, 'never on a push');

  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', batch.SLOW_WORKFLOW), 'utf8')) as { on: { workflow_dispatch: { inputs: { job: { options: string[]; default: string } } } }; concurrency: Record<string, string> };
  assert.deepEqual(wf.on.workflow_dispatch.inputs.job.options, ['all', ...Object.keys(batch.SLOW_JOBS)], 'a dispatch can name all, or any one slow job');
  assert.equal(wf.on.workflow_dispatch.inputs.job.default, 'all');
  assert.match(wf.concurrency.group ?? '', /github\.ref \}\}$/, 'one batch at a time on main; each bisect branch its own group');
  assert.equal(wf.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}", 'a batch is never cancelled: the updater refuses a cancelled check');
});

test('ci-batch.yml looks whenever a ci.yml or ci-slow.yml run ends and every 30 minutes, and never fails its own check', () => {
  const slowName = (parse(readFileSync(join(repoRoot, '.github', 'workflows', batch.SLOW_WORKFLOW), 'utf8')) as { name: string }).name;
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci-batch.yml'), 'utf8')) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown; workflow_run: { workflows: string[]; types: string[] } };
    jobs: Record<string, Job & { permissions?: Record<string, string> }>;
  };
  assert.deepEqual(wf.on.schedule, [{ cron: '*/30 * * * *' }]);
  assert.ok('workflow_dispatch' in wf.on);
  assert.deepEqual(wf.on.workflow_run, { workflows: [slowName, 'ci'], types: ['completed'] });
  assert.deepEqual(Object.keys(wf.jobs), ['batch']);
  const run = (wf.jobs.batch!.steps ?? []).map((s) => s.run ?? '').join('\n');
  assert.match(run, /^node scripts\/ci\/batch\.mjs$/m);
  assert.deepEqual(wf.jobs.batch!.permissions, { actions: 'write', contents: 'write', issues: 'write', 'pull-requests': 'write' });
  assert.ok(!('on' in wf && 'push' in wf.on), 'not on a push');
});

test('the engine repo requires to merge exactly the checks every pull request runs, never a main-only one a PR may skip', () => {
  const cfg = parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] };
  assert.deepEqual([...cfg.required_checks].sort(), prChecks());
  for (const x of ['dco', 'scan', 'desktop', 'test (ubuntu-latest, 22)']) assert.ok(prChecks().includes(x), x);
  for (const x of SLOW_CHECKS) assert.ok(!prChecks().includes(x), x);
});

test('each Node version\'s 4 test shards gate through a summary job under the required name, and nothing requires a shard', () => {
  const jobs = (parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs;
  const cfg = parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] };
  const all = checks();
  for (const [shard, summary] of Object.entries(SHARDS)) {
    const node = String(jobs[shard]?.strategy?.matrix?.node);
    const names = all.filter((c) => c.key === shard).map((c) => c.name);
    assert.deepEqual(names, [1, 2, 3, 4].map((k) => `test shard ${k}/4 (ubuntu-latest, ${node})`), `${shard}: 4 shards, named apart from the required check`);
    const steps = jobs[shard]!.steps ?? [];
    const run = steps.map((s) => s.run ?? '').join('\n');
    assert.match(run, /node scripts\/ci\/shard\.mjs "\$SHARD\/4" --only "\$RUNNER_TEMP\/selected"/, `${shard}: each shard runs its share of the 4, of the selected files`);
    assert.match(run, /node --test "\$\{files\[@\]\}"/);
    // The selection: affected.mjs, told the event (a push to main gets every file), diffing the PR's merge commit
    // against its base; a shard with no selected file passes only on a pull request.
    const tests = steps.find((s) => /node --test/.test(s.run ?? ''))!;
    assert.equal(tests.env?.EVENT, '${{ github.event_name }}', `${shard}: the selection knows the event`);
    assert.match(tests.run!, /if \[ "\$FULL_CI" = true \]; then EVENT=full-ci; fi/, `${shard}: the full-ci label runs every file`);
    assert.equal(tests.env?.FULL_CI, "${{ contains(github.event.pull_request.labels.*.name, 'full-ci') }}");
    assert.match(tests.run!, /node scripts\/ci\/affected\.mjs --event "\$EVENT" --base HEAD\^1 --explain > "\$RUNNER_TEMP\/selected"\n[\s\S]*mapfile -t files < <\(node scripts\/ci\/shard\.mjs "\$SHARD\/4" --only "\$RUNNER_TEMP\/selected"\)/);
    assert.match(tests.run!, /\[ "\$\{#files\[@\]\}" -eq 0 \]; then\n\s+\[ "\$EVENT" = pull_request \] \|\| \{ echo "shard \$SHARD\/4 has no test files" >&2; exit 1; \}/, `${shard}: on main every shard has files`);
    const checkout = steps.find((s) => (s as { uses?: string }).uses?.startsWith('actions/checkout@')) as { with?: Record<string, unknown> } | undefined;
    assert.equal(checkout?.with?.['fetch-depth'], 2, `${shard}: the merge commit and its base (HEAD^1)`);
    for (const n of names) {
      assert.ok(!defaults().includes(n) && !cfg.required_checks.includes(n), `${n}: the summary gates it, nothing requires it`);
      assert.equal(all.filter((c) => c.name === n).length, 1, `${n}: one check by that name`);
    }

    const s = jobs[summary]!;
    const required = `test (ubuntu-latest, ${node})`;
    assert.equal(s.name, required, `${summary}: the name the ruleset, config.yaml and the updater require`);
    assert.deepEqual(([] as string[]).concat(s.needs ?? []), [shard], `${summary}: needs exactly its own shards`);
    assert.match(s.if ?? '', ALWAYS, `${summary}: runs when a shard failed, was cancelled or skipped, and fails then`);
    const step = (s.steps ?? []).find((x) => x.env?.RESULT);
    assert.equal(step?.env?.RESULT, `\${{ needs.${shard}.result }}`);
    assert.match(step?.run ?? '', /\[ "\$RESULT" = success \]/, `${summary}: green only on success, never on cancelled or skipped`);
    assert.ok(defaults().includes(required) && cfg.required_checks.includes(required) && prChecks().includes(required), required);
  }
});

test('check names with commas reach updates.json whole, never split', { skip: process.platform === 'win32' && 'bash' }, () => {
  const names = ['test (macos-latest, 22)', 'test (windows-latest, 24)', 'scan'];
  const r = spawnSync('bash', ['-c', 'source "$1"; shift; updates_config_json "$@"', '_', lib, 'https://example.invalid/r.git', ...names], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((JSON.parse(r.stdout) as { required_checks: string[] }).required_checks, names);
  const d = spawnSync('bash', ['-c', 'source "$1"; updates_config_json url "${UPDATE_DEFAULT_CHECKS[@]}"', '_', lib], { encoding: 'utf8' });
  assert.deepEqual((JSON.parse(d.stdout) as { required_checks: string[] }).required_checks, defaults());
});

test('updates.sh passes each check as its own argument and refuses the old comma-separated --checks', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  assert.doesNotMatch(s, /split\(","\)/);
  assert.match(s, /updates_config_json "\$origin" "\$\{checks\[@\]\}"/);
  assert.match(s, /--checks\) echo .*gone/);
});
