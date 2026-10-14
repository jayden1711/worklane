#!/usr/bin/env node
// Which workflow jobs may reach a self-hosted runner, checked from the workflow files (test/self-hosted-guard.test.ts
// runs it over .github/workflows on every PR). A self-hosted runner runs a job's code on a machine of ours, so it may
// take only trusted jobs: never a pull request's (a fork's, or a branch's), and never one with secrets. The runner
// enforces this itself before a job's first step (scripts/setup/ci-runner/job-hook.sh); this keeps the workflows
// from even asking for it.
//
// A job may name only GitHub-hosted labels (ubuntu-*, windows-*, macos-*) unless it is guarded. Any other label can
// match a self-hosted runner (they carry self-hosted, linux and x64, plus their own), so it counts as self-hosted.
// Guarded means one of two shapes, each with a guard: a conjunction (&& only, no ||, no !, no parentheses) of
// `<context.path> == '<literal>'` / `!=` terms that includes all of
//   github.repository == '<owner>/<repo>', or github.repository_id == '<id>' (a fork's copy never matches; the id
//                                            also survives a rename or a transfer)
//   github.ref == 'refs/heads/<branch>'
//   github.event_name == 'push' | 'workflow_dispatch' | 'schedule'
//   1. runs-on: ${{ <guard> && fromJSON('<labels JSON array>') || <fallback> }}, the fallback a GitHub-hosted
//      label in quotes or matrix.<key> whose values are all GitHub-hosted labels;
//   2. runs-on: a literal (string, list, or {group, labels}), with the job's own if: being the guard.
// A matrix value that isn't a GitHub-hosted label, an expression of any other shape, or `secrets.` anywhere in a
// self-hosted job is a problem.
//   node scripts/ci/self-hosted-guard.mjs [<workflows dir>]     prints each problem; exit 1 if any
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const HOSTED = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/;
const TERM = /^([a-z_][a-z0-9_]*(?:\.[a-z0-9_-]+)*)\s*(==|!=)\s*'([^']*)'$/i;
const EVENTS = new Set(['push', 'workflow_dispatch', 'schedule']);

const unwrap = (s) => {
  const m = /^\$\{\{([\s\S]*)\}\}$/.exec(String(s).trim());
  return m ? m[1].trim() : null;
};

/** Why `expr` (no ${{ }}) is not a trusted-only guard, or null when it is one. */
export function guardProblem(expr) {
  if (/\|\||[()!](?!=)/.test(expr)) return 'a guard is a conjunction of == / != terms: no ||, no !, no parentheses';
  const terms = expr.split('&&').map((t) => t.trim());
  const eq = new Map();
  for (const t of terms) {
    const m = TERM.exec(t);
    if (!m) return `"${t}" is not a <context.path> == '<literal>' term`;
    if (m[2] === '==') eq.set(m[1], [...(eq.get(m[1]) ?? []), m[3]]);
  }
  const one = (k) => (eq.get(k)?.length === 1 ? eq.get(k)[0] : null);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(one('github.repository') ?? '') && !/^[1-9][0-9]*$/.test(one('github.repository_id') ?? '')) return "the guard needs github.repository == '<owner>/<repo>' or github.repository_id == '<the repo's id>'";
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(one('github.ref') ?? '')) return "the guard needs github.ref == 'refs/heads/<branch>'";
  if (!EVENTS.has(one('github.event_name') ?? '')) return "the guard needs github.event_name == 'push', 'workflow_dispatch' or 'schedule'";
  return null;
}

const hostedOnly = (labels) => labels.length > 0 && labels.every((l) => typeof l === 'string' && HOSTED.test(l));

/** The labels a literal runs-on names: a string, a list, or {group, labels} (a group counts as not hosted). */
function literalLabels(runsOn) {
  if (typeof runsOn === 'string') return [runsOn];
  if (Array.isArray(runsOn)) return runsOn.map(String);
  if (runsOn && typeof runsOn === 'object') return [...(runsOn.group ? [`group:${runsOn.group}`] : []), ...[].concat(runsOn.labels ?? []).map(String)];
  return [];
}

