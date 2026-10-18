import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/** WHY: release.mjs lists each merged PR as "- <title> (#N)", and this PR's title names the command (#651 round 4). */
const SHIPS = /\bcheck-comments\b|#651\b/;
const cmp = (a: number[], b: number[]) => a.reduce((d, x, i) => d || x - b[i]!, 0);
const v = (x: number[]) => x.join('.');

/** WHY: a release ships check-comments when its CHANGELOG.md section lists it; pre-release headings aren't releases (#651). */
function releases(changelog: string) {
  return changelog.split(/^(?=## v)/m).flatMap((s) => {
    const m = /^## v(\d+)\.(\d+)\.(\d+)(?=[ \n]|$)/.exec(s);
    return m ? [{ version: m.slice(1, 4).map(Number), ships: SHIPS.test(s.slice(m[0].length)) }] : [];
  });
}

/**
 * INVARIANT: the docs pin a version that ships check-comments (#651 round 4), read from CHANGELOG.md, not assumed.
 * Once a section lists it, the pin is that release or a later one with a section. Before that, the pin is
 * package.json's version while that release is being prepared (no section yet), else a possible next release
 * after the newest section, so a release that ships without the command can't be pinned. Null when right.
 */
function pinProblem(pinned: number[], version: number[], changelog: string): string | null {
  const at = `docs/quickstart.md pins ${BRAND.pkg}@${v(pinned)}`;
  const rel = releases(changelog);
  const own = rel.some((r) => cmp(r.version, pinned) === 0);
  const first = rel.filter((r) => r.ships).map((r) => r.version).sort(cmp)[0];
  if (first) {
    if (own && cmp(pinned, first) >= 0) return null;
    return `${at}, but ${v(first)} is the first release in CHANGELOG.md with check-comments and ${v(pinned)} ${own ? 'is older' : 'has no section'}: set the pin to ${v(first)}`;
  }
  const latest = rel.map((r) => r.version).reduce((a, b) => (cmp(a, b) >= 0 ? a : b), [0, 0, 0]);
  if (cmp(version, latest) > 0) return cmp(pinned, version) === 0 ? null : `${at}, but package.json is at ${v(version)}, the release being prepared: set the pin to ${v(version)}`;
  const [x, y, z] = latest as [number, number, number];
  const next = [[x, y, z + 1], [x, y + 1, 0], [x + 1, 0, 0]];
  if (next.some((n) => cmp(pinned, n) === 0)) return null;
  const why = own ? `CHANGELOG.md's v${v(pinned)} section doesn't list check-comments` : `it is not a next release after ${v(latest)}`;
  return `${at}, but ${why}, and no release ships check-comments yet: pin a next release after ${v(latest)} (${next.map(v).join(', ')})`;
}

test('docs: the managed-repo step pins a release that CHANGELOG.md says ships check-comments, or the next one, behind the pinned checkout', () => {
  const doc = readFileSync(join(repoRoot, 'docs', 'quickstart.md'), 'utf8');
  const pin = new RegExp(`npx -y ${BRAND.pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}@(\\d+)\\.(\\d+)\\.(\\d+) check-comments --base HEAD\\^1`).exec(doc);
  assert.ok(pin, 'the step names an exact version');
  const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version.split('.').map(Number);
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.equal(pinProblem(pin.slice(1, 4).map(Number), version, changelog), null);
  assert.ok(doc.includes(`uses: ${PINNED.checkout}`), "the docs' checkout is the starter CI's pin");
  assert.match(doc, /persist-credentials: false/);
});

const lib = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'changelog.mjs')).href)) as {
  prNumbers(subjects: string[]): number[];
  changelogSection(version: string, date: string, prs: { number: number; title: string }[]): string;
};

