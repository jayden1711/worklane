// #744: the desktop window is removed, with its lockfile, docs and build steps. Its CI job stays one more release as
// a job that only succeeds (#746, the owner's option (a)): an updater from v0.5.2 or older requires a successful
// "desktop" run on every commit it installs, so the job and its required check go together a release later (#877).
// Kept true here: every required check is a job some workflow defines (a check with no job at all would never run
// again; that a defined job runs on every commit is not proven here: an `if:`, a `workflow_call`- or
// `workflow_dispatch`-only file can still skip it), each required check is made by exactly one job (a second,
// red one that started first is hidden from a v0.5.2 updater), the desktop job can only succeed, and nothing but the
// release notes still names the removed app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isScalar, parse, parseDocument, visit } from 'yaml';
import { repoRoot } from './helpers.js';

type Job = { name?: unknown; strategy?: { matrix?: unknown } };

/**
 * Every check name the workflows in `dir` can create, as this models GitHub's naming: each job's name (its key when
 * it has none), a matrix job expanded (the values substituted where the name uses them, else appended in
 * parentheses), and, for a matrix job with an `if:` or `needs:`, its bare name too: a skipped one gets one check run
 * under it (round 10). A name this can't work out keeps an unresolved `${{` (see UNRESOLVED and mayName).
 */
function jobNames(dir: string): Set<string> {
  const out = new Set<string>();
  for (const f of workflowFiles(dir)) for (const n of fileJobNames(join(dir, f))) out.add(n);
  return out;
}

/**
 * The workflow files in `dir`. Whether GitHub runs a `.YML` or `.Yaml` file is unsure, and each use takes the closed
 * side: the twin search (`anyCase`) reads them, since one might make a check; "every required check is a job some
 * workflow defines" (jobNames) doesn't, since one might never run.
 */
function workflowFiles(dir: string, anyCase = false): string[] {
  return readdirSync(dir).filter((x) => (anyCase ? /\.ya?ml$/i : /\.ya?ml$/).test(x)).sort();
}

/** What a check name still holds when this can't evaluate it: an expression GitHub would evaluate on the runner. */
const UNRESOLVED = '${{';

/**
 * Whether `names` may include the check `check`: by name, or because one of them still holds an expression this
 * can't evaluate (`${{ 'desktop' }}`, `${{ github.x }}`, a matrix key it couldn't find), which could evaluate to
 * anything. That second case fails closed: such a name counts as a possible maker of every check.
 */
const mayName = (names: Set<string>, check: string) => names.has(check) || [...names].some((n) => n.includes(UNRESOLVED));

/** A plain mapping: not a list, and not a `Map` or other class (`!!omap`, `!!set` and the like). */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && [Object.prototype, null].includes(Object.getPrototypeOf(v));
/** A key as GitHub may compare it: case folded the Unicode way, so `job` + U+017F (long s) folds to `jobs`. */
const fold = (k: string) => k.toUpperCase().toLowerCase();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const shown = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

/**
 * A job's matrix combinations as GitHub builds them: the product of its axes, less each `exclude` match, then each
 * `include` entry merged into every combination whose original values it doesn't overwrite, or added as a
 * combination of its own when it fits none (so an `include`-only matrix is its entries). Null when the matrix isn't
 * written out (an expression such as `${{ fromJSON(...) }}`, for the matrix, an axis or an entry): the caller then
 * treats the job's name as unresolved. Each combination is a Map in key order, so no key is ever read from
 * Object.prototype (`toString`, `constructor`) and integer-like keys keep their place (round 8).
 */
function matrixCombos(matrix: unknown): Map<string, unknown>[] | null {
  if (!isRecord(matrix)) return null;
  const { include = [], exclude = [], ...axes } = matrix;
  if (!Array.isArray(include) || !Array.isArray(exclude) || !include.every(isRecord) || !exclude.every(isRecord)) return null;
  if (!Object.values(axes).every(Array.isArray)) return null;
  // Keys that differ only in case (`view` and `View`, or an `Include` axis): whether GitHub reads them as one key is
  // unsure, and the combinations differ either way, so the matrix counts as unreadable.
  const keys = [...Object.keys(axes), ...include.flatMap((e) => Object.keys(e)), ...exclude.flatMap((e) => Object.keys(e))];
  // A key outside a closed identifier set makes the matrix unreadable. That covers a key outside printable ASCII
  // (U+017F long s, U+00DF sharp s, U+212A Kelvin: whether `matrix.s` or `matrix.ss` reaches it is unsure; round 7),
  // an integer-like key such as `"1"` (JS lists those first, GitHub keeps the file's order; round 8), and
  // `__proto__`.
  if (keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) || k === '__proto__')) return null;
  if (Object.keys(axes).some((k) => ['include', 'exclude'].includes(fold(k)) || ['include', 'exclude'].includes(k.toLowerCase()))) return null;
  if (new Set(keys.map(fold)).size !== new Set(keys).size || new Set(keys.map((k) => k.toLowerCase())).size !== new Set(keys).size) return null;
  // A value that isn't a plain, non-blank scalar (null, an object or list, '' or blanks): how GitHub names the job
  // then (an empty or dropped suffix?) is unsure, so the matrix counts as unreadable (as src/check-pin-block.ts does).
  const values = [...(Object.values(axes) as unknown[][]).flat(), ...include.flatMap((e) => Object.values(e)), ...exclude.flatMap((e) => Object.values(e))];
  if (values.some((v) => v === null || typeof v === 'object' || (typeof v === 'string' && v.trim() === ''))) return null;
  // A number JS and GitHub may print differently makes the matrix unreadable: `22.00000000000001` (JS keeps the
  // digits, a 15-digit format drops them; round 8) and -0 (JS prints `0`, .NET `-0`; round 9). Every other integer
  // below 1e15 in size is taken to print the same both ways (inferred, not measured on GitHub).
  if (values.some((v) => typeof v === 'number' && (!(Number.isInteger(v) && Math.abs(v) < 1e15) || Object.is(v, -0)))) return null;
  let combos: Map<string, unknown>[] = Object.keys(axes).length ? [new Map()] : [];
  for (const [k, values] of Object.entries(axes) as [string, unknown[]][]) combos = combos.flatMap((c) => values.map((v) => new Map([...c, [k, v]])));
  combos = combos.filter((c) => !exclude.some((e) => Object.entries(e).every(([k, v]) => c.has(k) && same(c.get(k), v))));
  const original = combos.map((c) => new Map(c));
  const added: Map<string, unknown>[] = [];
  for (const entry of include) {
    let fits = false;
    combos.forEach((c, i) => {
      if (Object.entries(entry).every(([k, v]) => !original[i]!.has(k) || same(original[i]!.get(k), v))) {
        for (const [k, v] of Object.entries(entry)) c.set(k, v);
        fits = true;
      }
    });
    if (!fits) added.push(new Map(Object.entries(entry)));
  }
  return [...combos, ...added];
}

/** Whether `v` holds a YAML merge key (`<<`) anywhere: the `yaml` parser keeps it as a plain key. */
function hasMergeKey(v: unknown, seen = new Set<unknown>()): boolean {
  if (typeof v !== 'object' || v === null || seen.has(v)) return false;
  seen.add(v);
  if (!Array.isArray(v) && Object.hasOwn(v, '<<')) return true;
  return Object.values(v).some((x) => hasMergeKey(x, seen));
}

/** Whether `v` has a key that is one of `names` in another case (`Name:`, `Jobs:`, `job` + U+017F): how GitHub reads it is unsure. */
const otherCase = (v: unknown, names: string[]) => isRecord(v) && Object.keys(v).some((k) => names.includes(fold(k)) && !names.includes(k));

