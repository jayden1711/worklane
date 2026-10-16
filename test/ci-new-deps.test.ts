// scripts/ci/new-deps.mjs: a PR that adds or changes a runtime dependency (package.json, or a runtime package in
// package-lock.json, transitive ones included) names each in its body's "## New dependencies" section, with the
// lockfile's licence and why. Dev-only changes and removals need nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

type Lock = { packages: Record<string, Record<string, unknown>> };
type Pkg = Record<string, Record<string, string> | string>;
type Result = { changed: { name: string; versions: string[]; licences: (string | null)[] }[]; problems: string[] };
const script = join(repoRoot, 'scripts', 'ci', 'new-deps.mjs');
const nd = (await import(pathToFileURL(script).href)) as {
  check: (x: { basePkg: Pkg | null; headPkg: Pkg | null; baseLock: Lock | null; headLock: Lock | null; body: string }) => Result;
};

const BASE_PKG: Pkg = { name: 'fixture', dependencies: { ws: '8.0.0' }, devDependencies: { tiny: '1.0.0' } };
const BASE_LOCK: Lock = {
  packages: {
    '': { name: 'fixture', dependencies: { ws: '8.0.0' }, devDependencies: { tiny: '1.0.0' } },
    'node_modules/ws': { version: '8.0.0', license: 'MIT' },
    'node_modules/tiny': { version: '1.0.0', license: 'MIT', dev: true },
  },
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The base plus a runtime dependency `left-pad` 1.3.0 (WTFPL) that itself pulls in `pad-core` 2.0.0 (ISC). */
function withNewDep() {
  const headPkg = clone(BASE_PKG);
  (headPkg.dependencies as Record<string, string>)['left-pad'] = '1.3.0';
  const headLock = clone(BASE_LOCK);
  headLock.packages['node_modules/left-pad'] = { version: '1.3.0', license: 'WTFPL', dependencies: { 'pad-core': '2.0.0' } };
  headLock.packages['node_modules/pad-core'] = { version: '2.0.0', license: 'ISC' };
  return { basePkg: BASE_PKG, baseLock: BASE_LOCK, headPkg, headLock };
}
const SECTION = '## New dependencies\n- left-pad | WTFPL | pads the column in the report\n- `pad-core` | ISC | left-pad\'s own dependency\n';

test('an added runtime dependency with no "New dependencies" section fails, and says what to add', () => {
  const r = nd.check({ ...withNewDep(), body: '## What\nAdds padding.\n' });
  assert.deepEqual(r.changed.map((c) => c.name).sort(), ['left-pad', 'pad-core']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0]!, /no "## New dependencies" section/);
  assert.match(r.problems[0]!, /- left-pad \| WTFPL \| <why it is needed>/);
});

test('with a section naming each package, its licence and why, it passes', () => {
  assert.deepEqual(nd.check({ ...withNewDep(), body: `## What\nAdds padding.\n\n${SECTION}\n## How it was verified\n- npm test\n` }).problems, []);
  // A version on the name, another heading level, parentheses and case on the licence are fine.
  assert.deepEqual(nd.check({ ...withNewDep(), body: '### New Dependencies\n* left-pad@1.3.0 | wtfpl | pads\n- pad-core | (ISC) | transitive\n' }).problems, []);
});

test('a licence that is not the lockfile\'s fails', () => {
  const r = nd.check({ ...withNewDep(), body: SECTION.replace('| WTFPL |', '| MIT |') });
  assert.deepEqual(r.problems, ['left-pad: the body says "MIT", the lockfile says "WTFPL"']);
});

test('a line with no reason, or no licence, fails', () => {
  assert.deepEqual(nd.check({ ...withNewDep(), body: SECTION.replace("| left-pad's own dependency", '| ') }).problems, ['pad-core: no reason on its line (why it is needed)']);
  assert.match(nd.check({ ...withNewDep(), body: SECTION.replace('| WTFPL |', '| |') }).problems.join('\n'), /left-pad: no licence on its line/);
  assert.match(nd.check({ ...withNewDep(), body: '## New dependencies\n- left-pad WTFPL pads\n- pad-core | ISC | transitive\n' }).problems.join('\n'), /a line is "- <name> \| <licence> \| <why>"/);
});

test('a transitive runtime addition is caught even when package.json does not change', () => {
  const headLock = clone(BASE_LOCK);
  headLock.packages['node_modules/ws/node_modules/bufferutil'] = { version: '4.0.0', license: 'MIT' };
  const r = nd.check({ basePkg: BASE_PKG, headPkg: BASE_PKG, baseLock: BASE_LOCK, headLock, body: '' });
  assert.deepEqual(r.changed.map((c) => c.name), ['bufferutil']);
  assert.match(r.problems.join('\n'), /no "## New dependencies" section/);
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg: BASE_PKG, baseLock: BASE_LOCK, headLock, body: '## New dependencies\n- bufferutil | MIT | ws uses it\n' }).problems, []);
});

