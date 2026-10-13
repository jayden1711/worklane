// Schemas for a project's config folder. Unknown keys are errors (strict), so
// a typo fails loudly instead of silently falling back to a default.
import { loosenedProblems } from '../delegation.js';
import { z } from 'zod';
import { providerOf, providerRefusal } from '../providers.js';
import type { RoutedRun } from '../model-routing.js';
import { projectEnvProblem } from '../project-env.js';
import { TestRunConfig } from '../testrun/config.js';
import { DeployGateConfig, deployGateProblems } from '../deploy-gate/config.js';

const handle = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub handle');
const model = z.string().min(1);

/** An open-model provider (src/providers.ts): an Anthropic-compatible endpoint, a credential by name, its model id. */
const provider = z.strictObject({
  base_url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'an http(s) URL'),
  /** The key's name in the instance's credentials.yaml provider_keys; the key itself is never in the repo. */
  credential: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/, 'a credential name (lowercase letters, digits, _ or -)'),
  model: z.string().min(1),
  /**
   * A hosted model's price tier, by its per-token price against Anthropic's haiku, sonnet and opus: the instance's
   * model cap applies to it as to theirs. Required for a hosted model to run at all; a local model costs nothing.
   */
  tier: z.enum(['haiku', 'sonnet', 'opus']).optional(),
  usd_per_mtok_in: z.number().nonnegative().optional(),
  usd_per_mtok_out: z.number().nonnegative().optional(),
  gpu_lock: z.string().refine((p) => p.startsWith('/'), 'an absolute path').optional(),
  latency_ms: z.number().int().positive().max(60_000).optional(),
});
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
      // cli: the claude CLI on a Claude subscription login. api_key: the claude CLI billed to an API key (`sdk` is the old name).
      kind: z.enum(['cli', 'api_key', 'sdk']).default('cli').transform((k) => (k === 'sdk' ? 'api_key' : k)),
      max_concurrency: z.number().int().min(1).max(32).default(2),
      run_windows: z.array(z.strictObject({ from: hhmm, to: hhmm })).default([]),
    })
    .prefault({}),
  land_mode: z.enum(['direct', 'pr']).default('pr'),
  /**
   * PR mode: the checks that must pass on a PR's exact head (names as GitHub shows them) before it is marked
   * ready. None configured: nothing is ever marked ready.
   */
  required_checks: z.array(z.string().min(1)).default([]),
  /**
   * The default branch's protection as the harness recommends it (src/branch-protection.ts; advice only, never
   * applied). `strict`: whether a PR must be up to date with the default branch before it merges. Off by default:
   * post-merge CI and the main watch catch what strict would have, without PRs queueing to merge main in and rerun CI.
   */
  protection: z.strictObject({ strict: z.boolean().default(false) }).prefault({}),
  /**
   * The main watch (src/main-watch.ts), where GitHub doesn't protect the default branch. `direct_push_alert`: a
   * commit that lands there without a PR (a direct push, a force-push) is posted to the Discord ops channel at once,
   * mentioning the Discord owners. On by default; read as committed just before the push, so a push can't turn it off.
   */
  main_watch: z.strictObject({ direct_push_alert: z.boolean().default(true) }).prefault({}),
  /**
   * Files two tasks running at once would both change and then conflict on (globs). Two tasks that would
   * touch the same one never run together; the second waits while other ready work takes the slot.
   * Absent: lockfiles, registries and changelogs, shared test helpers. An empty list turns holds off.
   */
  hotspots: z.array(z.string().min(1)).optional(),
  /**
   * PR mode: when GitHub reports a harness PR as conflicting, merge its base into the branch and let a worker
   * resolve the conflicted hunks, then the usual checks and evaluator. `max_fixes_per_pr` caps the runs (a
   * run a restart cut short counts). Only merging is supported; rebasing (which rewrites the branch) is not.
   */
  /**
   * PR mode, before an auto-merge: if the default branch moved since the PR's checks ran and its new commits
   * touch what the PR touches (or what those files import), merge them into the PR head in a scratch
   * worktree and run the fast tier (tests.yaml runner.changed) there. Passing: the unchanged, already-green
   * head merges. The PR is never pushed to for this, and the full tier keeps running on the default branch.
   */
  combined_check: z.boolean().default(true),
  /**
   * Research runs (type:research / type:investigation issues, a ```research block): Claude Code's WebSearch and
   * WebFetch only. Fetches of a listed domain (or any subdomain of it) are refused and recorded.
   */
  research: z.strictObject({ domain_blocklist: z.array(z.string().min(1)).default([]) }).prefault({}),
  /**
   * Corrections become durable rules: when a writer rejects a PR, revises or rejects a held plan, requests
   * changes in a review, or corrects the chat ("correction: ..."), a read-only agent proposes the strongest
   * durable fix as an issue the pipeline builds into a reviewed PR. At most `max_per_day` agent runs a day.
   */
  corrections: z
    .strictObject({
      enabled: z.boolean().default(true),
      max_per_day: z.number().int().min(0).default(10),
    })
    .prefault({}),
  /**
   * The gardener: every `every_days` days at `at` (local, off-hours; it starts within 3 hours of it), one read-only
   * run (at most `max_usd`) looks for tech debt and anti-patterns. Findings go to one log issue; a fix is filed only
   * for a pattern seen 3+ times, at most `max_prs` per run, never in a high-risk or safety-floor path.
   */
  gardener: z
    .strictObject({
      enabled: z.boolean().default(false),
      every_days: z.number().int().min(1).max(90).default(7),
      at: hhmm.default('03:00'),
      max_usd: z.number().positive().max(100).default(5),
      max_prs: z.number().int().min(0).max(10).default(1),
    })
    .prefault({}),
  /**
   * Repeated "no"s become checks (src/checks-from-feedback.ts): people's words when they turn the harness's work
   * down (reviews requesting changes, closed PRs, revised or rejected plans, objections, chat corrections), with
   * the reverts as evidence, are grouped into constraints. At `min_sightings` one proposal per constraint: a draft
   * ast-grep rule with its test cases (the repo has sgconfig.yml) or a test, as a draft PR quoting the evidence; an
   * issue instead for a protected area. Never auto-merged; at most `max_proposals_per_week`. Off by default.
   */
  checks_from_feedback: z
    .strictObject({
      enabled: z.boolean().default(false),
      min_sightings: z.number().int().min(2).max(20).default(2),
      max_proposals_per_week: z.number().int().min(0).max(20).default(3),
    })
    .prefault({}),
  conflicts: z
    .strictObject({
      fix: z.boolean().default(true),
      max_fixes_per_pr: z.number().int().min(0).default(1),
      strategy: z.literal('merge').default('merge'),
    })
    .prefault({}),
  /** Machine-wide limits checked before each new agent starts. */
  governor: z
    .strictObject({
      /** Sustained load (max of 5/15-min averages) above which no new agent starts. Default: 2 x cores. */
      max_load: z.number().positive().optional(),
      /** Free disk that must remain after another worktree. */
      min_free_disk_pct: z.number().min(1).max(90).default(15),
    })
    .prefault({}),
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
  'corrections',
  'gardener',
] as const;

