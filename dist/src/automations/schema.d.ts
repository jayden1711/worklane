import { z } from 'zod';
export declare const AUTOMATIONS_FILE = "automations.yaml";
/** An automation's id: its key in the audit, the log and (for a webhook) its address. Never changes. */
export declare const AUTOMATION_ID: RegExp;
/**
 * INVARIANT: how deep a chain of automations may go (one automation's output starting another, and so on). A code
 * constant: no file, policy or payload changes it. Depth 0 is a person, a schedule or a chat command.
 */
export declare const MAX_CHAIN_DEPTH = 2;
/** At most this many automations per instance. */
export declare const MAX_AUTOMATIONS = 50;
/** How long a run waiting for its owner's approval waits: unanswered after this, it never runs. */
export declare const APPROVAL_EXPIRY_MS: number;
/** A trigger's text is cut to this many characters (after redaction) before any run sees it. */
export declare const TRIGGER_TEXT_MAX = 4000;
/** A scheduled time missed (the machine off, a hold) still fires within this long after it; never later. */
export declare const CATCH_UP_MINUTES = 120;
/** The GitHub events an automation can start on. */
export declare const GITHUB_EVENTS: readonly ["issue.opened", "issue.labeled", "issue_comment.created", "pull_request.opened", "pull_request.merged"];
export type GitHubEventName = (typeof GITHUB_EVENTS)[number];
export declare const Trigger: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"schedule">;
    cron: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"github">;
    on: z.ZodEnum<{
        "issue.opened": "issue.opened";
        "issue.labeled": "issue.labeled";
        "issue_comment.created": "issue_comment.created";
        "pull_request.opened": "pull_request.opened";
        "pull_request.merged": "pull_request.merged";
    }>;
    label: z.ZodOptional<z.ZodString>;
    command: z.ZodOptional<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"discord">;
    command: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"webhook">;
}, z.core.$strict>], "kind">;
export type Trigger = z.infer<typeof Trigger>;
export declare const Automation: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    owner: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
    enabled: z.ZodDefault<z.ZodBoolean>;
    trigger: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"schedule">;
        cron: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"github">;
        on: z.ZodEnum<{
            "issue.opened": "issue.opened";
            "issue.labeled": "issue.labeled";
            "issue_comment.created": "issue_comment.created";
            "pull_request.opened": "pull_request.opened";
            "pull_request.merged": "pull_request.merged";
        }>;
        label: z.ZodOptional<z.ZodString>;
        command: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"discord">;
        command: z.ZodString;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"webhook">;
    }, z.core.$strict>], "kind">;
    mode: z.ZodEnum<{
        report: "report";
        task: "task";
    }>;
    template: z.ZodObject<{
        title: z.ZodString;
        outcome: z.ZodString;
        done_when: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
            test: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            command: z.ZodString;
            expect: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>]>>>;
        trigger_text: z.ZodDefault<z.ZodEnum<{
            none: "none";
            quoted: "quoted";
        }>>;
    }, z.core.$strict>;
    budget: z.ZodObject<{
        per_run_usd: z.ZodNumber;
        per_day_usd: z.ZodNumber;
    }, z.core.$strict>;
    limits: z.ZodPrefault<z.ZodObject<{
        runs_per_day: z.ZodDefault<z.ZodNumber>;
        cooldown_minutes: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    gates: z.ZodPrefault<z.ZodObject<{
        start: z.ZodDefault<z.ZodEnum<{
            auto: "auto";
            approve: "approve";
        }>>;
    }, z.core.$strict>>;
    chain: z.ZodPrefault<z.ZodObject<{
        accept_from: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Automation = z.infer<typeof Automation>;
export declare const AutomationsFile: z.ZodObject<{
    version: z.ZodLiteral<1>;
    automations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        owner: z.ZodString & z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>;
        enabled: z.ZodDefault<z.ZodBoolean>;
        trigger: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"schedule">;
            cron: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"github">;
            on: z.ZodEnum<{
                "issue.opened": "issue.opened";
                "issue.labeled": "issue.labeled";
                "issue_comment.created": "issue_comment.created";
                "pull_request.opened": "pull_request.opened";
                "pull_request.merged": "pull_request.merged";
            }>;
            label: z.ZodOptional<z.ZodString>;
            command: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"discord">;
            command: z.ZodString;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"webhook">;
        }, z.core.$strict>], "kind">;
        mode: z.ZodEnum<{
            report: "report";
            task: "task";
        }>;
        template: z.ZodObject<{
            title: z.ZodString;
            outcome: z.ZodString;
            done_when: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
                test: z.ZodString;
            }, z.core.$strict>, z.ZodObject<{
                command: z.ZodString;
                expect: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>]>>>;
            trigger_text: z.ZodDefault<z.ZodEnum<{
                none: "none";
                quoted: "quoted";
            }>>;
        }, z.core.$strict>;
        budget: z.ZodObject<{
            per_run_usd: z.ZodNumber;
            per_day_usd: z.ZodNumber;
        }, z.core.$strict>;
        limits: z.ZodPrefault<z.ZodObject<{
            runs_per_day: z.ZodDefault<z.ZodNumber>;
            cooldown_minutes: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
        gates: z.ZodPrefault<z.ZodObject<{
            start: z.ZodDefault<z.ZodEnum<{
                auto: "auto";
                approve: "approve";
            }>>;
        }, z.core.$strict>>;
        chain: z.ZodPrefault<z.ZodObject<{
            accept_from: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export type AutomationsFile = z.infer<typeof AutomationsFile>;
/** An id on a cycle of accept_from (A accepts B, B accepts A, ...), or null. */
export declare function chainCycle(list: Pick<Automation, 'id' | 'chain'>[]): string | null;
/**
 * The instance policy's automations part (policy.yaml, the owners' only). Off until an owner turns it on. The caps
 * hold over every automation together: at most `max_runs_per_day` fires a local day, `max_concurrent` at once, and
 * `budget_share` of the daily budget spent by them a local day.
 */
export declare const AutomationsPolicy: z.ZodPrefault<z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_runs_per_day: z.ZodDefault<z.ZodNumber>;
    max_concurrent: z.ZodDefault<z.ZodNumber>;
    budget_share: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>>;
export type AutomationsPolicy = z.infer<typeof AutomationsPolicy>;
/** The repo's say (config.yaml automations): it can only tighten the policy; every field is a ceiling or an off. */
export declare const AutomationsRepo: z.ZodPrefault<z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    max_runs_per_day: z.ZodOptional<z.ZodNumber>;
    daily_usd: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>>;
export type AutomationsRepo = z.infer<typeof AutomationsRepo>;
/** What is in force: the policy, narrowed by the repo. The repo can turn it off or lower a cap, never more. */
export interface AutomationLimits {
    enabled: boolean;
    /** Why it is off, when it is. */
    off: string | null;
    maxRunsPerDay: number;
    maxConcurrent: number;
    dailyUsd: number;
}
export declare function limitsInForce(policy: AutomationsPolicy, repo: AutomationsRepo, dailyBudgetUsd: number): AutomationLimits;
