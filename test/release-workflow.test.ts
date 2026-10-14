// .github/workflows/release.yml: what keeps the npm release safe. Every action pinned by commit; no npm token or
// any secret; the OIDC token only for the publish job, which never runs on a pull request; a real publish (with
// provenance) only on a v* tag with the repo variable NPM_PUBLISH set, a dry run otherwise.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
const text = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const wf = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

test('release.yml: triggers, pins and no secrets', () => {
  assert.deepEqual((wf.on.push as { tags: string[] }).tags, ['v*']);
  assert.ok('workflow_dispatch' in wf.on);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const s of job.steps.filter((s) => s.uses)) assert.match(s.uses!, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name}: ${s.uses} pinned by commit`);
  }
  assert.doesNotMatch(text, /secrets\.|^\s*(NPM_TOKEN|NODE_AUTH_TOKEN): /m, 'no npm token, no secret');
});

test('release.yml: only the publish job gets the OIDC token, never on a pull request, and publishes for real only on a tag with NPM_PUBLISH', () => {
  for (const [name, job] of Object.entries(wf.jobs)) if (name !== 'publish') assert.equal(job.permissions?.['id-token'], undefined, name);
  const pub = wf.jobs.publish!;
  assert.equal(pub.permissions?.['id-token'], 'write');
  assert.equal(pub.if, "github.event_name != 'pull_request'");
  const step = pub.steps.find((s) => s.run?.includes('npm publish'))!;
  assert.equal(step.env?.REAL, "${{ vars.NPM_PUBLISH == 'true' && startsWith(github.ref, 'refs/tags/v') }}");
  const [dry, real] = step.run!.split(/\n\s*fi\n/) as [string, string];
  assert.match(dry, /if \[ "\$REAL" != true \]; then[\s\S]*npm publish "\$tgz" --dry-run[\s\S]*exit 0$/);
  assert.match(real, /npm publish "\$tgz" --provenance --access public\n?$/);
  // Every other publish in the workflow is a dry run.
  const others = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => s !== step && s.run?.includes('npm publish'));
  for (const s of others) assert.match(s.run!, /npm publish .*--dry-run/);
});
