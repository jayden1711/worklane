import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

const guard = (await import(pathToFileURL(join(repoRoot, 'scripts', 'ci', 'self-hosted-guard.mjs')).href)) as {
  workflowProblems: (text: string) => string[];
  guardProblem: (expr: string) => string | null;
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

// The jobs this repo sends to its own self-hosted runner (docs/ci-runners.md): trusted pushes to main only, behind
// the CI_SELF_HOSTED switch, falling back to GitHub's runners for everything else. That runner has no root, no
// Chrome, no gh or jq, no secrets, and refuses loopback (so nothing a job serves on 127.0.0.1 itself, and no Docker
// port): a job that needs any of these would fail or, worse, skip proof there, so it stays on GitHub. The test
// shards (real Chrome, local servers), desktop (apt as root) and the slow real-systemd jobs are never routed.
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
});
