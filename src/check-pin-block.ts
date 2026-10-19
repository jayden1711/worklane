// A paste-ready pin block for config.yaml required_check_sources (#727; src/check-source.ts): what doctor prints for
// each required check with no pin, and what auto-config writes into a new project's config.yaml. Each check name is
// mapped to the workflow file whose jobs post it, read from the committed workflow files (PR-only checks included),
// then confirmed against the check runs on the default branch's tip where it has one. A name more than one file or
// source posts, or none, is listed for a manual choice: never guessed.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { isJobOfRun, unrecorded, type CheckPin } from './check-source.js';

/** A check run on the default branch's tip: its name, its App, and the workflow file of its Actions run (or null). */
export interface TipRun {
  name: string;
  app: number | null;
  workflow: string | null;
}

export interface PinPlan {
  pins: { name: string; pin: CheckPin; evidence: string }[];
  manual: { name: string; why: string }[];
}

type Job = { name?: unknown; uses?: unknown; strategy?: { matrix?: unknown } };

/** The check names one workflow file's jobs post, as GitHub names them; null for a job this can't name surely. */
function namesOf(text: string): string[] {
  let wf: { jobs?: Record<string, Job> } | null;
  try {
    wf = parse(text) as { jobs?: Record<string, Job> } | null;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [key, job] of Object.entries(wf?.jobs ?? {})) {
    // A reusable workflow's checks are named after its own jobs: not knowable from here.
    if (!job || typeof job !== 'object' || job.uses !== undefined) continue;
    const name = typeof job.name === 'string' ? job.name : key;
    const matrix = job.strategy?.matrix;
    if (matrix !== undefined && (matrix === null || typeof matrix !== 'object' || Array.isArray(matrix))) continue;
    const axes = Object.entries((matrix ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'include' && k !== 'exclude');
    if (axes.some(([, v]) => !Array.isArray(v) || v.some((x) => x === null || typeof x === 'object'))) continue;
    let combos: string[][] = [[]];
    for (const [, values] of axes) combos = combos.flatMap((c) => (values as unknown[]).map((v) => [...c, String(v)]));
    for (const c of combos) {
      const vars = Object.fromEntries(axes.map(([k], i) => [k, c[i]!]));
      const named = name.includes('${{') ? name.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m) : c.length ? `${name} (${c.join(', ')})` : name;
      if (!named.includes('${{')) out.push(named);
    }
  }
  return out;
}

/** The committed workflow files of the checkout at `root`, by path from the repo root (none: {}). */
export function workflowFiles(root: string): Record<string, string> {
  const dir = join(root, '.github', 'workflows');
  const out: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names.filter((x) => /\.ya?ml$/.test(x)).sort()) {
    try {
      out[`.github/workflows/${n}`] = readFileSync(join(dir, n), 'utf8');
    } catch {
      // unreadable: its checks are listed for a manual choice
    }
  }
  return out;
}

/** Every check name the workflow files post, with the files that post it (by path from the repo root). */
export function workflowCheckNames(files: Record<string, string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [path, text] of Object.entries(files)) {
    for (const name of namesOf(text)) {
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(path);
    }
  }
  return out;
}

