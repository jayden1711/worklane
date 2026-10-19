// A paste-ready pin block for config.yaml required_check_sources (#727; src/check-source.ts): what doctor prints for
// each required check with no pin, and what auto-config writes into a new project's config.yaml.
// - The mapping reads the workflow files committed at one commit (main's tip, or a new project's base), with git:
//   regular files under .github/workflows/ only, each at most WORKFLOW_MAX_BYTES. Never the working tree, an untracked
//   file, or anything a symlink points to.
// - Each check name maps to the one workflow file whose jobs post it, confirmed against the check runs on main's tip
//   where it has one. Anything it can't map surely is listed for a manual choice, never guessed: a name more than one
//   file or source posts, a job it can't name (a reusable workflow, an expression name or matrix, a matrix with
//   include/exclude, a non-string name, a file that doesn't parse), and a check GitHub Actions posts outside a run
//   that passes the workflow-pin test (the Actions App is never proposed as a pin: any workflow posts as it).
// - The block is valid under the engine's own schema, or it isn't offered: no duplicate key, no name the schema or
//   YAML can't take (those are comments).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { isJobOfRun, unrecorded, type CheckPin } from './check-source.js';
import { ProjectConfig } from './config/schema.js';

/** The largest workflow file read (as the main watch reads committed files). */
export const WORKFLOW_MAX_BYTES = 256 * 1024;
/** The longest check name offered as a key (a YAML key is at most 1024 characters, quotes included). */
export const NAME_MAX = 1000;

/** A check run on the default branch's tip: its name, its App, whether that App is GitHub Actions, and the workflow file of its run when it passes the workflow-pin test. */
export interface TipRun {
  name: string;
  app: number | null;
  actions: boolean;
  workflow: string | null;
}
/** Main's tip as read: its commit, its check runs, and whether the read is partial (more runs than were read). */
export interface Tip {
  sha: string;
  runs: TipRun[];
  partial: boolean;
}
/** The workflow files committed at `at`, and the ones left out with why. */
export interface Workflows {
  at: string;
  files: Record<string, string>;
  skipped: { path: string; why: string }[];
}
export interface PinPlan {
  pins: { name: string; pin: CheckPin; evidence: string }[];
  manual: { name: string; why: string }[];
  /** Jobs or files the mapping couldn't read or name: a pinned name could also come from one of them. */
  unmapped: { where: string; why: string }[];
}

type Git = (repo: string, args: string[]) => string | null;
const gitIn: Git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/** The workflow files committed at `rev` in the repo at `repo`, or null when git can't read `rev`. */
export function workflowsAt(repo: string, rev: string, git: Git = gitIn): Workflows | null {
  const at = git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])?.trim();
  if (!at) return null;
  const ls = git(repo, ['ls-tree', '-z', '-l', at, '--', '.github/workflows/']);
  if (ls === null) return null;
  const out: Workflows = { at, files: {}, skipped: [] };
  for (const entry of ls.split('\0').filter(Boolean)) {
    // <mode> SP <type> SP <object> SP+ <size> TAB <path>
    const m = /^(\d+) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const [, mode, type, object, size, path] = m as unknown as [string, string, string, string, string, string];
    if (type === 'tree' || !/\.ya?ml$/.test(path)) continue;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      out.skipped.push({ path, why: mode === '120000' ? 'a symlink: never followed' : `not a regular file (mode ${mode})` });
      continue;
    }
    if (!(Number(size) <= WORKFLOW_MAX_BYTES)) {
      out.skipped.push({ path, why: `over ${WORKFLOW_MAX_BYTES / 1024} KiB` });
      continue;
    }
    const text = git(repo, ['cat-file', 'blob', object]);
    if (text === null) out.skipped.push({ path, why: 'git could not read it' });
    else out.files[path] = text;
  }
  return out;
}

type Job = { name?: unknown; uses?: unknown; strategy?: { matrix?: unknown } };