export const AgentsConfig = z
  .strictObject({
    /** No longer used (trust stages were removed); accepted so existing configs still load. */
    stage: z.number().int().min(1).max(3).optional(),
    daily_budget_usd: z.number().positive(),
    roles: z.partialRecord(z.enum(RoleNames), role),
    auto_land: z.array(z.string()).default([]),
    /**
     * Tiered evaluation: which model judges a change, from its review level, decided in code. Changes at
     * `cheap_levels` (docs-only, tests-only, comment-only: L0) are judged by `cheap_model`; every other level by
     * the evaluator role's model. A failed or uncertain verdict from the cheap model is judged once more by the
     * evaluator role's model before anything is rejected.
     */
    /**
     * Which model each kind of run uses (src/model-routing.ts); each key overrides its default. Builds: `build`
     * (L1/L2) and `build_high_risk` (issues with a high_risk_labels label, or after escalate_after failed attempts).
     */
    model_routing: z
      .strictObject({
        build: model.optional(),
        build_high_risk: model.optional(),
        high_risk_labels: z.array(z.string().min(1)).optional(),
        escalate_after: z.number().int().min(0).max(10).optional(),
        planner: model.optional(),
        research: model.optional(),
        intake_triage: model.optional(),
        intake_replier: model.optional(),
        intake_summary: model.optional(),
        intake_thread: model.optional(),
        stage_judge: model.optional(),
        eval_answer: model.optional(),
      })
      .optional(),
    /**
     * Open-model providers a model setting can name: `local`, or `hosted:<name>`. Each instance opts in (policy.yaml
     * settings.providers); what each may run is fixed in code (src/providers.ts).
     */
    providers: z
      .strictObject({
        local: provider.optional(),
        hosted: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/), provider).optional(),
      })
      .optional(),
    eval_routing: z
      .strictObject({
        cheap_model: model.default('sonnet'),
        cheap_levels: z.array(z.enum(['L0', 'L1', 'L2', 'L3'])).default(['L0']),
        escalate: z.boolean().default(true),
      })
      .prefault({}),
    /**
     * A change to the agents' own instructions (a skill, AGENTS.md, a role prompt) is evaluated before it
     * lands: its eval cases at the base and at the head. A drop, a cap hit or no cases: the PR waits.
     */
    instruction_evals: z
      .strictObject({
        enabled: z.boolean().default(true),
        /** Spend cap for one eval (base and head together), on the CLI's cost estimate. */
        cap_usd: z.number().positive().default(10),
        /** The model under test (default: the workers' model) and the judge (default: the evaluator's); never the same. */
        model: model.optional(),
        judge: model.optional(),
        samples: z.number().int().min(1).max(5).default(3),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    const w = c.roles.workers;
    if (w && w.count !== undefined && w.max !== undefined && w.count > w.max) {
      ctx.addIssue({ code: 'custom', path: ['roles', 'workers', 'count'], message: `count (${w.count}) exceeds max (${w.max})` });
    }
    if (c.roles.evaluator?.enabled === false && c.roles.workers?.enabled) {
      ctx.addIssue({ code: 'custom', path: ['roles', 'evaluator', 'enabled'], message: 'workers require an enabled evaluator' });
    }
    // An open model only where code allows it, and only one that is configured.
    for (const [key, value] of Object.entries(c.model_routing ?? {})) {
      if (typeof value !== 'string') continue;
      const named = providerOf(value);
      if (!named) continue;
      const route = key === 'build' ? 'build' : key === 'build_high_risk' ? 'build' : (key as RoutedRun);
      const why = key === 'build_high_risk' ? 'hosted and local models never build high-risk work' : providerRefusal(named.kind, { route });
      if (why) ctx.addIssue({ code: 'custom', path: ['model_routing', key], message: why });
      const known = named.kind === 'local' ? c.providers?.local : c.providers?.hosted?.[named.name];
      if (!known) ctx.addIssue({ code: 'custom', path: ['model_routing', key], message: `${value} is not configured under providers` });
    }
    // Everywhere else a model is named (role models, tiered evaluation, instruction evals), only Anthropic models.
    const plain = (path: (string | number)[], m: string | undefined) => m && providerOf(m) && ctx.addIssue({ code: 'custom', path, message: `${m}: open models are only for model_routing (the evaluator and roles keep their models)` });
    for (const [r, cfg] of Object.entries(c.roles)) {
      plain(['roles', r, 'model'], cfg?.model);
      plain(['roles', r, 'hard_issues_model'], cfg?.hard_issues_model);
    }
    plain(['eval_routing', 'cheap_model'], c.eval_routing.cheap_model);
    plain(['instruction_evals', 'model'], c.instruction_evals.model);
    plain(['instruction_evals', 'judge'], c.instruction_evals.judge);
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
  /** Limits on every push of agent-written code (checked on each change, and again at the push). */
  push: z
    .strictObject({
      /** Any file version in the pushed commits over this size is refused, including one added and later deleted. */
      max_file_mb: z.number().positive().default(10),
      /** Lines added plus removed across the change. */
      max_changed_lines: z.number().int().positive().default(1500),
      /** Paths never pushed, in any commit of the change (globs; `**` for any depth). */
      refuse_paths: z.array(z.string()).default([]),
    })
    .prefault({}),
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
      /** Share one dependency cache (pip, uv, npm, pnpm, yarn) across this instance's tasks; never across instances. */
      dep_cache: z.boolean().default(true),
      /** Worktrees kept ready on main, set up, for tasks to start in (0: off). Bounded by free disk. */
      pool: z.number().int().min(0).max(4).default(0),
    })
    .prefault({}),
  land: z
    .strictObject({
      pre: z.array(z.string()).default([]),
      /** Changes tested and landed together; 1 = strictly serial. A red batch is split in half. */
      batch_max: z.number().int().min(1).max(32).default(4),
      /**
       * How long a queued land may wait on the machine-wide full-run slot (held, pass after pass, by another
       * run), measured from its first such deferral in a row, before it goes to the owner.
       */
      defer_timeout_minutes: z.number().int().min(1).max(7 * 24 * 60).default(180),
      /**
       * PR mode: the most of the harness's own ready PRs the merge train merges in one pass of the PR watch
       * (src/merge-policy-train.ts). Each needs every required check green on its exact head and GitHub reporting it
       * mergeable; none is made to merge the default branch in first. Over the cap, a PR merges on the next pass.
       */
      parallel_merges: z.number().int().min(1).max(16).default(4),
      /**
       * PR mode only (coordinator/pr-batch.ts): approved PRs wait in a queue and are tested together, one full run
       * per batch, before any of them merges. Off by default. When on, a PR merges only with every `fast_checks`
       * check passing on its head and a passing full run from a batch that held exactly that head.
       */
      pr_batch: z
        .strictObject({
          enabled: z.boolean().default(false),
          /** The most PRs in one batch. The size starts from the PRs' recent pass rate and never exceeds this. */
          max: z.number().int().min(1).max(32).default(8),
          /** Shards of each batch's full run, run in parallel slots (1: one run). */
          shards: z.number().int().min(1).max(16).default(1),
          /** The fast tier's check names on each PR's head: all must pass before it is queued and before it merges. */
          fast_checks: z.array(z.string().min(1)).default([]),
          /** The full run's check names, posted on each PR's head once its batch passes (left out of readiness until then). */
          full_checks: z.array(z.string().min(1)).default([]),
        })
        .refine((b) => !b.enabled || (b.fast_checks.length > 0 && b.full_checks.length > 0), { message: 'pr_batch needs fast_checks and full_checks when enabled' })
        .prefault({}),
    })
    .prefault({}),
  /** Which tiers gate what. Names are tiers[] entries, or "changed" / "full" (runner commands). */
  gates: z
    .strictObject({
      land: z.array(z.string()).min(1).default(['changed']),
      money_path: z.array(z.string()).default([]),
      nightly: z.array(z.string()).default(['full']),
    })
    .prefault({}),
  /** How the runner lists failures, for the baseline gate ("no new failures vs main"). */
  failures: z.strictObject({ section: regex, item: regex }).optional(),
  /** Local time (HH:MM) to queue the nightly full run (re-records main's baseline) and nightly tiers. */
  nightly_at: hhmm.optional(),
  /** Exits 0 when no full test run is live on this machine (any harness or session). Queued full runs wait for it. */
  idle_probe: z.string().optional(),
  /**
   * A fast check of one file, run after an agent's Edit/Write on it (e.g. `npx eslint {file}`); a failure's output
   * goes back to the agent as feedback. Never blocks the edit; a timeout (20 s) or an error is ignored.
   */
  post_edit: z.string().includes('{file}', { message: 'must contain {file}' }).optional(),
  /**
   * Variables set for the project's agent sessions (and the hooks they run) and its commands
   * (checks, worktree setup), e.g. a fixed test worker count. Never secrets or harness variables.
   */
  env: z
    .record(z.string(), z.string().regex(/^[^\0\n]*$/, 'one line'))
    .superRefine((env, ctx) => {
      for (const k of Object.keys(env)) {
        const why = projectEnvProblem(k);
        if (why) ctx.addIssue({ code: 'custom', path: [k], message: why });
      }
    })
    .default({}),
  /**
   * The core budget: `{cores}` in an env value or a command is replaced by this task's share of the machine's
   * cores (cores minus `reserve`, split over the agents running, within min..max), so parallel test runs never
   * oversubscribe the machine.
   */
  cores: z
    .strictObject({
      reserve: z.number().int().min(0).max(256).default(0),
      min: z.number().int().min(1).max(256).default(1),
      max: z.number().int().min(1).max(256).optional(),
    })
    .refine((c) => c.max === undefined || c.max >= c.min, 'max must be at least min')
    .prefault({}),
  /** Project lints run in the PR-gate tier (e.g. scripts in the config folder's checks/). Non-zero exit fails the gate. */
  checks: z.array(z.string()).default([]),
  /** How long a project command (a check, a suite, a setup step) or an agent run may take before it's stopped. */
  command_timeout_s: z.number().int().min(60).max(86_400).default(7200),
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
  /** The coordinator's own test runs of PRs (src/testrun/, docs/test-runs.md); absent: none. */
  test_run: TestRunConfig.optional(),
  /** The pre-deploy gate (src/deploy-gate/, docs/deploy-gate.md); absent: off. */
  deploy_gate: DeployGateConfig.optional(),
}).superRefine((t, ctx) => {
  for (const p of deployGateProblems(t.deploy_gate, t.test_run ? t.test_run.tiers.map((x) => x.name) : null)) ctx.addIssue({ code: 'custom', path: p.path, message: p.message });
});

