// lint-test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

const guard = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'self-hosted-guard.mjs')).href)) as {
  workflowProblems: (text: string) => string[];
  guardProblem: (expr: string, opts?: { pullRequests?: boolean }) => string | null;
};

const G = "github.repository == 'example-org/example-shop' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'";
const wf = (job: string) => `on: [push, pull_request, workflow_dispatch]\njobs:\n  j:\n${job.replace(/^/gm, '    ')}\n    steps: [{ run: 'true' }]\n`;

test('every workflow here reaches GitHub-hosted runners only, or a self-hosted one only for trusted runs', () => {
  const dir = join(repoRoot, '.github', 'workflows');
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) assert.deepEqual(guard.workflowProblems(readFileSync(join(dir, f), 'utf8')), [], f);
});

test('the guard check: GitHub-hosted labels pass; self-hosted ones, or any other label, only behind a trusted-only guard', () => {
  const ok = [
    'runs-on: ubuntu-latest',
    'runs-on: [ubuntu-24.04]',
    "runs-on: ${{ matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest, macos-latest] } }",
    "runs-on: ${{ matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest], include: [{ os: windows-latest }] } }",
    `runs-on: \${{ ${G} && fromJSON('["self-hosted","box"]') || 'ubuntu-latest' }}`,
    `runs-on: \${{ vars.CI_SELF_HOSTED == 'box' && matrix.os == 'ubuntu-latest' && ${G} && fromJSON('["self-hosted","box"]') || matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest, macos-latest] } }`,
    `runs-on: [self-hosted, box]\nif: \${{ ${G} }}`,
    `runs-on: [self-hosted, box]\nif: ${G.replace('workflow_dispatch', 'push')}`,
    `runs-on: [self-hosted, box]\nif: github.repository_id == '123456' && github.ref == 'refs/heads/main' && github.event_name == 'schedule'`,
    "uses: ./.github/workflows/other.yml",
  ];
  for (const job of ok) assert.deepEqual(guard.workflowProblems(wf(job)), [], job);

  const bad: [string, RegExp][] = [
    // Unguarded: the self-hosted label, or any label a self-hosted runner carries.
    ['runs-on: [self-hosted, box]', /no if: guard/],
    ['runs-on: self-hosted', /no if: guard/],
    ['runs-on: box', /no if: guard/],
    ['runs-on: [linux, x64]', /no if: guard/],
    ['runs-on: { group: ci }', /no if: guard/],
    ["runs-on: ${{ matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest, box] } }", /matrix\.os has a value that isn't a GitHub-hosted label/],
    ["runs-on: ${{ matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest], include: [{ os: [self-hosted, box] }] } }", /matrix\.os has a value/],
    ["runs-on: ${{ vars.RUNNER }}", /an expression this check can't prove/],
    ["runs-on: ${{ github.event_name == 'push' && 'self-hosted' || 'ubuntu-latest' }}", /an expression this check can't prove/],
    // Guards that aren't: something missing, or a disjunction or negation that lets a pull request through.
    [`runs-on: [self-hosted, box]\nif: github.ref == 'refs/heads/main' && github.event_name == 'push'`, /github\.repository ==/],
    [`runs-on: [self-hosted, box]\nif: github.repository_id == 'x' && github.ref == 'refs/heads/main' && github.event_name == 'push'`, /github\.repository ==/],
    [`runs-on: [self-hosted, box]\nif: github.repository != 'a/b' && github.ref == 'refs/heads/main' && github.event_name == 'push'`, /github\.repository ==/],
    [`runs-on: [self-hosted, box]\nif: github.repository == 'a/b' && github.event_name == 'push'`, /github\.ref == 'refs\/heads/],
    [`runs-on: [self-hosted, box]\nif: github.repository == 'a/b' && github.ref == 'refs/heads/main'`, /github\.event_name ==/],
    [`runs-on: [self-hosted, box]\nif: github.repository == 'a/b' && github.ref == 'refs/heads/main' && github.event_name == 'pull_request'`, /github\.event_name ==/],
    [`runs-on: [self-hosted, box]\nif: ${G} || github.event_name == 'pull_request'`, /no \|\|/],
    [`runs-on: [self-hosted, box]\nif: \${{ !(github.event_name == 'pull_request') && ${G} }}`, /no \|\|, no !/],
    [`runs-on: [self-hosted, box]\nif: \${{ always() && ${G} }}`, /no parentheses/],
    [`runs-on: [self-hosted, box]\nif: ${G} && github.ref == 'refs/heads/other'`, /github\.ref == 'refs\/heads/],
    [`runs-on: \${{ ${G} && fromJSON('["box"]') || 'ubuntu-latest' }}`, /must name the self-hosted label/],
    [`runs-on: \${{ ${G} && fromJSON('["self-hosted","box"]') || 'self-hosted' }}`, /the fallback/],
    [`runs-on: \${{ ${G} && fromJSON('["self-hosted","box"]') || matrix.os }}\nstrategy: { matrix: { os: [ubuntu-latest, box] } }`, /the fallback/],
    [`runs-on: \${{ github.ref == 'refs/heads/main' && fromJSON('["self-hosted"]') || 'ubuntu-latest' }}`, /github\.repository ==/],
    // No secrets on a self-hosted job.
    [`runs-on: [self-hosted, box]\nif: ${G}\nenv: { T: '\${{ secrets.DEPLOY_KEY }}' }`, /may not use secrets/],
    [`runs-on: ubuntu-latest\nstrategy: { matrix: { label: [self-hosted] } }`, /matrix\.label: names self-hosted/],
  ];
  for (const [job, why] of bad) {
    const p = guard.workflowProblems(wf(job));
    assert.ok(p.some((x) => why.test(x)), `${job}\n  expected ${why}, got ${JSON.stringify(p)}`);
  }
  // A GitHub-hosted job may use secrets as before.
  assert.deepEqual(guard.workflowProblems(wf("runs-on: ubuntu-latest\nenv: { T: '${{ secrets.X }}' }")), []);
});

test('the guard check: a same-repo pull request guard, in the runs-on form only, never a fork\'s', () => {
  const R = "github.repository_id == '123456' && github.event_name == 'pull_request' && github.base_ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository";
  const P = "github.repository_id == '123456' && github.ref == 'refs/heads/main' && github.event_name == 'push'";
  const L = `fromJSON('["self-hosted","tests"]')`;
  const ok = [
    `runs-on: \${{ ${R} && ${L} || 'ubuntu-latest' }}`,
    `runs-on: \${{ ${P} && ${L} || ${R} && ${L} || 'ubuntu-24.04' }}`,
    `runs-on: \${{ vars.X == 'on' && ${P} && ${L} || vars.X == 'on' && ${R} && ${L} || 'ubuntu-24.04' }}`,
  ];
  for (const job of ok) assert.deepEqual(guard.workflowProblems(wf(job)), [], job);
  const bad: [string, RegExp][] = [
    // The head term is what keeps a fork's pull request out.
    [`runs-on: \${{ ${R.replace(' && github.event.pull_request.head.repo.full_name == github.repository', '')} && ${L} || 'ubuntu-latest' }}`, /needs github\.event\.pull_request\.head\.repo\.full_name == github\.repository/],
    [`runs-on: \${{ ${R.replace('== github.repository', "== 'someone/fork'")} && ${L} || 'ubuntu-latest' }}`, /needs github\.event\.pull_request\.head\.repo\.full_name == github\.repository/],
    [`runs-on: \${{ ${R.replace('== github.repository', '!= github.repository')} && ${L} || 'ubuntu-latest' }}`, /is not a <context\.path> == '<literal>' term/],
    [`runs-on: \${{ ${R.replace('head.repo', 'base.repo')} && ${L} || 'ubuntu-latest' }}`, /is not a <context\.path> == '<literal>' term/],
    [`runs-on: \${{ ${R.replace("github.base_ref == 'main' && ", '')} && ${L} || 'ubuntu-latest' }}`, /github\.base_ref == '<branch>'/],
    [`runs-on: \${{ ${R.replace("github.repository_id == '123456' && ", '')} && ${L} || 'ubuntu-latest' }}`, /github\.repository ==/],
    [`runs-on: \${{ ${R.replace("'pull_request'", "'pull_request_target'")} && ${L} || 'ubuntu-latest' }}`, /belongs in a pull request guard/],
    [`runs-on: \${{ ${R} && github.ref == 'refs/heads/main' && ${L} || 'ubuntu-latest' }}`, /by github\.base_ref, not github\.ref/],
    // Each alternative is checked on its own; a bad one isn't excused by a good one.
    [`runs-on: \${{ ${P} && ${L} || github.event_name == 'pull_request' && ${L} || 'ubuntu-latest' }}`, /github\.repository ==/],
    [`runs-on: \${{ ${P} && ${L} || ${R} && 'self-hosted' || 'ubuntu-latest' }}`, /an expression this check can't prove/],
    [`runs-on: \${{ ${P} && ${L} || ${R} && ${L} }}`, /the fallback/],
    [`runs-on: \${{ ${P} && ${L} || ${R} && ${L} || 'self-hosted' }}`, /the fallback/],
    // Only in runs-on's guarded form: an if: guard stays a trusted-push one.
    [`runs-on: [self-hosted, tests]\nif: ${R}`, /is not a <context\.path> == '<literal>' term|github\.event_name ==/],
    [`runs-on: \${{ ${R} && ${L} || 'ubuntu-latest' }}\nenv: { T: '\${{ secrets.X }}' }`, /may not use secrets/],
  ];
  for (const [job, why] of bad) {
    const p = guard.workflowProblems(wf(job));
    assert.ok(p.some((x) => why.test(x)), `${job}\n  expected ${why}, got ${JSON.stringify(p)}`);
  }
});

// The jobs this repo sends to its own self-hosted runner (docs/ci-runners.md): trusted pushes to main only, behind
// the CI_SELF_HOSTED switch, falling back to GitHub's runners for everything else. That runner has no root, no
// Chrome, no gh or jq, no secrets, and refuses loopback (so nothing a job serves on 127.0.0.1 itself, and no Docker
// port): a job that needs any of these would fail or, worse, skip proof there, so it stays on GitHub. The test
// shards (real Chrome, local servers) and the slow real-systemd jobs are never routed.
// This repo's id (gh api repos/<owner>/<repo> --jq .id): a fork's copy never has it, and it survives a rename.
const REPO_ID = '1409507019';
const ROUTED: Record<string, string[]> = { 'ci.yml': ['agentshield', 'push-gate', 'denylist'], 'gitleaks.yml': ['scan'] };
const NEEDS_WHAT_THE_RUNNER_LACKS = /\bsecrets\.|\bsudo\b|apt-get|\bdocker\b|services:|container:|continue-on-error|CI_REQUIRE_WEB|chrom|\bgh (api|pr|run|release|variable)\b|\bjq\b|127\.0\.0\.1|localhost|build:web|node --test|npm (run )?test\b/i;

test('the routed jobs: exactly these, each behind the documented trusted-push guard, needing nothing that runner lacks', async () => {
  const { parse } = await import('yaml');
  // The runner's own label (docs/ci-runners.md, --label at install): one, the same on every routed job, never a
  // GitHub-hosted one.
  const labels = new Set<string>();
  const want = (label: string) => `\${{ vars.CI_SELF_HOSTED == 'on' && github.repository_id == '${REPO_ID}' && github.ref == 'refs/heads/main' && github.event_name == 'push' && fromJSON('["self-hosted","${label}"]') || 'ubuntu-latest' }}`;
  // The checks a merge and the engine updater require, by the names GitHub gives them.
  const required = (parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] }).required_checks;
  const dir = join(repoRoot, '.github', 'workflows');
  const found: Record<string, string[]> = {};
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const jobs = (parse(readFileSync(join(dir, f), 'utf8')) as { jobs: Record<string, Record<string, unknown>> }).jobs;
    for (const [id, job] of Object.entries(jobs)) {
      if (!/self-hosted/.test(JSON.stringify(job['runs-on'] ?? ''))) continue;
      // The tests runner's jobs: a runner of their own, held by the test below.
      if (String(job['runs-on']).includes(`"${TESTS_LABEL}"`)) continue;
      (found[f] ??= []).push(id);
      const label = /fromJSON\('\["self-hosted","([a-z0-9-]+)"\]'\)/.exec(String(job['runs-on']))?.[1] ?? '';
      labels.add(label);
      assert.equal(job['runs-on'], want(label), `${f} ${id}: runs-on is the documented guard with a GitHub-hosted fallback`);
      assert.equal(guard.guardProblem(want(label).replace(/^\$\{\{\s*|\s*&& fromJSON[\s\S]*$/g, '')), null, `${f} ${id}`);
      // Its check keeps its name (the job id, no name: of its own), and a required check stays required by that name.
      assert.equal(job.name, undefined, `${f} ${id}: no name: of its own, so the check is still called ${id}`);
      const hit = NEEDS_WHAT_THE_RUNNER_LACKS.exec(JSON.stringify({ ...job, 'runs-on': undefined }));
      assert.equal(hit, null, `${f} ${id} uses ${hit?.[0]}, which the self-hosted runner lacks or forbids: keep it on GitHub`);
      // Every tool it downloads is pinned and checked, and a download that fails fails the step (curl -f).
      const runs = JSON.stringify(job.steps);
      if (/curl /.test(runs)) assert.match(runs, /curl -sSfL[\s\S]*sha256sum -c -/, `${f} ${id}: a download is checked`);
    }
  }
  assert.deepEqual(found, ROUTED);
  assert.equal(labels.size, 1, `one runner label on every routed job: ${[...labels].join(', ')}`);
  assert.doesNotMatch([...labels][0] ?? '', /^$|^(ubuntu|windows|macos)-|^(self-hosted|linux|x64)$/i);
  for (const id of Object.values(ROUTED).flat()) assert.ok(required.includes(id), `${id} is a required check under that name`);
  assert.notEqual([...labels][0], TESTS_LABEL, 'the main-only runner and the tests runner never share a label');
});

// The test shards and their summaries go to a second runner of their own (docs/ci-runners.md, "The tests runner"):
// installed with --pull-requests same-repo, so it also takes pull requests into main from this repo's own branches,
// never a fork's. Behind a switch of its own (CI_SELF_HOSTED_TESTS), apart from CI_SELF_HOSTED, and a label of its
// own, so a main-only runner is never asked for a pull request's job. A shard runs there in a container (root
// inside it for its setup, a loopback of its own for its servers); a summary only reads its shards' result.
const TESTS_LABEL = 'trusted-tests';
const TESTS_ROUTED: Record<string, string> = { 'test-shard-22': 'ubuntu-24.04', 'test-shard-24': 'ubuntu-24.04', 'test-22': 'ubuntu-latest', 'test-24': 'ubuntu-latest' };

test('the tests runner\'s jobs: exactly the shards and their summaries, behind its own switch, pushes to main and same-repo pull requests only', async () => {
  const { parse } = await import('yaml');
  const push = `vars.CI_SELF_HOSTED_TESTS == 'on' && github.repository_id == '${REPO_ID}' && github.ref == 'refs/heads/main' && github.event_name == 'push'`;
  const pr = `vars.CI_SELF_HOSTED_TESTS == 'on' && github.repository_id == '${REPO_ID}' && github.event_name == 'pull_request' && github.base_ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository`;
  const labels = `fromJSON('["self-hosted","${TESTS_LABEL}"]')`;
  const want = (fallback: string) => `\${{ ${push} && ${labels} || ${pr} && ${labels} || '${fallback}' }}`;
  for (const g of [push, pr]) assert.equal(guard.guardProblem(g, { pullRequests: true }), null, g);
  // A fork's pull request fails the pull request guard's own check without the head term.
  assert.notEqual(guard.guardProblem(pr.replace(/ && github\.event\.pull_request[\s\S]*$/, ''), { pullRequests: true }), null);
  const required = (parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] }).required_checks;
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as { jobs: Record<string, Record<string, unknown>> };
  const found: string[] = [];
  for (const f of readdirSync(join(repoRoot, '.github', 'workflows')).filter((x) => /\.ya?ml$/.test(x))) {
    const jobs = (parse(readFileSync(join(repoRoot, '.github', 'workflows', f), 'utf8')) as { jobs: Record<string, Record<string, unknown>> }).jobs;
    for (const [id, job] of Object.entries(jobs)) if (JSON.stringify(job).includes(TESTS_LABEL) || JSON.stringify(job).includes('CI_SELF_HOSTED_TESTS')) found.push(`${f} ${id}`);
  }
  assert.deepEqual(found.sort(), Object.keys(TESTS_ROUTED).map((id) => `ci.yml ${id}`).sort());
  for (const [id, fallback] of Object.entries(TESTS_ROUTED)) {
    const job = wf.jobs[id]!;
    assert.equal(job['runs-on'], want(fallback), `${id}: runs-on is the tests runner's two guards with GitHub's fallback`);
    assert.doesNotMatch(JSON.stringify(job), /\bsecrets\.|services:|continue-on-error/, `${id}: no secrets, services or ignored failures`);
    // Every tool it downloads is pinned and checked, and a download that fails fails the step (curl -f).
    for (const s of (job.steps ?? []) as { run?: string }[]) if (/curl /.test(s.run ?? '')) assert.match(s.run!, /curl -sSfL[\s\S]*sha256sum -c -/, `${id}: a download is checked`);
  }
  // The required checks keep their names: the summaries' names, the shards' none of the required list's.
  for (const n of ['22', '24']) {
    assert.equal(wf.jobs[`test-${n}`]!.name, `test (ubuntu-latest, ${n})`);
    assert.ok(required.includes(`test (ubuntu-latest, ${n})`), `test (ubuntu-latest, ${n}) is still required`);
  }
  // A shard runs in the container on the tests runner and nowhere else: the same guards, then no container.
  const image = /"image":"(buildpack-deps:noble-scm@sha256:[0-9a-f]{64})"/;
  for (const id of ['test-shard-22', 'test-shard-24']) {
    const c = String(wf.jobs[id]!.container);
    const m = /^\$\{\{ ([\s\S]+?) && fromJSON\('(\{[^']*\})'\) \|\| ([\s\S]+?) && fromJSON\('(\{[^']*\})'\) \|\| '' \}\}$/.exec(c);
    assert.ok(m, `${id}: container is the two guards, then none: ${c}`);
    assert.equal(m[1], push, id);
    assert.equal(m[3], pr, id);
    assert.equal(m[2], m[4], `${id}: the same container for pushes and pull requests`);
    assert.match(m[2]!, image, `${id}: an official image, pinned by digest`);
  }
  // The summaries only read a result: no container, no checkout, no code of the pull request's.
  for (const id of ['test-22', 'test-24']) {
    const job = wf.jobs[id]!;
    assert.equal(job.container, undefined, id);
    assert.doesNotMatch(JSON.stringify(job.steps), /"uses"/, `${id}: no actions, no checkout`);
  }
});