/**
 * Whether GitHub may show `name` as another name. A closed set, not a list of bad characters: any character outside
 * printable ASCII (a line break from a `|` or `>+` block scalar, a tab, a no-break space, a zero-width or format
 * character, a control character, any letter it might fold), or a leading or trailing space. It may trim, drop or
 * fold them, so such a name fails closed. Every name the real workflows make is inside the set.
 */
const unsureName = (name: string) => /[^\x20-\x7e]|^ | $/.test(name);

/** The check names one job can create (see jobNames). */
function jobCheckNames(key: string, job: Job): Set<string> {
  const out = new Set<string>();
  // A merge key: whether Actions merges it (YAML 1.1) or not (1.2, as parsed here) is unsure, so the job fails closed.
  if (hasMergeKey(job)) return new Set([`${key} (${UNRESOLVED} merge key }})`]);
  if (otherCase(job, ['name', 'strategy']) || otherCase(job.strategy, ['matrix'])) return new Set([`${key} (${UNRESOLVED} a key in another case }})`]);
  // A name that isn't a non-blank string (`''`, a number, a list): what GitHub shows is unsure, so it fails closed.
  if (job.name !== undefined && (typeof job.name !== 'string' || job.name.trim() === '')) return new Set([`${key} (${UNRESOLVED} name ${JSON.stringify(job.name)} }})`]);
  const name = (job.name as string | undefined) ?? key;
  // A `strategy` that isn't a plain mapping (a whole `${{ fromJSON(...) }}` expression, null, a list): GitHub may
  // expand it into a matrix, `test (ubuntu-latest, 22)`, where this would read a bare `test` (round 9). Unresolved.
  if (job.strategy !== undefined && !isRecord(job.strategy)) return new Set([`${name} (${UNRESOLVED} strategy ${JSON.stringify(job.strategy)} }})`]);
  const matrix = job.strategy?.matrix;
  const combos = matrix === undefined ? [new Map<string, unknown>()] : matrixCombos(matrix);
  // A matrix this can't read, or one with no combination at all (`{}`, `include: []`, an empty axis, everything
  // excluded): what GitHub shows for it is unsure, possibly a failed job under its own name, so it fails closed.
  if (!combos || combos.length === 0) return new Set([`${name} (${UNRESOLVED} matrix ${JSON.stringify(matrix)} }})`]);
  for (const c of combos) {
    // GitHub's expression contexts and property names ignore case, and spacing inside ${{ }} is free.
    const vars = new Map([...c].map(([k, v]) => [fold(k), v]));
    if (name.includes(UNRESOLVED)) out.add(name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/gi, (m, k: string) => (vars.has(fold(k)) ? shown(vars.get(fold(k))) : m)));
    else out.add(c.size ? `${name} (${[...c.values()].map(shown).join(', ')})` : name);
  }
  // A matrix job with an `if:` or `needs:`: GitHub evaluates them before it expands the matrix, and a job skipped
  // there gets ONE check run under its bare name (`name:`, else the key; measured on this repo: ci-slow.yml's
  // `bootstrap`, skipped). So it also makes its bare name (round 10). A bare name holding `${{` stays unresolved.
  if (matrix !== undefined && Object.keys(job).some((k) => ['if', 'needs'].includes(fold(k)))) out.add(name);
  // A name holding ` / `: GitHub names a reusable workflow's jobs `<caller> / <callee job>`, which this doesn't
  // build, so a literal name of that shape may twin one (round 8). It fails closed like any unsure name.
  return new Set([...out].map((n) => (unsureName(n) || n.includes(' / ') ? `${key} (${UNRESOLVED} name ${JSON.stringify(n)} }})` : n)));
}

/**
 * One workflow file as this reads it, and why it may read it otherwise than GitHub (`unsure`, null when it can't
 * tell any reason). Unsure, each failing closed:
 * - bytes that aren't UTF-8 (a UTF-16 file with a BOM reads as one string, with no jobs);
 * - any character other than TAB, LF and printable ASCII, past a BOM at offset 0. A closed set: it takes in a NUL,
 *   a lone CR, NEL, LS and PS (line breaks to other YAML readers that end a comment early and so hide the rest of the
 *   line from this one), a BOM at a line start (skipped by other readers, part of a key here), and every other
 *   control or non-ASCII character. Every real workflow is inside it;
 * - any `%YAML` or `%TAG` directive (under `%YAML 1.1`, `022` reads as octal 18, and `<<` merges);
 * - a merge key anywhere, found in the YAML syntax tree, so every spelling counts (`<<`, `"<<"`, `!!merge <<`, and
 *   `<<` under `%YAML 1.1`, which the parser applies and leaves no key for): whether Actions merges it is unsure;
 * - a root, a `jobs`, or a job that isn't a plain mapping (a scalar, a list, `!!omap`), a `permissions` (at the root
 *   or in a job) that is neither a string nor a plain mapping, or any value anywhere that is neither a plain mapping,
 *   a list nor a scalar (a `Map`, a `Set`, binary data);
 * - any key outside printable ASCII (`jobs` and a no-break space), and a root key that is `jobs` in another case (`Jobs:`).
 * `wf` is null when the file can't be read as a mapping at all.
 */
function readWorkflow(file: string): { wf: Record<string, unknown> | null; unsure: string | null } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
  } catch {
    return { wf: null, unsure: 'not UTF-8' };
  }
  const odd = /[^\t\n\x20-\x7e]/.test(text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text);
  let value: unknown;
  try {
    value = parse(text);
  } catch (e) {
    // A file that is unsure anyway may also not parse; any other parse error fails the test, as before.
    if (odd) return { wf: null, unsure: 'a character outside TAB, LF and printable ASCII' };
    throw e;
  }
  if (!isRecord(value)) return { wf: null, unsure: 'a root that is not a mapping' };
  const unsure = (why: string) => ({ wf: value as Record<string, unknown>, unsure: why });
  if (odd) return unsure('a character outside TAB, LF and printable ASCII');
  const doc = parseDocument(text);
  if (doc.directives?.yaml.explicit || JSON.stringify(doc.directives?.tags) !== JSON.stringify({ '!!': 'tag:yaml.org,2002:' })) return unsure('a %YAML or %TAG directive');
  let merge = false;
  visit(doc, { Pair: (_, p) => void (isScalar(p.key) && p.key.source === '<<' && (merge = true)) });
  if (merge || hasMergeKey(value)) return unsure('a merge key');
  if (!plainAll(value)) return unsure('a value that is not a plain mapping, list or scalar, or a key outside printable ASCII');
  if (value.jobs !== undefined && !isRecord(value.jobs)) return unsure('jobs that are not a mapping');
  const jobs = Object.values(isRecord(value.jobs) ? value.jobs : {});
  if (!jobs.every(isRecord)) return unsure('a job that is not a mapping');
  const permsOk = (o: Record<string, unknown>) => Object.entries(o).every(([k, v]) => fold(k) !== 'permissions' || typeof v === 'string' || isRecord(v));
  if (!permsOk(value) || !(jobs as Record<string, unknown>[]).every(permsOk)) return unsure('permissions that are neither a string nor a mapping');
  if (otherCase(value, ['jobs'])) return unsure('jobs in another case');
  return { wf: value, unsure: null };
}

/**
 * Whether `v` holds only plain mappings, lists and scalars, with every mapping key inside printable ASCII and with no
 * leading or trailing space (`"jobs "`): the same closed set as names (unsureName).
 */
function plainAll(v: unknown, seen = new Set<unknown>()): boolean {
  if (typeof v !== 'object' || v === null) return true;
  if (seen.has(v)) return true;
  seen.add(v);
  if (Array.isArray(v)) return v.every((x) => plainAll(x, seen));
  if (!isRecord(v)) return false;
  return Object.entries(v).every(([k, x]) => !unsureName(k) && plainAll(x, seen));
}

