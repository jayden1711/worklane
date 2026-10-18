import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';
import { PINNED } from '../src/starter-ci.js';
import { engineCli, exampleProject, repoRoot } from './helpers.js';

const script = fileURLToPath(new URL('../../scripts/check-comments.mjs', import.meta.url));

/** WHY: a managed repo runs the CLI and this repo runs the script (#330); both must say the same, word for word. */
function both(dir: string, args: string[]) {
  const run = (argv: string[]) => {
    const r = spawnSync('node', argv, { cwd: dir, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const cli = run([engineCli, 'check-comments', ...args]);
  const viaScript = run([script, ...args]);
  assert.deepEqual(cli, viaScript, 'the CLI and the script agree');
  return cli;
}

/** WHY: a committed base with the policy on or off (#330: CI reads the base's config), and a git helper. */
function project(on: boolean) {
  const { dir } = exampleProject();
  if (on) appendFileSync(join(dir, BRAND.configDir, 'config.yaml'), 'comment_policy: { enabled: true }\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const change = (text: string) => {
    writeFileSync(join(dir, 'src', 'x.ts'), text);
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  };
  return { dir, base, change };
}

test('check-comments: a finding exits 1 with file:line, the same from the CLI and the script', () => {
  const { dir, base, change } = project(true);
  change('// untagged\nexport const x = 1;\n');
  const r = both(dir, ['--base', base, '--head', 'HEAD']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^src\/x\.ts:1: no WHY:, INVARIANT: or issue\/decision id$/m);
});

test('check-comments: a passing change exits 0; the policy off at the base exits 0 saying "off"', () => {
  const on = project(true);
  on.change('// WHY: the API counts from 1 (#4)\nexport const x = 1;\n');
  const pass = both(on.dir, ['--base', on.base]);
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /every comment added in .* passes/);
  const off = project(false);
  off.change('// untagged\nexport const x = 1;\n');
  const r = both(off.dir, ['--base', off.base, '--head', 'HEAD']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^comment policy: off in the config at /);
});

/** WHY: the newest release without `check-comments` (#651 review): npx of it prints "unknown command". */
const LAST_WITHOUT: [number, number, number] = [0, 5, 2];
const cmp = (a: number[], b: number[]) => a.reduce((d, x, i) => d || x - b[i]!, 0);

/**
 * INVARIANT: the docs pin a version that ships (#651 round 3). Until package.json passes LAST_WITHOUT, the pin is one
 * of the possible next releases; from then on it is package.json's version or one with a CHANGELOG.md section, so
 * release prep for any other version fails here. Null when the pin is right, else what to change.
 */
function pinProblem(pinned: number[], version: number[], changelog: string): string | null {
  const v = (x: number[]) => x.join('.');
  const at = `docs/quickstart.md pins ${BRAND.pkg}@${v(pinned)}`;
  if (cmp(pinned, LAST_WITHOUT) <= 0) return `${at}, which has no check-comments: pin ${v(LAST_WITHOUT)} or later`;
  if (cmp(version, LAST_WITHOUT) <= 0) {
    const [x, y, z] = version as [number, number, number];
    const next = [[x, y, z + 1], [x, y + 1, 0], [x + 1, 0, 0]];
    return next.some((n) => cmp(pinned, n) === 0) ? null : `${at}, which is not a next release after ${v(version)} (${next.map(v).join(', ')})`;
  }
  if (cmp(pinned, version) === 0 || new RegExp(`^## v${v(pinned).replace(/\./g, '\\.')}\\b`, 'm').test(changelog)) return null;
  return `${at}, but neither package.json (${v(version)}) nor CHANGELOG.md has ${v(pinned)}: set the pin to ${v(version)}`;
}

test('docs: the managed-repo step pins the release being prepared or a released one with check-comments, behind the pinned checkout', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');
  const pin = new RegExp(`npx -y ${BRAND.pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@(\\d+)\\.(\\d+)\\.(\\d+) check-comments --base HEAD\\^1`).exec(doc);
  assert.ok(pin, 'the step names an exact version');
  const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version.split('.').map(Number);
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.equal(pinProblem(pin.slice(1, 4).map(Number), version, changelog), null);
  assert.ok(doc.includes(`uses: ${PINNED.checkout}`), "the docs' checkout is the starter CI's pin");
  assert.match(doc, /persist-credentials: false/);
});

test('docs pin rule: release prep for a version the docs don\'t pin fails, naming the fix', () => {
  const log = '## v0.5.2 (2026-10-17)\n## v0.5.1 (2026-10-16)\n';
  assert.equal(pinProblem([0, 5, 3], [0, 5, 2], log), null, 'before the release: the next patch');
  assert.equal(pinProblem([0, 6, 0], [0, 5, 2], log), null, 'before the release: the next minor');
  assert.equal(pinProblem([0, 5, 3], [0, 5, 3], log), null, 'prep for 0.5.3');
  assert.equal(pinProblem([0, 5, 3], [0, 5, 4], `## v0.5.3 (2026-10-20)\n${log}`), null, 'a later release: 0.5.3 shipped');
  assert.equal(pinProblem([0, 5, 3], [0, 6, 0], log), `docs/quickstart.md pins ${BRAND.pkg}@0.5.3, but neither package.json (0.6.0) nor CHANGELOG.md has 0.5.3: set the pin to 0.6.0`);
  assert.match(pinProblem([0, 5, 4], [0, 5, 2], log) ?? '', /not a next release after 0\.5\.2/, 'an unreleased future version');
  assert.match(pinProblem([0, 5, 2], [0, 5, 2], log) ?? '', /has no check-comments/);
  assert.match(pinProblem([0, 5, 3], [0, 5, 31], `## v0.5.30 (x)\n${log}`) ?? '', /set the pin to 0\.5\.31/, 'v0.5.30 is not v0.5.3');
});

test('check-comments: no --base, or a base git can\'t resolve, exits 2', () => {
  const { dir } = project(true);
  assert.equal(spawnSync('node', [engineCli, 'check-comments'], { cwd: dir, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script], { cwd: dir, encoding: 'utf8' }).status, 2);
  const r = both(dir, ['--base', 'no-such-rev']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comment policy: could not check no-such-rev\.\.HEAD/);
});