test('a version change of a runtime package counts; dev-only additions and removals do not', () => {
  const bumped = clone(BASE_LOCK);
  bumped.packages['node_modules/ws']!.version = '8.1.0';
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg: BASE_PKG, baseLock: BASE_LOCK, headLock: bumped, body: '' }).changed.map((c) => c.name), ['ws']);

  const devPkg = clone(BASE_PKG);
  (devPkg.devDependencies as Record<string, string>).vite = '8.0.0';
  const devLock = clone(BASE_LOCK);
  devLock.packages['node_modules/vite'] = { version: '8.0.0', license: 'MIT', dev: true };
  devLock.packages['node_modules/esbuild'] = { version: '0.25.0', license: 'MIT', dev: true };
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg: devPkg, baseLock: BASE_LOCK, headLock: devLock, body: '' }), { changed: [], problems: [] });

  const removed = clone(BASE_LOCK);
  delete removed.packages['node_modules/ws'];
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg: { name: 'fixture' }, baseLock: BASE_LOCK, headLock: removed, body: '' }), { changed: [], problems: [] });
});

test('a dev package that becomes a runtime one counts, and devOptional entries are runtime', () => {
  const headPkg = clone(BASE_PKG);
  (headPkg.dependencies as Record<string, string>).tiny = '1.0.0';
  const headLock = clone(BASE_LOCK);
  delete headLock.packages['node_modules/tiny']!.dev;
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg, baseLock: BASE_LOCK, headLock, body: '' }).changed.map((c) => c.name), ['tiny']);
  const opt = clone(BASE_LOCK);
  opt.packages['node_modules/fsevents'] = { version: '2.3.3', license: 'MIT', devOptional: true, optional: true };
  assert.deepEqual(nd.check({ basePkg: BASE_PKG, headPkg: BASE_PKG, baseLock: BASE_LOCK, headLock: opt, body: '' }).changed.map((c) => c.name), ['fsevents']);
});

test('a package.json dependency the lockfile lacks, or one with no licence in the lockfile, fails', () => {
  const headPkg = clone(BASE_PKG);
  (headPkg.peerDependencies as unknown) = { react: '19.0.0' };
  assert.match(nd.check({ basePkg: BASE_PKG, headPkg, baseLock: BASE_LOCK, headLock: BASE_LOCK, body: '## New dependencies\n- react | MIT | peer\n' }).problems.join('\n'), /react: package\.json peerDependencies names it but package-lock\.json has no node_modules\/react/);
  const headLock = clone(BASE_LOCK);
  headLock.packages['node_modules/mystery'] = { version: '0.1.0' };
  assert.match(nd.check({ basePkg: BASE_PKG, headPkg: BASE_PKG, baseLock: BASE_LOCK, headLock, body: '## New dependencies\n- mystery | MIT | why not\n' }).problems.join('\n'), /mystery: package-lock\.json has no license for it/);
});

test('the CLI reads both revisions with git and the body from the event payload; exit 1 on a problem, 0 when named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'new-deps-'));
  try {
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=you@example.com', '-c', 'user.name=you', ...a], { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    const commit = (pkg: Pkg, lock: Lock) => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
      git('add', 'package.json', 'package-lock.json');
      git('commit', '-qm', 'x');
      return git('rev-parse', 'HEAD');
    };
    const base = commit(BASE_PKG, BASE_LOCK);
    const { headPkg, headLock } = withNewDep();
    const head = commit(headPkg, headLock);
    const run = (body: string) => {
      const event = join(dir, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { body } }));
      return spawnSync(process.execPath, [script, base, head], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event } });
    };
    const red = run('No section.');
    assert.equal(red.status, 1, red.stderr);
    assert.match(red.stderr, /new-deps: the PR adds or changes 2 runtime package\(s\)/);
    const green = run(SECTION);
    assert.equal(green.status, 0, green.stderr);
    assert.match(green.stdout, /runtime package: left-pad 1\.3\.0 \(WTFPL\)/);
    const same = spawnSync(process.execPath, [script, base, base], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: join(dir, 'event.json') } });
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /no runtime dependency added or changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow runs the base\'s copy of the check on every PR event, the body edit included, from the payload', () => {
  const wf = parse(readFileSync(join(repoRoot, '.github', 'workflows', 'new-deps.yml'), 'utf8')) as {
    on: { pull_request: { types: string[]; paths?: unknown } };
    permissions: Record<string, string>;
    jobs: Record<string, { name?: string; steps: { uses?: string; run?: string; with?: Record<string, unknown> }[] }>;
  };
  assert.deepEqual(wf.on.pull_request.types, ['opened', 'synchronize', 'reopened', 'edited']);
  assert.equal(wf.on.pull_request.paths, undefined, 'every PR, so it can be a required check');
  assert.deepEqual(wf.permissions, { contents: 'read' });
  const job = wf.jobs['new-deps']!;
  assert.equal(job.name, undefined, 'the check is called new-deps');
  assert.equal(job.steps[0]!.with?.['fetch-depth'], 2);
  assert.equal(job.steps[0]!.with?.['persist-credentials'], false);
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /git show HEAD\^1:scripts\/ci\/new-deps\.mjs > "\$check"/);
  assert.match(run, /node "\$check" HEAD\^1 HEAD/);
  assert.doesNotMatch(JSON.stringify(wf), /secrets\.|GITHUB_TOKEN|github\.token|gh api/);
});
