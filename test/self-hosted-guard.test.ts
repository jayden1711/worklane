import './isolate.js';
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
