// Which jobs an owner approves first, which can't run at all, and what a study may still spend today
// (docs/experiments.md "Approval" and "Caps"). Root's caps are limits, not thresholds: a job above them is refused and
// no approval can start it. Below them, a job above the instance's thresholds waits for an owner in the Inbox.
import type { Study } from './study.js';

/** The instance's thresholds (owner, 2026-10-15: 20 minutes to start with). Never above root's caps. */
export const APPROVE_DEFAULTS = { above_minutes: 20, above_gb: 20 } as const;
export type Thresholds = { above_minutes: number; above_gb: number };

/** What root's file allows this instance (src/experiments/root-file.ts reads it). */
export interface RootCaps {
  devices: number[];
  max_minutes: number;
  gpu_hours_per_day: number;
  output_gb: number;
  /** Approved data sources: id -> the sha256 root checked and who may read it. */
  sources: Record<string, { sha256: string; visibility: 'job' | 'scorer' }>;
}

export interface JobAsk {
  minutes: number;
  gpus: number;
  output_gb: number;
  /** The first job of a study version: a person sees the baseline run once. */
  first: boolean;
  lockfile: boolean;
}

/** Why an owner must approve this job (empty: it may start by itself). */
export function approvalReasons(j: JobAsk, t: Thresholds): string[] {
  const r: string[] = [];
  if (j.first) r.push('the first job of this study version');
  if (j.minutes > t.above_minutes) r.push(`${j.minutes} min is above ${t.above_minutes} min`);
  if (j.gpus > 1) r.push(`${j.gpus} GPUs`);
  if (j.output_gb > t.above_gb) r.push(`${j.output_gb} GB of output is above ${t.above_gb} GB`);
  if (j.lockfile) r.push('the dependency lockfile changed');
  return r;
}

/** Why a study can't run on this machine at all (root's caps and data sources), or null. */
export function rootRefusal(s: Study, root: RootCaps | null): string | null {
  if (!root) return 'experiments are not on for this instance in root\'s file';
  if (s.job.max_minutes > root.max_minutes) return `${s.job.max_minutes} min a job is above root's ${root.max_minutes}`;
  if (s.job.gpus > root.devices.length) return `${s.job.gpus} GPUs a job, root's file lists ${root.devices.length}`;
  if (s.job.output_gb > root.output_gb) return `${s.job.output_gb} GB a job is above root's ${root.output_gb}`;
  if (s.budget.gpu_hours_per_day > root.gpu_hours_per_day) return `${s.budget.gpu_hours_per_day} GPU-hours a day is above root's ${root.gpu_hours_per_day}`;
  for (const id of [...s.train.data, s.eval.inputs]) {
    const src = root.sources[id];
    if (!src) return `the data source ${id} is not approved in root's file`;
    if (src.visibility !== 'job') return `the data source ${id} is the scorer's only; a job can't read it`;
  }
  const l = root.sources[s.eval.labels];
  if (!l) return `the data source ${s.eval.labels} is not approved in root's file`;
  if (l.visibility !== 'scorer') return `the labels ${s.eval.labels} must be a scorer-only source in root's file`;
  return null;
}

/** What the study has used today (the local day) and in all. */
export interface Used {
  gpu_hours_today: number;
  agent_usd_today: number;
  agent_usd_total: number;
  jobs: number;
}

/** Why the study can't start another session or job now (its budget), or null. A job is held if its cap could cross a line. */
export function budgetHold(s: Study, u: Used, instanceUsdLeft: number): string | null {
  if (u.jobs >= s.budget.max_jobs) return `${u.jobs} of ${s.budget.max_jobs} jobs used`;
  if (u.agent_usd_total >= s.budget.agent_usd_total) return `$${u.agent_usd_total.toFixed(2)} of $${s.budget.agent_usd_total} in all`;
  if (u.agent_usd_today >= s.budget.agent_usd_per_day) return `$${u.agent_usd_today.toFixed(2)} of $${s.budget.agent_usd_per_day} today`;
  if (u.gpu_hours_today + (s.job.max_minutes * s.job.gpus) / 60 > s.budget.gpu_hours_per_day + 1e-9) return `${u.gpu_hours_today.toFixed(2)} of ${s.budget.gpu_hours_per_day} GPU-hours today; a job may take ${(s.job.max_minutes * s.job.gpus) / 60}`;
  if (instanceUsdLeft <= 0) return 'the instance\'s daily budget is spent';
  return null;
}

/** A session's budget: the least of the per-session cap, the study's day and total, and the instance's day. */
export function sessionBudgetUsd(s: Study, u: Used, instanceUsdLeft: number, perSession = 2): number {
  return Math.max(0, Math.min(perSession, s.budget.agent_usd_per_day - u.agent_usd_today, s.budget.agent_usd_total - u.agent_usd_total, instanceUsdLeft));
}