/** Each value matrix.<key> can take, the include entries' too. */
function matrixValues(job, key) {
  const m = job.strategy?.matrix;
  if (!m || typeof m !== 'object') return null;
  const vals = [...(Array.isArray(m[key]) ? m[key] : []), ...[].concat(m.include ?? []).filter((x) => x && key in x).map((x) => x[key])];
  return vals.length ? vals : null;
}

/** The problems with one job: [] when it can only reach GitHub-hosted runners, or is guarded. */
export function jobProblems(job) {
  const out = [];
  if (!job || typeof job !== 'object' || job.uses) return out; // a reusable workflow call: its own file is checked
  const runsOn = job['runs-on'];
  let selfHosted = false;
  const expr = typeof runsOn === 'string' ? unwrap(runsOn) : null;
  if (expr !== null) {
    const matrixOnly = /^matrix\.([A-Za-z0-9_-]+)$/.exec(expr);
    if (matrixOnly) {
      const vals = matrixValues(job, matrixOnly[1]);
      if (!vals || !vals.every((v) => hostedOnly(literalLabels(v)))) out.push(`runs-on: matrix.${matrixOnly[1]} has a value that isn't a GitHub-hosted label; name self-hosted labels only in the guarded form`);
    } else {
      const m = /^([\s\S]+?)\s*&&\s*fromJSON\('(\[[^']*\])'\)\s*\|\|\s*([\s\S]+)$/.exec(expr);
      if (!m) {
        out.push(`runs-on: an expression this check can't prove reaches GitHub-hosted runners only: \${{ ${expr} }}`);
      } else {
        const g = guardProblem(m[1]);
        if (g) out.push(`runs-on: ${g}`);
        let labels = null;
        try { labels = JSON.parse(m[2]); } catch { /* reported below */ }
        if (!Array.isArray(labels) || !labels.includes('self-hosted')) out.push("runs-on: fromJSON('[...]') must name the self-hosted label");
        const fb = m[3].trim();
        const fq = /^'([^']*)'$/.exec(fb);
        const fm = /^matrix\.([A-Za-z0-9_-]+)$/.exec(fb);
        const fmVals = fm ? matrixValues(job, fm[1]) : null;
        const fallbackOk = fq ? HOSTED.test(fq[1]) : !!fmVals && fmVals.every((v) => hostedOnly(literalLabels(v)));
        if (!fallbackOk) {
          out.push(`runs-on: the fallback (${fb}) must be a GitHub-hosted label in quotes, or matrix.<key> with GitHub-hosted values only`);
        }
        selfHosted = true;
      }
    }
  } else if (!hostedOnly(literalLabels(runsOn))) {
    selfHosted = true;
    const cond = job.if === undefined ? null : unwrap(job.if) ?? String(job.if).trim();
    const g = cond === null ? 'no if: guard' : guardProblem(cond);
    if (g) out.push(`runs-on ${JSON.stringify(runsOn)} can reach a self-hosted runner, so the job's if: must be a trusted-only guard: ${g}`);
  }
  const m = job.strategy?.matrix;
  if (m && typeof m === 'object') {
    for (const [k, vals] of Object.entries(m)) {
      if (k === 'include' || k === 'exclude' || !Array.isArray(vals)) continue;
      if (typeof runsOn === 'string' && runsOn.includes(`matrix.${k}`)) continue; // checked above
      for (const v of vals) if (/self-hosted/i.test(JSON.stringify(v))) out.push(`matrix.${k}: names self-hosted; put self-hosted labels only in the guarded runs-on form`);
    }
  }
  if (selfHosted && /\bsecrets\./.test(JSON.stringify(job))) out.push('a self-hosted job may not use secrets: keep jobs that need them on GitHub-hosted runners');
  return out;
}

/** Every problem in a workflow file's text, as "<job>: <problem>". */
export function workflowProblems(text) {
  const wf = parse(text);
  const out = [];
  for (const [key, job] of Object.entries(wf?.jobs ?? {})) for (const p of jobProblems(job)) out.push(`${key}: ${p}`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2] ?? join(process.cwd(), '.github', 'workflows');
  let bad = 0;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    for (const p of workflowProblems(readFileSync(join(dir, f), 'utf8'))) { console.log(`${f} ${p}`); bad++; }
  }
  if (bad) process.exit(1);
  console.log('every job reaches GitHub-hosted runners only, or is guarded to trusted runs');
}
