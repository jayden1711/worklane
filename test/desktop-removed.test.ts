// lint-test
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
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isNode, isPair, isScalar, parse, parseDocument, visit } from 'yaml';
import { fileURLToPath } from 'node:url';
import { LINT_MARK, registrationsOf, weakeningReasons } from '../src/merge-policy-weakening.js';

/**
 * The repo's top, from this file's built place (dist/test/). Computed here, not imported from test/helpers.ts: that
 * file is no guard, so a changed line there is held by nothing, and it could point this backstop at another tree or
 * patch what it reads (round 18). Everything this file runs is in it, in test/isolate.ts (a guard file) or in src/.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

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
 * A job's matrix combinations as GitHub builds them: the product of its axes, each a Map in axis order. Null when
 * this can't tell: a matrix that isn't written out (an expression such as `${{ fromJSON(...) }}`, for the matrix or
 * an axis), and any matrix with an `include` or `exclude` key (round 17; readWorkflow makes its whole file unsure).
 * The caller then treats the job's name as unresolved. Maps, so no key is ever read from Object.prototype
 * (`toString`, `constructor`) and integer-like keys keep their place (round 8).
 */
function matrixCombos(matrix: unknown): Map<string, unknown>[] | null {
  if (!isRecord(matrix)) return null;
  // An expression anywhere in the matrix, key or value: GitHub evaluates it, where this would read it as text
  // (round 11).
  if (JSON.stringify(matrix).includes('${{')) return null;
  // `include` and `exclude`, in any case: how GitHub merges include entries and names the jobs they make (A7, D1, B1,
  // R9-3) was a guess three rounds running, so the class is refused, not modelled (round 17). No workflow uses either.
  if (Object.keys(matrix).some((k) => isListKey(k))) return null;
  const axes = matrix;
  if (!Object.values(axes).every(Array.isArray)) return null;
  // Keys that differ only in case (`view` and `View`): whether GitHub reads them as one key is unsure, and the
  // combinations differ either way, so the matrix counts as unreadable.
  const keys = Object.keys(axes);
  // A key outside a closed identifier set makes the matrix unreadable. That covers a key outside printable ASCII
  // (U+017F long s, U+00DF sharp s, U+212A Kelvin: whether `matrix.s` or `matrix.ss` reaches it is unsure; round 7),
  // an integer-like key such as `"1"` (JS lists those first, GitHub keeps the file's order; round 8), and
  // `__proto__`.
  if (keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) || k === '__proto__')) return null;
  if (new Set(keys.map(fold)).size !== new Set(keys).size || new Set(keys.map((k) => k.toLowerCase())).size !== new Set(keys).size) return null;
  // A value that isn't a plain, non-blank scalar (null, an object or list, '' or blanks): how GitHub names the job
  // then (an empty or dropped suffix?) is unsure, so the matrix counts as unreadable (as src/check-pin-block.ts does).
  const values = (Object.values(axes) as unknown[][]).flat();
  if (values.some((v) => v === null || typeof v === 'object' || (typeof v === 'string' && v.trim() === ''))) return null;
  // A string value outside the closed set names keep to (unsureName): any character outside printable ASCII (a tab,
  // NEL from a `\N` escape, a no-break space; round 14), or a leading or trailing space (`'q '`; round 13). Whether
  // GitHub trims or folds it before it names the job is unsure, so the matrix is unreadable.
  if (values.some((v) => typeof v === 'string' && unsureName(v))) return null;
  // A number JS and GitHub may print differently makes the matrix unreadable: `22.00000000000001` (JS keeps the
  // digits, a 15-digit format drops them; round 8) and -0 (JS prints `0`, .NET `-0`; round 9). Every other integer
  // below 1e15 in size is taken to print the same both ways (inferred, not measured on GitHub). It is written in
  // plain decimal: readWorkflow makes a file with any other spelling (`0xffffffff`, `+22`, `22.0`) unsure (round 12).
  if (values.some((v) => typeof v === 'number' && (!(Number.isInteger(v) && Math.abs(v) < 1e15) || Object.is(v, -0)))) return null;
  // Two values of one key that differ, but match once printed and case-folded (`'1'` and `1`, `'true'` and `true`,
  // `Q` and `q`): whether GitHub tells them apart is unsure, so the matrix is unreadable (round 11).
  const byKey = new Map<string, unknown[]>();
  const note = (k: string, v: unknown) => byKey.set(fold(k), [...(byKey.get(fold(k)) ?? []), v]);
  for (const [k, vs] of Object.entries(axes) as [string, unknown[]][]) for (const v of vs) note(k, v);
  for (const vs of byKey.values()) {
    // One key holding values of two YAML types (`true` and `1`, `'1.0'` and `1`, `'1e0'` and `1`, `false` and `0`):
    // whether GitHub converts one to the other when it matches is unsure, so the matrix is unreadable (round 13).
    if (new Set(vs.map((v) => typeof v)).size > 1) return null;
    const seen = new Map<string, unknown>();
    for (const v of vs) {
      const loose = fold(String(v));
      if (seen.has(loose) && !same(seen.get(loose), v)) return null;
      seen.set(loose, v);
    }
  }
  let combos: Map<string, unknown>[] = keys.length ? [new Map()] : [];
  for (const [k, values] of Object.entries(axes) as [string, unknown[]][]) combos = combos.flatMap((c) => values.map((v) => new Map([...c, [k, v]])));
  return combos;
}

