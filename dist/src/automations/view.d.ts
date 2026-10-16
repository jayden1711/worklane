import type { Role } from '../dashboard-auth.js';
import type { StoredEvent } from '../events/types.js';
import { type AutomationLimits } from './schema.js';
import { type Loaded } from './store.js';
export declare function automationsView(o: {
    loaded: Loaded;
    limits: AutomationLimits;
    events: StoredEvent[];
    role: Role;
    now: Date;
    hooks?: {
        stateDir: string;
        home: string;
        instance: string;
    };
}): {
    limits: AutomationLimits;
    timezone: string;
    today: {
        runs: number;
        spentUsd: number;
    };
    error: string | null;
    digest: string;
    /** What this person may do: the page shows these buttons and no other. */
    actions: ("run" | "pause" | "resume" | "delete" | "create" | "edit" | "rotate" | "unbind")[];
    automations: {
        when: string;
        summary: string[];
        next: string | null;
        today: {
            runs: number;
            spentUsd: number;
        };
        runs: {
            run: string;
            at: string;
            trigger: {
                kind: "manual" | "schedule" | "github" | "discord" | "webhook";
                ref: string | null;
                by: string | null;
            };
            depth: number;
            outcome: string;
            costUsd: number | null;
            outputs: {
                kind: "issue" | "comment";
                number: number;
            }[];
        }[];
        refused: {
            at: string;
            trigger: "manual" | "schedule" | "github" | "discord" | "webhook";
            why: string;
        }[];
        /** A webhook's address (on this machine's tailnet name, port 8444), its bound device, and whether it has a secret. */
        webhook: {
            path: string;
            bound: {
                name: string;
                at: string;
            } | null;
            hasSecret: boolean;
        } | null;
        /** Fires waiting for its owner's approval now. */
        waiting: string[];
        pausedBy: {
            by: string;
            role: "owner" | "writer" | "system";
            why: string | null;
            at: string;
        } | null;
        id: string;
        name: string;
        owner: string;
        enabled: boolean;
        trigger: {
            kind: "github";
            on: "issue.opened" | "issue.labeled" | "issue_comment.created" | "pull_request.opened" | "pull_request.merged";
            label?: string | undefined;
            command?: string | undefined;
        } | {
            kind: "schedule";
            cron: string;
        } | {
            kind: "discord";
            command: string;
        } | {
            kind: "webhook";
        };
        mode: "report" | "task";
        template: {
            title: string;
            outcome: string;
            done_when: ({
                test: string;
            } | {
                command: string;
                expect?: string | undefined;
            })[];
            trigger_text: "none" | "quoted";
        };
        budget: {
            per_run_usd: number;
            per_day_usd: number;
        };
        limits: {
            runs_per_day: number;
            cooldown_minutes: number;
        };
        gates: {
            start: "auto" | "approve";
        };
        chain: {
            accept_from: string[];
        };
    }[];
};