// ---------- review.yaml ----------

export const ReviewConfig = z.strictObject({
  version: z.literal(1),
  money_path_source: z.strictObject({ file: z.string().min(1), pattern: regex.optional() }).optional(),
  /** Path categories (globs) the levels can name; a built-in category of the same name is replaced. */
  categories: z.record(z.string(), z.array(z.string())).default({}),
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
  /**
   * PR mode: which of the harness's own ready PRs it may merge itself. Only where the instance policy turns
   * auto-merge on; this can only narrow it. Everything outside it waits for a human.
   */
  merge: z
    .strictObject({
      /** false: every PR waits for a human, whatever the instance policy says. */
      auto: z.boolean().default(true),
      /** Over either and the PR waits. */
      max_lines: z.number().int().positive().default(800),
      max_files: z.number().int().positive().default(20),
      /** Categories (built-in or from `categories`) that wait, on top of the L3 ones, ci-config and dependency. */
      wait_categories: z.array(z.string()).default([]),
      /**
       * Categories the owner stopped waiting on (gradual delegation); a revert, a red main or a later fix in one
       * proposes waiting again. High-risk and safety-floor categories can never be listed here.
       */
      loosened: z.array(z.string()).default([]),
    })
    .prefault({}),
  /**
   * Gradual delegation, suggest-only: a waiting category whose last `min_clean` PRs were approved unchanged, with
   * no revert, red main or later fix, is put to the owner for loosening, with the evidence. Never automatic.
   */
  delegation: z
    .strictObject({
      enabled: z.boolean().default(false),
      min_clean: z.number().int().min(3).default(10),
    })
    .prefault({}),
}).superRefine((r, ctx) => {
  for (const message of loosenedProblems(r)) ctx.addIssue({ code: 'custom', path: ['merge', 'loosened'], message });
});