/** Each name's pin, with its evidence, or why it needs a manual choice. `tip`: null when it couldn't be read. */
export function pinPlan(o: { names: string[]; workflows: Record<string, string>; tip: TipRun[] | null; tipSha?: string }): PinPlan {
  const byFile = workflowCheckNames(o.workflows);
  const at = o.tipSha ? ` ${o.tipSha.slice(0, 8)}` : '';
  const plan: PinPlan = { pins: [], manual: [] };
  for (const name of o.names) {
    const files = [...(byFile.get(name) ?? [])].sort();
    const runs = (o.tip ?? []).filter((r) => r.name === name);
    const seen = [...new Set(runs.map((r) => (r.workflow ? `workflow ${r.workflow}` : `App ${r.app ?? 'unknown'}`)))].sort();
    if (files.length > 1) {
      plan.manual.push({ name, why: `posted by more than one workflow file (${files.join(', ')})` });
    } else if (files.length === 1) {
      const file = files[0]!;
      if (!runs.length) plan.pins.push({ name, pin: { workflow: file }, evidence: o.tip ? `from the workflow files only: main's tip${at} has no run of it` : `from the workflow files only: main's tip couldn't be read` });
      else if (seen.length === 1 && seen[0] === `workflow ${file}`) plan.pins.push({ name, pin: { workflow: file }, evidence: `confirmed: its run on main's tip${at} is from ${file}` });
      else plan.manual.push({ name, why: `the workflow files say ${file}, but main's tip${at} has it from ${seen.join(' and ')}` });
    } else if (seen.length === 1 && seen[0]!.startsWith('App ') && runs[0]!.app !== null) {
      plan.pins.push({ name, pin: { app_id: runs[0]!.app }, evidence: `from main's tip${at} only: no workflow file posts it, and App ${runs[0]!.app} does there` });
    } else {
      plan.manual.push({ name, why: seen.length ? `no workflow file posts it, and main's tip${at} has it from ${seen.join(' and ')}` : `no workflow file posts it${o.tip ? `, and main's tip${at} has no run of it` : ''}` });
    }
  }
  return plan;
}

/** The plan as YAML to paste into config.yaml (valid under ProjectConfig's required_check_sources), comments saying why. */
export function pinBlock(plan: PinPlan): string {
  const lines = plan.pins.length ? ['required_check_sources:'] : [];
  // WHY: a comment carries file and check names; a line break in one (a workflow file can be named so) would end the
  // comment and inject YAML, a pin, into the block the owner pastes. Each comment stays one line.
  const oneLine = (s: string) => s.replace(/[\r\n\x85\p{Zl}\p{Zp}]+/gu, ' ');
  for (const p of plan.pins) lines.push(`  ${JSON.stringify(p.name)}: ${'app_id' in p.pin ? `{ app_id: ${p.pin.app_id} }` : `{ workflow: ${JSON.stringify(p.pin.workflow)} }`}  # ${oneLine(p.evidence)}`);
  for (const m of plan.manual) lines.push(`# needs a manual choice: ${JSON.stringify(m.name)}: ${oneLine(m.why)}`);
  return lines.join('\n');
}

/**
 * A new project's config.yaml at `cfgDir` (just scaffolded, never an existing one: auto-config, for init and
 * add-project) gets the pin block for every check its committed workflow files post, so it starts pinned.
 */
export function pinNewConfig(cfgDir: string): void {
  const workflows = workflowFiles(dirname(cfgDir));
  const plan = pinPlan({ names: [...workflowCheckNames(workflows).keys()].sort(), workflows, tip: null });
  const block = pinBlock(plan);
  if (!block) return;
  const file = join(cfgDir, 'config.yaml');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, `${text.endsWith('\n') ? text : `${text}\n`}# #727: each check pinned to the workflow file that posts it (from the committed workflow files)\n${block}\n`);
}

/** doctor's line: each required check with no pin in config.yaml, which is judged by name, and the block that pins it. */
export function checkSourceDoctor(p: { land_mode: string; ci?: string | undefined; required_checks: string[]; required_check_sources: Record<string, CheckPin> }, workflows: Record<string, string>, tip: { sha: string; runs: TipRun[] } | null): { level: 'ok' | 'warn'; detail: string } {
  if (p.land_mode !== 'pr' || p.ci === 'none' || !p.required_checks.length) return { level: 'ok', detail: 'no required GitHub checks to pin' };
  const bare = unrecorded(p.required_checks, p.required_check_sources);
  if (!bare.length) return { level: 'ok', detail: `every required check is pinned to its source: ${p.required_checks.join(', ')}` };
  const plan = pinPlan({ names: bare, workflows, tip: tip?.runs ?? null, ...(tip ? { tipSha: tip.sha } : {}) });
  return {
    level: 'warn',
    detail: `no source recorded for ${bare.join(', ')}: each is judged by name (any App or workflow posting that name counts) unless GitHub's branch protection or ruleset names its App. Pin them: paste into config.yaml (a change on the default branch)\n${pinBlock(plan)}`,
  };
}

/**
 * The check runs on `branch`'s tip of `repo`, read with gh (read-only): each one's App and, for an Actions run that is
 * one of its workflow run's own jobs, that run's file. Null when gh can't read them.
 */
export function ghTipRuns(repo: string, branch: string): { sha: string; runs: TipRun[] } | null {
  const api = (path: string): unknown => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }));
  try {
    const cr = api(`repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?filter=latest&per_page=100`) as { check_runs?: { id: number; name: string; head_sha: string; html_url?: string; app?: { id?: number; slug?: string }; check_suite?: { id?: number } }[] };
    const list = cr.check_runs ?? [];
    const sha = list[0]?.head_sha ?? '';
    const wr = sha ? (api(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`) as { workflow_runs?: { id: number; html_url: string; check_suite_id: number; path: string; head_sha: string; repository?: { full_name?: string } }[] }) : { workflow_runs: [] };
    const bySuite = new Map((wr.workflow_runs ?? []).map((w) => [w.check_suite_id, w]));
    const runs = list.map((c) => {
      const w = c.app?.slug === 'github-actions' && c.check_suite?.id !== undefined ? bySuite.get(c.check_suite.id) : undefined;
      // The same test a workflow pin passes (src/check-source.ts): this repo, this commit, one of that run's own jobs.
      const ok = !!w && w.head_sha === sha && w.repository?.full_name?.toLowerCase() === repo.toLowerCase() && isJobOfRun(c.html_url, c.id, { run: w.id, url: w.html_url });
      return { name: c.name, app: c.app?.id ?? null, workflow: ok ? w!.path : null };
    });
    return { sha, runs };
  } catch {
    return null;
  }
}