/** The check names one workflow file's jobs post, as GitHub names them, and each job it can't name surely, with why. */
function namesOf(text: string): { names: string[]; unknown: string[] } {
  let wf: { jobs?: unknown } | null;
  try {
    wf = parse(text) as { jobs?: unknown } | null;
  } catch {
    return { names: [], unknown: ["the file doesn't parse"] };
  }
  const jobs = wf && typeof wf === 'object' ? wf.jobs : undefined;
  if (jobs === undefined || jobs === null) return { names: [], unknown: [] };
  if (typeof jobs !== 'object' || Array.isArray(jobs)) return { names: [], unknown: ['its jobs are not a mapping'] };
  const names: string[] = [];
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(jobs as Record<string, unknown>)) {
    const job = raw as Job;
    const at = `job ${JSON.stringify(key)}`;
    if (!job || typeof job !== 'object') {
      unknown.push(`${at}: not a mapping`);
      continue;
    }
    if (job.uses !== undefined) {
      unknown.push(`${at}: a reusable workflow, whose checks are named after its own jobs`);
      continue;
    }
    if (job.name !== undefined && typeof job.name !== 'string') {
      unknown.push(`${at}: its name is not a string`);
      continue;
    }
    const name = typeof job.name === 'string' ? job.name : key;
    const matrix = job.strategy?.matrix;
    if (matrix !== undefined && (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix))) {
      unknown.push(`${at}: its matrix is an expression`);
      continue;
    }
    const m = (matrix ?? {}) as Record<string, unknown>;
    if ('include' in m || 'exclude' in m) {
      unknown.push(`${at}: its matrix has include or exclude`);
      continue;
    }
    const axes = Object.entries(m);
    if (axes.some(([, v]) => !Array.isArray(v) || v.some((x) => x === null || typeof x === 'object'))) {
      unknown.push(`${at}: its matrix values aren't plain lists`);
      continue;
    }
    let combos: string[][] = [[]];
    for (const [, values] of axes) combos = combos.flatMap((c) => (values as unknown[]).map((v) => [...c, String(v)]));
    const named = combos.map((c) => {
      const vars = Object.fromEntries(axes.map(([k], i) => [k, c[i]!]));
      return name.includes('${{') ? name.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (s, k: string) => vars[k] ?? s) : c.length ? `${name} (${c.join(', ')})` : name;
    });
    if (named.some((n) => n.includes('${{'))) unknown.push(`${at}: its name is an expression`);
    else names.push(...named);
  }
  return { names, unknown };
}

/** Every check name the workflow files post, with the files that post each, and every job or file it couldn't name. */
export function workflowCheckNames(w: Pick<Workflows, 'files' | 'skipped'>): { byName: Map<string, Set<string>>; unmapped: { where: string; why: string }[] } {
  const byName = new Map<string, Set<string>>();
  const unmapped = w.skipped.map((s) => ({ where: s.path, why: s.why }));
  for (const [path, text] of Object.entries(w.files)) {
    const { names, unknown } = namesOf(text);
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name)!.add(path);
    }
    for (const why of unknown) unmapped.push({ where: path, why });
  }
  return { byName, unmapped };
}

/** Whether `name` can be a key in required_check_sources (the schema refuses __proto__; YAML a key over 1024 chars). */
const usable = (name: string) => name.length > 0 && name.length <= NAME_MAX && name !== '__proto__';