// ---------- app.yaml ----------
//
// How to run the project's app in a worktree and drive it in a browser (Track B). Off when the file is absent:
// a project without an app pays nothing. Flows name stable targets only (a data-testid or visible text), and
// address the app by path, never by host: the browser only ever opens the app on localhost.

/** A stable target: `testid:<data-testid>` or `text:<visible text>`, as the dashboard's control script drives them. */
const AppTarget = z.string().regex(/^(testid|text):\S/, 'a stable target: testid:<data-testid> or text:<visible text>, never a CSS path');
/** A path on the app (the host is always localhost), e.g. /cart?item=3. */
const AppPath = z.string().regex(/^\/(?!\/)\S*$/, 'a path on the app, starting with one /: the host is always localhost');

export const FlowStep = z.union([
  z.strictObject({ goto: AppPath }),
  z.strictObject({ click: AppTarget }),
  z.strictObject({ type: z.strictObject({ target: AppTarget, text: z.string() }) }),
  z.strictObject({ key: z.string().min(1) }),
  /** A target to appear, or a pause in milliseconds (at most a minute). */
  z.strictObject({ wait: z.union([AppTarget, z.number().int().positive().max(60_000)]) }),
  z.strictObject({ expect_text: z.strictObject({ target: AppTarget, text: z.string().min(1) }) }),
]);
export type FlowStep = z.infer<typeof FlowStep>;

