import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';

type Problems = { errors: string[]; warnings: string[] };
const script = join(repoRoot, 'scripts', 'setup', 'app-permissions.mjs');
const { permissionProblems } = (await import(pathToFileURL(script).href)) as { permissionProblems: (p: Record<string, string>) => Problems };

const base = { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write', checks: 'read' };

test('an App with checks and actions read passes cleanly', () => {
  assert.deepEqual(permissionProblems({ ...base, actions: 'read' }), { errors: [], warnings: [] });
});

test('without actions read the App still passes, with a warning that CI fix runs need it', () => {
  const p = permissionProblems(base);
  assert.deepEqual(p.errors, []);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0]!, /actions: read: CI fix runs/);
});

test('checks read is required: the PR watcher reads CI results with it', () => {
  const { checks: _c, ...noChecks } = base;
  assert.deepEqual(permissionProblems(noChecks).errors, ['missing checks: read']);
});

test('each required permission is checked, at its level', () => {
  assert.deepEqual(permissionProblems({ ...base, contents: 'read' }).errors, ['missing contents: write (has read)']);
  const { issues: _i, pull_requests: _p, ...rest } = base;
  assert.deepEqual(permissionProblems(rest).errors, ['missing issues: write', 'missing pull_requests: write']);
});

test('workflows, administration and actions write are refused', () => {
  const p = permissionProblems({ ...base, workflows: 'write', administration: 'read', actions: 'write' });
  assert.equal(p.errors.length, 3);
  assert.match(p.errors.join('\n'), /Workflows/);
  assert.match(p.errors.join('\n'), /Administration/);
  assert.match(p.errors.join('\n'), /Actions: write.*never reruns/);
});

test('permissions beyond what the harness needs are flagged', () => {
  const p = permissionProblems({ ...base, actions: 'read', statuses: 'read', checks: 'write' });
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, ['checks: write is more than needed (read)', 'statuses: read is not needed; remove it']);
});

test('credentials.sh checks permissions only through app-permissions.mjs, at install and in verify-app', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'credentials.sh'), 'utf8');
  assert.match(sh, /verify_app\(\) \{[^\n]*app-permissions\.mjs/);
  const install = sh.slice(sh.indexOf('  github-app)'), sh.indexOf('  verify-app)'));
  const verify = sh.slice(sh.indexOf('  verify-app)'), sh.indexOf('  github)'));
  assert.match(install, /\n\s+verify_app "\$key" "\$app_id" "\$inst_id" "\$repo"/);
  assert.match(verify, /\n\s+verify_app "\$key" "\$app_id" "\$inst_id" "\$repo"/);
  // verify-app reads the instance's files and writes nothing.
  assert.doesNotMatch(verify, /install |> "|shred|chmod/);
  // No second copy of the rules inline.
  assert.doesNotMatch(sh, /permissions\.(workflows|administration)/);
});
