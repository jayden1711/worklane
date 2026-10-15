// Experiment studies (docs/experiments.md): the project's own definitions, read from `experiments.yaml` in the project's config directory
// (a self-modification path: always L3, the owner merges it). A study fixes the goal: one metric and its direction,
// a split eval (the job's code predicts; a separate scorer, as another user, scores against labels the job never
// sees), the data it may read (ids of root's approved data sources, never paths), the files a job may change, the
// knobs it may set, and its caps. Nothing here names a project: the project's specifics live in its own repo and in
// root's file on its machine.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { globToRegExp } from '../guardrails/glob.js';

export const STUDIES_FILE = 'experiments.yaml';
/** A study's or a data source's id: also a path segment, a ref segment and an event key. */
export const ID = /^[a-z][a-z0-9-]{0,39}$/;
const Id = z.string().regex(ID, 'lowercase letters, digits and dashes, starting with a letter (at most 40)');

/** A repo-relative path or glob a study names: never absolute, never `..`, never the harness's own config. */
const RepoPath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '.'), 'a repo-relative path without . or ..')
  .refine((p) => p !== BRAND.configDir && !p.startsWith(`${BRAND.configDir}/`) && p !== '.git' && !p.startsWith('.git/'), `never ${BRAND.configDir}/ or .git/`);

/** One knob a job may set. Values outside it are refused, never clamped. */
export const Knob = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('number'), min: z.number().finite(), max: z.number().finite() }),
  z.strictObject({ type: z.literal('integer'), min: z.number().int(), max: z.number().int() }),
  z.strictObject({ type: z.literal('enum'), values: z.array(z.string().min(1).max(60)).min(1).max(30) }),
]);
export type Knob = z.infer<typeof Knob>;

const Command = z.string().min(1).max(500).refine((c) => !c.includes('\n'), 'one line');

export const Study = z
  .strictObject({
    id: Id,
    goal: z.string().min(1).max(200),
    metric: z.strictObject({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
      direction: z.enum(['min', 'max']),
      min_delta: z.number().finite().nonnegative().default(0),
    }),
    eval: z.strictObject({
      /** Only split in this version (owner, 2026-10-15): the job's code never computes its own score. */
      mode: z.literal('split').default('split'),
      predict: Command,
      score: Command,
      files: z.array(RepoPath).min(1).max(20),
      inputs: Id,
      labels: Id,
    }),
    train: z.strictObject({
      command: Command,
      data: z.array(Id).max(20).default([]),
      env: z.strictObject({ lockfile: RepoPath, build: Command }),
      preflight: Command.optional(),
    }),
    editable: z.array(RepoPath).min(1).max(50),
    config_schema: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), Knob).default({}),
    /** The owner's words on the data for the agent: shapes and fields, never paths or where it came from. */
    data_card: z.string().max(2000).default(''),
    job: z
      .strictObject({
        max_minutes: z.number().int().min(1).max(1440).default(10),
        gpus: z.number().int().min(1).max(16).default(1),
        output_gb: z.number().int().min(1).max(10000).default(5),
      })
      .prefault({}),
    budget: z.strictObject({
      gpu_hours_per_day: z.number().positive().max(24 * 16),
      agent_usd_per_day: z.number().positive(),
      agent_usd_total: z.number().positive(),
      max_jobs: z.number().int().positive().max(100_000),
    }),
    exploration: z.strictObject({ share: z.number().min(0).max(0.5).default(0.2), near_miss: z.number().min(0).max(1).default(0.02) }).prefault({}),
    confirm_runs: z.number().int().min(0).max(3).default(1),
  })
  .superRefine((s, ctx) => {
    for (const [k, v] of Object.entries(s.config_schema)) {
      if (v.type !== 'enum' && v.min > v.max) ctx.addIssue({ code: 'custom', path: ['config_schema', k], message: 'min is above max' });
    }
    // WHY: labels are what the score is computed against. A job that can read them can learn them.
    if (s.eval.labels === s.eval.inputs || s.train.data.includes(s.eval.labels)) ctx.addIssue({ code: 'custom', path: ['eval', 'labels'], message: 'the labels are the scorer\'s alone: never the eval inputs or a training source' });
    // WHY: an editable glob that covers the eval would let a job change what scores it.
    const res = s.editable.map(globToRegExp);
    for (const f of s.eval.files) if (res.some((r) => r.test(f))) ctx.addIssue({ code: 'custom', path: ['editable'], message: `covers the eval file ${f}` });
  });
export type Study = z.infer<typeof Study>;

export const StudiesFile = z
  .strictObject({ version: z.literal(1), studies: z.array(Study).max(50).default([]) })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const s of f.studies) {
      if (seen.has(s.id)) ctx.addIssue({ code: 'custom', path: ['studies'], message: `two studies named ${s.id}` });
      seen.add(s.id);
    }
  });
export type StudiesFile = z.infer<typeof StudiesFile>;

/** Every approved data source a study reads: what root's file must list for this instance before it can run. */
export function sourcesOf(s: Study): { job: string[]; scorer: string[] } {
  return { job: [...new Set([...s.train.data, s.eval.inputs])].sort(), scorer: [s.eval.labels] };
}

/** The same value whatever its keys' order: what a version is hashed over. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * A study's version: its definition, its eval files' sha256 and its data sources' sha256, as pinned when an owner
 * confirmed it. Any of them changing is a new version, and the best starts over.
 */
export function studyVersion(s: Study, evalFiles: Record<string, string>, sources: Record<string, string>): string {
  return createHash('sha256').update(canonical({ s, evalFiles, sources })).digest('hex').slice(0, 16);
}

/** Why a config can't run (the first problem), or null. Unknown keys and values outside a knob are refused. */
export function configRefusal(config: unknown, schema: Record<string, Knob>): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'the config is not an object';
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    const knob = schema[k];
    if (!knob) return `${k} is not one of the study's knobs`;
    if (knob.type === 'enum') {
      if (typeof v !== 'string' || !knob.values.includes(v)) return `${k} must be one of ${knob.values.join(', ')}`;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v) || (knob.type === 'integer' && !Number.isInteger(v))) return `${k} must be ${knob.type === 'integer' ? 'an integer' : 'a number'}`;
      if (v < knob.min || v > knob.max) return `${k} must be between ${knob.min} and ${knob.max}`;
    }
  }
  return null;
}
