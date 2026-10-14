import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './helpers.js';
import { AGENT_APP_PERMISSIONS, appManifest } from '../src/setup/app-manifest.js';

type Problems = { errors: string[]; warnings: string[] };
const script = join(repoRoot, 'scripts', 'setup', 'app-permissions.mjs');
type Rules = {
  permissionProblems: (p: Record<string, string>) => Problems;
  REQUIRED: Record<string, string>;
  ALLOWED_UP_TO: Record<string, string>;
  EXPECTED: Record<string, { level: string; why: string }>;
  REFUSED: Record<string, (level: string) => string | null>;
};
const { permissionProblems, REQUIRED, ALLOWED_UP_TO, EXPECTED, REFUSED } = (await import(pathToFileURL(script).href)) as Rules;

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
  const p = permissionProblems({ ...base, actions: 'read', statuses: 'read', issues: 'admin' });
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, ['issues: admin is more than needed (write)', 'statuses: read is not needed; remove it']);
});

test('checks: write, which the manifest App asks for, passes without a warning', () => {
  assert.deepEqual(permissionProblems({ ...base, actions: 'read', checks: 'write' }), { errors: [], warnings: [] });
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

// WHY: the manifest the setup console posts to GitHub (AGENT_APP_PERMISSIONS) and the check every installation must
// pass (app-permissions.mjs) are two lists in two files. If they drift, GitHub makes an App that the check then
// refuses, or one with a permission the check never looks at. This holds them to exactly the same set.
test("the manifest App's permissions are exactly what app-permissions.mjs asks for: every required and expected one, at the most it allows, nothing else", () => {
  const exact: Record<string, string> = {};
  for (const [name, level] of Object.entries(REQUIRED)) exact[name] = ALLOWED_UP_TO[name] ?? level;
  for (const [name, { level }] of Object.entries(EXPECTED)) exact[name] = level;
  assert.deepEqual({ ...AGENT_APP_PERMISSIONS }, exact);
  // So the check passes it with nothing to say, and no refused permission is in it at a refused level.
  assert.deepEqual(permissionProblems({ ...AGENT_APP_PERMISSIONS }), { errors: [], warnings: [] });
  for (const [name, refuse] of Object.entries(REFUSED)) if (name in AGENT_APP_PERMISSIONS) assert.equal(refuse(AGENT_APP_PERMISSIONS[name]!), null, name);
  // And the manifest posts that list, as it is.
  const m = appManifest({ kind: 'agent', name: 'alpha-app', repo: 'example/alpha', publicUrl: 'https://hub.example.test' });
  assert.deepEqual(m.default_permissions, exact);
});
