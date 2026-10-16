import { z } from 'zod';
import type { Config } from './config/load.js';
import { InstanceSettings, PolicyFile } from './instance.js';
import { type IntakeCaps } from './intake/report.js';
import { type ResearchCaps } from './research.js';
import type { StuckMode } from './stuck.js';
/** The machine's bounds on instance settings: root-owned, outside every instance's home. */
export declare const LIMITS_PATH: string;
export declare const Limits: z.ZodObject<{
    workers: z.ZodDefault<z.ZodObject<{
        min: z.ZodNumber;
        max: z.ZodNumber;
    }, z.core.$strict>>;
    daily_budget_usd: z.ZodDefault<z.ZodObject<{
        max: z.ZodNumber;
    }, z.core.$strict>>;
    max_fixes_per_pr: z.ZodDefault<z.ZodObject<{
        max: z.ZodNumber;
    }, z.core.$strict>>;
    research: z.ZodPrefault<z.ZodObject<{
        max_searches_per_day: z.ZodDefault<z.ZodNumber>;
        max_fetches_per_day: z.ZodDefault<z.ZodNumber>;
        max_usd_per_day: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
    intake: z.ZodPrefault<z.ZodObject<{
        reports_per_sender_per_day: z.ZodDefault<z.ZodNumber>;
        drafts_per_day: z.ZodDefault<z.ZodNumber>;
        max_usd_per_day: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Limits = z.infer<typeof Limits>;
export declare class SettingsError extends Error {
}
/** The machine's limits: the engine's defaults when there's no limits file; an unreadable or invalid one is an error. */
export declare function loadLimits(path?: string): Limits;
/** Every way these settings break the machine's limits or the policy's own ceilings. */
export declare function settingsProblems(s: InstanceSettings, limits: Limits, policy?: Pick<PolicyFile, 'budget' | 'agents'>): string[];
/** The repo's config with the instance's settings applied over it (the repo's values are the defaults). */
export declare function applySettings(cfg: Config, s: InstanceSettings): Config;
/** Is `now` (local time) inside one of the run windows? No windows: always. A window may cross midnight. */
export declare function inRunWindow(windows: {
    from: string;
    to: string;
}[], now?: Date): boolean;
/**
 * A reader of an instance's settings for the coordinator's every tick: it parses policy.yaml again only when the
 * text of it (or of the limits file) changed. Compared by content, not mtime and size: an edit of the same length
 * within one timestamp tick (workers 2 -> 3) would otherwise go unseen. Both files are a few hundred bytes. An unreadable or invalid file, or settings out of bounds: the error, and no
 * settings (the repo's values apply) until it's fixed.
 */
export declare function settingsReader(policyPath: string, limitsPath?: string): () => {
    settings: InstanceSettings;
    error: string | null;
};
export declare const SETTING_KEYS: readonly ["workers", "daily_budget_usd", "ci_repair.enabled", "ci_repair.max_fixes_per_pr", "run_windows", "research.max_searches_per_day", "research.max_fetches_per_day", "research.max_usd_per_day", "research.repo_access", "intake.reports_per_sender_per_day", "intake.drafts_per_day", "intake.max_usd_per_day", "stuck_guard", "chat_attachments.max_file_mb", "chat_attachments.max_message_mb", "chat_attachments.retention_days"];
export type SettingKey = (typeof SETTING_KEYS)[number];
/** A setting's value in effect: the instance's if set, else the repo's. */
export declare function currentValue(cfg: Config, s: InstanceSettings, key: SettingKey): unknown;
/** The stuck-run guard's mode: the instance's, else dry-run (logs what it would stop, stops nothing). */
export declare function stuckMode(s: InstanceSettings): StuckMode;
/** Intake's daily caps in force: the instance's settings, else the intake config's values, else the engine's defaults. */
export declare function intakeCaps(s: InstanceSettings, defaults?: IntakeCaps): IntakeCaps;
/** Whether research runs may read the repo: only when the owner turned it on. */
export declare function researchRepoAccess(s: InstanceSettings): boolean;
/** The research caps in force: the instance's, else the engine's conservative defaults (there's no repo value). */
export declare function researchCaps(s: InstanceSettings): ResearchCaps;
/**
 * Change one instance setting, for the instance's own dashboard. Only the owner may: `owner` says whether the
 * dashboard read `by` as one of the instance's owners (admin on its repo); without it, owners.default only.
 * The new value is checked against the schema, the machine's limits and the policy's ceilings; refused,
 * nothing changes. Written atomically (a temp file beside policy.yaml, same owner, mode 0600, then a
 * rename), and recorded as settings.changed in the instance's event log.
 */
export declare function changeSetting(o: {
    policyPath: string;
    cfg: Config;
    eventsDb: string;
    key: string;
    value: unknown;
    by: string;
    owner?: boolean;
    actor?: string;
    limitsPath?: string;
    now?: () => Date;
}): {
    from: unknown;
    to: unknown;
};