/**
 * Each job in one workflow file, by key, with the check names it can create. A file readWorkflow is unsure of also
 * gets an entry `?` with an unresolved name, so it may make any check. A `<<` under `jobs:` is not read as a job.
 */
function fileJobs(file: string): [string, Set<string>][] {
  const { wf, unsure } = readWorkflow(file);
  const jobs = Object.entries(isRecord(wf?.jobs) ? (wf.jobs as Record<string, Job>) : {})
    .filter(([key, job]) => key !== '<<' && isRecord(job))
    .map(([key, job]): [string, Set<string>] => [key, jobCheckNames(key, job)]);
  if (unsure) jobs.push(['?', new Set([`? (${UNRESOLVED} ${unsure} }})`])]);
  return jobs;
}

/** The check names one workflow file can create (see jobNames). */
function fileJobNames(file: string): Set<string> {
  return new Set(fileJobs(file).flatMap(([, names]) => [...names]));
}

/**
 * The workflows and jobs in `dir` that let a step post a check run of any name, `desktop` included, through the
 * Checks API: `checks: write` or `write-all`, keys and values in any case. The protection is by design: the repo's
 * default workflow token is read-only and each workflow sets its own `permissions` without `checks`. This is a
 * backstop beside it until #877 removes the check. A file readWorkflow is unsure of counts as `<file> (?)`.
 */
function checkWriters(dir: string): string[] {
  const grants = (p: unknown) => (typeof p === 'string' && fold(p.trim()) === 'write-all') || (isRecord(p) && Object.entries(p).some(([k, v]) => fold(k) === 'checks' && fold(String(v).trim()) === 'write'));
  const perms = (o: unknown) => (isRecord(o) ? Object.entries(o).filter(([k]) => fold(k) === 'permissions').map(([, v]) => v) : []);
  const out: string[] = [];
  for (const f of workflowFiles(dir, true)) {
    const { wf, unsure } = readWorkflow(join(dir, f));
    if (unsure) out.push(`${f} (?)`);
    if (perms(wf).some(grants)) out.push(f);
    for (const [key, job] of Object.entries(isRecord(wf?.jobs) ? wf.jobs : {})) if (perms(job).some(grants)) out.push(`${f}:${key}`);
  }
  return out;
}

/**
 * Why `job` might end any way but success on a commit: anything beyond GitHub's runner and one step that runs
 * `true`. No `if` (a skipped required check is refused by a v0.5.2 updater), no `needs` (a failed or skipped
 * dependency skips it), no `name` (the check must keep the job id as its name), and no `continue-on-error`,
 * `uses`, matrix, container, environment or timeout of its own: nothing that can turn it red, skip it or rename it.
 */
function notOnlySuccess(job: Record<string, unknown> | undefined): string[] {
  if (!job) return ['no such job'];
  const out = Object.keys(job).filter((k) => k !== 'runs-on' && k !== 'steps').map((k) => `has ${k}`);
  if (job['runs-on'] !== 'ubuntu-latest') out.push(`runs-on ${JSON.stringify(job['runs-on'])}`);
  if (JSON.stringify(job.steps) !== JSON.stringify([{ run: 'true' }])) out.push(`steps ${JSON.stringify(job.steps)}`);
  return out;
}

type Workflow = { on?: Record<string, unknown>; defaults?: unknown; env?: unknown; jobs?: Record<string, Record<string, unknown>> };

/** ci.yml's triggers, exactly: every push to main and every pull request (opened, synchronized, reopened). */
const CI_ON = { push: { branches: ['main'] }, pull_request: { types: ['opened', 'synchronize', 'reopened'] } };

/**
 * Why ci.yml might not give every main commit and every pull request a desktop run that succeeds, outside the job
 * itself: a trigger other than exactly CI_ON (a `paths`, `paths-ignore` or `branches` filter, narrowed `types`, a
 * trigger dropped), or workflow-level `defaults` (a `run.shell` or `working-directory` that fails the `true` step)
 * or `env` (a `BASH_ENV` the step's shell would source first). ci.yml has neither today.
 */
function workflowProblems(wf: Workflow): string[] {
  const out: string[] = [];
  for (const [event, want] of Object.entries(CI_ON)) {
    const got = wf.on?.[event];
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`on.${event} ${JSON.stringify(got)}`);
  }
  if (wf.defaults !== undefined) out.push(`defaults ${JSON.stringify(wf.defaults)}`);
  if (wf.env !== undefined) out.push(`env ${JSON.stringify(wf.env)}`);
  return out;
}

/**
 * Every job in `dir`'s workflows that may make a `desktop` check (mayName), as `file:job`. Jobs, not files: a second
 * job inside ci.yml is a twin too.
 */
function desktopMakers(dir: string): string[] {
  return makersOf(dir, 'desktop');
}

/** Every job in `dir`'s workflows (any-case extensions) that may make the check `check` (mayName), as `file:job`. */
function makersOf(dir: string, check: string): string[] {
  return workflowFiles(dir, true).flatMap((f) => fileJobs(join(dir, f)).filter(([, names]) => mayName(names, check)).map(([key]) => `${f}:${key}`));
}

/**
 * The check names not made by exactly one job, each with the jobs that may make it: every name in `required`, and
 * every name any job in `dir` makes. A v0.5.2 updater gates every check run on a commit by the newest run of its
 * name, required or not, so a second job making the same name hides the first: a red run that started first is
 * never read (#746 adversarial reviews, rounds 6 and 7).
 */
