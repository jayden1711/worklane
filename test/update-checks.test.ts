import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');

/** The default list as lib.sh declares it, read from the text (no bash needed). */
function defaults(): string[] {
  const m = readFileSync(lib, 'utf8').match(/^UPDATE_DEFAULT_CHECKS=\((.*)\)$/m);
  assert.ok(m, 'lib.sh declares UPDATE_DEFAULT_CHECKS');
  return [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

type Step = { run?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; needs?: string | string[]; strategy?: { matrix?: Record<string, unknown[]> }; steps?: Step[] };
/** both: every PR and every push to main. pr-only: never on main. main-only: every push to main, a PR only sometimes. */
type Tier = 'both' | 'pr-only' | 'main-only';
type Check = { name: string; key: string; tier: Tier; push: boolean; pr: boolean };

const PR_ONLY = /^github\.event_name == 'pull_request'$/;
/** Always on a push; on a PR only when the scope job says so (what the PR touches, or the full-ci label). */
const MAIN_ONLY = /^\$\{\{ !cancelled\(\) && \(github\.event_name == 'push' \|\| needs\.scope\.outputs\.[a-z]+ == 'true'\) \}\}$/;
/** A summary job runs whatever its needs did, so a failed, cancelled or skipped need fails it rather than skipping it. */
const ALWAYS = /^\$\{\{ always\(\) \}\}$/;
/** ci.yml's PR-only helper that picks the main-only jobs a PR runs: not a check anything requires. */
const HELPERS = ['scope'];
/**
 * ci.yml's unit test shards, each with the summary job that gates them. The shards are left out of the updater's
 * list and the required checks on purpose: the summary, under the required name test (ubuntu-latest, <node>), is
 * green only when all of its shards are, so requiring the shards as well would add names to keep in step and no gate.
 */
const SHARDS: Record<string, string> = { 'test-shard-22': 'test-22', 'test-shard-24': 'test-24' };

function tier(file: string, key: string, job: Job): Tier {
  if (!job.if) return 'both';
  if (PR_ONLY.test(job.if)) return 'pr-only';
  if (MAIN_ONLY.test(job.if)) {
    assert.ok(([] as string[]).concat(job.needs ?? []).includes('scope'), `${file} ${key}: a main-only job needs the scope job`);
    return 'main-only';
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
    const push = Array.isArray(on) ? on.includes('push') : on && 'push' in on ? (on.push?.branches ?? ['main']).includes('main') : false;
    const pr = Array.isArray(on) ? on.includes('pull_request') : !!on && 'pull_request' in on;
    for (const [key, job] of Object.entries(wf.jobs ?? {})) {
      if (HELPERS.includes(key)) continue;
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
        out.push({ name: named, key, tier: t, push: !!push, pr });
      }
    }
  }
  return out;
}

/** Every check run a push to main creates, but the shards (their summary jobs gate them). */
const pushChecks = () => checks().filter((c) => c.push && c.tier !== 'pr-only' && !(c.key in SHARDS)).map((c) => c.name).sort();
/** Every check run every pull request creates, but the shards (their summary jobs gate them). */
const prChecks = () => checks().filter((c) => c.pr && c.tier !== 'main-only' && !(c.key in SHARDS)).map((c) => c.name).sort();

const MAIN_ONLY_CHECKS = ['bootstrap (macos-latest)', 'bootstrap (ubuntu-latest)', 'bootstrap (windows-wsl)', 'test-run sandbox (real systemd)', 'add-project (real systemd)', 'Claude sign-in probe (real users)'];

test('the updater\'s default required checks are exactly the checks a push to main runs (no PR-only ones)', () => {
  assert.deepEqual([...defaults()].sort(), pushChecks());
  assert.ok(!defaults().includes('dco'), 'dco runs on pull requests only, so on main it is always skipped');
  for (const x of MAIN_ONLY_CHECKS) {
    assert.equal(checks().find((c) => c.name === x)?.tier, 'main-only', `${x} runs on every push to main, on a PR only when it touches what it tests`);
    assert.ok(defaults().includes(x), `${x} gates the updater: a PR may not have run it`);
  }
});

test('the engine repo requires to merge exactly the checks every pull request runs, never a main-only one a PR may skip', () => {
  const cfg = parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] };
  assert.deepEqual([...cfg.required_checks].sort(), prChecks());
  for (const x of ['dco', 'scan', 'desktop', 'test (ubuntu-latest, 22)']) assert.ok(prChecks().includes(x), x);
  for (const x of MAIN_ONLY_CHECKS) assert.ok(!prChecks().includes(x), x);
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
