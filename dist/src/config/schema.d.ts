import { z } from 'zod';
import { type Routing } from '../routing.js';
export declare const Area: z.ZodObject<{
    name: z.ZodString;
    owner: z.ZodString;
    paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const ProjectConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    project: z.ZodObject<{
        name: z.ZodString;
        repo: z.ZodString;
        default_branch: z.ZodDefault<z.ZodString>;
    }, z.core.$strict>;
    mode: z.ZodDefault<z.ZodEnum<{
        local: "local";
        shared: "shared";
    }>>;
    backlog: z.ZodDefault<z.ZodEnum<{
        file: "file";
        github: "github";
    }>>;
    runner: z.ZodDefault<z.ZodEnum<{
        local: "local";
        ci: "ci";
        "remote-machine": "remote-machine";
    }>>;
    agent_runtime: z.ZodPrefault<z.ZodObject<{
        kind: z.ZodPipe<z.ZodDefault<z.ZodEnum<{
            cli: "cli";
            api_key: "api_key";
            sdk: "sdk";
        }>>, z.ZodTransform<"cli" | "api_key", "cli" | "api_key" | "sdk">>;
        max_concurrency: z.ZodDefault<z.ZodNumber>;
        run_windows: z.ZodDefault<z.ZodArray<z.ZodObject<{
            from: z.ZodString;
            to: z.ZodString;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    land_mode: z.ZodDefault<z.ZodEnum<{
        pr: "pr";
        direct: "direct";
    }>>;
    plan_gate: z.ZodDefault<z.ZodEnum<{
        always: "always";
        off: "off";
        risky: "risky";
    }>>;
    required_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    ci: z.ZodOptional<z.ZodEnum<{
        none: "none";
        github: "github";
    }>>;
    protection: z.ZodPrefault<z.ZodObject<{
        strict: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    flaky: z.ZodPrefault<z.ZodObject<{
        rerun: z.ZodDefault<z.ZodBoolean>;
        release_after_passes: z.ZodDefault<z.ZodNumber>;
        rerun_timeout_min: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    fix_forward: z.ZodPrefault<z.ZodObject<{
        max_attempts: z.ZodDefault<z.ZodNumber>;
        revert_first_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    main_watch: z.ZodPrefault<z.ZodObject<{
        direct_push_alert: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    hotspots: z.ZodOptional<z.ZodArray<z.ZodString>>;
    combined_check: z.ZodDefault<z.ZodBoolean>;
    research: z.ZodPrefault<z.ZodObject<{
        domain_blocklist: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    corrections: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_per_day: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    automations: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        max_runs_per_day: z.ZodOptional<z.ZodNumber>;
        daily_usd: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    gardener: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        every_days: z.ZodDefault<z.ZodNumber>;
        at: z.ZodDefault<z.ZodString>;
        max_usd: z.ZodDefault<z.ZodNumber>;
        max_prs: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    harness_evals: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        weekly: z.ZodDefault<z.ZodBoolean>;
        on_change: z.ZodDefault<z.ZodBoolean>;
        budget_usd: z.ZodDefault<z.ZodNumber>;
        samples: z.ZodDefault<z.ZodNumber>;
        tasks: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    checks_from_feedback: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        min_sightings: z.ZodDefault<z.ZodNumber>;
        max_proposals_per_week: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    optimize: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        weekday: z.ZodDefault<z.ZodNumber>;
        at: z.ZodDefault<z.ZodString>;
        budget_usd: z.ZodDefault<z.ZodNumber>;
        max_prs: z.ZodDefault<z.ZodNumber>;
        targets: z.ZodDefault<z.ZodArray<z.ZodString>>;
        slow_test_command: z.ZodOptional<z.ZodString>;
        repeats: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    conflicts: z.ZodPrefault<z.ZodObject<{
        fix: z.ZodDefault<z.ZodBoolean>;
        max_fixes_per_pr: z.ZodDefault<z.ZodNumber>;
        strategy: z.ZodDefault<z.ZodLiteral<"merge">>;
    }, z.core.$strict>>;
    pr_hygiene: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        every_hours: z.ZodDefault<z.ZodNumber>;
        stale_after_days: z.ZodDefault<z.ZodNumber>;
        abandon_after_days: z.ZodDefault<z.ZodNumber>;
        hold_labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    governor: z.ZodPrefault<z.ZodObject<{
        max_load: z.ZodOptional<z.ZodNumber>;
        min_free_disk_pct: z.ZodDefault<z.ZodNumber>;
        min_free_disk_gb: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    metrics: z.ZodPrefault<z.ZodObject<{
        slow_test_budget_s: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    os: z.ZodDefault<z.ZodEnum<{
        linux: "linux";
        auto: "auto";
        macos: "macos";
        "windows-wsl": "windows-wsl";
    }>>;
    owners: z.ZodObject<{
        default: z.ZodString;
        writers: z.ZodArray<z.ZodString>;
        areas: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            owner: z.ZodString;
            paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
            labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
    reports: z.ZodPrefault<z.ZodObject<{
        times: z.ZodDefault<z.ZodArray<z.ZodString>>;
        to: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const RoleNames: readonly ["chief_of_staff", "pm", "workers", "evaluator", "security", "qa_playtester", "researcher", "red_attributor", "ci_repair", "monitor", "release_prep", "corrections", "gardener"];
export declare const AgentsConfig: z.ZodPipe<z.ZodObject<{
    stage: z.ZodOptional<z.ZodNumber>;
    daily_budget_usd: z.ZodNumber;
    max_attempts: z.ZodDefault<z.ZodNumber>;
    budget: z.ZodOptional<z.ZodObject<{
        task_minutes: z.ZodOptional<z.ZodNumber>;
        task_tokens: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    roles: z.ZodRecord<z.ZodEnum<{
        pm: "pm";
        evaluator: "evaluator";
        workers: "workers";
        researcher: "researcher";
        chief_of_staff: "chief_of_staff";
        corrections: "corrections";
        gardener: "gardener";
        security: "security";
        qa_playtester: "qa_playtester";
        red_attributor: "red_attributor";
        ci_repair: "ci_repair";
        monitor: "monitor";
        release_prep: "release_prep";
    }> & z.core.$partial, z.ZodObject<{
        enabled: z.ZodBoolean;
        model: z.ZodString;
        count: z.ZodOptional<z.ZodNumber>;
        max: z.ZodOptional<z.ZodNumber>;
        hard_issues_model: z.ZodOptional<z.ZodString>;
        max_per_day: z.ZodOptional<z.ZodNumber>;
        max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
        applies_to: z.ZodOptional<z.ZodArray<z.ZodString>>;
        budget_usd: z.ZodOptional<z.ZodNumber>;
        conversation_budget_usd: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    auto_land: z.ZodDefault<z.ZodArray<z.ZodString>>;
    routing: z.ZodOptional<z.ZodObject<{
        eval_cheap: z.ZodOptional<z.ZodString>;
        eval_cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            L0: "L0";
            L1: "L1";
            L2: "L2";
            L3: "L3";
        }>>>;
        eval_escalate: z.ZodOptional<z.ZodBoolean>;
        eval_cross_family: z.ZodOptional<z.ZodString>;
        build: z.ZodOptional<z.ZodString>;
        build_high_risk: z.ZodOptional<z.ZodString>;
        high_risk_labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        escalate_after: z.ZodOptional<z.ZodNumber>;
        planner: z.ZodOptional<z.ZodString>;
        research: z.ZodOptional<z.ZodString>;
        intake_triage: z.ZodOptional<z.ZodString>;
        intake_replier: z.ZodOptional<z.ZodString>;
        intake_summary: z.ZodOptional<z.ZodString>;
        intake_thread: z.ZodOptional<z.ZodString>;
        stage_judge: z.ZodOptional<z.ZodString>;
        eval_answer: z.ZodOptional<z.ZodString>;
        reflection: z.ZodOptional<z.ZodString>;
        chat: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    model_routing: z.ZodOptional<z.ZodObject<{
        build: z.ZodOptional<z.ZodString>;
        build_high_risk: z.ZodOptional<z.ZodString>;
        high_risk_labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
        escalate_after: z.ZodOptional<z.ZodNumber>;
        planner: z.ZodOptional<z.ZodString>;
        research: z.ZodOptional<z.ZodString>;
        intake_triage: z.ZodOptional<z.ZodString>;
        intake_replier: z.ZodOptional<z.ZodString>;
        intake_summary: z.ZodOptional<z.ZodString>;
        intake_thread: z.ZodOptional<z.ZodString>;
        stage_judge: z.ZodOptional<z.ZodString>;
        eval_answer: z.ZodOptional<z.ZodString>;
        reflection: z.ZodOptional<z.ZodString>;
        chat: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    providers: z.ZodOptional<z.ZodObject<{
        local: z.ZodOptional<z.ZodObject<{
            base_url: z.ZodString;
            credential: z.ZodString;
            model: z.ZodString;
            tier: z.ZodOptional<z.ZodEnum<{
                haiku: "haiku";
                sonnet: "sonnet";
                opus: "opus";
            }>>;
            usd_per_mtok_in: z.ZodOptional<z.ZodNumber>;
            usd_per_mtok_out: z.ZodOptional<z.ZodNumber>;
            gpu_lock: z.ZodOptional<z.ZodString>;
            latency_ms: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        hosted: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            base_url: z.ZodString;
            credential: z.ZodString;
            model: z.ZodString;
            tier: z.ZodOptional<z.ZodEnum<{
                haiku: "haiku";
                sonnet: "sonnet";
                opus: "opus";
            }>>;
            usd_per_mtok_in: z.ZodOptional<z.ZodNumber>;
            usd_per_mtok_out: z.ZodOptional<z.ZodNumber>;
            gpu_lock: z.ZodOptional<z.ZodString>;
            latency_ms: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>>;
        cli: z.ZodOptional<z.ZodObject<{
            codex: z.ZodOptional<z.ZodObject<{
                model: z.ZodString;
                tier: z.ZodEnum<{
                    haiku: "haiku";
                    sonnet: "sonnet";
                    opus: "opus";
                }>;
                usd_per_mtok_in: z.ZodNumber;
                usd_per_mtok_out: z.ZodNumber;
            }, z.core.$strict>>;
            gemini: z.ZodOptional<z.ZodObject<{
                model: z.ZodString;
                tier: z.ZodEnum<{
                    haiku: "haiku";
                    sonnet: "sonnet";
                    opus: "opus";
                }>;
                usd_per_mtok_in: z.ZodNumber;
                usd_per_mtok_out: z.ZodNumber;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    eval_routing: z.ZodOptional<z.ZodObject<{
        cheap_model: z.ZodOptional<z.ZodString>;
        cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            L0: "L0";
            L1: "L1";
            L2: "L2";
            L3: "L3";
        }>>>;
        escalate: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
    instruction_evals: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        cap_usd: z.ZodDefault<z.ZodNumber>;
        model: z.ZodOptional<z.ZodString>;
        judge: z.ZodOptional<z.ZodString>;
        samples: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodTransform<{
    routing: Partial<Routing>;
    routing_from: Partial<Record<"research" | "chat" | "build" | "planner" | "intake_triage" | "intake_replier" | "intake_summary" | "intake_thread" | "stage_judge" | "eval_answer" | "build_high_risk" | "high_risk_labels" | "escalate_after" | "reflection" | "eval_cheap" | "eval_cheap_levels" | "eval_escalate" | "eval_cross_family", string>>;
    daily_budget_usd: number;
    max_attempts: number;
    roles: Partial<Record<"pm" | "evaluator" | "workers" | "researcher" | "chief_of_staff" | "corrections" | "gardener" | "security" | "qa_playtester" | "red_attributor" | "ci_repair" | "monitor" | "release_prep", {
        enabled: boolean;
        model: string;
        count?: number | undefined;
        max?: number | undefined;
        hard_issues_model?: string | undefined;
        max_per_day?: number | undefined;
        max_fixes_per_pr?: number | undefined;
        applies_to?: string[] | undefined;
        budget_usd?: number | undefined;
        conversation_budget_usd?: number | undefined;
    }>>;
    auto_land: string[];
    instruction_evals: {
        enabled: boolean;
        cap_usd: number;
        samples: number;
        model?: string | undefined;
        judge?: string | undefined;
    };
    stage?: number | undefined;
    budget?: {
        task_minutes?: number | undefined;
        task_tokens?: number | undefined;
    } | undefined;
    providers?: {
        local?: {
            base_url: string;
            credential: string;
            model: string;
            tier?: "haiku" | "sonnet" | "opus" | undefined;
            usd_per_mtok_in?: number | undefined;
            usd_per_mtok_out?: number | undefined;
            gpu_lock?: string | undefined;
            latency_ms?: number | undefined;
        } | undefined;
        hosted?: Record<string, {
            base_url: string;
            credential: string;
            model: string;
            tier?: "haiku" | "sonnet" | "opus" | undefined;
            usd_per_mtok_in?: number | undefined;
            usd_per_mtok_out?: number | undefined;
            gpu_lock?: string | undefined;
            latency_ms?: number | undefined;
        }> | undefined;
        cli?: {
            codex?: {
                model: string;
                tier: "haiku" | "sonnet" | "opus";
                usd_per_mtok_in: number;
                usd_per_mtok_out: number;
            } | undefined;
            gemini?: {
                model: string;
                tier: "haiku" | "sonnet" | "opus";
                usd_per_mtok_in: number;
                usd_per_mtok_out: number;
            } | undefined;
        } | undefined;
    } | undefined;
}, {
    daily_budget_usd: number;
    max_attempts: number;
    roles: Partial<Record<"pm" | "evaluator" | "workers" | "researcher" | "chief_of_staff" | "corrections" | "gardener" | "security" | "qa_playtester" | "red_attributor" | "ci_repair" | "monitor" | "release_prep", {
        enabled: boolean;
        model: string;
        count?: number | undefined;
        max?: number | undefined;
        hard_issues_model?: string | undefined;
        max_per_day?: number | undefined;
        max_fixes_per_pr?: number | undefined;
        applies_to?: string[] | undefined;
        budget_usd?: number | undefined;
        conversation_budget_usd?: number | undefined;
    }>>;
    auto_land: string[];
    instruction_evals: {
        enabled: boolean;
        cap_usd: number;
        samples: number;
        model?: string | undefined;
        judge?: string | undefined;
    };
    stage?: number | undefined;
    budget?: {
        task_minutes?: number | undefined;
        task_tokens?: number | undefined;
    } | undefined;
    routing?: {
        eval_cheap?: string | undefined;
        eval_cheap_levels?: ("L0" | "L1" | "L2" | "L3")[] | undefined;
        eval_escalate?: boolean | undefined;
        eval_cross_family?: string | undefined;
        build?: string | undefined;
        build_high_risk?: string | undefined;
        high_risk_labels?: string[] | undefined;
        escalate_after?: number | undefined;
        planner?: string | undefined;
        research?: string | undefined;
        intake_triage?: string | undefined;
        intake_replier?: string | undefined;
        intake_summary?: string | undefined;
        intake_thread?: string | undefined;
        stage_judge?: string | undefined;
        eval_answer?: string | undefined;
        reflection?: string | undefined;
        chat?: string | undefined;
    } | undefined;
    model_routing?: {
        build?: string | undefined;
        build_high_risk?: string | undefined;
        high_risk_labels?: string[] | undefined;
        escalate_after?: number | undefined;
        planner?: string | undefined;
        research?: string | undefined;
        intake_triage?: string | undefined;
        intake_replier?: string | undefined;
        intake_summary?: string | undefined;
        intake_thread?: string | undefined;
        stage_judge?: string | undefined;
        eval_answer?: string | undefined;
        reflection?: string | undefined;
        chat?: string | undefined;
    } | undefined;
    providers?: {
        local?: {
            base_url: string;
            credential: string;
            model: string;
            tier?: "haiku" | "sonnet" | "opus" | undefined;
            usd_per_mtok_in?: number | undefined;
            usd_per_mtok_out?: number | undefined;
            gpu_lock?: string | undefined;
            latency_ms?: number | undefined;
        } | undefined;
        hosted?: Record<string, {
            base_url: string;
            credential: string;
            model: string;
            tier?: "haiku" | "sonnet" | "opus" | undefined;
            usd_per_mtok_in?: number | undefined;
            usd_per_mtok_out?: number | undefined;
            gpu_lock?: string | undefined;
            latency_ms?: number | undefined;
        }> | undefined;
        cli?: {
            codex?: {
                model: string;
                tier: "haiku" | "sonnet" | "opus";
                usd_per_mtok_in: number;
                usd_per_mtok_out: number;
            } | undefined;
            gemini?: {
                model: string;
                tier: "haiku" | "sonnet" | "opus";
                usd_per_mtok_in: number;
                usd_per_mtok_out: number;
            } | undefined;
        } | undefined;
    } | undefined;
    eval_routing?: {
        cheap_model?: string | undefined;
        cheap_levels?: ("L0" | "L1" | "L2" | "L3")[] | undefined;
        escalate?: boolean | undefined;
    } | undefined;
}>>;
export declare const RuleMatch: z.ZodUnion<readonly [z.ZodObject<{
    command: z.ZodObject<{
        pattern: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    cli_env: z.ZodObject<{
        cli: z.ZodString;
        subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
        flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
        flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
        environments: z.ZodArray<z.ZodString>;
        env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
        resolver: z.ZodDefault<z.ZodEnum<{
            none: "none";
            railway: "railway";
        }>>;
        unresolved: z.ZodDefault<z.ZodEnum<{
            match: "match";
            no_match: "no_match";
        }>>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    connection: z.ZodObject<{
        fingerprints: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    path: z.ZodObject<{
        globs: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export declare const Rule: z.ZodObject<{
    id: z.ZodString;
    action: z.ZodEnum<{
        ask: "ask";
        block: "block";
    }>;
    reason: z.ZodString;
    applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        agent: "agent";
        interactive: "interactive";
    }>>>;
    match: z.ZodUnion<readonly [z.ZodObject<{
        command: z.ZodObject<{
            pattern: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        cli_env: z.ZodObject<{
            cli: z.ZodString;
            subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
            flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
            flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
            environments: z.ZodArray<z.ZodString>;
            env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
            resolver: z.ZodDefault<z.ZodEnum<{
                none: "none";
                railway: "railway";
            }>>;
            unresolved: z.ZodDefault<z.ZodEnum<{
                match: "match";
                no_match: "no_match";
            }>>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        connection: z.ZodObject<{
            fingerprints: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        path: z.ZodObject<{
            globs: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>]>;
    unless: z.ZodOptional<z.ZodObject<{
        pattern: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const Example: z.ZodUnion<readonly [z.ZodObject<{
    bash: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
    cwd: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    tool: z.ZodEnum<{
        Write: "Write";
        Edit: "Edit";
        MultiEdit: "MultiEdit";
        NotebookEdit: "NotebookEdit";
        Read: "Read";
        Grep: "Grep";
    }>;
    path: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    fetch: z.ZodString;
    agent: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>]>;
export declare const GuardrailsConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        action: z.ZodEnum<{
            ask: "ask";
            block: "block";
        }>;
        reason: z.ZodString;
        applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            agent: "agent";
            interactive: "interactive";
        }>>>;
        match: z.ZodUnion<readonly [z.ZodObject<{
            command: z.ZodObject<{
                pattern: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            cli_env: z.ZodObject<{
                cli: z.ZodString;
                subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
                flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
                flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
                environments: z.ZodArray<z.ZodString>;
                env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
                resolver: z.ZodDefault<z.ZodEnum<{
                    none: "none";
                    railway: "railway";
                }>>;
                unresolved: z.ZodDefault<z.ZodEnum<{
                    match: "match";
                    no_match: "no_match";
                }>>;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            connection: z.ZodObject<{
                fingerprints: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            path: z.ZodObject<{
                globs: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
        }, z.core.$strict>]>;
        unless: z.ZodOptional<z.ZodObject<{
            pattern: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
    fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        command: z.ZodString;
        key: z.ZodString;
    }, z.core.$strict>>>;
    protected_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    secret_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    credential_stores: z.ZodDefault<z.ZodArray<z.ZodString>>;
    network: z.ZodPrefault<z.ZodObject<{
        allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    push: z.ZodPrefault<z.ZodObject<{
        max_file_mb: z.ZodDefault<z.ZodNumber>;
        max_changed_lines: z.ZodDefault<z.ZodNumber>;
        refuse_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    pre_approved: z.ZodDefault<z.ZodArray<z.ZodString>>;
    examples: z.ZodPrefault<z.ZodObject<{
        must_block: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Write: "Write";
                Edit: "Edit";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        must_ask: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Write: "Write";
                Edit: "Edit";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        must_allow: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            bash: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
            cwd: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            tool: z.ZodEnum<{
                Write: "Write";
                Edit: "Edit";
                MultiEdit: "MultiEdit";
                NotebookEdit: "NotebookEdit";
                Read: "Read";
                Grep: "Grep";
            }>;
            path: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>, z.ZodObject<{
            fetch: z.ZodString;
            agent: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>]>>>;
        fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        linked_environments: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const TestsConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    runner: z.ZodObject<{
        kind: z.ZodLiteral<"command">;
        changed: z.ZodString;
        full: z.ZodString;
        one: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    vacuity: z.ZodOptional<z.ZodObject<{
        test_globs: z.ZodArray<z.ZodString>;
        assertion_pattern: z.ZodString;
        app_paths: z.ZodArray<z.ZodString>;
        dynamic: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
    stop_gate: z.ZodPrefault<z.ZodObject<{
        timeout_s: z.ZodDefault<z.ZodNumber>;
        lock_wait_s: z.ZodDefault<z.ZodNumber>;
        busy_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    worktree: z.ZodPrefault<z.ZodObject<{
        root: z.ZodDefault<z.ZodString>;
        setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
        est_size_gb: z.ZodDefault<z.ZodNumber>;
        dep_cache: z.ZodDefault<z.ZodBoolean>;
        pool: z.ZodDefault<z.ZodNumber>;
        setup_key: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    checkout: z.ZodPrefault<z.ZodObject<{
        sparse_exclude: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
    }, z.core.$strict>>;
    land: z.ZodPrefault<z.ZodObject<{
        pre: z.ZodDefault<z.ZodArray<z.ZodString>>;
        batch_max: z.ZodDefault<z.ZodNumber>;
        defer_timeout_minutes: z.ZodDefault<z.ZodNumber>;
        parallel_merges: z.ZodDefault<z.ZodNumber>;
        pr_batch: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            max: z.ZodDefault<z.ZodNumber>;
            shards: z.ZodDefault<z.ZodNumber>;
            fast_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
            full_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    gates: z.ZodPrefault<z.ZodObject<{
        land: z.ZodDefault<z.ZodArray<z.ZodString>>;
        money_path: z.ZodDefault<z.ZodArray<z.ZodString>>;
        nightly: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    failures: z.ZodOptional<z.ZodObject<{
        section: z.ZodString;
        item: z.ZodString;
    }, z.core.$strict>>;
    nightly_at: z.ZodOptional<z.ZodString>;
    idle_probe: z.ZodOptional<z.ZodString>;
    post_edit: z.ZodOptional<z.ZodString>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    cores: z.ZodPrefault<z.ZodObject<{
        reserve: z.ZodDefault<z.ZodNumber>;
        min: z.ZodDefault<z.ZodNumber>;
        max: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    command_timeout_s: z.ZodDefault<z.ZodNumber>;
    tiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        max_disk_used_pct: z.ZodOptional<z.ZodNumber>;
        exclusive: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>>;
    test_run: z.ZodOptional<z.ZodObject<{
        select: z.ZodOptional<z.ZodEnum<{
            imports: "imports";
            repo: "repo";
            off: "off";
        }>>;
        setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
        fetch: z.ZodDefault<z.ZodArray<z.ZodObject<{
            npm: z.ZodString;
        }, z.core.$strict>>>;
        setup_network: z.ZodDefault<z.ZodBoolean>;
        tiers: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodString;
            kind: z.ZodEnum<{
                fast: "fast";
                full: "full";
            }>;
            database: z.ZodDefault<z.ZodBoolean>;
            shardable: z.ZodDefault<z.ZodBoolean>;
            full_checkout: z.ZodDefault<z.ZodBoolean>;
            gpu: z.ZodDefault<z.ZodBoolean>;
            network: z.ZodDefault<z.ZodBoolean>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        database: z.ZodOptional<z.ZodObject<{
            image: z.ZodString;
            name: z.ZodDefault<z.ZodString>;
            ready_timeout_s: z.ZodDefault<z.ZodNumber>;
            max_connections: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        caches: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            env: z.ZodString;
            key: z.ZodArray<z.ZodString>;
        }, z.core.$strict>>>;
        shared: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            env: z.ZodString;
        }, z.core.$strict>>>;
        checks: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>>;
    deploy_gate: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        branch: z.ZodDefault<z.ZodString>;
        tiers: z.ZodArray<z.ZodString>;
        notify: z.ZodDefault<z.ZodEnum<{
            off: "off";
            ops: "ops";
        }>>;
        post_deploy: z.ZodOptional<z.ZodObject<{
            host: z.ZodLiteral<"railway">;
            project: z.ZodString;
            environment: z.ZodString;
            services: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>>;
            origin: z.ZodString;
            checks: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                kind: z.ZodEnum<{
                    api: "api";
                    sign_in: "sign_in";
                    health: "health";
                }>;
                url: z.ZodString;
                method: z.ZodDefault<z.ZodLiteral<"GET">>;
                expect_status: z.ZodNumber;
                expect_text: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>;
            wait_for_deploy_s: z.ZodDefault<z.ZodNumber>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
            github_environment: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    preview: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        host: z.ZodDefault<z.ZodLiteral<"railway">>;
        project: z.ZodOptional<z.ZodString>;
        template_environment: z.ZodOptional<z.ZodString>;
        services: z.ZodOptional<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            id: z.ZodString;
        }, z.core.$strict>>>;
        url_service: z.ZodOptional<z.ZodString>;
        flows: z.ZodOptional<z.ZodArray<z.ZodString>>;
        max_concurrent: z.ZodDefault<z.ZodNumber>;
        timeout_s: z.ZodDefault<z.ZodNumber>;
        ttl_hours: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** Generated files not counted toward review.yaml max_pr_lines, unless a repo lists its own. */
export declare const DEFAULT_GENERATED: string[];
export declare const ReviewConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    money_path_source: z.ZodOptional<z.ZodObject<{
        file: z.ZodString;
        pattern: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    categories: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
    levels: z.ZodObject<{
        L0_auto: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            max_lines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        L1_evaluator: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            max_lines: z.ZodOptional<z.ZodNumber>;
            max_files: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
        L2_notify: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
        L3_human: z.ZodObject<{
            when: z.ZodArray<z.ZodString>;
            over_lines: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    merge: z.ZodPrefault<z.ZodObject<{
        auto: z.ZodDefault<z.ZodBoolean>;
        max_lines: z.ZodDefault<z.ZodNumber>;
        max_files: z.ZodDefault<z.ZodNumber>;
        wait_categories: z.ZodDefault<z.ZodArray<z.ZodString>>;
        loosened: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
    max_pr_lines: z.ZodDefault<z.ZodNumber>;
    generated: z.ZodDefault<z.ZodArray<z.ZodString>>;
    docs_only_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    delegation: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        min_clean: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const FlowStep: z.ZodUnion<readonly [z.ZodObject<{
    goto: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    click: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    type: z.ZodObject<{
        target: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    key: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    wait: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>, z.ZodObject<{
    expect_text: z.ZodObject<{
        target: z.ZodString;
        text: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>]>;
export type FlowStep = z.infer<typeof FlowStep>;
export declare const AppConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    start: z.ZodObject<{
        command: z.ZodString;
        port: z.ZodNumber;
        ready: z.ZodPrefault<z.ZodObject<{
            path: z.ZodDefault<z.ZodString>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    ui_paths: z.ZodArray<z.ZodString>;
    thresholds: z.ZodPrefault<z.ZodObject<{
        max_long_task_ms: z.ZodDefault<z.ZodNumber>;
        max_dropped_frame_pct: z.ZodDefault<z.ZodNumber>;
        slow_request_ms: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    flows: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        goto: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        click: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        type: z.ZodObject<{
            target: z.ZodString;
            text: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        key: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        wait: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    }, z.core.$strict>, z.ZodObject<{
        expect_text: z.ZodObject<{
            target: z.ZodString;
            text: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>]>>>;
}, z.core.$strict>;
export type AppConfig = z.infer<typeof AppConfig>;
export declare const DeployConfig: z.ZodObject<{
    version: z.ZodLiteral<1>;
    prod_read: z.ZodOptional<z.ZodObject<{
        via: z.ZodLiteral<"railway-ssh">;
        service: z.ZodString;
        environment: z.ZodString;
        url_var: z.ZodString;
        max_rows: z.ZodDefault<z.ZodNumber>;
        timeout_s: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    environments: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        trigger: z.ZodOptional<z.ZodString>;
        verify: z.ZodString;
        production: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type AgentsConfig = z.infer<typeof AgentsConfig>;
export type GuardrailsConfig = z.infer<typeof GuardrailsConfig>;
export type Rule = z.infer<typeof Rule>;
export type Example = z.infer<typeof Example>;
export type TestsConfig = z.infer<typeof TestsConfig>;
export type ReviewConfig = z.infer<typeof ReviewConfig>;
export type DeployConfig = z.infer<typeof DeployConfig>;
export declare const FILES: {
    readonly 'config.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        project: z.ZodObject<{
            name: z.ZodString;
            repo: z.ZodString;
            default_branch: z.ZodDefault<z.ZodString>;
        }, z.core.$strict>;
        mode: z.ZodDefault<z.ZodEnum<{
            local: "local";
            shared: "shared";
        }>>;
        backlog: z.ZodDefault<z.ZodEnum<{
            file: "file";
            github: "github";
        }>>;
        runner: z.ZodDefault<z.ZodEnum<{
            local: "local";
            ci: "ci";
            "remote-machine": "remote-machine";
        }>>;
        agent_runtime: z.ZodPrefault<z.ZodObject<{
            kind: z.ZodPipe<z.ZodDefault<z.ZodEnum<{
                cli: "cli";
                api_key: "api_key";
                sdk: "sdk";
            }>>, z.ZodTransform<"cli" | "api_key", "cli" | "api_key" | "sdk">>;
            max_concurrency: z.ZodDefault<z.ZodNumber>;
            run_windows: z.ZodDefault<z.ZodArray<z.ZodObject<{
                from: z.ZodString;
                to: z.ZodString;
            }, z.core.$strict>>>;
        }, z.core.$strict>>;
        land_mode: z.ZodDefault<z.ZodEnum<{
            pr: "pr";
            direct: "direct";
        }>>;
        plan_gate: z.ZodDefault<z.ZodEnum<{
            always: "always";
            off: "off";
            risky: "risky";
        }>>;
        required_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        ci: z.ZodOptional<z.ZodEnum<{
            none: "none";
            github: "github";
        }>>;
        protection: z.ZodPrefault<z.ZodObject<{
            strict: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        flaky: z.ZodPrefault<z.ZodObject<{
            rerun: z.ZodDefault<z.ZodBoolean>;
            release_after_passes: z.ZodDefault<z.ZodNumber>;
            rerun_timeout_min: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        fix_forward: z.ZodPrefault<z.ZodObject<{
            max_attempts: z.ZodDefault<z.ZodNumber>;
            revert_first_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        main_watch: z.ZodPrefault<z.ZodObject<{
            direct_push_alert: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        hotspots: z.ZodOptional<z.ZodArray<z.ZodString>>;
        combined_check: z.ZodDefault<z.ZodBoolean>;
        research: z.ZodPrefault<z.ZodObject<{
            domain_blocklist: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        corrections: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            max_per_day: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        automations: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            max_runs_per_day: z.ZodOptional<z.ZodNumber>;
            daily_usd: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        gardener: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            every_days: z.ZodDefault<z.ZodNumber>;
            at: z.ZodDefault<z.ZodString>;
            max_usd: z.ZodDefault<z.ZodNumber>;
            max_prs: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        harness_evals: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            weekly: z.ZodDefault<z.ZodBoolean>;
            on_change: z.ZodDefault<z.ZodBoolean>;
            budget_usd: z.ZodDefault<z.ZodNumber>;
            samples: z.ZodDefault<z.ZodNumber>;
            tasks: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        checks_from_feedback: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            min_sightings: z.ZodDefault<z.ZodNumber>;
            max_proposals_per_week: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        optimize: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            weekday: z.ZodDefault<z.ZodNumber>;
            at: z.ZodDefault<z.ZodString>;
            budget_usd: z.ZodDefault<z.ZodNumber>;
            max_prs: z.ZodDefault<z.ZodNumber>;
            targets: z.ZodDefault<z.ZodArray<z.ZodString>>;
            slow_test_command: z.ZodOptional<z.ZodString>;
            repeats: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        conflicts: z.ZodPrefault<z.ZodObject<{
            fix: z.ZodDefault<z.ZodBoolean>;
            max_fixes_per_pr: z.ZodDefault<z.ZodNumber>;
            strategy: z.ZodDefault<z.ZodLiteral<"merge">>;
        }, z.core.$strict>>;
        pr_hygiene: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            every_hours: z.ZodDefault<z.ZodNumber>;
            stale_after_days: z.ZodDefault<z.ZodNumber>;
            abandon_after_days: z.ZodDefault<z.ZodNumber>;
            hold_labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        governor: z.ZodPrefault<z.ZodObject<{
            max_load: z.ZodOptional<z.ZodNumber>;
            min_free_disk_pct: z.ZodDefault<z.ZodNumber>;
            min_free_disk_gb: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        metrics: z.ZodPrefault<z.ZodObject<{
            slow_test_budget_s: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        os: z.ZodDefault<z.ZodEnum<{
            linux: "linux";
            auto: "auto";
            macos: "macos";
            "windows-wsl": "windows-wsl";
        }>>;
        owners: z.ZodObject<{
            default: z.ZodString;
            writers: z.ZodArray<z.ZodString>;
            areas: z.ZodDefault<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                owner: z.ZodString;
                paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
                labels: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>>;
        }, z.core.$strict>;
        reports: z.ZodPrefault<z.ZodObject<{
            times: z.ZodDefault<z.ZodArray<z.ZodString>>;
            to: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'agents.yaml': z.ZodPipe<z.ZodObject<{
        stage: z.ZodOptional<z.ZodNumber>;
        daily_budget_usd: z.ZodNumber;
        max_attempts: z.ZodDefault<z.ZodNumber>;
        budget: z.ZodOptional<z.ZodObject<{
            task_minutes: z.ZodOptional<z.ZodNumber>;
            task_tokens: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        roles: z.ZodRecord<z.ZodEnum<{
            pm: "pm";
            evaluator: "evaluator";
            workers: "workers";
            researcher: "researcher";
            chief_of_staff: "chief_of_staff";
            corrections: "corrections";
            gardener: "gardener";
            security: "security";
            qa_playtester: "qa_playtester";
            red_attributor: "red_attributor";
            ci_repair: "ci_repair";
            monitor: "monitor";
            release_prep: "release_prep";
        }> & z.core.$partial, z.ZodObject<{
            enabled: z.ZodBoolean;
            model: z.ZodString;
            count: z.ZodOptional<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
            hard_issues_model: z.ZodOptional<z.ZodString>;
            max_per_day: z.ZodOptional<z.ZodNumber>;
            max_fixes_per_pr: z.ZodOptional<z.ZodNumber>;
            applies_to: z.ZodOptional<z.ZodArray<z.ZodString>>;
            budget_usd: z.ZodOptional<z.ZodNumber>;
            conversation_budget_usd: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        auto_land: z.ZodDefault<z.ZodArray<z.ZodString>>;
        routing: z.ZodOptional<z.ZodObject<{
            eval_cheap: z.ZodOptional<z.ZodString>;
            eval_cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                L0: "L0";
                L1: "L1";
                L2: "L2";
                L3: "L3";
            }>>>;
            eval_escalate: z.ZodOptional<z.ZodBoolean>;
            eval_cross_family: z.ZodOptional<z.ZodString>;
            build: z.ZodOptional<z.ZodString>;
            build_high_risk: z.ZodOptional<z.ZodString>;
            high_risk_labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            escalate_after: z.ZodOptional<z.ZodNumber>;
            planner: z.ZodOptional<z.ZodString>;
            research: z.ZodOptional<z.ZodString>;
            intake_triage: z.ZodOptional<z.ZodString>;
            intake_replier: z.ZodOptional<z.ZodString>;
            intake_summary: z.ZodOptional<z.ZodString>;
            intake_thread: z.ZodOptional<z.ZodString>;
            stage_judge: z.ZodOptional<z.ZodString>;
            eval_answer: z.ZodOptional<z.ZodString>;
            reflection: z.ZodOptional<z.ZodString>;
            chat: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        model_routing: z.ZodOptional<z.ZodObject<{
            build: z.ZodOptional<z.ZodString>;
            build_high_risk: z.ZodOptional<z.ZodString>;
            high_risk_labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
            escalate_after: z.ZodOptional<z.ZodNumber>;
            planner: z.ZodOptional<z.ZodString>;
            research: z.ZodOptional<z.ZodString>;
            intake_triage: z.ZodOptional<z.ZodString>;
            intake_replier: z.ZodOptional<z.ZodString>;
            intake_summary: z.ZodOptional<z.ZodString>;
            intake_thread: z.ZodOptional<z.ZodString>;
            stage_judge: z.ZodOptional<z.ZodString>;
            eval_answer: z.ZodOptional<z.ZodString>;
            reflection: z.ZodOptional<z.ZodString>;
            chat: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        providers: z.ZodOptional<z.ZodObject<{
            local: z.ZodOptional<z.ZodObject<{
                base_url: z.ZodString;
                credential: z.ZodString;
                model: z.ZodString;
                tier: z.ZodOptional<z.ZodEnum<{
                    haiku: "haiku";
                    sonnet: "sonnet";
                    opus: "opus";
                }>>;
                usd_per_mtok_in: z.ZodOptional<z.ZodNumber>;
                usd_per_mtok_out: z.ZodOptional<z.ZodNumber>;
                gpu_lock: z.ZodOptional<z.ZodString>;
                latency_ms: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            hosted: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
                base_url: z.ZodString;
                credential: z.ZodString;
                model: z.ZodString;
                tier: z.ZodOptional<z.ZodEnum<{
                    haiku: "haiku";
                    sonnet: "sonnet";
                    opus: "opus";
                }>>;
                usd_per_mtok_in: z.ZodOptional<z.ZodNumber>;
                usd_per_mtok_out: z.ZodOptional<z.ZodNumber>;
                gpu_lock: z.ZodOptional<z.ZodString>;
                latency_ms: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>>;
            cli: z.ZodOptional<z.ZodObject<{
                codex: z.ZodOptional<z.ZodObject<{
                    model: z.ZodString;
                    tier: z.ZodEnum<{
                        haiku: "haiku";
                        sonnet: "sonnet";
                        opus: "opus";
                    }>;
                    usd_per_mtok_in: z.ZodNumber;
                    usd_per_mtok_out: z.ZodNumber;
                }, z.core.$strict>>;
                gemini: z.ZodOptional<z.ZodObject<{
                    model: z.ZodString;
                    tier: z.ZodEnum<{
                        haiku: "haiku";
                        sonnet: "sonnet";
                        opus: "opus";
                    }>;
                    usd_per_mtok_in: z.ZodNumber;
                    usd_per_mtok_out: z.ZodNumber;
                }, z.core.$strict>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        eval_routing: z.ZodOptional<z.ZodObject<{
            cheap_model: z.ZodOptional<z.ZodString>;
            cheap_levels: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                L0: "L0";
                L1: "L1";
                L2: "L2";
                L3: "L3";
            }>>>;
            escalate: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>;
        instruction_evals: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            cap_usd: z.ZodDefault<z.ZodNumber>;
            model: z.ZodOptional<z.ZodString>;
            judge: z.ZodOptional<z.ZodString>;
            samples: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodTransform<{
        routing: Partial<Routing>;
        routing_from: Partial<Record<"research" | "chat" | "build" | "planner" | "intake_triage" | "intake_replier" | "intake_summary" | "intake_thread" | "stage_judge" | "eval_answer" | "build_high_risk" | "high_risk_labels" | "escalate_after" | "reflection" | "eval_cheap" | "eval_cheap_levels" | "eval_escalate" | "eval_cross_family", string>>;
        daily_budget_usd: number;
        max_attempts: number;
        roles: Partial<Record<"pm" | "evaluator" | "workers" | "researcher" | "chief_of_staff" | "corrections" | "gardener" | "security" | "qa_playtester" | "red_attributor" | "ci_repair" | "monitor" | "release_prep", {
            enabled: boolean;
            model: string;
            count?: number | undefined;
            max?: number | undefined;
            hard_issues_model?: string | undefined;
            max_per_day?: number | undefined;
            max_fixes_per_pr?: number | undefined;
            applies_to?: string[] | undefined;
            budget_usd?: number | undefined;
            conversation_budget_usd?: number | undefined;
        }>>;
        auto_land: string[];
        instruction_evals: {
            enabled: boolean;
            cap_usd: number;
            samples: number;
            model?: string | undefined;
            judge?: string | undefined;
        };
        stage?: number | undefined;
        budget?: {
            task_minutes?: number | undefined;
            task_tokens?: number | undefined;
        } | undefined;
        providers?: {
            local?: {
                base_url: string;
                credential: string;
                model: string;
                tier?: "haiku" | "sonnet" | "opus" | undefined;
                usd_per_mtok_in?: number | undefined;
                usd_per_mtok_out?: number | undefined;
                gpu_lock?: string | undefined;
                latency_ms?: number | undefined;
            } | undefined;
            hosted?: Record<string, {
                base_url: string;
                credential: string;
                model: string;
                tier?: "haiku" | "sonnet" | "opus" | undefined;
                usd_per_mtok_in?: number | undefined;
                usd_per_mtok_out?: number | undefined;
                gpu_lock?: string | undefined;
                latency_ms?: number | undefined;
            }> | undefined;
            cli?: {
                codex?: {
                    model: string;
                    tier: "haiku" | "sonnet" | "opus";
                    usd_per_mtok_in: number;
                    usd_per_mtok_out: number;
                } | undefined;
                gemini?: {
                    model: string;
                    tier: "haiku" | "sonnet" | "opus";
                    usd_per_mtok_in: number;
                    usd_per_mtok_out: number;
                } | undefined;
            } | undefined;
        } | undefined;
    }, {
        daily_budget_usd: number;
        max_attempts: number;
        roles: Partial<Record<"pm" | "evaluator" | "workers" | "researcher" | "chief_of_staff" | "corrections" | "gardener" | "security" | "qa_playtester" | "red_attributor" | "ci_repair" | "monitor" | "release_prep", {
            enabled: boolean;
            model: string;
            count?: number | undefined;
            max?: number | undefined;
            hard_issues_model?: string | undefined;
            max_per_day?: number | undefined;
            max_fixes_per_pr?: number | undefined;
            applies_to?: string[] | undefined;
            budget_usd?: number | undefined;
            conversation_budget_usd?: number | undefined;
        }>>;
        auto_land: string[];
        instruction_evals: {
            enabled: boolean;
            cap_usd: number;
            samples: number;
            model?: string | undefined;
            judge?: string | undefined;
        };
        stage?: number | undefined;
        budget?: {
            task_minutes?: number | undefined;
            task_tokens?: number | undefined;
        } | undefined;
        routing?: {
            eval_cheap?: string | undefined;
            eval_cheap_levels?: ("L0" | "L1" | "L2" | "L3")[] | undefined;
            eval_escalate?: boolean | undefined;
            eval_cross_family?: string | undefined;
            build?: string | undefined;
            build_high_risk?: string | undefined;
            high_risk_labels?: string[] | undefined;
            escalate_after?: number | undefined;
            planner?: string | undefined;
            research?: string | undefined;
            intake_triage?: string | undefined;
            intake_replier?: string | undefined;
            intake_summary?: string | undefined;
            intake_thread?: string | undefined;
            stage_judge?: string | undefined;
            eval_answer?: string | undefined;
            reflection?: string | undefined;
            chat?: string | undefined;
        } | undefined;
        model_routing?: {
            build?: string | undefined;
            build_high_risk?: string | undefined;
            high_risk_labels?: string[] | undefined;
            escalate_after?: number | undefined;
            planner?: string | undefined;
            research?: string | undefined;
            intake_triage?: string | undefined;
            intake_replier?: string | undefined;
            intake_summary?: string | undefined;
            intake_thread?: string | undefined;
            stage_judge?: string | undefined;
            eval_answer?: string | undefined;
            reflection?: string | undefined;
            chat?: string | undefined;
        } | undefined;
        providers?: {
            local?: {
                base_url: string;
                credential: string;
                model: string;
                tier?: "haiku" | "sonnet" | "opus" | undefined;
                usd_per_mtok_in?: number | undefined;
                usd_per_mtok_out?: number | undefined;
                gpu_lock?: string | undefined;
                latency_ms?: number | undefined;
            } | undefined;
            hosted?: Record<string, {
                base_url: string;
                credential: string;
                model: string;
                tier?: "haiku" | "sonnet" | "opus" | undefined;
                usd_per_mtok_in?: number | undefined;
                usd_per_mtok_out?: number | undefined;
                gpu_lock?: string | undefined;
                latency_ms?: number | undefined;
            }> | undefined;
            cli?: {
                codex?: {
                    model: string;
                    tier: "haiku" | "sonnet" | "opus";
                    usd_per_mtok_in: number;
                    usd_per_mtok_out: number;
                } | undefined;
                gemini?: {
                    model: string;
                    tier: "haiku" | "sonnet" | "opus";
                    usd_per_mtok_in: number;
                    usd_per_mtok_out: number;
                } | undefined;
            } | undefined;
        } | undefined;
        eval_routing?: {
            cheap_model?: string | undefined;
            cheap_levels?: ("L0" | "L1" | "L2" | "L3")[] | undefined;
            escalate?: boolean | undefined;
        } | undefined;
    }>>;
    readonly 'guardrails.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            action: z.ZodEnum<{
                ask: "ask";
                block: "block";
            }>;
            reason: z.ZodString;
            applies_to: z.ZodDefault<z.ZodArray<z.ZodEnum<{
                agent: "agent";
                interactive: "interactive";
            }>>>;
            match: z.ZodUnion<readonly [z.ZodObject<{
                command: z.ZodObject<{
                    pattern: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                cli_env: z.ZodObject<{
                    cli: z.ZodString;
                    subcommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    flags_any: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    flags_none: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    environments: z.ZodArray<z.ZodString>;
                    env_flags: z.ZodDefault<z.ZodArray<z.ZodString>>;
                    resolver: z.ZodDefault<z.ZodEnum<{
                        none: "none";
                        railway: "railway";
                    }>>;
                    unresolved: z.ZodDefault<z.ZodEnum<{
                        match: "match";
                        no_match: "no_match";
                    }>>;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                connection: z.ZodObject<{
                    fingerprints: z.ZodString;
                }, z.core.$strict>;
            }, z.core.$strict>, z.ZodObject<{
                path: z.ZodObject<{
                    globs: z.ZodArray<z.ZodString>;
                }, z.core.$strict>;
            }, z.core.$strict>]>;
            unless: z.ZodOptional<z.ZodObject<{
                pattern: z.ZodString;
            }, z.core.$strict>>;
        }, z.core.$strict>>>;
        fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            command: z.ZodString;
            key: z.ZodString;
        }, z.core.$strict>>>;
        protected_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        secret_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        credential_stores: z.ZodDefault<z.ZodArray<z.ZodString>>;
        network: z.ZodPrefault<z.ZodObject<{
            allow: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        push: z.ZodPrefault<z.ZodObject<{
            max_file_mb: z.ZodDefault<z.ZodNumber>;
            max_changed_lines: z.ZodDefault<z.ZodNumber>;
            refuse_paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        pre_approved: z.ZodDefault<z.ZodArray<z.ZodString>>;
        examples: z.ZodPrefault<z.ZodObject<{
            must_block: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Write: "Write";
                    Edit: "Edit";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            must_ask: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Write: "Write";
                    Edit: "Edit";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            must_allow: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                bash: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
                cwd: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>, z.ZodObject<{
                tool: z.ZodEnum<{
                    Write: "Write";
                    Edit: "Edit";
                    MultiEdit: "MultiEdit";
                    NotebookEdit: "NotebookEdit";
                    Read: "Read";
                    Grep: "Grep";
                }>;
                path: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodObject<{
                fetch: z.ZodString;
                agent: z.ZodDefault<z.ZodBoolean>;
            }, z.core.$strict>]>>>;
            fingerprints: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
            linked_environments: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'tests.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        runner: z.ZodObject<{
            kind: z.ZodLiteral<"command">;
            changed: z.ZodString;
            full: z.ZodString;
            one: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>;
        vacuity: z.ZodOptional<z.ZodObject<{
            test_globs: z.ZodArray<z.ZodString>;
            assertion_pattern: z.ZodString;
            app_paths: z.ZodArray<z.ZodString>;
            dynamic: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        stop_gate: z.ZodPrefault<z.ZodObject<{
            timeout_s: z.ZodDefault<z.ZodNumber>;
            lock_wait_s: z.ZodDefault<z.ZodNumber>;
            busy_patterns: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        worktree: z.ZodPrefault<z.ZodObject<{
            root: z.ZodDefault<z.ZodString>;
            setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
            est_size_gb: z.ZodDefault<z.ZodNumber>;
            dep_cache: z.ZodDefault<z.ZodBoolean>;
            pool: z.ZodDefault<z.ZodNumber>;
            setup_key: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        checkout: z.ZodPrefault<z.ZodObject<{
            sparse_exclude: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
        }, z.core.$strict>>;
        land: z.ZodPrefault<z.ZodObject<{
            pre: z.ZodDefault<z.ZodArray<z.ZodString>>;
            batch_max: z.ZodDefault<z.ZodNumber>;
            defer_timeout_minutes: z.ZodDefault<z.ZodNumber>;
            parallel_merges: z.ZodDefault<z.ZodNumber>;
            pr_batch: z.ZodPrefault<z.ZodObject<{
                enabled: z.ZodDefault<z.ZodBoolean>;
                max: z.ZodDefault<z.ZodNumber>;
                shards: z.ZodDefault<z.ZodNumber>;
                fast_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
                full_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        gates: z.ZodPrefault<z.ZodObject<{
            land: z.ZodDefault<z.ZodArray<z.ZodString>>;
            money_path: z.ZodDefault<z.ZodArray<z.ZodString>>;
            nightly: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        failures: z.ZodOptional<z.ZodObject<{
            section: z.ZodString;
            item: z.ZodString;
        }, z.core.$strict>>;
        nightly_at: z.ZodOptional<z.ZodString>;
        idle_probe: z.ZodOptional<z.ZodString>;
        post_edit: z.ZodOptional<z.ZodString>;
        env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        cores: z.ZodPrefault<z.ZodObject<{
            reserve: z.ZodDefault<z.ZodNumber>;
            min: z.ZodDefault<z.ZodNumber>;
            max: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        command_timeout_s: z.ZodDefault<z.ZodNumber>;
        tiers: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodString;
            max_disk_used_pct: z.ZodOptional<z.ZodNumber>;
            exclusive: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>>;
        test_run: z.ZodOptional<z.ZodObject<{
            select: z.ZodOptional<z.ZodEnum<{
                imports: "imports";
                repo: "repo";
                off: "off";
            }>>;
            setup: z.ZodDefault<z.ZodArray<z.ZodString>>;
            fetch: z.ZodDefault<z.ZodArray<z.ZodObject<{
                npm: z.ZodString;
            }, z.core.$strict>>>;
            setup_network: z.ZodDefault<z.ZodBoolean>;
            tiers: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                command: z.ZodString;
                kind: z.ZodEnum<{
                    fast: "fast";
                    full: "full";
                }>;
                database: z.ZodDefault<z.ZodBoolean>;
                shardable: z.ZodDefault<z.ZodBoolean>;
                full_checkout: z.ZodDefault<z.ZodBoolean>;
                gpu: z.ZodDefault<z.ZodBoolean>;
                network: z.ZodDefault<z.ZodBoolean>;
                timeout_s: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            database: z.ZodOptional<z.ZodObject<{
                image: z.ZodString;
                name: z.ZodDefault<z.ZodString>;
                ready_timeout_s: z.ZodDefault<z.ZodNumber>;
                max_connections: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
            caches: z.ZodDefault<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                env: z.ZodString;
                key: z.ZodArray<z.ZodString>;
            }, z.core.$strict>>>;
            shared: z.ZodDefault<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                env: z.ZodString;
            }, z.core.$strict>>>;
            checks: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
            env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strict>>;
        deploy_gate: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            branch: z.ZodDefault<z.ZodString>;
            tiers: z.ZodArray<z.ZodString>;
            notify: z.ZodDefault<z.ZodEnum<{
                off: "off";
                ops: "ops";
            }>>;
            post_deploy: z.ZodOptional<z.ZodObject<{
                host: z.ZodLiteral<"railway">;
                project: z.ZodString;
                environment: z.ZodString;
                services: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    id: z.ZodString;
                }, z.core.$strict>>;
                origin: z.ZodString;
                checks: z.ZodArray<z.ZodObject<{
                    name: z.ZodString;
                    kind: z.ZodEnum<{
                        api: "api";
                        sign_in: "sign_in";
                        health: "health";
                    }>;
                    url: z.ZodString;
                    method: z.ZodDefault<z.ZodLiteral<"GET">>;
                    expect_status: z.ZodNumber;
                    expect_text: z.ZodOptional<z.ZodString>;
                }, z.core.$strict>>;
                wait_for_deploy_s: z.ZodDefault<z.ZodNumber>;
                timeout_s: z.ZodDefault<z.ZodNumber>;
                github_environment: z.ZodDefault<z.ZodString>;
            }, z.core.$strict>>;
        }, z.core.$strict>>;
        preview: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            host: z.ZodDefault<z.ZodLiteral<"railway">>;
            project: z.ZodOptional<z.ZodString>;
            template_environment: z.ZodOptional<z.ZodString>;
            services: z.ZodOptional<z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                id: z.ZodString;
            }, z.core.$strict>>>;
            url_service: z.ZodOptional<z.ZodString>;
            flows: z.ZodOptional<z.ZodArray<z.ZodString>>;
            max_concurrent: z.ZodDefault<z.ZodNumber>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
            ttl_hours: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'review.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        money_path_source: z.ZodOptional<z.ZodObject<{
            file: z.ZodString;
            pattern: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        categories: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
        levels: z.ZodObject<{
            L0_auto: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                max_lines: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            L1_evaluator: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                max_lines: z.ZodOptional<z.ZodNumber>;
                max_files: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
            L2_notify: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
            }, z.core.$strict>;
            L3_human: z.ZodObject<{
                when: z.ZodArray<z.ZodString>;
                over_lines: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>;
        }, z.core.$strict>;
        merge: z.ZodPrefault<z.ZodObject<{
            auto: z.ZodDefault<z.ZodBoolean>;
            max_lines: z.ZodDefault<z.ZodNumber>;
            max_files: z.ZodDefault<z.ZodNumber>;
            wait_categories: z.ZodDefault<z.ZodArray<z.ZodString>>;
            loosened: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
        max_pr_lines: z.ZodDefault<z.ZodNumber>;
        generated: z.ZodDefault<z.ZodArray<z.ZodString>>;
        docs_only_checks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        delegation: z.ZodPrefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            min_clean: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'deploy.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        prod_read: z.ZodOptional<z.ZodObject<{
            via: z.ZodLiteral<"railway-ssh">;
            service: z.ZodString;
            environment: z.ZodString;
            url_var: z.ZodString;
            max_rows: z.ZodDefault<z.ZodNumber>;
            timeout_s: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        environments: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            trigger: z.ZodOptional<z.ZodString>;
            verify: z.ZodString;
            production: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    readonly 'app.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        start: z.ZodObject<{
            command: z.ZodString;
            port: z.ZodNumber;
            ready: z.ZodPrefault<z.ZodObject<{
                path: z.ZodDefault<z.ZodString>;
                timeout_s: z.ZodDefault<z.ZodNumber>;
            }, z.core.$strict>>;
        }, z.core.$strict>;
        ui_paths: z.ZodArray<z.ZodString>;
        thresholds: z.ZodPrefault<z.ZodObject<{
            max_long_task_ms: z.ZodDefault<z.ZodNumber>;
            max_dropped_frame_pct: z.ZodDefault<z.ZodNumber>;
            slow_request_ms: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        flows: z.ZodRecord<z.ZodString, z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            goto: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            click: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            type: z.ZodObject<{
                target: z.ZodString;
                text: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            key: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            wait: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
        }, z.core.$strict>, z.ZodObject<{
            expect_text: z.ZodObject<{
                target: z.ZodString;
                text: z.ZodString;
            }, z.core.$strict>;
        }, z.core.$strict>]>>>;
    }, z.core.$strict>;
    readonly 'benchmarks.yaml': z.ZodObject<{
        version: z.ZodLiteral<1>;
        benchmarks: z.ZodDefault<z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            command: z.ZodString;
            repeats: z.ZodDefault<z.ZodNumber>;
            metric: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"wall_ms">, z.ZodObject<{
                pattern: z.ZodString;
                unit: z.ZodDefault<z.ZodString>;
            }, z.core.$strict>]>>;
            lower_is_better: z.ZodDefault<z.ZodBoolean>;
            profile: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
};