function checkTwins(dir: string, required: string[]): string[] {
  const made = workflowFiles(dir, true).flatMap((f) => fileJobs(join(dir, f)).flatMap(([, names]) => [...names].filter((n) => !n.includes(UNRESOLVED))));
  return [...new Set([...required, ...made])].map((r) => [r, makersOf(dir, r)] as const).filter(([, m]) => m.length !== 1).map(([r, m]) => `${r}: ${m.join(', ') || 'no job'}`);
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

test('every check name in the workflows, required or not, is made by exactly one job (rounds 6 and 7)', () => {
  assert.deepEqual(checkTwins(workflows, [...requiredChecks(), ...updaterDefaults()]), [], 'every name the workflows make, and config.yaml required_checks and UPDATE_DEFAULT_CHECKS');
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'ci.yml'), "jobs:\n  desktop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  dco:\n    runs-on: x\n  build:\n    runs-on: x\n");
  assert.deepEqual(checkTwins(dir, ['desktop', 'dco']), [], 'one job each');
  writeFileSync(join(dir, 'other.yml'), "jobs:\n  twin:\n    name: dco\n    runs-on: x\n    steps: [ { run: 'false' } ]\n");
  assert.deepEqual(checkTwins(dir, ['desktop', 'dco', 'lint']), ['dco: ci.yml:dco, other.yml:twin', 'lint: no job'], 'a red dco twin, and a check with no job');
  writeFileSync(join(dir, 'other.yml'), 'jobs:\n  twin:\n    name: build\n    runs-on: x\n');
  assert.deepEqual(checkTwins(dir, ['desktop', 'dco']), ['build: ci.yml:build, other.yml:twin'], 'a twin of a check nobody requires: v0.5.2 gates on it too');
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

test('no workflow or job may post a check run through the Checks API: no checks: write, no write-all (round 5)', () => {
  assert.deepEqual(checkWriters(workflows), [], 'a step with checks: write could post a red desktop check run');
  const writers = (yml: string | Buffer) => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'w.yml'), yml);
    return checkWriters(dir);
  };
  assert.deepEqual(writers('permissions: write-all\njobs:\n  a:\n    runs-on: x\n'), ['w.yml']);
  assert.deepEqual(writers('permissions: { checks: write }\njobs:\n  a:\n    runs-on: x\n'), ['w.yml']);
  assert.deepEqual(writers('jobs:\n  a:\n    permissions: { contents: read, checks: write }\n    runs-on: x\n'), ['w.yml:a']);
  assert.deepEqual(writers('jobs:\n  a:\n    permissions: write-all\n    runs-on: x\n'), ['w.yml:a']);
  assert.deepEqual(writers('Permissions: { Checks: Write }\njobs:\n  a:\n    runs-on: x\n'), ['w.yml'], 'any case');
  assert.deepEqual(writers('permissions: { checks: read, contents: write }\njobs:\n  a:\n    permissions: read-all\n    runs-on: x\n'), [], 'reading checks is fine');
  // Round 6: a file this can't be sure it reads as GitHub does counts as a possible writer.
  assert.deepEqual(writers(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('permissions: write-all\njobs:\n  a:\n    runs-on: x\n', 'utf16le')])), ['w.yml (?)'], 'UTF-16');
  assert.deepEqual(writers('x: &p { permissions: write-all }\njobs:\n  a:\n    <<: *p\n    runs-on: x\n'), ['w.yml (?)'], 'permissions from a merge key');
  assert.deepEqual(writers('%YAML 1.1\n---\nx: &p { permissions: write-all }\njobs:\n  a:\n    <<: *p\n    runs-on: x\n'), ['w.yml (?)', 'w.yml:a'], 'a merge the parser applied');
  assert.deepEqual(writers('"job\\u017f":\n  a:\n    permissions: write-all\n    runs-on: x\n'), ['w.yml (?)'], 'jobs under a key that folds to jobs');
  // Round 7: a job or permissions that isn't a plain mapping, and text another YAML reader reads otherwise.
  assert.deepEqual(writers('%YAML 1.1\n---\njobs:\n  a: !!omap\n    - permissions: write-all\n    - runs-on: x\n'), ['w.yml (?)'], 'XW1 a job that is an !!omap');
  assert.deepEqual(writers('%YAML 1.1\n---\npermissions: !!omap\n  - checks: write\njobs:\n  a:\n    runs-on: x\n'), ['w.yml (?)'], 'XW2 root permissions that are an !!omap');
  assert.deepEqual(writers('permissions: [checks]\njobs:\n  a:\n    runs-on: x\n'), ['w.yml (?)'], 'permissions that are a list');
  assert.deepEqual(writers('jobs:\n  a:\n    runs-on: x\n    # c' + String.fromCharCode(0x2028) + '    permissions: write-all\n'), ['w.yml (?)'], 'L2 permissions after an LS');
  assert.deepEqual(writers('jobs:\n  a:\n    runs-on: x\n' + String.fromCharCode(0xfeff) + '   permissions: write-all\n'), ['w.yml (?)'], "B3' permissions after a BOM");
});

test('a required check defined only in a .YML or .Yaml file counts as undefined: GitHub may never run it (round 5)', () => {
  for (const f of ['ci.YML', 'lint.Yaml']) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), 'jobs:\n  desktop:\n    runs-on: x\n');
    writeFileSync(join(dir, f), 'jobs:\n  lint:\n    runs-on: x\n');
    assert.deepEqual(undefinedChecks(dir, ['desktop', 'lint']), ['lint'], f);
  }
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'lint.yml'), 'jobs:\n  lint:\n    runs-on: x\n');
  assert.deepEqual(undefinedChecks(dir, ['lint']), [], 'lint.yml defines it');
});

/** Text that names the removed app: its folder, its framework, its build script, its window, its env var or flag. */
const NAMES_IT = /\bTauri\b|(^|[^\w.-])desktop\/|build:desktop|_DESKTOP\b|\bdesktop (app|window|shell)\b|dashboard --app\b/i;

/**
 * The files that may still name it. The CHANGELOG, which records the removal (#744). docs/progress.md, the dated
 * build log, which records what each step shipped then. docs/prior-art.md, whose rows describe other projects.
 * .worklane/review.yaml, whose `engine` globs keep `desktop/**` (owner-only review for the folder) until #877:
 * dropping a glob is a loosening, the owner's call, so it goes with the job's removal, not here.
 */
const MAY_NAME_IT = new Set(['CHANGELOG.md', 'docs/progress.md', 'docs/prior-art.md', '.worklane/review.yaml']);

function filesUnder(dir: string, keep: (p: string) => boolean): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

test('the desktop check stays one more release: one job that only succeeds, on every pull request and push to main, still required (#746, #877)', () => {
  const ci = parse(readFileSync(join(workflows, 'ci.yml'), 'utf8')) as Workflow;
  assert.deepEqual(notOnlySuccess(ci.jobs?.desktop), [], 'ci.yml\'s desktop job: one `true` step on GitHub\'s runner, nothing that could skip, fail or rename it');
  assert.deepEqual(workflowProblems(ci), [], 'ci.yml runs on every push to main (where the updater reads it) and every pull request, with no filter and no workflow defaults');
  assert.deepEqual(desktopMakers(workflows), ['ci.yml:desktop'], 'one job makes the desktop check: no second run of that name, in any file, ci.yml included, can hide or be read for the no-op (a name this can\'t evaluate counts as one)');
  assert.ok(requiredChecks().includes('desktop'), 'config.yaml still requires desktop, until #877 removes the job and the check together');
  assert.ok(updaterDefaults().includes('desktop'), 'a new install\'s updater still lists desktop, until #877');
});

/**
 * A second workflow's job, and whether it may make a `desktop` check. True ones would give an updater a second
 * `desktop` run that could be red (the "red twin"); the false ones show the fail-closed rule isn't "every name".
 * The first seven are the second adversarial review's (#746); the four it found missed come after the controls.
 */