/** A matrix key GitHub reads as `include` or `exclude`, in any case (`Include`, `EXCLUDE`, a folded letter). */
const isListKey = (k: string) => ['include', 'exclude'].includes(fold(k)) || ['include', 'exclude'].includes(k.toLowerCase());

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
  // A matrix this can't read (an expression, an `include` or `exclude`), or one with no combination at all (`{}`, an
  // empty axis): what GitHub shows for it is unsure, possibly a failed job under its own name, so it fails closed.
  if (!combos || combos.length === 0) return new Set([`${name} (${UNRESOLVED} matrix ${JSON.stringify(matrix)} }})`]);
  for (const c of combos) {
    // GitHub's expression contexts and property names ignore case, and spacing inside ${{ }} is free.
    const vars = new Map([...c].map(([k, v]) => [fold(k), v]));
    if (name.includes(UNRESOLVED)) out.add(name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/gi, (m, k: string) => (vars.has(fold(k)) ? shown(vars.get(fold(k))) : m)));
    else out.add(c.size ? `${name} (${[...c.values()].map(shown).join(', ')})` : name);
  }
  // Fewer names than combinations: one job makes two runs of one name (a name that leaves out a key that varies, or
  // two equal combinations). A v0.5.2 updater reads only the newest run of a name, so a later green run hides a red
  // one; each combination is its own check run (measured on this repo's shards). Unresolved (round 15).
  if (out.size < combos.length) return new Set([`${key} (${UNRESOLVED} ${combos.length} combinations, ${out.size} names }})`]);
  // A matrix job with an `if:` or `needs:`: GitHub evaluates them before it expands the matrix, and a job skipped
  // there gets ONE check run under its bare name (`name:`, else the key; measured on this repo: ci-slow.yml's
  // `bootstrap`, skipped). So it also makes its bare name (round 10). A bare name holding `${{` stays unresolved.
  if (matrix !== undefined && Object.keys(job).some((k) => ['if', 'needs'].includes(fold(k)))) out.add(name);
  // A name holding ` / `: GitHub names a reusable workflow's jobs `<caller> / <callee job>`, which this doesn't
  // build, so a literal name of that shape may twin one (round 8). It fails closed like any unsure name. So does a
  // name over 100 characters, in case GitHub shortens it (guess; round 15). The real tree's longest has 34.
  return new Set([...out].map((n) => (unsureName(n) || n.includes(' / ') || n.length > 100 ? `${key} (${UNRESOLVED} name ${JSON.stringify(n)} }})` : n)));
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
 * - an explicit tag on any node, and a number scalar not written in plain decimal (round 12): GitHub resolves core
 *   tags, and reads hex and octal as 32-bit numbers, where `yaml` does neither;
 * - an anchor defined twice (round 15): which definition an alias gets may differ;
 * - a mapping key that isn't a string scalar (round 16): `true:` and `"true":` are one property in JS;
 * - a root, a `jobs`, or a job that isn't a plain mapping (a scalar, a list, `!!omap`), a `permissions` (at the root
 *   or in a job) that is neither a string nor a plain mapping, or any value anywhere that is neither a plain mapping,
 *   a list nor a scalar (a `Map`, a `Set`, binary data);
 * - any key outside printable ASCII (`jobs` and a no-break space), and a root key that is `jobs` in another case (`Jobs:`);
 * - a matrix with an `include` or `exclude` key, in any job (round 17): how GitHub merges and names include entries
 *   is not modelled. A workflow that needs one later changes this backstop, which waits for the owner (lint-test).
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
  // One walk over every node, keys included (a function visitor: an object one with a Scalar key skips Node for
  // scalars). Round 12, #746 second adversarial review of 00ed28c2:
  // - an explicit tag, any form (`!!float 22`, `!!str`, `!`, `!x`), on any node: `yaml` leaves `!!float 22` the
  //   string "22", GitHub's reader makes it the number 22 (inferred from the runner source);
  // - a number not written in plain decimal (`0xffffffff`, `0o17`, `+22`, `022`, `2.2e1`, `22.0`, `.5`, `.inf`):
  //   GitHub reads hex and octal as 32-bit, so `0xffffffff` is -1 there and 4294967295 here (inferred from the runner
  //   source), so a value can differ on GitHub only.
  // - an anchor defined twice (`&n desktop`, then `&n shots`): `yaml` resolves `*n` to the newest; whether GitHub's
  //   reader does too is unsure (round 15).
  // - a mapping key that isn't a string scalar (`true:`, `True:`, `~:`, `1:`, an alias, a list): JS makes it a
  //   property name, so `true:` and `"true":` fold into one, the last, where `yaml` and GitHub keep two keys; a red
  //   job under the first would be hidden here (round 16).
  let tagged = false;
  let number = false;
  let twice = false;
  let oddKey = false;
  const anchors = new Set<string>();
  visit(doc, (_, n) => {
    if (isPair(n) && !(isScalar(n.key) && typeof n.key.value === 'string')) oddKey = true;
    if (!isNode(n)) return;
    if (n.anchor !== undefined) {
      if (anchors.has(n.anchor)) twice = true;
      anchors.add(n.anchor);
    }
    if (n.tag !== undefined) tagged = true;
    if (isScalar(n) && ['number', 'bigint'].includes(typeof n.value) && !/^-?(0|[1-9][0-9]*)$/.test(n.source ?? '')) number = true;
  });
  if (twice) return unsure('an anchor defined twice');
  if (tagged) return unsure('an explicit tag');
  if (number) return unsure('a number not in plain decimal');
  if (oddKey) return unsure('a mapping key that is not a string');
  if (!plainAll(value)) return unsure('a value that is not a plain mapping, list or scalar, or a key outside printable ASCII');
  if (value.jobs !== undefined && !isRecord(value.jobs)) return unsure('jobs that are not a mapping');
  const jobs = Object.values(isRecord(value.jobs) ? value.jobs : {});
  if (!jobs.every(isRecord)) return unsure('a job that is not a mapping');
  const permsOk = (o: Record<string, unknown>) => Object.entries(o).every(([k, v]) => fold(k) !== 'permissions' || typeof v === 'string' || isRecord(v));
  if (!permsOk(value) || !(jobs as Record<string, unknown>[]).every(permsOk)) return unsure('permissions that are neither a string nor a mapping');
  // A matrix with an `include` or `exclude` key, in any job, any case (round 17): the class is refused (matrixCombos).
  const within = (o: unknown, name: string) => (isRecord(o) ? Object.entries(o).filter(([k]) => fold(k) === name).map(([, v]) => v) : []);
  const matrixLists = jobs.some((j) => within(j, 'strategy').some((s) => within(s, 'matrix').some((m) => isRecord(m) && Object.keys(m).some(isListKey))));
  if (matrixLists) return unsure('a matrix with include or exclude');
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
// check-table: never-grow
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
// check-table: never-shrink
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
  // Round 11 (#746 adversarial review of 094acd50): an expression inside a matrix value, and loose value matching.
  ['E1 an exclude by expression empties the product; include desktop and phone stand alone', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [q]\n        exclude: [ { k: \"${{ 'q' }}\" } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['E1b the axis value is the expression, the exclude literal', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [\"${{ 'q' }}\"]\n        exclude: [ { k: q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['E1c the conditional-exclude idiom', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [q]\n        exclude: [ { k: \"${{ github.event_name == 'push' && 'q' || 'none' }}\" } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['Q1 an exclude that differs in case only (q, Q)', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [q]\n        exclude: [ { k: Q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ["Q2 an exclude that differs in type only (1, '1')", "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [1]\n        exclude: [ { k: '1' } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ["Q3 an exclude by a string for a boolean (true, 'true')", "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [true]\n        exclude: [ { k: 'true' } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  // Round 12 (#746 second adversarial review of 00ed28c2): GitHub reads 0xffffffff as -1 (32-bit), `yaml` as
  // 4294967295, so the exclude empties the product on GitHub only, and include desktop and phone stand alone.
  ['H1b a hex exclude 0xffffffff against an axis -1; include desktop and phone stand alone on GitHub', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [-1]\n        exclude: [ { k: 0xffffffff } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  // Round 13 (the round 11 delta check's list, #948): pairs GitHub may match loosely where the helper doesn't. One
  // key holding values of two YAML types, or a string with a leading or trailing space, makes the matrix unreadable.
  ['Y1 an exclude 1 against an axis true', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [true]\n        exclude: [ { k: 1 } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ["Y2 an exclude 1 against an axis '1.0'", "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: ['1.0']\n        exclude: [ { k: 1 } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ["Y3 an exclude 1 against an axis '1e0'", "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: ['1e0']\n        exclude: [ { k: 1 } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['Y4 an exclude 0 against an axis false', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [false]\n        exclude: [ { k: 0 } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ["Y5 an exclude q against an axis 'q '", "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: ['q ']\n        exclude: [ { k: q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  // Round 14 (#746 delta check of b107cc97): NEL (U+0085), which JS `\s` doesn't match, through a YAML escape, so
  // the file's text stays ASCII. Any matrix string value outside printable ASCII makes the matrix unreadable.
  ['P1 an exclude q against an axis "q\\N" (NEL)', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [\"q\\N\"]\n        exclude: [ { k: q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['P2 an exclude q against an axis "q\\x85"', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [\"q\\x85\"]\n        exclude: [ { k: q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['P3 an exclude q against an axis "\\u0085q", NEL first', "jobs:\n  shots:\n    name: ${{ matrix.v }}\n    strategy:\n      matrix:\n        k: [\"\\u0085q\"]\n        exclude: [ { k: q } ]\n        include: [ { v: desktop }, { v: phone } ]\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['a name with more around the value', 'jobs:\n  shots:\n    name: shots ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: x\n', false],
  ['no name: the values in parentheses', 'jobs:\n  shots:\n    strategy: { matrix: { view: [desktop] } }\n    runs-on: x\n', false],
  // Round 17: a matrix with `include` or `exclude` makes the file unsure, so these three controls are now caught.
  ['no name, include entries only (round 17: unsure)', 'jobs:\n  shots:\n    strategy: { matrix: { include: [{ view: desktop }] } }\n    runs-on: x\n', true],
  ['desktop excluded (round 17: unsure)', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone], exclude: [{ view: desktop }] } }\n    runs-on: x\n', true],
  ['an include entry that adds a key only (round 17: unsure)', 'jobs:\n  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [phone], include: [{ size: big }] } }\n    runs-on: x\n', true],
  // Round 17 (#746 second adversarial review of f204b1b3): an exclude empties the product, so the include entry
  // stands alone with no axis value. Under A7's guess (a suffix may leave out a value outside the axes) GitHub names
  // it `desktop`, a red twin the round 16 helper read as `desktop (q)`.
  ['D1 a job keyed desktop, k: [a], exclude { k: a }, include { q: q }', "jobs:\n  desktop:\n    strategy: { matrix: { k: [a], exclude: [ { k: a } ], include: [ { q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['D1b the same under name: desktop', "jobs:\n  shots:\n    name: desktop\n    strategy: { matrix: { k: [a], exclude: [ { k: a } ], include: [ { q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
];

/** A fixture whose text has a matrix `include:` or `exclude:` key (round 17: its file must be unsure). */
const LIST_KEY = /\b(?:include|exclude):/;

/** ci.yml with only the no-op job, as the fixtures start from. */
const NOOP_CI = "jobs:\n  desktop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'true'\n";

/**
 * A second job INSIDE ci.yml that makes a `desktop` check (round 4: the backstop counted files, so these passed).
 * v0.5.2 keeps only the run of a name that started last: a red twin that started first is never read, and it
 * installs (measured by the second adversarial review), so these are fail-open twins, not only stalls.
 */
// check-table: never-shrink
const CI_TWIN_FIXTURES: [string, string][] = [
  ['name: desktop, a failing step', "  desktop-screens:\n    name: desktop\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ["name: ${{ 'desktop' }}", "  shots:\n    name: ${{ 'desktop' }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ['a matrix over [desktop, phone]', "  shots:\n    name: ${{ matrix.view }}\n    strategy: { matrix: { view: [desktop, phone] } }\n    runs-on: ubuntu-latest\n    steps:\n      - run: 'false'\n"],
  ['a merge key under jobs: bringing in a red name: desktop job (round 5)', "  <<: { desktop-red: { name: desktop, runs-on: x, steps: [ { run: 'false' } ] } }\n"],
];

/** A workflow file name the backstop must read: `.yml` or `.yaml`, any case. */
// check-table: never-shrink
const FILE_NAME_FIXTURES = ['other.YML', 'other.Yaml'];

/** Workflow files whose bytes this can't read as GitHub might (round 6): each holds a `name: desktop` job. */
// check-table: never-shrink
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
    // Since round 17 a row with a matrix `include` or `exclude` is caught as an unsure file, whatever it names.
    if (LIST_KEY.test(yml)) assert.ok(got.includes('other.yml:?'), `${label}: unsure, ${JSON.stringify(got)}`);
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
 * BASE_CI with two plain jobs, `dco` (required) and `build` (not), for the round 10 skipped-matrix fixtures and,
 * since round 12, the name-twin ones (so a `dco` twin among them is judged against a real `dco` job).
 */
const BARE_BASE_CI = BASE_CI + '  dco:\n    runs-on: x\n  build:\n    runs-on: x\n';

/**
 * Round 7 (#746 adversarial review of 80395fcb): text another YAML reader (libyaml and its ports) reads otherwise.
 * A lone CR, NEL, LS or PS ends a comment there but not here, so the rest of the line is hidden from this reader; a
 * BOM at a line start is skipped there but read as part of a key here; `%YAML 1.1` makes `022` octal here. Each file
 * must count as unsure (`<file>:?`). [label, file, text, unsure]
 */
// check-table: never-shrink
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
  // Round 12 (#746 second adversarial review of 00ed28c2): a number not in plain decimal, and an explicit tag, anywhere
  // in the file. GitHub reads hex and octal as 32-bit and honours core tags `yaml` leaves unresolved.
  ['N1 a hex number, 0x16, in a matrix', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [0x16] } }\n    runs-on: x\n', true],
  ['N2 an octal number, 0o26', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [0o26] } }\n    runs-on: x\n', true],
  ['N3 a leading plus, +22', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [+22] } }\n    runs-on: x\n', true],
  ['N4 a leading zero, 022', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [022] } }\n    runs-on: x\n', true],
  ['N5 an exponent, 2.2e1', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [2.2e1] } }\n    runs-on: x\n', true],
  ['N6 a decimal point, 22.0', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [22.0] } }\n    runs-on: x\n', true],
  ['N7 no integer part, .5', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [.5] } }\n    runs-on: x\n', true],
  ['N8 .inf', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [.inf] } }\n    runs-on: x\n', true],
  ['N9 a hex number outside any matrix, timeout-minutes: 0x10', 'other.yml', 'jobs:\n  t:\n    timeout-minutes: 0x10\n    runs-on: x\n', true],
  ['N10 a hex number as a key', 'other.yml', 'jobs:\n  t:\n    env: { 0x10: a }\n    runs-on: x\n', true],
  ['T1 !!float 22 in an exclude against an axis 22', 'other.yml', "jobs:\n  t:\n    name: ${{ matrix.n }}\n    strategy:\n      matrix:\n        k: [22]\n        exclude: [ { k: !!float 22 } ]\n        include: [ { n: dco }, { n: x } ]\n    runs-on: x\n", true],
  ['T2 !!int 0x16 on an axis value', 'other.yml', 'jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [!!int 0x16] } }\n    runs-on: x\n', true],
  ['T3 !!str on a name', 'other.yml', 'jobs:\n  t:\n    name: !!str shots\n    runs-on: x\n', true],
  ['T4 the non-specific tag !, on a name', 'other.yml', 'jobs:\n  t:\n    name: ! shots\n    runs-on: x\n', true],
  ['T5 a local tag !x, on a name', 'other.yml', 'jobs:\n  t:\n    name: !x shots\n    runs-on: x\n', true],
  ['T6 a tag on a mapping, jobs: !!map', 'other.yml', 'jobs: !!map\n  t:\n    runs-on: x\n', true],
  ['T7 a tag on a list, steps: !!seq', 'other.yml', "jobs:\n  t:\n    runs-on: x\n    steps: !!seq [ { run: 'true' } ]\n", true],
  ['T8 a tag on a key, !!str name', 'other.yml', 'jobs:\n  t:\n    !!str name: shots\n    runs-on: x\n', true],
  ['T9 a tag on an empty value', 'other.yml', 'jobs:\n  t:\n    runs-on: x\n    env: !!null\n', true],
  ['control: plain decimal numbers, -1, 0, 22 and 4294967295', 'other.yml', 'jobs:\n  t:\n    strategy: { matrix: { v: [-1, 0, 22, 4294967295] } }\n    timeout-minutes: 10\n    runs-on: x\n', false],
  ["control: '0x16' and \"+22\" quoted, ! inside a scalar, !! in a quoted name and in a comment", 'other.yml', "jobs:\n  t:\n    name: 'a!b !!c'\n    strategy: { matrix: { v: ['0x16', \"+22\", a!b] } }\n    runs-on: x # !!float 22\n", false],
  // Round 15 (#746 second adversarial review of f8448bb4): an anchor defined twice. `yaml` resolves an alias to the
  // newest definition; if GitHub's reader keeps the first, this is a desktop twin (guess).
  ['A8 an anchor defined twice, &n desktop then &n shots, name: *n', 'other.yml', "env:\n  A: &n desktop\n  B: &n shots\njobs:\n  t:\n    name: *n\n    runs-on: x\n    steps: [ { run: 'false' } ]\n", true],
  ['control: one anchor, two aliases', 'other.yml', 'env:\n  A: &n shots\njobs:\n  t:\n    name: *n\n    runs-on: x\n  u:\n    env: { N: *n }\n    runs-on: x\n', false],
  ['control: a matrix name that uses every key', 'other.yml', 'jobs:\n  t:\n    name: lint ${{ matrix.a }} ${{ matrix.b }}\n    strategy: { matrix: { a: [x, y], b: [1, 2] } }\n    runs-on: x\n', false],
  // Round 16 (#746 second adversarial review of 8249c09c, A6): a key that isn't a string. JS folds `true:` (a boolean)
  // and `"true":` into one property, the last, so a red job named desktop under the first was hidden here.
  ['A6 a job keyed true (a boolean) named desktop, then one keyed "true"', 'other.yml', "jobs:\n  true:\n    name: desktop\n    runs-on: x\n    steps: [ { run: 'false' } ]\n  \"true\":\n    runs-on: x\n", true],
  ['A6b a job keyed ~ (null) named desktop, then one keyed ""', 'other.yml', "jobs:\n  ~:\n    name: desktop\n    runs-on: x\n    steps: [ { run: 'false' } ]\n  \"\":\n    runs-on: x\n", true],
  ['A6c in ci.yml, a job keyed True (a boolean) named desktop, then one keyed "true"', 'ci.yml', BASE_CI + "  True:\n    name: desktop\n    runs-on: x\n    steps: [ { run: 'false' } ]\n  \"true\":\n    runs-on: x\n", true],
  ['control: keys "true", "1", "~" and \'null\' quoted are strings', 'other.yml', "jobs:\n  \"true\":\n    runs-on: x\n  t:\n    env: { \"1\": a, \"~\": b, 'null': c }\n    runs-on: x\n", false],
  ['control: a BOM at offset 0 only', 'other.yml', String.fromCharCode(0xfeff) + 'jobs:\n  t:\n    runs-on: x\n', false],
  ['control: TAB in a comment', 'other.yml', 'jobs:\n  t:\n    runs-on: x # a\tb\n', false],
];

/**
 * Round 8 (#746 adversarial review of abff5d0d): plain-ASCII jobs that GitHub may name as a twin of
 * `test (ubuntu-latest, 22)` (BASE_CI makes it) where JS object and number semantics named them otherwise, and a
 * literal name of the `<caller> / <callee>` shape. Each must leave checkTwins non-empty. [label, other.yml]
 */
// check-table: never-shrink
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
  // Round 11: an exclude by expression, so the include entry stands alone as GitHub builds it.
  ['E2b a green test (ubuntu-latest, 22) twin, an exclude by expression, needs: a slow job', "jobs:\n  slow:\n    runs-on: x\n    steps: [ { run: 'sleep 1500' } ]\n  test:\n    needs: slow\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        k: [q]\n        exclude: [ { k: \"${{ 'q' }}\" } ]\n        include: [ { os: ubuntu-latest, node: 22 } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['E2c a green dco twin, name ${{ matrix.n }}, an exclude by expression', "jobs:\n  t:\n    name: ${{ matrix.n }}\n    strategy:\n      matrix:\n        k: [q]\n        exclude: [ { k: \"${{ 'q' }}\" } ]\n        include: [ { n: dco }, { n: x } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  // Round 12 (#746 second adversarial review of 00ed28c2): hex and octal of 2^31 and above, which GitHub reads as
  // 32-bit (0xffffffff is -1) and `yaml` does not (4294967295), and a core tag `yaml` leaves unresolved.
  ['H1 a green test (ubuntu-latest, 22) twin, a hex exclude 0xffffffff against an axis -1, needs: a slow job', "jobs:\n  slow:\n    runs-on: x\n    steps: [ { run: 'sleep 1500' } ]\n  test:\n    needs: slow\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        k: [-1]\n        exclude: [ { k: 0xffffffff } ]\n        include: [ { os: ubuntu-latest, node: 22 } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['H1c a green dco twin, name ${{ matrix.n }}, a hex exclude 0xffffffff against an axis -1', "jobs:\n  t:\n    name: ${{ matrix.n }}\n    strategy:\n      matrix:\n        k: [-1]\n        exclude: [ { k: 0xffffffff } ]\n        include: [ { n: dco }, { n: x } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['H1d the same, an octal exclude 0o37777777777', "jobs:\n  t:\n    name: ${{ matrix.n }}\n    strategy:\n      matrix:\n        k: [-1]\n        exclude: [ { k: 0o37777777777 } ]\n        include: [ { n: dco }, { n: x } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['H1e the same, the axis 0xffffffff and the exclude -1', "jobs:\n  t:\n    name: ${{ matrix.n }}\n    strategy:\n      matrix:\n        k: [0xffffffff]\n        exclude: [ { k: -1 } ]\n        include: [ { n: dco }, { n: x } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['H2 the reverse: an axis 4294967295, a hex exclude 0xffffffff; GitHub keeps test (ubuntu-latest, 22)', "jobs:\n  twin:\n    name: test (${{ matrix.os }}, ${{ matrix.node }})\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        node: [22]\n        k: [4294967295]\n        exclude: [ { k: 0xffffffff } ]\n        include: [ { os: other, node: 1 } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ["T1b an exclude !!float 22 against an axis '22'; GitHub may keep test (ubuntu-latest, 22)", "jobs:\n  twin:\n    name: test (${{ matrix.os }}, ${{ matrix.n }})\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        n: [22]\n        k: ['22']\n        exclude: [ { k: !!float 22 } ]\n        include: [ { os: other, n: 1 } ]\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  // Round 15 (#746 second adversarial review of f8448bb4, A10): names over 100 characters fail closed, in case GitHub
  // shortens them (guess). The real tree's longest name has 34 characters.
  ['A10 two names of 101 characters sharing their first 100', 'jobs:\n  a:\n    name: ' + 'x'.repeat(100) + "a\n    runs-on: x\n    steps: [ { run: 'false' } ]\n  b:\n    name: " + 'x'.repeat(100) + 'b\n    runs-on: x\n'],
  // Round 16 (#746 reviews of 8249c09c, A7): an include entry that adds a key outside the axes to a combination, in a
  // job whose name has no expression. If GitHub's suffix leaves the added value out, it is `test (ubuntu-latest, 22)`.
  ['A7 a job keyed test, include { node: 22, q: q } on its one combination', "jobs:\n  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22], include: [ { node: 22, q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['A7b the same under a constant name: test', "jobs:\n  twin:\n    name: test\n    strategy: { matrix: { os: [ubuntu-latest], node: [22], include: [ { q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  // Round 17 (#746 second adversarial review of f204b1b3): an include entry that stands alone carries a value outside
  // the axes too. Under A7's guess, GitHub names it `test (ubuntu-latest, 22)` or `bootstrap (ubuntu-latest)`.
  ['B1 a job keyed test, axes os: [other], node: [24], include { os: ubuntu-latest, node: 22, q: q } (stands alone)', "jobs:\n  test:\n    strategy: { matrix: { os: [other], node: [24], include: [ { os: ubuntu-latest, node: 22, q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
  ['B1c a job keyed bootstrap, axes os: [other], include { os: ubuntu-latest, q: q }', "jobs:\n  bootstrap:\n    strategy: { matrix: { os: [other], include: [ { os: ubuntu-latest, q: q } ] } }\n    runs-on: x\n    steps: [ { run: 'true' } ]\n"],
];

test('a job GitHub may name as a twin of another check is caught: matrix keys, numbers, reusable-workflow names (round 8)', () => {
  const REQUIRED = ['desktop', 'dco', 'test (ubuntu-latest, 22)', 'test (ubuntu-latest, 24)'];
  const base = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(base, 'ci.yml'), BARE_BASE_CI);
  assert.deepEqual(checkTwins(base, REQUIRED), [], 'BARE_BASE_CI alone');
  for (const [label, yml] of NAME_TWIN_FIXTURES) {
    const dir = mkdtempSync(join(tmpdir(), 'wf-'));
    writeFileSync(join(dir, 'ci.yml'), BARE_BASE_CI);
    writeFileSync(join(dir, 'other.yml'), yml);
    assert.notDeepEqual(checkTwins(dir, REQUIRED), [], label);
    // Since round 17 a row with a matrix `include` or `exclude` is caught as an unsure file.
    if (LIST_KEY.test(yml)) assert.ok(desktopMakers(dir).includes('other.yml:?'), `${label}: unsure`);
  }
  // Integer matrix values below 1e15, and identifier keys, still resolve: a plain matrix is no twin.
  const ok = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(ok, 'ci.yml'), BARE_BASE_CI);
  writeFileSync(join(ok, 'other.yml'), 'jobs:\n  lint:\n    strategy: { matrix: { node_v: [22, 999999999999999], os-x: [a] } }\n    runs-on: x\n');
  assert.deepEqual(checkTwins(ok, REQUIRED), [], 'lint (22, a), lint (999999999999999, a)');
  // Round 16's A7 controls, as round 17 reads them: the include-only matrix, and the axis matrix with an include entry
  // that adds no key, now make the file unsure; a plain axis matrix is still read.
  const ok7 = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(ok7, 'ci.yml'), BARE_BASE_CI);
  writeFileSync(join(ok7, 'other.yml'), 'jobs:\n  lint:\n    strategy: { matrix: { include: [ { node: 22, q: q }, { node: 24 } ] } }\n    runs-on: x\n  fmt:\n    strategy: { matrix: { os: [a, b], include: [ { os: a } ] } }\n    runs-on: x\n');
  assert.ok([...fileJobNames(join(ok7, 'other.yml'))].includes(`? (${UNRESOLVED} a matrix with include or exclude }})`), 'A7 controls: unsure');
  const plain = mkdtempSync(join(tmpdir(), 'wf-'));
  writeFileSync(join(plain, 'ci.yml'), BARE_BASE_CI);
  writeFileSync(join(plain, 'other.yml'), 'jobs:\n  fmt:\n    strategy: { matrix: { os: [a, b], node: [22] } }\n    runs-on: x\n');
  assert.deepEqual([...fileJobNames(join(plain, 'other.yml'))].sort(), ['fmt (a, 22)', 'fmt (b, 22)']);
  assert.deepEqual(checkTwins(plain, REQUIRED), [], 'a plain axis matrix is still read');
});

/**
 * Round 10 (#746 adversarial review of f5fafeca): a matrix job with an `if:` or `needs:` that GitHub skips gets one
 * check run under its bare name, which this didn't count. Each makes a skipped twin of a name BARE_BASE_CI makes, so
 * checkTwins must report it. [label, file, text]; a `ci.yml` row is the whole ci.yml. Since round 15 it also holds
 * one job that makes two runs of one name (a matrix name that leaves out a key that varies, or two equal
 * combinations): a v0.5.2 updater reads only the newest, so the second hides a red first.
 */
// check-table: never-shrink
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
  // Round 15 (#746 second adversarial review of f8448bb4): one job, two runs of one name.
  ['A1 in ci.yml, the dco job named ${{ matrix.c }}, axes c: [dco] and copy: [1, 2]', 'ci.yml', BARE_BASE_CI.replace('  dco:\n    runs-on: x\n', '  dco:\n    name: ${{ matrix.c }}\n    strategy: { max-parallel: 1, fail-fast: false, matrix: { c: [dco], copy: [1, 2] } }\n    runs-on: x\n')],
  ['A1b in ci.yml, the test job named test (${{ matrix.os }}, ${{ matrix.node }}), an extra axis attempt: [1, 2]', 'ci.yml', BARE_BASE_CI.replace('  test:\n    strategy: { matrix: { os: [ubuntu-latest], node: [22, 24] } }\n', '  test:\n    name: test (${{ matrix.os }}, ${{ matrix.node }})\n    strategy: { max-parallel: 1, matrix: { os: [ubuntu-latest], node: [22, 24], attempt: [1, 2] } }\n')],
  ['A1c in ci.yml, the dco job named ${{ matrix.c }}, two include entries { c: dco, k: a } and { c: dco, k: b }', 'ci.yml', BARE_BASE_CI.replace('  dco:\n    runs-on: x\n', '  dco:\n    name: ${{ matrix.c }}\n    strategy: { max-parallel: 1, matrix: { include: [ { c: dco, k: a }, { c: dco, k: b } ] } }\n    runs-on: x\n')],
  ['A1e in ci.yml, the dco job named ${{ matrix.c }}, a repeated axis value c: [dco, dco]', 'ci.yml', BARE_BASE_CI.replace('  dco:\n    runs-on: x\n', '  dco:\n    name: ${{ matrix.c }}\n    strategy: { matrix: { c: [dco, dco] } }\n    runs-on: x\n')],
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
  // Since round 17 a matrix with `include` or `exclude`, in any case, makes the file unsure: these four were read as
  // `v a`, `v b`; `s (x, 1)` (round 16: unresolved), `s (z)`; `s (x)`, `s (z, 1)`; and `x-1`, `x-2`.
  const UNSURE = `? (${UNRESOLVED} a matrix with include or exclude }})`;
  assert.ok(names('jobs:\n  s:\n    name: v ${{matrix.View}}\n    strategy: { matrix: { include: [{ view: a }, { view: b }] } }\n').includes(UNSURE));
  assert.ok(names('jobs:\n  s:\n    strategy: { matrix: { os: [x, y], exclude: [{ os: y }], include: [{ os: x, n: 1 }, { os: z }] } }\n').includes(UNSURE));
  assert.ok(names('jobs:\n  s:\n    strategy: { matrix: { os: [x, y], exclude: [{ os: y }], include: [{ os: x }, { os: z, n: 1 }] } }\n').includes(UNSURE));
  assert.ok(names('jobs:\n  s:\n    name: ${{ matrix.os }}-${{ matrix.n }}\n    strategy: { matrix: { os: [x], n: [1, 2], include: [{ n: 2, extra: e }] } }\n').includes(UNSURE));
  assert.ok(names('jobs:\n  s:\n    strategy: { matrix: { os: [x], Include: [{ os: x }] } }\n').includes(UNSURE), 'Include, another case');
  assert.ok(names('jobs:\n  s:\n    Strategy: { Matrix: { os: [x], EXCLUDE: [{ os: x }] } }\n').includes(UNSURE), 'EXCLUDE under Strategy and Matrix');
  // Case and spacing in a name's expression, on a plain axis matrix, still resolve.
  assert.deepEqual(names('jobs:\n  s:\n    name: v ${{matrix.View}}\n    strategy: { matrix: { view: [a, b] } }\n'), ['v a', 'v b']);
  assert.deepEqual(names('jobs:\n  s:\n    name: ${{ matrix.os }}-${{  MATRIX.n}}\n    strategy: { matrix: { os: [x], n: [1, 2] } }\n'), ['x-1', 'x-2']);
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

/**
 * Round 16 (#746 second adversarial review of 8249c09c, M1 to M4): this file's rules live in its helpers, which no
 * fixture reaches in full, so a later change could narrow one with every test still green. Its lint-test mark (line
 * 1) makes the #783/#869 hold see any line taken out of the file. Each row narrows one rule; its anchor is split in
 * two so this table never holds it whole. [label, anchor, narrowed]
 */
// check-table: never-shrink
const NARROWING_MUTANTS: [string, [string, string], string][] = [
  ['M1 one job, two runs of one name: only under 5 combinations', ['if (out.size <', ' combos.length) return'], 'if (out.size < combos.length && combos.length < 5) return'],
  ['M2 names over 100 characters: only up to 199', ['n.length >', ' 100 ?'], '(n.length > 100 && n.length < 200) ?'],
  ['M3 an anchor defined twice: only under 3 anchors', ['if (twice)', ' return'], 'if (twice && anchors.size < 3) return'],
  ['M4 an unresolved name may make only desktop', ['[...names].some((n) =>', ' n.includes(UNRESOLVED));'], "(check === 'desktop' && [...names].some((n) => n.includes(UNRESOLVED)));"],
  ['A7 a matrix with include or exclude (round 17): only with an anchor twice', ['if (matrixLists)', ' return'], 'if (matrixLists && twice) return'],
  ['A7c the same in matrixCombos: include only', ['if (Object.keys(matrix).some((k) =>', ' isListKey(k))) return null;'], "if (Object.keys(matrix).some((k) => isListKey(k) && fold(k) === 'include')) return null;"],
  ['A6 a key that is not a string: only with an anchor twice', ['if (oddKey)', ' return'], 'if (oddKey && twice) return'],
];

test('a later change that narrows one of these rules waits for the owner: this file is a lint test (round 16)', () => {
  const P = 'test/desktop-removed.test.ts';
  const before = readFileSync(join(repoRoot, P), 'utf8');
  /** The #783/#869 hold for a change to this file alone, its lines as a diff gives them. */
  const hold = (after: string) => {
    const minus = (a: string[], b: string[]) => {
      const left = [...b];
      return a.filter((x) => {
        const k = left.indexOf(x);
        if (k === -1) return true;
        left.splice(k, 1);
        return false;
      });
    };
    const [b, a] = [before.split('\n'), after.split('\n')];
    const removed = minus(b, a);
    const added = minus(a, b);
    const files = [{ path: P, added: added.length, removed: removed.length, addedLines: added, removedLines: removed }];
    return weakeningReasons({ files, deleted: new Set(), before: (p) => (p === P ? before : null), after: (p) => (p === P ? after : null), scope: undefined });
  };
  assert.ok(registrationsOf(before).lint, 'the file carries its lint-test mark');
  for (const [label, [head, tail], narrowed] of NARROWING_MUTANTS) {
    const rule = head + tail;
    assert.equal(before.split(rule).length, 2, `${label}: the rule is in the file once`);
    const reasons = hold(before.replace(rule, () => narrowed));
    assert.ok(reasons.some((r) => r.includes('removes or changes a line of a guard or lint')), `${label}: ${JSON.stringify(reasons)}`);
  }
  assert.notDeepEqual(hold(before.replace(`${LINT_MARK}\n`, '')), [], 'the mark taken out');
});

/**
 * The modules this file may load, since round 18: node built-ins it uses, yaml, typescript (its import reader, round
 * 19) and the weakening module. Not a local helper such as test/helpers.ts, which no hold covers; and not
 * `node:module`, `node:vm` or `node:child_process`, which could load one.
 */
// check-table: never-grow
const MAY_IMPORT = new Set(['node:test', 'node:assert/strict', 'node:fs', 'node:os', 'node:path', 'node:url', 'yaml', 'typescript', '../src/merge-policy-weakening.js']);

/**
 * The packages this backstop, its preload and their modules load, each with its lockfile entry pinned to this
 * integrity (round 19). npm ci checks the installed tarball against the lockfile; the installed bytes themselves are
 * not read here, which is why ci.yml runs this backstop before any package script or unheld file (round 20). A
 * swapped tarball, an `npm:` alias or a `file:` spec changes the lockfile entry; so does any bump (Dependabot,
 * `npm update`), which then turns this test red until the owner changes this line.
 */
// check-table: never-shrink
const PINNED_PACKAGES: Record<string, string> = { yaml: 'sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==', typescript: 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==' };

/** Text that loads a module no import statement names (split, so this line never holds it). */
// check-table: never-shrink
const LOADER_WORDS = ['getBuiltin' + 'Module', 'create' + 'Require'];

/**
 * The modules a TS or JS text names, from a full parse (round 20; round 19's ts.preProcessFile is a scanner, and a
 * regex literal holding a quote, a backtick or `/*` made it skip the import after it): import and export
 * declarations, TypeScript's import-equals require, dynamic import and require calls, and import types. `computed` counts a
 * dynamic import or require whose name isn't a literal. What a parse can't see: code built from parts at run time
 * (`new Function`, a computed `eval`), the pure-addition class of #992.
 */
function importsIn(text: string, kind: ts.ScriptKind): { names: string[]; computed: number } {
  const file = ts.createSourceFile(kind === ts.ScriptKind.JS ? 'x.js' : 'x.ts', text, ts.ScriptTarget.Latest, false, kind);
  const names: string[] = [];
  let computed = 0;
  const literal = (e: ts.Node | undefined) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null);
  const named = (e: ts.Node | undefined) => {
    const n = literal(e);
    if (n === null) computed++;
    else names.push(n);
  };
  const walk = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier) named(n.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) named(n.moduleReference.expression);
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) named(n.arguments[0]);
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) named(n.argument.literal);
    ts.forEachChild(n, walk);
  };
  walk(file);
  return { names, computed };
}

/**
 * Why a file's text may load a module outside MAY_IMPORT (rounds 19 and 20): every module a full parse finds, a
 * dynamic import or require by a computed name, round 18's line-start readers and its dynamic-import and require text
 * check (kept beside the parse), and text that loads a module by name at run time. Strings and comments are not
 * imports.
 */
function importProblems(text: string): string[] {
  const { names, computed } = importsIn(text, ts.ScriptKind.TS);
  const r18 = [...text.matchAll(/^(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/^import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
  const out = [...new Set([...names, ...r18])].filter((s) => !MAY_IMPORT.has(s)).map((s) => `imports ${s}`);
  if (computed > 0) out.push('a dynamic import or require by a computed name');
  if (/\bimport\s*\(|\brequire\s*\(/.test(text)) out.push('a dynamic import or require');
  for (const w of LOADER_WORDS) if (text.includes(w)) out.push(`the text ${w}`);
  return out;
}

/**
 * Round 19 (#746 reviews of 87cf2165): lines that load a local helper, each added after this file's imports, which
 * the round 18 line-start reader missed. Each must give importProblems something. [label, line]
 */
// check-table: never-shrink
const IMPORT_FORM_FIXTURES: [string, string][] = [
  ['indented', "  import './helpers.js';"],
  ['a tab first', "\timport { engineCli } from './helpers.js';"],
  ['a comment first', "/* x */ import './helpers.js';"],
  ['no space, side effect', "import'./helpers.js';"],
  ['no space, named', "import{engineCli}from'./helpers.js';"],
  ['export * with no space', "export*from'./helpers.js';"],
  ['a comment between a dynamic import and its paren',"await import/**/('./helpers.js');"],
  ['a built-in loader by name', 'const m = process.' + 'getBuiltin' + "Module('node:module');"],
  // Round 20 (#746 final check of 7b420051): a regex literal that made round 19's scanner skip the import after it.
  ['a regex literal holding a quote, then an import', "const q1 = /'/; import './helpers.js';"],
  ['a regex literal holding a backtick, then an import', "const q2 = /`/;\nimport './helpers.js';"],
  ['a regex literal holding a comment opener, then an import', "const q3 = /a\\/*/;\nimport './helpers.js';"],
];

/** The #783/#869 hold for a change to the files in `edits` (path to [text before, text after]), lines as a diff gives them. */
function holdOf(edits: Record<string, [string, string]>): string[] {
  const minus = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((x) => {
      const k = left.indexOf(x);
      if (k === -1) return true;
      left.splice(k, 1);
      return false;
    });
  };
  const files = Object.entries(edits).map(([path, [b, a]]) => {
    const removed = minus(b.split('\n'), a.split('\n'));
    const added = minus(a.split('\n'), b.split('\n'));
    return { path, added: added.length, removed: removed.length, addedLines: added, removedLines: removed };
  });
  return weakeningReasons({ files, deleted: new Set(), before: (p) => edits[p]?.[0] ?? null, after: (p) => edits[p]?.[1] ?? null, scope: undefined });
}

test('this backstop imports only MAY_IMPORT, in every spelling a parse can see, and finds the repo itself (rounds 18 to 20)', () => {
  const P = 'test/desktop-removed.test.ts';
  const text = readFileSync(join(repoRoot, P), 'utf8');
  const from = importsIn(text, ts.ScriptKind.TS).names;
  assert.ok(from.includes('yaml') && from.includes('node:test') && from.includes('typescript'), `the import list was read: ${JSON.stringify(from)}`);
  assert.deepEqual(importProblems(text), [], 'no module outside MAY_IMPORT: no local helper outside the hold');
  const anchor = "import { LINT_MARK, registrationsOf, weakeningReasons } from '../src/merge-policy-weakening.js';\n";
  assert.equal(text.split(anchor).length, 2, 'the last import is there once');
  for (const [label, line] of IMPORT_FORM_FIXTURES) assert.notDeepEqual(importProblems(text.replace(anchor, () => `${anchor}${line}\n`)), [], label);
  // The second adversarial review of 2fd92b5d (T1): a changed repoRoot line in test/helpers.ts got no hold (measured
  // then), and it could point this file at another tree. This file no longer reads helpers.ts, and the same change
  // here is held.
  const elsewhere = "new URL(process.argv.some((a) => a.endsWith('desktop-removed.test.js')) ? '../../test/fixtures/frozen/' : '../../', import.meta.url)";
  // Split, so this line never holds it whole.
  const OWN_ROOT = 'const repoRoot = fileURLToPath(new URL(' + "'../../', import.meta.url));";
  assert.equal(text.split(OWN_ROOT).length, 2, 'this file sets repoRoot once');
  for (const [label, after] of [
    ['its repoRoot pointed at another tree', text.replace(OWN_ROOT, () => `const repoRoot = fileURLToPath(${elsewhere});`)],
    ['its repoRoot taken from helpers.ts again', text.replace(OWN_ROOT, () => "import { repoRoot } from './helpers.js';")],
  ] as const) {
    const reasons = holdOf({ [P]: [text, after] });
    assert.ok(reasons.some((r) => r.includes('removes or changes a line of a guard or lint')), `${label}: ${JSON.stringify(reasons)}`);
  }
});

/**
 * The built modules that run in this backstop's process, from its preload (test/isolate.ts) and itself: each local
 * module as its source path, each package it names, and how many dynamic imports or requires by a computed name they
 * hold. Read with a full parse (importsIn, round 20), so every spelling a parse can see counts; a module with no
 * source fails the caller. Code built from parts at run time stays outside it (#992).
 */
function builtClosure(): { local: string[]; packages: Set<string>; built: string[]; computed: number } {
  const seen = new Set<string>();
  const packages = new Set<string>();
  let computed = 0;
  const todo = [join(repoRoot, 'dist', 'test', 'isolate.js'), fileURLToPath(import.meta.url)];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const read = importsIn(readFileSync(f, 'utf8'), ts.ScriptKind.JS);
    computed += read.computed;
    for (const name of read.names) {
      if (name.startsWith('.') || name.startsWith('/')) todo.push(resolve(dirname(f), name));
      else packages.add(name);
    }
  }
  const built = [...seen].sort();
  const local = built.map((f) => relative(repoRoot, f).split(sep).join('/').replace(/^dist\//, '').replace(/\.js$/, '.ts'));
  return { local, packages, built, computed };
}

test('every module this backstop runs, as a parse finds them, is held: a changed line of any local one waits for the owner (rounds 19 and 20)', () => {
  const { local, built, computed } = builtClosure();
  assert.equal(computed, 0, 'no dynamic import or require by a computed name in the closure');
  // Round 20 (#746 final check of 7b420051): a regex literal holding a backtick hid the import after it from round
  // 19's scanner, in a built module. The parse finds it.
  assert.deepEqual(importsIn("const zzq = /`/;\nimport './zz-extra.js';\n", ts.ScriptKind.JS).names, ['./zz-extra.js'], 'a built text with a regex literal, then an import');
  // Round 19 (#746 second adversarial review of 87cf2165, row 1): src/brand.ts and src/os/{system-paths,own-env,
  // child-process}.ts ran here and no hold covered them; one changed line turned this backstop green over a red twin.
  for (const m of ['test/isolate.ts', 'test/desktop-removed.test.ts', 'src/merge-policy-weakening.ts', 'src/brand.ts', 'src/os/child-process.ts']) assert.ok(local.includes(m), `the closure was read: ${m}`);
  for (const p of local) {
    assert.ok(existsSync(join(repoRoot, p)), `${p}: a built module with no source`);
    const before = readFileSync(join(repoRoot, p), 'utf8');
    const line = before.split('\n').find((l) => l.trim() !== '')!;
    const reasons = holdOf({ [p]: [before, before.replace(line, () => `${line} // changed`)] });
    assert.ok(reasons.some((r) => r.includes('removes or changes a line of a guard or lint')), `${p} runs in this backstop's process, so it must be a guard file: ${JSON.stringify(reasons)}`);
  }
  // A module that loads another by name at run time would load it unseen.
  for (const f of built) if (f !== fileURLToPath(import.meta.url)) for (const w of LOADER_WORDS) assert.ok(!readFileSync(f, 'utf8').includes(w), `${relative(repoRoot, f)}: ${w}`);
});

test('the packages this backstop runs are the locked ones, from the repo\'s own node_modules (round 19)', () => {
  const { packages, built } = builtClosure();
  // What this pins is the lockfile entry and where each package resolves; npm ci checks the installed tarball against
  // that integrity. Code that runs before this test could still change the installed bytes, which is why ci.yml runs
  // this backstop before any such step (round 20, the next test).
  const named = [...packages].filter((s) => !s.startsWith('node:'));
  assert.deepEqual(named.sort(), Object.keys(PINNED_PACKAGES).sort(), 'every package in the closure is pinned, and every pin is used');
  // Round 21: CI checks the same pins, and the installed files, before any pinned package runs (scripts/ci/check-pins.mjs,
  // step 4 of SHARD_FIRST_STEPS). It must carry the same integrity strings, and a changed line of it must be held.
  const CHECK = 'scripts/ci/check-pins.mjs';
  const check = readFileSync(join(repoRoot, CHECK), 'utf8');
  for (const [name, integrity] of Object.entries(PINNED_PACKAGES)) assert.ok(check.includes(`${name}: {\n    integrity: '${integrity}',`), `${CHECK} pins ${name} to the same integrity`);
  const first = check.split('\n').find((l) => l.trim() !== '')!;
  assert.ok(holdOf({ [CHECK]: [check, check.replace(first, () => `${first} // changed`)] }).some((r) => r.includes('removes or changes a line of a guard or lint')), `${CHECK} is held`);
  assert.deepEqual(importsIn(check, ts.ScriptKind.JS).names.filter((s) => !s.startsWith('node:')), [], `${CHECK} loads built-ins only`);
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string; link?: boolean }> };
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { name?: string };
  const root = realpathSync(repoRoot);
  for (const [name, integrity] of Object.entries(PINNED_PACKAGES)) {
    // A swapped tarball, an alias or a file: or link: spec changes the lockfile entry.
    assert.equal(lock.packages[`node_modules/${name}`]?.integrity, integrity, `${name}: the lockfile's integrity`);
    assert.ok(!lock.packages[`node_modules/${name}`]?.link, `${name}: not a link`);
    assert.notEqual(pkg.name, name, `${name}: the package isn't the repo itself (a self-reference resolves first)`);
    // Resolved where npm ci put it: not a node_modules under dist/ (Node looks there first), not a symlink elsewhere.
    const dir = join(repoRoot, 'node_modules', name);
    assert.ok(lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(), `${name}: node_modules/${name} is a plain directory`);
    const at = realpathSync(fileURLToPath(import.meta.resolve(name)));
    assert.ok(at.startsWith(join(root, 'node_modules', name) + sep), `${name} resolves to ${at}`);
  }
  // No node_modules between any built module and the repo's top, where Node would look before the repo's own.
  const top = resolve(repoRoot);
  for (const f of built) {
    assert.ok(f.startsWith(top + sep), `${f} is in the repo`);
    for (let d = dirname(f); d !== top && d.startsWith(top + sep); d = dirname(d)) assert.ok(!existsSync(join(d, 'node_modules')), `${relative(top, join(d, 'node_modules'))} would shadow a package`);
  }
});

/**
 * Round 20 (#746 second adversarial review of 7b420051, A1 to A5): ci.yml's test shards ran `npm ci` (with its
 * prepare script), `build:web` and machine.sh before their tests. A changed line in scripts/prepare.mjs,
 * scripts/web-licenses.mjs or machine.sh, or a changed vite lockfile entry, ran on the same checkout first and could
 * hide a twin from this backstop. So every shard now starts with exactly these steps, and nothing the hold doesn't
 * cover runs before this backstop has run: checkout, Node, an install with no package scripts, a build with the
 * locked typescript straight from node_modules, then this file alone. Round 21 (#746 reviews of d576000d): the pinned
 * packages ran (tsc, then this file's own imports) before their pin was read, so scripts/ci/check-pins.mjs (a guard
 * path) now checks their lockfile entries and installed files right after the install; and the other lint tests
 * are held at step 7, before anything unheld. [step, as parsed]
 */
// check-table: never-shrink
const SHARD_FIRST_STEPS: [string, (s: Record<string, unknown>) => boolean][] = [
  ['checkout, the merge commit and its base', (s) => String(s.uses).startsWith('actions/checkout@') && same(Object.keys(s).sort(), ['uses', 'with']) && same(s.with, { 'fetch-depth': 2 })],
  ['setup-node, the matrix version, the npm cache', (s) => String(s.uses).startsWith('actions/setup-node@') && same(Object.keys(s).sort(), ['uses', 'with']) && same(s.with, { 'node-version': '${{ matrix.node }}', cache: 'npm' })],
  ['npm ci with no package scripts', (s) => same(s, { run: 'npm ci --ignore-scripts' })],
  ['the pins, checked before any pinned package runs', (s) => same(s, { name: 'the pinned packages, before any of them runs', run: 'node scripts/ci/check-pins.mjs' })],
  ['the locked tsc, no npm script', (s) => same(s, { run: 'node node_modules/typescript/bin/tsc -p tsconfig.json' })],
  ['this backstop, alone', (s) => same(s, { name: 'the desktop backstop, before anything unheld runs', run: 'node --import ./dist/test/isolate.js --test dist/test/desktop-removed.test.js' })],
  ['the other lint tests', (s) => same(s, { name: 'the other lint tests, before anything unheld runs', shell: 'bash', run: OTHER_LINT_TESTS })],
];

/** Step 7's script, exactly: every other `// lint-test` file, built, preloaded with the isolation; none found fails. */
const OTHER_LINT_TESTS = "mapfile -t files < <(grep -lx '// lint-test' test/*.test.ts | grep -vx 'test/desktop-removed.test.ts' | sed -e 's#^test/#dist/test/#' -e 's#\\.ts$#.js#')\n[ \"${#files[@]}\" -gt 0 ] || { echo \"no lint tests found\" >&2; exit 1; }\nnode --import ./dist/test/isolate.js --test \"${files[@]}\"\n";

test('ci.yml runs the pin check, then this backstop, then the other lint tests first in every test shard, before any package script or unheld file (rounds 20 and 21)', () => {
  const wf = parse(readFileSync(join(workflows, 'ci.yml'), 'utf8')) as { jobs: Record<string, Record<string, unknown>> };
  // No workflow-wide env (a NODE_OPTIONS there reaches every step of every job) or defaults (a run shell), round 21.
  assert.deepEqual(Object.keys(wf).sort(), ['concurrency', 'jobs', 'name', 'on', 'permissions'], 'ci.yml: no workflow-level env or defaults');
  const shards = Object.entries(wf.jobs).filter(([id]) => id.startsWith('test-shard-'));
  assert.ok(shards.length >= 2, 'found the test shard jobs');
  // Every job that runs the test suite is a shard, so none runs it otherwise.
  for (const [id, job] of Object.entries(wf.jobs)) if (JSON.stringify(job).includes('dist/test/isolate.js')) assert.ok(id.startsWith('test-shard-'), `${id} runs tests: only the shards may`);
  for (const [id, job] of shards) {
    // No job-wide env (a NODE_OPTIONS there would load code into every step), defaults, container or services.
    assert.deepEqual(Object.keys(job).sort(), ['name', 'runs-on', 'steps', 'strategy'], `${id}: no env, defaults, container or services`);
    const steps = job.steps as Record<string, unknown>[];
    SHARD_FIRST_STEPS.forEach(([label, ok], i) => assert.ok(ok(steps[i] ?? {}), `${id} step ${i + 1} must be ${label}: ${JSON.stringify(steps[i])}`));
    // A later install runs no package scripts either.
    for (const s of steps) if (/\bnpm (ci|install|i|rebuild)\b/.test(String(s.run ?? ''))) assert.match(String(s.run), /--ignore-scripts/, `${id}: ${String(s.run)}`);
  }
  // A reorder is caught: the old order (npm ci with scripts, first) fails.
  const old = shards[0]![1].steps as Record<string, unknown>[];
  const fails = (steps: Record<string, unknown>[]) => !SHARD_FIRST_STEPS.every(([, ok], i) => ok(steps[i] ?? {}));
  assert.ok(fails([old[0]!, old[1]!, { run: 'npm ci' }, ...old.slice(3)]), 'npm ci with scripts first fails');
  assert.ok(fails([old[0]!, old[1]!, old[2]!, old[4]!, old[3]!, ...old.slice(5)]), 'tsc before the pin check fails');
  assert.ok(fails([...old.slice(0, 4), old[5]!, old[4]!, ...old.slice(6)]), 'the backstop before its build fails');
  assert.ok(fails([...old.slice(0, 6), { run: 'npm run build:web' }, ...old.slice(6)]), 'an unheld step before the other lint tests fails');
  assert.ok(fails([...old.slice(0, 6), ...old.slice(7), old[6]!]), 'the other lint tests moved last fails');
  assert.ok(fails([...old.slice(0, 3), ...old.slice(4)]), 'the pin check removed fails');
});
