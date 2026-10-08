// Schemas for a project's config folder. Unknown keys are errors (strict), so
// a typo fails loudly instead of silently falling back to a default.
import { z } from 'zod';

const handle = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub handle');
const model = z.string().min(1);
const regex = z.string().refine(
  (s) => {
    try {
      new RegExp(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid regular expression' },
);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');

// ---------- config.yaml ----------

export const Area = z.strictObject({
  name: z.string().min(1),
  owner: handle,
  paths: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
});

export const ProjectConfig = z.strictObject({
  version: z.literal(1),
  project: z.strictObject({
    name: z.string().min(1),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/repo'),
    default_branch: z.string().default('main'),
  }),
  mode: z.enum(['local', 'shared']).default('local'),
  backlog: z.enum(['github', 'file']).default('github'),
  runner: z.enum(['local', 'ci', 'remote-machine']).default('local'),
  agent_runtime: z
    .strictObject({
      kind: z.enum(['cli', 'sdk']).default('cli'),
      max_concurrency: z.number().int().min(1).max(32).default(2),
      run_windows: z.array(z.strictObject({ from: hhmm, to: hhmm })).default([]),
    })
    .prefault({}),
  land_mode: z.enum(['direct', 'pr']).default('pr'),
  os: z.enum(['auto', 'macos', 'linux', 'windows-wsl']).default('auto'),
  owners: z.strictObject({
    default: handle,
    writers: z.array(handle).min(1),
    areas: z.array(Area).default([]),
  }),
  reports: z
    .strictObject({
      times: z.array(hhmm).default(['08:00', '18:00']),
      to: z.array(handle).default([]),
    })
    .prefault({}),
});

// ---------- agents.yaml ----------

const role = z.strictObject({
  enabled: z.boolean(),
  model: model,
  count: z.number().int().min(0).optional(),
  max: z.number().int().min(0).optional(),
  hard_issues_model: model.optional(),
  max_per_day: z.number().int().min(0).optional(),
  max_fixes_per_pr: z.number().int().min(0).optional(),
  applies_to: z.array(z.string()).optional(),
  budget_usd: z.number().positive().optional(),
});

export const RoleNames = [
  'chief_of_staff',
  'pm',
  'workers',
  'evaluator',
  'security',
  'qa_playtester',
  'researcher',
  'red_attributor',
  'ci_repair',
  'monitor',
  'release_prep',
] as const;

export const AgentsConfig = z
  .strictObject({
    stage: z.number().int().min(1).max(3),
    daily_budget_usd: z.number().positive(),
    roles: z.partialRecord(z.enum(RoleNames), role),
    auto_land: z.array(z.string()).default([]),
  })
  .superRefine((c, ctx) => {
    const w = c.roles.workers;
    if (w && w.count !== undefined && w.max !== undefined && w.count > w.max) {
      ctx.addIssue({ code: 'custom', path: ['roles', 'workers', 'count'], message: `count (${w.count}) exceeds max (${w.max})` });
    }
    if (c.roles.evaluator?.enabled === false && c.roles.workers?.enabled) {
      ctx.addIssue({ code: 'custom', path: ['roles', 'evaluator', 'enabled'], message: 'workers require an enabled evaluator' });
    }
  });

// ---------- guardrails.yaml ----------

const appliesTo = z.array(z.enum(['agent', 'interactive'])).default(['agent', 'interactive']);

export const RuleMatch = z.union([
  z.strictObject({ command: z.strictObject({ pattern: regex }) }),
  z.strictObject({
    cli_env: z.strictObject({
      cli: z.string().min(1),
      subcommands: z.array(z.string()).default([]),
      flags_any: z.array(z.string()).default([]),
      flags_none: z.array(z.string()).default([]),
      environments: z.array(z.string()).min(1),
      env_flags: z.array(z.string()).default(['--environment', '-e']),
      resolver: z.enum(['none', 'railway']).default('none'),
      /** What an environment that can't be determined counts as. */
      unresolved: z.enum(['match', 'no_match']).default('match'),
    }),
  }),
  z.strictObject({ connection: z.strictObject({ fingerprints: z.string().min(1) }) }),
  z.strictObject({ path: z.strictObject({ globs: z.array(z.string()).min(1) }) }),
]);

export const Rule = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase-kebab id'),
  action: z.enum(['block', 'ask']),
  reason: z.string().min(1),
  applies_to: appliesTo,
  match: RuleMatch,
  unless: z.strictObject({ pattern: regex }).optional(),
});

export const Example = z.union([
  z.strictObject({ bash: z.string().min(1), agent: z.boolean().default(true), cwd: z.string().optional() }),
  z.strictObject({ tool: z.enum(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read', 'Grep']), path: z.string().min(1), agent: z.boolean().default(true) }),
  z.strictObject({ fetch: z.string().url(), agent: z.boolean().default(true) }),
]);

export const GuardrailsConfig = z.strictObject({
  version: z.literal(1),
  rules: z.array(Rule).default([]),
  fingerprints: z
    .record(
      z.string(),
      z.strictObject({
        /** Read-only command that prints JSON containing the secret value. */
        command: z.string().min(1),
        key: z.string().min(1),
      }),
    )
    .default({}),
  protected_paths: z.array(z.string()).default([]),
  /** Files agents may not read or write (hook-enforced, agent mode only). */
  secret_paths: z.array(z.string()).default([]),
  /** Tool credential stores no Claude session reads, agent or human (written as Read(...) deny rules). */
  credential_stores: z.array(z.string()).default([]),
  network: z.strictObject({ allow: z.array(z.string()).default([]) }).prefault({}),
  pre_approved: z.array(z.string()).default([]),
  examples: z
    .strictObject({
      must_block: z.array(Example).default([]),
      must_ask: z.array(Example).default([]),
      must_allow: z.array(Example).default([]),
      /** Fake values standing in for real fingerprint sets during checks. */
      fingerprints: z.record(z.string(), z.array(z.string())).default({}),
      /** cwd -> linked environment, standing in for CLI link files during checks. */
      linked_environments: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
});

// ---------- tests.yaml ----------

export const TestsConfig = z.strictObject({
  version: z.literal(1),
  runner: z.strictObject({
    kind: z.literal('command'),
    changed: z.string().min(1),
    full: z.string().min(1),
    one: z.string().includes('{file}').optional(),
  }),
  vacuity: z
    .strictObject({
      test_globs: z.array(z.string()).min(1),
      assertion_pattern: regex,
      app_paths: z.array(z.string()).min(1),
      dynamic: z.boolean().default(false),
    })
    .optional(),
  stop_gate: z
    .strictObject({
      timeout_s: z.number().int().positive().default(900),
      lock_wait_s: z.number().int().min(0).default(30),
      /** Output that means "couldn't run right now", not "failed". */
      busy_patterns: z.array(regex).default([]),
    })
    .prefault({}),
  worktree: z
    .strictObject({
      root: z.string().default('.claude/worktrees'),
      setup: z.array(z.string()).default([]),
      est_size_gb: z.number().positive().default(1),
    })
    .prefault({}),
  land: z.strictObject({ pre: z.array(z.string()).default([]) }).prefault({}),
  /** How the runner lists failures, for the baseline gate ("no new failures vs main"). */
  failures: z.strictObject({ section: regex, item: regex }).optional(),
  /** Exits 0 when no full test run is live on this machine (any harness or session). Queued full runs wait for it. */
  idle_probe: z.string().optional(),
  /** Project lints run in the PR-gate tier (e.g. scripts in the config folder's checks/). Non-zero exit fails the gate. */
  checks: z.array(z.string()).default([]),
  tiers: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        command: z.string().min(1),
        max_disk_used_pct: z.number().min(1).max(100).optional(),
        exclusive: z.boolean().default(false),
      }),
    )
    .default([]),
});

// ---------- review.yaml ----------

export const ReviewConfig = z.strictObject({
  version: z.literal(1),
  money_path_source: z.strictObject({ file: z.string().min(1), pattern: regex.optional() }).optional(),
  levels: z.strictObject({
    L0_auto: z.strictObject({ when: z.array(z.string()), max_lines: z.number().int().positive().optional() }),
    L1_evaluator: z.strictObject({
      when: z.array(z.string()),
      max_lines: z.number().int().positive().optional(),
      max_files: z.number().int().positive().optional(),
    }),
    L2_notify: z.strictObject({ when: z.array(z.string()) }),
    L3_human: z.strictObject({ when: z.array(z.string()), over_lines: z.number().int().positive().optional() }),
  }),
});

// ---------- deploy.yaml ----------

export const DeployConfig = z.strictObject({
  version: z.literal(1),
  /** The one sanctioned production read path (see prodread.ts). Absent = no production reads. */
  prod_read: z
    .strictObject({
      via: z.literal('railway-ssh'),
      service: z.string().min(1),
      environment: z.string().min(1),
      url_var: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      max_rows: z.number().int().positive().max(10_000).default(500),
      timeout_s: z.number().int().positive().max(120).default(15),
    })
    .optional(),
  environments: z.array(
    z.strictObject({
      name: z.string().min(1),
      trigger: z.string().optional(),
      verify: z.string().min(1),
      production: z.boolean().default(false),
    }),
  ),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type AgentsConfig = z.infer<typeof AgentsConfig>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfig>;
export type Rule = z.infer<typeof Rule>;
export type Example = z.infer<typeof Example>;
export type TestsConfig = z.infer<typeof TestsConfig>;
export type ReviewConfig = z.infer<typeof ReviewConfig>;
export type DeployConfig = z.infer<typeof DeployConfig>;

export const FILES = {
  'config.yaml': ProjectConfig,
  'agents.yaml': AgentsConfig,
  'guardrails.yaml': GuardrailsConfig,
  'tests.yaml': TestsConfig,
  'review.yaml': ReviewConfig,
  'deploy.yaml': DeployConfig,
} as const;