const TWIN_FIXTURES: [string, string, boolean][] = [
  ['a job keyed desktop', 'jobs:\n  desktop:\n    runs-on: x\n', true],
  ['name: desktop', 'jobs:\n  shots:\n    name: desktop\n    runs-on: x\n', true],
  ['a matrix axis, ${{ matrix.view }}', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: x\n', true],
  ['a matrix of include entries only', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy:\n      matrix:\n        include:\n          - view: desktop\n          - view: phone\n    runs-on: x\n', true],
  ['no spaces, ${{matrix.view}}', 'jobs:\n  shots:\n    name: ${{matrix.view}}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: x\n', true],
  ['a camelCase key, ${{ matrix.viewName }}', 'jobs:\n  shots:\n    name: ${{ matrix.viewName }}\n    strategy: { matrix: { viewName: [desktop, phone] } }\n    runs-on: x\n', true],
  ["a literal expression, ${{ 'desktop' }}", "jobs:\n  shots:\n    name: ${{ 'desktop' }}\n    runs-on: x\n", true],
  ['another case, ${{ MATRIX.View }}', 'jobs:\n  shots:\n    name: ${{ MATRIX.View }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: x\n', true],
  ['an include entry merged into an axis combination', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { os: [a], include: [{ os: a, view: desktop }] } }\n    runs-on: x\n', true],
  ['an include entry that fits no combination, added as its own', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [phone], include: [{ view: desktop }] } }\n    runs-on: x\n', true],
  ['a matrix from an expression', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: "${{ fromJSON(needs.plan.outputs.views) }}" }\n    runs-on: x\n', true],
  ['an axis from an expression, the name not using it (unreadable, so it fails closed)','jobs:\n  shots:\n    strategy: { matrix: { view: "${{ fromJSON(needs.plan.outputs.views) }}" } }\n    runs-on: x\n', true],
  ['another context, ${{ github.job }}', 'jobs:\n  shots:\n    name: ${{ github.job }}\n    runs-on: x\n', true],
  ['a matrix key the matrix lacks', 'jobs:\n  shots:\n    name: ${{ matrix.other }}\n    strategy: { matrix: { view: [phone] } }\n    runs-on: x\n', true],
  // Round 4 (#746 delta check): a matrix with no combination at all fails closed, whatever GitHub makes of it.
  ['a job keyed desktop, an empty matrix', 'jobs:\n  desktop:\n    strategy: { matrix: {} }\n    runs-on: x\n', true],
  ['a job keyed desktop, an empty include', 'jobs:\n  desktop:\n    strategy: { matrix: { include: [] } }\n    runs-on: x\n', true],
  ['a job keyed desktop, an empty axis', 'jobs:\n  desktop:\n    strategy: { matrix: { view: [] } }\n    runs-on: x\n', true],
  ['name: desktop, every combination excluded', 'jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { view: [a], exclude: [{ view: a }] } }\n    runs-on: x\n', true],
  // Round 4 (#746 second adversarial review, round 3): shapes GitHub may read otherwise than this helper fail closed.
  ['matrix keys that differ only in case', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop], include: [{ View: phone }] } }\n    runs-on: x\n', true],
  ['a merge key, the name overridden', 'jobs:\n  base: &base\n    name: shots\n    runs-on: x\n  shots2:\n    <<: *base\n    name: desktop\n', true],
  ['a merge key, the name from the anchor', 'env:\n  X: &n { name: desktop }\njobs:\n  shots:\n    <<: *n\n    runs-on: x\n', true],
  ["name: '' on a job keyed desktop", "jobs:\n  desktop:\n    name: ''\n    runs-on: x\n", true],
  // Round 5 (#746 delta check): a merge key above the job level fails closed too.
  ['a merge key under jobs:, from an anchor', "x: &j { desktop: { runs-on: x, steps: [ { run: 'false' } ] } }\njobs:\n  <<: *j\n  shots:\n    runs-on: x\n", true],
  ['a merge key at the workflow root', "x: &w { jobs: { desktop: { runs-on: x, steps: [ { run: 'false' } ] } } }\n<<: *w\n", true],
  ['a merge key under jobs:, inline', 'jobs:\n  <<: { desktop: { runs-on: x } }\n', true],
  // Round 5 (#746 third adversarial review): names GitHub may trim, and matrix values it may drop, fail closed.
  ['F1 a trailing space, "desktop "', 'jobs:\n  shots:\n    name: "desktop "\n    runs-on: x\n', true],
  ['F1 a leading space, " desktop"', 'jobs:\n  shots:\n    name: " desktop"\n    runs-on: x\n', true],
  ['F2 a | block scalar (keeps a line break)', 'jobs:\n  shots:\n    name: |\n      desktop\n    runs-on: x\n', true],
  ['F2 a >+ block scalar', 'jobs:\n  shots:\n    name: >+\n      desktop\n\n    runs-on: x\n', true],
  ['F3 a no-break space after desktop', 'jobs:\n  shots:\n    name: "desktop\\u00a0"\n    runs-on: x\n', true],
  ['F3 a zero-width space after desktop', 'jobs:\n  shots:\n    name: "desktop\\u200b"\n    runs-on: x\n', true],
  ["F4 name: desktop, a matrix value ''", "jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { v: [''] } }\n    runs-on: x\n", true],
  ["F4 a job keyed desktop, a matrix value ''", "jobs:\n  desktop:\n    strategy: { matrix: { v: [''] } }\n    runs-on: x\n", true],
  ["F4 name: desktop, a blank matrix value '  '", "jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { v: ['  '] } }\n    runs-on: x\n", true],
  ['F5 name: desktop, a null matrix value', 'jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { v: [~] } }\n    runs-on: x\n', true],
  ['F5 name: desktop, an object matrix value', 'jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { v: [{}] } }\n    runs-on: x\n', true],
  ['F5 a job keyed desktop, a null matrix value', 'jobs:\n  desktop:\n    strategy: { matrix: { v: [~] } }\n    runs-on: x\n', true],
  ['F5 a job keyed desktop, an object matrix value', 'jobs:\n  desktop:\n    strategy: { matrix: { v: [{}] } }\n    runs-on: x\n', true],
  ['F5 a job keyed desktop, a null value in an include entry', 'jobs:\n  desktop:\n    strategy: { matrix: { include: [{ v: ~ }] } }\n    runs-on: x\n', true],
  ['R2 Name: desktop (another case)', 'jobs:\n  shots:\n    Name: desktop\n    runs-on: x\n', true],
  ['R2 Jobs: (another case) with a job keyed desktop', 'Jobs:\n  desktop:\n    runs-on: x\n', true],
  // Round 6 (#746 adversarial review): merge keys in every spelling, files that aren't plain mappings, names outside
  // printable ASCII, and keys that fold to `jobs` the Unicode way.
  ['%YAML 1.1 merge key, an explicit name over the anchor', "%YAML 1.1\n---\nenv:\n  X: &n { name: desktop }\njobs:\n  shots:\n    <<: *n\n    name: shots\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['%YAML 1.1 merge key under jobs:, an explicit job over it', "%YAML 1.1\n---\nx: &j { twin: { name: desktop, runs-on: x } }\njobs:\n  <<: *j\n  twin:\n    name: shots\n    runs-on: x\n", true],
  ['!!merge tag, an explicit name over the anchor', "env:\n  X: &n { name: desktop }\njobs:\n  shots:\n    !!merge <<: *n\n    name: shots\n    runs-on: x\n", true],
  ['jobs: !!omap', '%YAML 1.1\n---\njobs: !!omap\n  - twin: { name: desktop, runs-on: x }\n', true],
  ['jobs: a list', 'jobs:\n  - desktop\n', true],
  ['jobs: empty', 'on: push\njobs:\n', true],
  ['a root that is a scalar', 'desktop\n', true],
  ['a root key that folds to jobs, "job\\u017f"', '"job\\u017f":\n  desktop:\n    runs-on: x\n', true],
  ['a name with a NUL escape', 'jobs:\n  shots:\n    name: "desktop\\0"\n    runs-on: x\n', true],
  ['a name with ESC', 'jobs:\n  shots:\n    name: "desktop\\e"\n    runs-on: x\n', true],
  ['a name with DEL', 'jobs:\n  shots:\n    name: "desktop\\x7f"\n    runs-on: x\n', true],
  ['a name with a C1 control', 'jobs:\n  shots:\n    name: "desktop\\x9b"\n    runs-on: x\n', true],
  ['a name with U+034F', 'jobs:\n  shots:\n    name: "desktop\\u034f"\n    runs-on: x\n', true],
  ['a name with U+FE0F', 'jobs:\n  shots:\n    name: "desktop\\ufe0f"\n    runs-on: x\n', true],
  ['a name with U+3164', 'jobs:\n  shots:\n    name: "desktop\\u3164"\n    runs-on: x\n', true],
  ['a name with U+2800', 'jobs:\n  shots:\n    name: "desktop\\u2800"\n    runs-on: x\n', true],
  // Round 7 (#746 delta check): matrix keys outside ASCII, and values that are neither plain mappings nor scalars.
  ['X1 a job that is an !!omap', '%YAML 1.1\n---\njobs:\n  twin: !!omap\n    - name: desktop\n    - runs-on: x\n', true],
  ['X2 a job that is a list', 'jobs:\n  twin:\n    - name: desktop\n', true],
  ['X3 a job that is a scalar', 'jobs:\n  twin: desktop\n', true],
  ['X6 a matrix key U+017F, name ${{ matrix.s }}, a job keyed desktop', 'jobs:\n  desktop:\n    name: ${{ matrix.s }}\n    strategy: { matrix: { "\\u017f": [phone] } }\n    runs-on: x\n', true],
  ['X6b the same, a job keyed shots', 'jobs:\n  shots:\n    name: ${{ matrix.s }}\n    strategy: { matrix: { "\\u017f": [phone] } }\n    runs-on: x\n', true],
  ['X16 matrix keys U+00DF and U+1E9E', 'jobs:\n  shots:\n    strategy: { matrix: { "\\u00df": [a], "\\u1e9e": [b] } }\n    runs-on: x\n', true],
  ['X17 a matrix key U+00DF, name ${{ matrix.ss }}, a job keyed desktop', 'jobs:\n  desktop:\n    name: ${{ matrix.ss }}\n    strategy: { matrix: { "\\u00df": [phone] } }\n    runs-on: x\n', true],
  ['a root key with a no-break space, "jobs\\u00a0"', '"jobs\\u00a0":\n  desktop:\n    runs-on: x\n', true],
  ['a root key with a trailing space, "jobs "', '"jobs ":\n  desktop:\n    runs-on: x\n', true],
  ['a name with more around the value', 'jobs:\n  shots:\n    name: shots ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: x\n', false],
  ['no name: the values in parentheses', 'jobs:\n  shots:\n    strategy: { matrix: { view: [desktop] } }\n    runs-on: x\n', false],
  ['no name, include entries only', 'jobs:\n  shots:\n    strategy: { matrix: { include: [{ view: desktop }] } }\n    runs-on: x\n', false],
  ['desktop excluded', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone], exclude: [{ view: desktop }] } }\n    runs-on: x\n', false],
  ['an include entry that adds a key only', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [phone], include: [{ size: big }] } }\n    runs-on: x\n', false],
];