/** Each name's pin, with its evidence, or why it needs a manual choice. `tip`: null when it couldn't be read. */
export function pinPlan(o: { names: string[]; workflows: Workflows | null; tip: Tip | null }): PinPlan {
  const { byName, unmapped } = o.workflows ? workflowCheckNames(o.workflows) : { byName: new Map<string, Set<string>>(), unmapped: [{ where: '.github/workflows/', why: "main's committed tree couldn't be read" }] };
  const tipAt = o.tip ? ` ${o.tip.sha.slice(0, 8)}${o.tip.partial ? ' (read only in part)' : ''}` : '';
  const filesAt = o.workflows ? ` at ${o.workflows.at.slice(0, 8)}` : '';
  const plan: PinPlan = { pins: [], manual: [], unmapped };
  for (const name of [...new Set(o.names)]) {
    if (!usable(name)) {
      plan.manual.push({ name: name.slice(0, 80), why: `can't be a key in required_check_sources (${name === '__proto__' ? 'the name __proto__' : `${name.length} characters`})` });
      continue;
    }
    const files = [...(byName.get(name) ?? [])].sort();
    const runs = (o.tip?.runs ?? []).filter((r) => r.name === name);
    const seen = [...new Set(runs.map((r) => (r.workflow ? `workflow ${r.workflow}` : r.actions ? 'GitHub Actions outside a run that passes the workflow-pin test' : `App ${r.app ?? 'unknown'}`)))].sort();
    if (files.length > 1) {
      plan.manual.push({ name, why: `posted by more than one workflow file (${files.join(', ')})` });
    } else if (files.length === 1) {
      const file = files[0]!;
      if (!runs.length) plan.pins.push({ name, pin: { workflow: file }, evidence: `from the workflow files${filesAt} only: ${o.tip ? `main's tip${tipAt} has no run of it` : "main's tip couldn't be read"}` });
      else if (seen.length === 1 && seen[0] === `workflow ${file}`) plan.pins.push({ name, pin: { workflow: file }, evidence: `confirmed: its run on main's tip${tipAt} is a job of a ${file} run` });
      else plan.manual.push({ name, why: `the workflow files${filesAt} say ${file}, but main's tip${tipAt} has it from ${seen.join(' and ')}` });
    } else if (o.tip && !o.tip.partial && seen.length === 1 && seen[0]!.startsWith('App ') && runs[0]!.app !== null && !runs[0]!.actions) {
      plan.pins.push({ name, pin: { app_id: runs[0]!.app }, evidence: `from main's tip${tipAt} only: no workflow file posts it, and only App ${runs[0]!.app} does there` });
    } else {
      plan.manual.push({ name, why: seen.length ? `no workflow file${filesAt} posts it, and main's tip${tipAt} has it from ${seen.join(' and ')}` : `no workflow file${filesAt} posts it${o.tip ? `, and main's tip${tipAt} has no run of it` : ''}` });
    }
  }
  // A pin the engine's schema refuses (a workflow file name it can't take, say) is a manual choice, never offered.
  const ok = (name: string, pin: CheckPin) => ProjectConfig.shape.required_check_sources.safeParse(Object.fromEntries([[name, pin]])).success;
  for (const p of plan.pins.filter((x) => !ok(x.name, x.pin))) plan.manual.push({ name: p.name, why: `its pin ${JSON.stringify(p.pin)} isn't one the engine's schema takes` });
  plan.pins = plan.pins.filter((x) => ok(x.name, x.pin));
  return plan;
}

/** One line, nothing a terminal acts on: line breaks, control and format characters (escapes, bidi) become spaces. */
const comment = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');

/** The plan as YAML to paste into config.yaml, comments saying why, or '' when it has nothing to pin. */
export function pinBlock(plan: PinPlan): string {
  const lines = plan.pins.length ? ['required_check_sources:'] : [];
  for (const p of plan.pins) lines.push(`  ${JSON.stringify(p.name)}: ${'app_id' in p.pin ? `{ app_id: ${p.pin.app_id} }` : `{ workflow: ${JSON.stringify(p.pin.workflow)} }`}  # ${comment(p.evidence)}`);
  for (const m of plan.manual) lines.push(`# needs a manual choice: ${comment(JSON.stringify(m.name))}: ${comment(m.why)}`);
  for (const u of plan.unmapped) lines.push(`# couldn't map: ${comment(u.where)}: ${comment(u.why)} (a pinned name could also come from it: check)`);
  return lines.join('\n');
}

/** Whether `text` parses as the engine parses config.yaml and its required_check_sources passes the engine's schema. */
export function validPins(text: string): boolean {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return false;
  const raw = doc.toJS() as Record<string, unknown> | null;
  return ProjectConfig.shape.required_check_sources.safeParse(raw && typeof raw === 'object' ? raw.required_check_sources : undefined).success;
}

/**
 * A new project's config.yaml at `cfgDir` (just scaffolded in a worktree of its default branch, never an existing one:
 * auto-config, for init and add-project) gets the pin block for every check the workflow files committed there post,
 * so it starts pinned. Nothing is written unless the whole config still parses and the block is valid.
 */
export function pinNewConfig(cfgDir: string, git: Git = gitIn): void {
  const workflows = workflowsAt(dirname(cfgDir), 'HEAD', git);
  if (!workflows) return;
  const names = [...workflowCheckNames(workflows).byName.keys()].sort();
  const block = pinBlock(pinPlan({ names, workflows, tip: null }));
  if (!block) return;
  const file = join(cfgDir, 'config.yaml');
  const text = readFileSync(file, 'utf8');
  const next = `${text.endsWith('\n') ? text : `${text}\n`}# #727: each check pinned to the workflow file that posts it (from the committed workflow files)\n${block}\n`;
  if (validPins(next)) writeFileSync(file, next);
}

/** doctor's line: each required check with no pin in config.yaml, which is judged by name, and the block that pins it. */
export function checkSourceDoctor(p: { land_mode: string; ci?: string | undefined; required_checks: string[]; required_check_sources: Record<string, CheckPin> }, workflows: Workflows | null, tip: Tip | null): { level: 'ok' | 'warn'; detail: string } {
  if (p.land_mode !== 'pr' || p.ci === 'none' || !p.required_checks.length) return { level: 'ok', detail: 'no required GitHub checks to pin' };
  const bare = unrecorded(p.required_checks, p.required_check_sources);
  if (!bare.length) return { level: 'ok', detail: `every required check is pinned to its source: ${p.required_checks.join(', ')}` };
  const block = pinBlock(pinPlan({ names: bare, workflows, tip }));
  const lead = `no source recorded for ${bare.map((n) => comment(n)).join(', ')}: each is judged by name (any App or workflow posting that name counts) unless GitHub's branch protection or ruleset names its App.`;
  if (!validPins(block)) return { level: 'warn', detail: `${lead} No valid pin block could be built; pin them by hand in config.yaml required_check_sources.` };
  return { level: 'warn', detail: `${lead} Pin them: paste into config.yaml (a change on the default branch)\n${block}` };
}

type Api = (path: string) => unknown;
const ghApi: Api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
/** Pages read at most for one list: past it, the read is partial and says so. */
export const TIP_PAGES_MAX = 10;

/** Every page of a GitHub list (`key`), up to TIP_PAGES_MAX; partial when total_count says there are more. */
function pages<T>(api: Api, path: string, key: string): { items: T[]; partial: boolean } {
  const items: T[] = [];
  let total = 0;
  for (let page = 1; page <= TIP_PAGES_MAX; page++) {
    const r = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`) as Record<string, unknown>;
    const list = Array.isArray(r[key]) ? (r[key] as T[]) : [];
    total = typeof r.total_count === 'number' ? r.total_count : total;
    items.push(...list);
    if (list.length < 100 || items.length >= total) break;
  }
  return { items, partial: total > items.length };
}

/**
 * The check runs on `branch`'s tip of `repo`, read with gh (read-only), every page: each one's App, whether it is
 * GitHub Actions, and, for a run that passes the workflow-pin test (this repo, this commit, one of its run's own jobs),
 * that run's file. Null when gh can't read them.
 */
export function ghTipRuns(repo: string, branch: string, api: Api = ghApi): Tip | null {
  try {
    const cr = pages<{ id: number; name: string; head_sha: string; html_url?: string; app?: { id?: number; slug?: string }; check_suite?: { id?: number } }>(api, `repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?filter=latest`, 'check_runs');
    const sha = cr.items[0]?.head_sha ?? '';
    if (!sha) return null;
    const wr = pages<{ id: number; html_url: string; check_suite_id: number; path: string; head_sha: string; repository?: { full_name?: string } }>(api, `repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs');
    const bySuite = new Map(wr.items.map((w) => [w.check_suite_id, w]));
    const runs = cr.items.map((c) => {
      const actions = c.app?.slug === 'github-actions';
      const w = actions && c.check_suite?.id !== undefined ? bySuite.get(c.check_suite.id) : undefined;
      const ok = !!w && w.head_sha === sha && w.repository?.full_name?.toLowerCase() === repo.toLowerCase() && isJobOfRun(c.html_url, c.id, { run: w.id, url: w.html_url });
      return { name: c.name, app: c.app?.id ?? null, actions, workflow: ok ? w!.path : null };
    });
    return { sha, runs, partial: cr.partial || wr.partial };
  } catch {
    return null;
  }
}
