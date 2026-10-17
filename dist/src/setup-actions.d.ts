import type { Config } from './config/load.js';
import { type RefreshResult } from './guardrails/context.js';
import { type Mode, type RunResult } from './setup-steps.js';
import { type Download, type InstallableTool, type ToolInstall } from './tool-install.js';
export declare const ACTION_IDS: readonly ["install-tools", "local-hooks", "git-hooks", "fingerprints", "protection", "default-branch"];
export type ActionId = (typeof ACTION_IDS)[number];
export declare const isActionId: (s: unknown) => s is ActionId;
export interface ActionPlan {
    id: ActionId;
    step: string;
    label: string;
    available: boolean;
    why?: string;
    changes: string[];
    commands: string[];
}
export interface ActionResult {
    ok: boolean;
    detail: string;
}
export interface ActionContext {
    mode: Mode;
    root: string;
    cfg: Config;
}
export interface ActionDeps {
    which: (cmd: string) => string | null;
    prefix: string;
    plan: (tool: InstallableTool, prefix: string) => ToolInstall | null;
    download: Download;
    refresh: (root: string, cfg: Config['guardrails']) => RefreshResult[];
    gh: (args: string[], input?: string) => RunResult;
}
export declare function systemActionDeps(): ActionDeps;
interface ActionDef {
    step: string;
    label: string;
    plan: (c: ActionContext, d: ActionDeps) => Omit<ActionPlan, 'id' | 'step' | 'label'>;
    run: (c: ActionContext, d: ActionDeps) => Promise<ActionResult>;
}
export declare const ACTIONS: Record<ActionId, ActionDef>;
/** WHY: classic protection, not a ruleset: the main watch and direct landing read the branch protection API. */
export declare function protectionBody(cfg: Config): {
    required_status_checks: {
        strict: boolean;
        contexts: string[];
    };
    enforce_admins: boolean;
    required_pull_request_reviews: null;
    restrictions: null;
};
export declare function actionPlan(id: ActionId, c: ActionContext, d: ActionDeps): ActionPlan;
export {};