/** ci.yml with only the no-op job, as the fixtures start from. */
const NOOP_CI = "jobs:\n  desktop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n";

/**
 * A second job INSIDE ci.yml that makes a `desktop` check (round 4: the backstop counted files, so these passed).
 * v0.5.2 keeps only the run of a name that started last: a red twin that started first is never read, and it
 * installs (measured by the second adversarial review), so these are fail-open twins, not only stalls.
 */
const CI_TWIN_FIXTURES: [string, string][] = [
  ['name: desktop, a failing step', "  desktop-screens:\n    name: desktop\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ["name: ${{ 'desktop' }}", "  shots:\n    name: ${{ 'desktop' }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ['a matrix over [desktop, phone]', "  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ['a merge key under jobs: bringing in a red name: desktop job (round 5)', "  <<: { desktop-red: { name: desktop, runs-on: x, steps: [ { run: 'false' } ] } }\n"],
];

/** A workflow file name the backstop must read: `.yml` or `.yaml`, any case. */
const FILE_NAME_FIXTURES = ['other.YML', 'other.Yaml'];

/** Workflow files whose bytes this can't read as GitHub might (round 6): each holds a `name: desktop` job. */
const BYTE_FIXTURES: [string, Buffer][] = [
  ['UTF-16LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('jobs:\n  twin:\n    name: desktop\n    runs-on: x\n', 'utf16le')])],
  ['UTF-16BE with a BOM', Buffer.from(String.fromCharCode(0xfeff) + 'jobs:\n  twin:\n    name: desktop\n    runs-on: x\n', 'utf16le').swap16()],
  ['a NUL byte in a comment', Buffer.from('jobs:\n  twin:\n    name: shots\n    runs-on: x\n# ' + String.fromCharCode(0) + '\n')],
];

test('a second job that may make a desktop check is caught, in another workflow or in ci.yml, whatever its name is built from (#746 adversarial reviews)', () => {
  const makers = (files: Record<string, string | Buffer>) => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), NOOP_CI);
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return desktopMakers(dir);
  };
  assert.deepEqual(makers({}), ['ci.yml:desktop'], 'the no-op job alone');
  for (const [label, yml, makes] of TWIN_FIXTURES) {
    const got = makers({ 'other.yml': yml });
    assert.equal(got[0], 'ci.yml:desktop', label);
    assert.equal(got.length > 1, makes, `${label}: ${JSON.stringify(got)}`);
  }
  for (const [label, job] of CI_TWIN_FIXTURES) {
    const got = makers({ 'ci.yml': NOOP_CI + job });
    assert.equal(got.length, 2, `in ci.yml, ${label}: ${JSON.stringify(got)}`);
    assert.equal(got[0], 'ci.yml:desktop');
  }
  for (const f of FILE_NAME_FIXTURES) assert.deepEqual(makers({ [f]: 'jobs:\n  desktop:\n    runs-on: x\n' }), ['ci.yml:desktop', `${f}:desktop`], f);
  for (const [label, bytes] of BYTE_FIXTURES) assert.deepEqual(makers({ 'other.yml': bytes }), ['ci.yml:desktop', 'other.yml:?'], label);
});

/**
 * ci.yml as the round 7 text fixtures start from: the real triggers and the no-op job, and a matrix job making
 * `test (ubuntu-latest, 22)` and `(..., 24)`, so a hidden twin or condition is the only thing wrong.
 */
const BASE_CI = "on:\n  push:\n    branches: [main]\n  pull_request:\n    types: [opened, synchronize, reopened]\njobs:\n  desktop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22, 24] } }\n    runs-on: x\n";

/**
 * Round 7 (#746 adversarial review of 80395fcb): text another YAML reader (libyaml and its ports) reads otherwise.
 * A lone CR, NEL, LS or PS ends a comment there but not here, so the rest of the line is hidden from this reader; a
 * BOM at a line start is skipped there but read as part of a key here; `%YAML 1.1` makes `022` octal here. Each file
 * must count as unsure (`<file>:?`). [label, file, text, unsure]
 */
const UNSURE_TEXT_FIXTURES: [string, string, string, boolean][] = [
  ['L1 NEL ends a comment, then name: desktop', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n    # c' + String.fromCharCode(0x85) + '    name: desktop\n', true],
  ['L2 LS, then permissions: write-all', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n    # c' + String.fromCharCode(0x2028) + '    permissions: write-all\n', true],
  ['L3 PS, then a second job named desktop', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n  # c' + String.fromCharCode(0x2029) + '  u:\n    name: desktop\n', true],
  ['L4 LS, then a test (ubuntu-latest, 22) twin', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n  # c' + String.fromCharCode(0x2028) + '  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22] } }\n', true],
  ['L5 NEL, then root permissions: { checks: write }', 'other.yml', 'on: push # c' + String.fromCharCode(0x85) + 'permissions: { checks: write }\njobs:\n  t:\n    runs-on: x\n', true],
  ["L6 in ci.yml's desktop job: LS, then if: false", 'ci.yml', BASE_CI.replace("      - run: 'true'\n", "      - run: 'true'\n    # c" + String.fromCharCode(0x2028) + '    if: false\n'), true],
  ['R1 a lone CR ends a comment, then name: desktop', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n    # c' + String.fromCharCode(13) + '    name: desktop\n', true],
  ['R2 a lone CR, then permissions: write-all', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n    # c' + String.fromCharCode(13) + '    permissions: write-all\n', true],
  ["B1' a BOM and a space at a line start, a second job named desktop", 'other.yml', 'jobs:\n  t:\n    runs-on: x\n' + String.fromCharCode(0xfeff) + " u:\n    name: desktop\n    steps: [ { run: 'false' } ]\n", true],
  ["B2' a BOM and 3 spaces, name: desktop in a job", 'other.yml', 'jobs:\n  t:\n    runs-on: x\n' + String.fromCharCode(0xfeff) + '   name: desktop\n', true],
  ["B3' a BOM and 3 spaces, permissions: write-all in a job", 'other.yml', 'jobs:\n  t:\n    runs-on: x\n' + String.fromCharCode(0xfeff) + '   permissions: write-all\n', true],
  ["B4' a BOM at a line start, root permissions", 'other.yml', ' on: push\n' + String.fromCharCode(0xfeff) + 'permissions: { checks: write }\n jobs:\n  t:\n    runs-on: x\n', true],
  ["B5' in ci.yml, a BOM and a space, a second job named desktop", 'ci.yml', BASE_CI + String.fromCharCode(0xfeff) + " shots:\n    name: desktop\n    steps: [ { run: 'false' } ]\n", true],
  ["B6' a BOM and a space, a test (ubuntu-latest, 22) twin", 'other.yml', 'jobs:\n  t:\n    runs-on: x\n' + String.fromCharCode(0xfeff) + ' test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22] } }\n', true],
  ["C1 in ci.yml's desktop job, a BOM and 3 spaces, if: false", 'ci.yml', BASE_CI.replace('  desktop:\n    runs-on: ubuntu-latest\n', '  desktop:\n    runs-on: ubuntu-latest\n' + String.fromCharCode(0xfeff) + '   if: false\n'), true],
  ["C2 in ci.yml's desktop job, a BOM and 3 spaces, a rename", 'ci.yml', BASE_CI.replace('  desktop:\n    runs-on: ubuntu-latest\n', '  desktop:\n    runs-on: ubuntu-latest\n' + String.fromCharCode(0xfeff) + '   name: renamed\n'), true],
  ['C3 in ci.yml, a BOM and 3 spaces, a paths filter on push', 'ci.yml', BASE_CI.replace('    branches: [main]\n', '    branches: [main]\n' + String.fromCharCode(0xfeff) + '   paths: [x]\n'), true],
  ['%YAML 1.1: node 022 reads as octal 18, a test (ubuntu-latest, 22) twin elsewhere', 'other.yml', '%YAML 1.1\n---\njobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [022] } }\n    runs-on: x\n', true],
  ['%YAML 1.2 (any directive)', 'other.yml', '%YAML 1.2\n---\njobs:\n  t:\n    runs-on: x\n', true],
  ['%TAG', 'other.yml', '%TAG !e! tag:yaml.org,2002:\n---\njobs:\n  t:\n    name: !e!str shots\n    runs-on: x\n', true],
  ['control: a BOM at offset 0 only', 'other.yml', String.fromCharCode(0xfeff) + 'jobs:\n  t:\n    runs-on: x\n', false],
  ['control: TAB in a comment', 'other.yml', 'jobs:\n  t:\n    runs-on: x # a\tb\n', false],
];

/**
 * Round 8 (#746 adversarial review of abff5d0d): plain-ASCII jobs that GitHub may name as a twin of
 * `test (ubuntu-latest, 22)` (BASE_CI makes it) where JS object and number semantics named them otherwise, and a
 * literal name of the `<caller> / <callee>` shape. Each must leave checkTwins non-empty. [label, other.yml]
 */
const NAME_TWIN_FIXTURES: [string, string][] = [
  ['A1 an include entry with a key toString', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], include: [ { toString: 22 } ] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A1 an include entry with a key constructor', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], include: [ { constructor: 22 } ] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A2 an integer-like axis key "1"', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], \"1\": [22] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A2 an integer-like key "1" in an include entry', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], include: [ { \"1\": 22 } ] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A3 a value 22.00000000000001 in the suffix', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22.00000000000001] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A3 a value 22.00000000000001 through ${{ matrix.node }}', "jobs:\n  twin:\n    name: test (ubuntu-latest, ${{ matrix.node }})\n    strategy: { matrix: { node: [22.00000000000001] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['A4 a literal name full-ci / scope', "jobs:\n  twin:\n    name: full-ci / scope\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  // Round 9: a whole `strategy` that is an expression (GitHub may expand it), and a -0 matrix value.
  ['R9-1 a job keyed test, its whole strategy an expression', "jobs:\n  test:\n    strategy: >-\n      ${{ fromJSON('{\"matrix\":{\"os\":[\"ubuntu-latest\"],\"node\":[22]}}') }}\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['R9-1 a job keyed bootstrap, its whole strategy an expression', "jobs:\n  bootstrap:\n    strategy: >-\n      ${{ fromJSON('{\"matrix\":{\"os\":[\"ubuntu-latest\"]}}') }}\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['R9-4 a matrix value -0', "jobs:\n  lint:\n    strategy: { matrix: { v: [-0] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
];

test('a job GitHub may name as a twin of another check is caught: matrix keys, numbers, reusable-workflow names (round 8)', () => {
  const REQUIRED = ['desktop', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)'];
  const base = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(base, 'ci.yml'), BASE_CI);
  assert.deepEqual(checkTwins(base, REQUIRED), [], 'BASE_CI alone');
  for (const [label, yml] of NAME_TWIN_FIXTURES) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), BASE_CI);
    writeFileSync(join(dir, 'other.yml'), yml);
    assert.notDeepEqual(checkTwins(dir, REQUIRED), [], label);
  }
  // Integer matrix values below 1e15, and identifier keys, still resolve: a plain matrix is no twin.
  const ok = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(ok, 'ci.yml'), BASE_CI);
  writeFileSync(join(ok, 'other.yml'), 'jobs:\n  lint:\n    strategy: { matrix: { node_v: [22, 999999999999999], os-x: [a] } }\n    runs-on: x\n');
  assert.deepEqual(checkTwins(ok, REQUIRED), [], 'lint (22, a), lint (999999999999999, a)');
});

/** BASE_CI with two plain jobs, `dco` (required) and `build` (not), for the round 10 skipped-matrix fixtures. */
const BARE_BASE_CI = BASE_CI + '  dco:\n    runs-on: x\n  build:\n    runs-on: x\n';

/**
 * Round 10 (#746 adversarial review of f5fafeca): a matrix job with an `if:` or `needs:` that GitHub skips gets one
 * check run under its bare name, which this didn't count. Each makes a skipped twin of a name BARE_BASE_CI makes, so
 * checkTwins must report it. [label, file, text]; a `ci.yml` row is the whole ci.yml.
 */
const BARE_NAME_FIXTURES: [string, string, string][] = [
  ['S1 a job keyed desktop, a matrix, if: false', 'other.yml', "jobs:\n  desktop:\n    if: false\n    strategy: { matrix: { v: [a] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['S1b the same, an if false on push and pull_request', 'other.yml', "jobs:\n  desktop:\n    if: github.event_name == 'schedule'\n    strategy: { matrix: { v: [a] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['S2 name: desktop, a matrix, needs: a failing job', 'other.yml', "jobs:\n  gate:\n    runs-on: x\n    steps: [ { run: 'false' } ]\n  shots:\n    name: desktop\n    needs: gate\n    strategy: { matrix: { view: [phone, tablet] } }\n    runs-on: x\n"],
  ['S3 a job keyed build (not required), a matrix, needs: a slow job, if: false', 'other.yml', "jobs:\n  slow:\n    runs-on: x\n    steps: [ { run: 'sleep 600' } ]\n  build:\n    needs: slow\n    if: false\n    strategy: { matrix: { v: [a] } }\n    runs-on: x\n"],
  ['S4 a job keyed dco (required), a matrix, if: false', 'other.yml', 'jobs:\n  dco:\n    if: false\n    strategy: { matrix: { v: [a] } }\n    runs-on: x\n'],
  ['S5 in ci.yml, a second job named desktop, a matrix, if: false', 'ci.yml', BARE_BASE_CI + "  shots:\n    name: desktop\n    if: false\n    strategy: { matrix: { view: [phone] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n"],
  ['S6 a reusable-workflow caller keyed desktop, a matrix, if: false', 'other.yml', 'jobs:\n  desktop:\n    if: false\n    strategy: { matrix: { v: [a] } }\n    uses: ./.github/workflows/ci-slow.yml\n'],
  ['S7 an include-only matrix, name: desktop, if: false', 'other.yml', 'jobs:\n  shots:\n    name: desktop\n    if: false\n    strategy: { matrix: { include: [ { view: phone } ] } }\n    runs-on: x\n'],
  ['G2 a job keyed desktop, name ${{ matrix.v }}, if: false (the bare name stays unresolved)', 'other.yml', 'jobs:\n  desktop:\n    name: ${{ matrix.v }}\n    if: false\n    strategy: { matrix: { v: [phone] } }\n    runs-on: x\n'],
];

test('a skipped matrix job twins its bare name: an if: or needs: on a matrix job makes it (round 10)', () => {
  const REQUIRED = ['desktop', 'dco', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)'];
  const base = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(base, 'ci.yml'), BARE_BASE_CI);
  assert.deepEqual(checkTwins(base, REQUIRED), [], 'BARE_BASE_CI alone');
  for (const [label, file, text] of BARE_NAME_FIXTURES) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), BARE_BASE_CI);
    writeFileSync(join(dir, file), text);
    assert.notDeepEqual(checkTwins(dir, REQUIRED), [], label);
  }
  // A matrix job with no if: or needs: makes only its expanded names, as before.
  const ok = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(ok, 'ci.yml'), BARE_BASE_CI);
  writeFileSync(join(ok, 'other.yml'), 'jobs:\n  desktop2:\n    name: lint\n    strategy: { matrix: { v: [a] } }\n    runs-on: x\n');
  assert.deepEqual(checkTwins(ok, REQUIRED), [], 'lint (a) only');
});

test('a file another YAML reader may read otherwise counts as unsure: hidden line breaks, BOMs past the start, directives (round 7)', () => {
  const REQUIRED = ['desktop', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)'];
  for (const [label, file, text, unsure] of UNSURE_TEXT_FIXTURES) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), BASE_CI);
    writeFileSync(join(dir, file), text);
    const makers = desktopMakers(dir);
    if (unsure) assert.ok(makers.includes(`${file}:?`), `${label}: ${JSON.stringify(makers)}`);
    else {
      assert.deepEqual(makers, ['ci.yml:desktop'], label);
      assert.deepEqual(checkTwins(dir, REQUIRED), [], label);
    }
  }
});

test('matrix names expand as GitHub gives them: include, exclude, case and spacing', () => {
  const names = (yml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'w.yml'), yml);
    return [...fileJobNames(join(dir, 'w.yml'))].sort();
  };
  assert.deepEqual(names('jobs:\n  s:\n    name: v ${{matrix.View}}\n    strategy: { matrix: { include: [{ view: a }, { view: b }] } }\n'), ['v a', 'v b']);
  assert.deepEqual(names('jobs:\n  s:\n    strategy: { matrix: { os: [x, y], exclude: [{ os: y }], include: [{ os: x, n: 1 }, { os: z }] } }\n'), ['s (x, 1)', 's (z)']);
  assert.deepEqual(names('jobs:\n  s:\n    name: ${{ matrix.os }}-${{ matrix.n }}\n    strategy: { matrix: { os: [x], n: [1, 2], include: [{ n: 2, extra: e }] } }\n'), ['x-1', 'x-2']);
});