export const AppConfig = z.strictObject({
  version: z.literal(1),
  start: z.strictObject({
    /** Run in the worktree to serve the app on `port`, e.g. `npm run dev -- --port 5173`. */
    command: z.string().min(1),
    port: z.number().int().min(1024).max(65_535),
    /** Ready once this path answers 2xx on localhost:port, within timeout_s. */
    ready: z.strictObject({ path: AppPath.default('/'), timeout_s: z.number().int().positive().max(600).default(60) }).prefault({}),
  }),
  /** Repo-relative globs of the app's UI: a PR touching none of them runs no browser check. */
  ui_paths: z.array(z.string().min(1)).min(1),
  /** What a browser check holds a flow to, besides no new console errors and no failed requests. */
  thresholds: z
    .strictObject({
      /** No single main-thread task longer than this. */
      max_long_task_ms: z.number().int().positive().default(200),
      /** At most this share of frames dropped while the flow runs. */
      max_dropped_frame_pct: z.number().min(0).max(100).default(25),
      /** A request slower than this is reported as slow. */
      slow_request_ms: z.number().int().positive().default(3_000),
    })
    .prefault({}),
  /** Named flows: what a person does in the app, step by step. */
  flows: z.record(z.string(), z.array(FlowStep).min(1)).superRefine((f, ctx) => {
    const names = Object.keys(f);
    if (!names.length) ctx.addIssue({ code: 'custom', message: 'at least one flow' });
    for (const n of names) if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) ctx.addIssue({ code: 'custom', path: [n], message: `"${n}" isn't a flow name: lowercase letters, digits and dashes` });
  }),
});
export type AppConfig = z.infer<typeof AppConfig>;

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
  'app.yaml': AppConfig,
} as const;
