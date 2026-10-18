// #744: the desktop window is removed, with its CI job, its required check and its lockfile. Two things are kept true
// here: every required check is a job some workflow defines (so neither a merge nor an engine install waits on a
// check that never runs again), and nothing but the CHANGELOG still names the removed app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

type Job = { name?: string; strategy?: { matrix?: Record<string, unknown> } };

/**
 * Every check name the workflows in `dir` can create: each job's name (its key when it has none), a matrix job
 * expanded as GitHub names it (the values substituted where the name uses them, else appended in parentheses).
 */
function jobNames(dir: string): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parse(readFileSync(join(dir, f), 'utf8')) as { jobs?: Record<string, Job> };
    for (const [key, job] of Object.entries(wf.jobs ?? {})) {
      const name = job.name ?? key;
      const axes = Object.entries(job.strategy?.matrix ?? {}).filter(([k, v]) => k !== 'include' && k !== 'exclude' && Array.isArray(v)) as [string, unknown[]][];
      let combos: string[][] = [[]];
      for (const [, values] of axes) combos = combos.flatMap((c) => values.map((v) => [...c, String(v)]));
      for (const c of combos) {
        const vars = Object.fromEntries(axes.map(([k], i) => [k, c[i]!]));
        out.add(name.includes('${{') ? name.replace(/\$\{\{ matrix\.([a-z]+) \}\}/g, (m, k: string) => vars[k] ?? m) : c.length ? `${name} (${c.join(', ')})` : name);
      }
    }
  }
  return out;
}

/** The names in `required` that no workflow in `dir` defines: checks nothing will ever run. */
function undefinedChecks(dir: string, required: string[]): string[] {
  const names = jobNames(dir);
  return required.filter((n) => !names.has(n));
}

const workflows = join(repoRoot, '.github', 'workflows');
const requiredChecks = () => (parse(readFileSync(join(repoRoot, '.worklane', 'config.yaml'), 'utf8')) as { required_checks: string[] }).required_checks;
/** UPDATE_DEFAULT_CHECKS as scripts/setup/lib.sh declares it: the checks a new install's updater requires. */
function updaterDefaults(): string[] {
  const m = readFileSync(join(repoRoot, 'scripts', 'setup', 'lib.sh'), 'utf8').match(/^UPDATE_DEFAULT_CHECKS=\((.*)\)$/m);
  assert.ok(m, 'lib.sh declares UPDATE_DEFAULT_CHECKS');
  return [...m![1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
}

test('every required check, the repo\'s and the updater\'s defaults, is a job some workflow defines', () => {
  assert.deepEqual(undefinedChecks(workflows, requiredChecks()), [], 'config.yaml required_checks');
  assert.deepEqual(undefinedChecks(workflows, updaterDefaults()), [], 'UPDATE_DEFAULT_CHECKS in scripts/setup/lib.sh');
});

test('a required check whose job was removed first is caught, matrix names expanded as GitHub gives them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(
    join(dir, 'ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    strategy: { matrix: { os: [ubuntu-latest], node: [22, 24] } }',
      '    runs-on: x',
      '  shard:',
      '    name: shard ${{ matrix.n }}/2',
      '    strategy: { matrix: { n: [1, 2] } }',
      '    runs-on: x',
      '  lint:',
      '    name: lint all',
      '    runs-on: x',
      '',
    ].join('\n'),
  );
  assert.deepEqual([...jobNames(dir)].sort(), ['lint all', 'shard 1/2', 'shard 2/2', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)']);
  // The desktop job gone, its check still required: the order #744 forbids.
  assert.deepEqual(undefinedChecks(dir, ['test (ubuntu-latest, 22)', 'desktop', 'lint all', 'lint']), ['desktop', 'lint']);
});

/** Text that names the removed app: its folder, its framework, its build script, its window, its env var or flag. */
const NAMES_IT = /\bTauri\b|(^|[^\w.-])desktop\/|build:desktop|_DESKTOP\b|\bdesktop (app|window|shell)\b|dashboard --app\b/i;

/**
 * The files that may still name it. The CHANGELOG, which records the removal (#744). docs/progress.md, the dated
 * build log, which records what each step shipped then. docs/prior-art.md, whose rows describe other projects.
 */
const MAY_NAME_IT = new Set(['CHANGELOG.md', 'docs/progress.md', 'docs/prior-art.md']);

function filesUnder(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

test('the desktop app is gone: its folder, module, build script, CI job and check, notice, globs and docs', () => {
  for (const p of ['desktop', join('src', 'desktop.ts'), join('test', 'desktop.test.ts')]) assert.ok(!existsSync(join(repoRoot, p)), `${p} is removed`);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(!('build:desktop' in pkg.scripts), 'no build:desktop script');
  assert.ok(!jobNames(workflows).has('desktop'), 'no workflow defines a desktop job');
  assert.ok(!requiredChecks().includes('desktop'), 'config.yaml no longer requires desktop');
  assert.ok(!updaterDefaults().includes('desktop'), 'a new install\'s updater no longer requires desktop');

  const files = [
    ...filesUnder(workflows, (p) => /\.ya?ml$/.test(p)),
    ...filesUnder(join(repoRoot, 'docs'), (p) => p.endsWith('.md')),
    ...filesUnder(join(repoRoot, '.worklane'), (p) => /\.(ya?ml|md)$/.test(p)),
    ...['README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'scripts/lib/denylist.mjs', 'scripts/setup/lib.sh', 'src/cli.ts'].map((p) => join(repoRoot, p)),
  ];
  const named = files
    .map((f) => relative(repoRoot, f).split('\\').join('/'))
    .filter((r) => !MAY_NAME_IT.has(r))
    .flatMap((r) => readFileSync(join(repoRoot, r), 'utf8').split('\n').map((line, i) => ({ at: `${r}:${i + 1}`, line })).filter((x) => NAMES_IT.test(x.line)))
    .map((x) => `${x.at}: ${x.line.trim()}`);
  assert.deepEqual(named, [], 'nothing but the CHANGELOG (and the dated build log and other projects\' rows) names it');

  // The CHANGELOG says what replaces it, under the release that removes it.
  const unreleased = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8').split(/^## /m)[1] ?? '';
  assert.match(unreleased, /^v[\d.]+ \(unreleased\)/, 'the newest CHANGELOG section is the unreleased one');
  assert.match(unreleased, /desktop window[^\n]*removed[^\n]*#744/i);
  assert.match(unreleased, /open the dashboard in (a|your) browser/i);
});

test('the fixture helpers read a real tree: this test would see a desktop job if one came back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'ci.yml'), 'jobs:\n  desktop:\n    runs-on: x\n');
  assert.ok(jobNames(dir).has('desktop'));
  assert.ok(NAMES_IT.test('The optional desktop window (`desktop/`) is built with Tauri'));
  assert.ok(!NAMES_IT.test('screenshots (desktop, dark mode, phone width)'), 'the word alone, for a viewport, is fine');
});