test('the no-op shape check catches whatever could make the desktop check anything but success', () => {
  const ok = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] };
  assert.deepEqual(notOnlySuccess(ok), []);
  assert.deepEqual(notOnlySuccess(undefined), ['no such job'], 'the job removed before its check: v0.5.2 installs would wait forever');
  assert.deepEqual(notOnlySuccess({ if: "github.event_name == 'pull_request'", ...ok }), ['has if'], 'skipped on main: a v0.5.2 updater refuses a skipped required check');
  assert.deepEqual(notOnlySuccess({ ...ok, needs: 'test-22' }), ['has needs']);
  assert.deepEqual(notOnlySuccess({ ...ok, name: 'desktop (no-op)' }), ['has name'], 'renamed: the check "desktop" would never run again');
  assert.deepEqual(notOnlySuccess({ ...ok, 'continue-on-error': true }), ['has continue-on-error']);
  assert.deepEqual(notOnlySuccess({ ...ok, steps: [{ run: 'false' }] }), ['steps [{"run":"false"}]']);
  assert.deepEqual(notOnlySuccess({ ...ok, steps: [{ uses: 'actions/checkout@x' }, { run: 'true' }] }), ['steps [{"uses":"actions/checkout@x"},{"run":"true"}]']);
  assert.deepEqual(notOnlySuccess({ ...ok, 'runs-on': ['self-hosted'] }), ['runs-on ["self-hosted"]']);
});