test('docs pin rule: the pin is a release CHANGELOG.md says ships check-comments, else the next possible one', () => {
  const at = `docs/quickstart.md pins ${BRAND.pkg}@`;
  const log = '## v0.5.2 (2026-10-17)\n\n- older work (#600)\n\n## v0.5.1 (2026-10-16)\n';
  // WHY: the sections are written the way release.mjs writes them, from PR titles, so its wording is what's tested.
  const section = (version: string, ...prs: { number: number; title: string }[]) => `${lib.changelogSection(version, '2026-10-20', prs)}\n`;
  const thisPr = { number: 651, title: "cli: check-comments runs the comment policy's PR check for managed repos (#330) [PROTECTED: owner merges]" };
  const other = { number: 700, title: 'dashboard: the board refreshes on focus' };
  assert.deepEqual(lib.prNumbers(['Merge pull request #651 from owner/issue-330-managed-ci']), [651], 'release.mjs lists this PR');

  // WHY: no release ships it yet (#651), so the pin is the next release.
  assert.equal(pinProblem([0, 5, 3], [0, 5, 2], log), null, 'before the release: the next patch');
  assert.equal(pinProblem([0, 6, 0], [0, 5, 2], log), null, 'before the release: the next minor');
  assert.equal(pinProblem([0, 5, 3], [0, 5, 3], log), null, 'prep for 0.5.3, before its section is written');
  assert.equal(pinProblem([0, 5, 3], [0, 6, 0], log), `${at}0.5.3, but package.json is at 0.6.0, the release being prepared: set the pin to 0.6.0`);
  assert.match(pinProblem([0, 5, 4], [0, 5, 2], log) ?? '', /it is not a next release after 0\.5\.2, .*\(0\.5\.3, 0\.6\.0, 1\.0\.0\)$/, 'an unreleased future version');
  assert.match(pinProblem([0, 5, 2], [0, 5, 2], log) ?? '', /v0\.5\.2 section doesn't list check-comments/);

  // WHY: a release can ship without it while this PR waits (#651 round 3's hole); that version is refused, patch or minor.
  const without = section('0.5.3', other) + log;
  assert.equal(pinProblem([0, 5, 3], [0, 5, 3], without), `${at}0.5.3, but CHANGELOG.md's v0.5.3 section doesn't list check-comments, and no release ships check-comments yet: pin a next release after 0.5.3 (0.5.4, 0.6.0, 1.0.0)`);
  assert.match(pinProblem([0, 6, 0], [0, 6, 0], section('0.6.0', other) + log) ?? '', /v0\.6\.0 section doesn't list check-comments.*\(0\.6\.1, 0\.7\.0, 1\.0\.0\)$/, 'a minor release without it');
  assert.equal(pinProblem([0, 5, 4], [0, 5, 3], without), null, 'the next patch after it');
  assert.equal(pinProblem([0, 5, 4], [0, 5, 4], without), null, 'prep for 0.5.4, before its section is written');

  // WHY: once a release lists it (#651), the pin is that release or a later released one.
  const shipped = section('0.5.4', other, thisPr) + without;
  assert.equal(pinProblem([0, 5, 4], [0, 5, 4], shipped), null, 'prep for the release that ships it');
  assert.equal(pinProblem([0, 5, 4], [0, 5, 6], shipped), null, 'a later release, the pin unchanged');
  assert.equal(pinProblem([0, 5, 5], [0, 5, 5], section('0.5.5', other) + shipped), null, 'a later release with a section');
  assert.equal(pinProblem([0, 5, 3], [0, 5, 4], shipped), `${at}0.5.3, but 0.5.4 is the first release in CHANGELOG.md with check-comments and 0.5.3 is older: set the pin to 0.5.4`);
  assert.match(pinProblem([0, 5, 5], [0, 5, 4], shipped) ?? '', /0\.5\.5 has no section: set the pin to 0\.5\.4$/, 'an unreleased later version');
  assert.match(pinProblem([0, 5, 3], [0, 6, 0], section('0.6.0', thisPr) + log) ?? '', /set the pin to 0\.6\.0$/, 'prep for 0.6.0 that ships it, the docs on 0.5.3');
  assert.match(pinProblem([0, 5, 3], [0, 5, 31], section('0.5.30', thisPr) + log) ?? '', /0\.5\.3 has no section: set the pin to 0\.5\.30$/, 'v0.5.30 is not v0.5.3');
});

test('check-comments: no --base, or a base git can\'t resolve, exits 2', () => {
  const { dir } = project(true);
  assert.equal(spawnSync('node', [engineCli, 'check-comments'], { cwd: dir, encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script], { cwd: dir, encoding: 'utf8' }).status, 2);
  const r = both(dir, ['--base', 'no-such-rev']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /comment policy: could not check no-such-rev\.\.HEAD/);
});
