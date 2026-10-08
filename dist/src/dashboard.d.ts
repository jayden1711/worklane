import { type Server } from 'node:http';
import type { Config } from './config/load.js';
/**
 * What the Settings page shows: the config's shape and choices, read-only.
 * Commands, connection fingerprints and deploy details stay out; editing
 * happens in the project's config folder, through review like any change.
 */
export declare function settingsView(cfg: Config): {
    configDir: ".worklane";
    project: {
        name: string;
        repo: string;
        landMode: "direct" | "pr";
        runtime: {
            kind: "cli" | "sdk";
            max_concurrency: number;
            run_windows: {
                from: string;
                to: string;
            }[];
        };
    };
    owners: {
        default: string;
        writers: string[];
        areas: {
            name: string;
            owner: string;
            paths: string[];
            labels: string[];
        }[];
    };
    reports: {
        times: string[];
        to: string[];
    };
    governor: {
        min_free_disk_pct: number;
        max_load?: number | undefined;
    };
    agents: {
        stage: number;
        budget: number;
        trust: {
            window_days: number;
            promote_after_days: number;
            min_tasks: number;
            min_evaluator_pass_rate: number;
            max_unverified_claim_rate: number;
            max_reverts: number;
            max_baseline_growth: number;
        };
        roles: {
            name: string;
            enabled: boolean;
            model: string;
            count: number | null;
        }[];
    };
    tests: {
        gates: {
            land: string[];
            money_path: string[];
            nightly: string[];
        };
        batchMax: number;
        nightlyAt: string | null;
        tiers: string[];
        baselineParser: boolean;
    };
    review: {
        levels: {
            [k: string]: string[];
        };
        stages: {
            stage: number;
            relax: {
                category: string;
                to: "L0" | "L1" | "L2" | "L3";
            }[];
        }[];
    } | null;
    guardrails: {
        rules: number;
        protectedPaths: string[];
        secretPaths: number;
        network: string;
        preApproved: string[];
    };
    deploy: {
        environments: {
            name: string;
            production: boolean;
        }[];
        prodRead: boolean;
    } | null;
};
export interface DashboardOptions {
    root: string;
    cfg: Config;
    eventsDb: string;
    stateDir: string;
    user: string;
    port?: number;
    webDir?: string;
    pollMs?: number;
}
export declare function dashboardToken(stateDir: string): string;
export declare function startDashboard(opts: DashboardOptions): Promise<{
    server: Server;
    url: string;
    token: string;
    close: () => Promise<void>;
}>;
