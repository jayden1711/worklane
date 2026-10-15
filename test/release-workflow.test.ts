// .github/workflows/release.yml: what keeps the npm release safe. Every action pinned by commit; no npm token or
// any secret; the OIDC token only for the publish job, which never runs on a pull request; CI only ever STAGES a
// version (`npm stage publish`, with provenance), which the owner approves on npmjs.com with 2FA: never a real
// `npm publish`, never `npm dist-tag`. It stages only on a v* tag with the repo variable NPM_PUBLISH set, behind the
// tag check (scripts/verify-release-tag.mjs) and the npm/Node version guards; a dry run otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
const text = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const wf = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; env: Record<string, string>; jobs: Record<string, Job> };
const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
const ver = (v: string) => v.split('.').map(Number) as [number, number, number];
const atLeast = (v: string, min: string) => {
  const [a, b, c] = ver(v);
  const [x, y, z] = ver(min);
  return a > x || (a === x && (b > y || (b === y && c >= z)));
};
const STAGE = 'npm stage publish "$tgz" --provenance';

test('release.yml: triggers, pins and no secrets', () => {
  assert.deepEqual((wf.on.push as { tags: string[] }).tags, ['v*']);
  assert.ok('workflow_dispatch' in wf.on);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const s of job.steps.filter((s) => s.uses)) assert.match(s.uses!, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${s.uses} pinned by commit`);
  }
  assert.doesNotMatch(text, /secrets\.|^\s*(NPM_TOKEN|NODE_AUTH_TOKEN): /m, 'no npm token, no secret');
  // A change to the tag check, the signers or the dry run proves itself on its pull request.
  const paths = (wf.on.pull_request as { paths: string[] }).paths;
  for (const p of ['.github/workflows/release.yml', '.github/release-signers', 'scripts/verify-release-tag.mjs', 'scripts/ci/npm-stage-dry-run.sh', 'test/verify-release-tag.test.ts']) assert.ok(paths.includes(p), p);
});

test('release.yml: only the publish job gets the OIDC token, never on a pull request, and stages for real only on a verified tag with NPM_PUBLISH', () => {
  for (const [name, job] of Object.entries(wf.jobs)) if (name !== 'publish') assert.equal(job.permissions?.['id-token'], undefined, name);
  const pub = wf.jobs.publish!;
  assert.equal(pub.permissions?.['id-token'], 'write');
  assert.equal(pub.if, "github.event_name != 'pull_request'");
  const i = pub.steps.findIndex((s) => s.run?.includes(STAGE));
  assert.ok(i >= 0, 'the publish job stages');
  const step = pub.steps[i]!;
  assert.equal(step.env?.REAL, "${{ vars.NPM_PUBLISH == 'true' && startsWith(github.ref, 'refs/tags/v') }}");
  assert.equal(step.env?.VERIFIED, '${{ steps.verify.outputs.commit }}');
  const [dry, real] = step.run!.split(/\n\s*fi\n/) as [string, string];
  assert.match(dry, /if \[ "\$REAL" != true \]; then[\s\S]*bash scripts\/ci\/npm-stage-dry-run\.sh "\$tgz"[\s\S]*exit 0$/);
  // The real path: the tag check passed for this commit, OIDC only, then staged (never published).
  assert.match(real, /^\s*# Only behind the tag check[^\n]*\n\s*\[ "\$VERIFIED" = "\$GITHUB_SHA" \] \|\| \{[^\n]*exit 1; \}\n/);
  assert.match(real, /\[ -n "\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}" \] \|\| \{[^\n]*exit 1; \}/);
  assert.match(real, /\[ -z "\$\{NODE_AUTH_TOKEN:-\}\$\{NPM_TOKEN:-\}" \] \|\| \{[^\n]*exit 1; \}/);
  assert.match(real, /npm stage publish "\$tgz" --provenance --access public\n?$/);
  assert.equal(real.match(/^\s*npm /gm)?.length, 1, 'one npm command on the real path: the stage');
  // The tag check: before the stage, on every v* tag, fetching the tag object and main, failing closed.
  const v = pub.steps.findIndex((s) => s.id === 'verify');
  assert.ok(v >= 0 && v < i, 'the verify step runs before the stage step');
  const verify = pub.steps[v]!;
  assert.equal(verify.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.match(verify.run!, /git fetch --no-tags --depth=1 origin '\+refs\/heads\/main:refs\/remotes\/origin\/main' "\+refs\/tags\/\$\{GITHUB_REF_NAME\}:refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
  assert.match(verify.run!, /node scripts\/verify-release-tag\.mjs "\$GITHUB_REF_NAME" --commit "\$GITHUB_SHA" --signers-ref refs\/remotes\/origin\/main\n\s*echo "commit=\$\{GITHUB_SHA\}" >> "\$GITHUB_OUTPUT"/);
  assert.equal((pub.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with ?? {})['persist-credentials'], false);
});

test('release.yml: npm and Node guarded at the staging minimums (npm 11.15.0, Node 22.14.0), with npm pinned exactly', () => {
  assert.match(wf.env.NPM_VERSION!, /^\d+\.\d+\.\d+$/, 'an exact npm version');
  assert.ok(atLeast(wf.env.NPM_VERSION!, '11.15.0'), `npm ${wf.env.NPM_VERSION} has npm stage`);
  let jobs = 0;
  for (const [name, job] of Object.entries(wf.jobs)) {
    const at = job.steps.findIndex((s) => /npm stage publish|npm-stage-dry-run/.test(s.run ?? ''));
    if (at < 0) continue;
    jobs++;
    const install = job.steps.findIndex((s) => s.run?.includes('npm install -g "npm@${NPM_VERSION}"'));
    assert.ok(install >= 0 && install <= at, `${name}: installs the pinned npm before staging`);
    assert.match(job.steps[install]!.run!, /\[ "\$\(npm --version\)" = "\$NPM_VERSION" \] \|\| \{[^\n]*exit 1; \}/, `${name}: checks it got exactly that npm`);
    const node = String(job.steps.find((s) => s.uses?.startsWith('actions/setup-node@'))!.with!['node-version']);
    assert.ok(/^\d+$/.test(node) ? Number(node) >= 23 : atLeast(node, '22.14.0'), `${name}: Node ${node}`);
  }
  assert.equal(jobs, 2, 'the build job dry-runs the stage, the publish job stages');
  const [guards] = wf.jobs.publish!.steps.find((s) => s.run?.includes(STAGE))!.run!.split('tgz="$(ls');
  assert.match(guards!, /\(b>15\|\|\(b===15&&c>=0\)\)[\s\S]*"\$\(npm --version\)"[\s\S]*predates staged publishing \(11\.15\.0\)" >&2; exit 1; \}/, 'the npm guard, before the dry run and the real path');
  assert.match(guards!, /process\.versions\.node[\s\S]*\(b>14\|\|\(b===14&&c>=0\)\)[\s\S]*\(22\.14\.0\)" >&2; exit 1; \}/, 'the Node guard');
});

test('release.yml: never a real npm publish, never a dist-tag; every dry run is the staging dry run', () => {
  for (const s of steps) {
    const run = s.run ?? '';
    assert.doesNotMatch(run, /\bdist-tag\b/, `${s.name}: no dist-tag`);
    assert.doesNotMatch(run.replace(/npm stage publish/g, ''), /npm publish/, `${s.name}: no npm publish at all`);
  }
  assert.doesNotMatch(text, /^[^#]*\bnpm dist-tag\b/m);
  const dry = readFileSync(join(repoRoot, 'scripts', 'ci', 'npm-stage-dry-run.sh'), 'utf8');
  const cmds = dry.split('\n').filter((l) => !l.startsWith('#') && /\bnpm (stage|publish|dist-tag)\b/.test(l));
  assert.deepEqual(cmds.map((l) => l.trim()), ['out="$(npm stage publish "$tgz" --dry-run --access public 2>&1)" || code=$?'], 'the dry run only ever dry-runs the stage');
});

test('regression (#458): on a tag, the tarball is checked against the signed commit byte for byte, and nothing is staged unless that passed', () => {
  const TREE = 'node scripts/verify-release-tree.mjs "$(ls "$RUNNER_TEMP"/pack/*.tgz)" --commit "$GITHUB_SHA"';
  const build = wf.jobs.build!.steps;
  const early = build.findIndex((s) => s.run?.trim() === TREE);
  assert.ok(early > build.findIndex((s) => s.name === 'pack'), 'the build job checks the tarball it packed');
  assert.equal(build[early]!.if, "startsWith(github.ref, 'refs/tags/v')");
  const pub = wf.jobs.publish!.steps;
  const t = pub.findIndex((s) => s.id === 'tree');
  const verify = pub.findIndex((s) => s.id === 'verify');
  const stage = pub.findIndex((s) => s.run?.includes(STAGE));
  assert.ok(verify < t && t < stage, 'after the tag check, before the stage');
  assert.equal(pub[t]!.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(pub[t]!.run!.trim(), `${TREE}\necho "commit=\${GITHUB_SHA}" >> "$GITHUB_OUTPUT"`);
  assert.equal(pub[stage]!.env?.SAME_TREE, '${{ steps.tree.outputs.commit }}');
  const real = pub[stage]!.run!.split(/\n\s*fi\n/)[1]!;
  const gate = real.search(/\[ "\$SAME_TREE" = "\$GITHUB_SHA" \] \|\| \{[^\n]*nothing staged" >&2; exit 1; \}/);
  assert.ok(gate >= 0 && gate < real.indexOf('npm stage publish'), 'the real path requires the tree check, before the stage');
  const paths = (wf.on.pull_request as { paths: string[] }).paths;
  for (const p of ['scripts/verify-release-tree.mjs', 'scripts/lib/release-tree.mjs', 'scripts/web-licenses.mjs', 'test/release-tree.test.ts']) assert.ok(paths.includes(p), p);
});