test('the workflow check catches a filter on either trigger, a narrowed or dropped trigger, and workflow defaults', () => {
  const pr = CI_ON.pull_request;
  const wf = (on: Record<string, unknown>, extra: Record<string, unknown> = {}): Workflow => ({ on, ...extra });
  assert.deepEqual(workflowProblems(wf({ ...CI_ON })), []);
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, paths: ['src/**'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"paths":["src/**"]}'], 'a PR paths filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, 'paths-ignore': ['docs/**'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"paths-ignore":["docs/**"]}'], 'a PR paths-ignore filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { ...pr, branches: ['release'] } })), ['on.pull_request {"types":["opened","synchronize","reopened"],"branches":["release"]}'], 'a PR branches filter');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, pull_request: { types: ['closed'] } })), ['on.pull_request {"types":["closed"]}'], 'PR types narrowed');
  assert.deepEqual(workflowProblems(wf({ push: CI_ON.push })), ['on.pull_request undefined'], 'the PR trigger dropped');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON, push: { branches: ['main'], paths: ['src/**'] } })), ['on.push {"branches":["main"],"paths":["src/**"]}'], 'a push paths filter: main commits without a run strand v0.5.2');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON }, { defaults: { run: { shell: 'false {0}' } } })), ['defaults {"run":{"shell":"false {0}"}}'], 'a workflow-level shell that fails every run step');
  assert.deepEqual(workflowProblems(wf({ ...CI_ON }, { env: { BASH_ENV: '/nonexistent' } })), ['env {"BASH_ENV":"/nonexistent"}'], 'a workflow-level env the step\'s shell reads');
});

test('the desktop app is gone: its folder, module, build script, notice and docs', () => {
  for (const p of ['desktop', join('src', 'desktop.ts'), join('test', 'desktop.test.ts')]) assert.ok(!existsSync(join(repoRoot, p)), `${p} is removed`);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(!('build:desktop' in pkg.scripts), 'no build:desktop script');

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
});

test('the release notes say what replaces it, that the desktop check stays one more release, and that v0.5.2 installs rerun updates.sh', () => {
  // The fragment until the release step moves it into CHANGELOG.md: read both, so the release PR passes too.
  const dir = join(repoRoot, 'changelog.d');
  const notes = [join(repoRoot, 'CHANGELOG.md'), ...readdirSync(dir).filter((f) => f !== 'README.md').map((f) => join(dir, f))].map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.match(notes, /desktop window[^\n]*removed[^\n]*#744/i);
  assert.match(notes, /open the dashboard in (a|your) browser/i);
  assert.match(notes, /`desktop` (CI )?check stays[^\n]*one more release/i);
  assert.match(notes, /v0\.5\.2 installs[^\n]*rerun `updates\.sh` once/i);
});

test('the fixture helpers read a real tree: this test would see a desktop job if one came back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(dir, 'ci.yml'), 'jobs:\n  desktop:\n    runs-on: x\n');
  assert.ok(jobNames(dir).has('desktop'));
  assert.ok(NAMES_IT.test('The optional desktop window (`desktop/`) is built with Tauri'));
  assert.ok(!NAMES_IT.test('screenshots (desktop, dark mode, phone width)'), 'the word alone, for a viewport, is fine');
});
