import { type GitRun } from './checkout-sync.js';
export type Gh = (args: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
/** The page's record of one config PR it proposed (or the setup PR init proposed), and how it ended. */
export interface ConfigPrRecord {
    number: number;
    url: string;
    /** The setup PR (setup mode's, from init's auto-config), or a later change from the Repo config form. */
    kind: 'setup' | 'config';
    /** The default branch it merges into: the branch the checkout is fast-forwarded on. */
    base: string;
    /** INVARIANT (#468, the owner): the commit this page pushed for it when it opened it; only that PR, at that head, merges here. */
    head: string | null;
    state: 'open' | 'merged' | 'closed' | 'unknown';
    mergedBy: string | null;
    mergedAt: string | null;
    /** Merged and this checkout fast-forwarded to it (or already there). */
    synced: boolean;
    /** The checkout's commit once synced. */
    sha: string | null;
    /** Merged, not synced: why, and what can be done (Fast-forward now once the cause is gone, or the command). */
    why: string | null;
    retry: boolean;
    command: string | null;
    checkedAt: string | null;
}
export declare const CONFIG_PRS_FILE = "config-prs.json";
/** Whether a PR's head is one of the page's own branches (the setup branch, or a Repo config change's). */
export declare const ownBranch: (head: string | undefined) => boolean;
interface PrView {
    state?: string;
    headRefName?: string;
    headRefOid?: string;
    baseRefName?: string;
    url?: string;
    title?: string;
    mergedAt?: string | null;
    mergedBy?: {
        login?: string;
    } | null;
}
export declare function readPr(gh: Gh, repo: string, n: number): PrView;
/** The one line a merged PR's step shows: who, when, and where the checkout is now. */
export declare const mergedLine: (r: Pick<ConfigPrRecord, "number" | "mergedBy" | "mergedAt" | "sha" | "synced" | "why">) => string;
/** Bring the checkout to a merged PR (a fast-forward only), recording what happened. */
export declare function syncMerged(r: ConfigPrRecord, git: GitRun): ConfigPrRecord;
/**
 * Look at a PR again: open, closed without merging, or merged (wherever: this page, GitHub, the CLI), and then the
 * checkout fast-forwarded to it. A record already merged and synced is final: nothing is asked again.
 */
export declare function refreshConfigPr(r: ConfigPrRecord, o: {
    repo: string;
    gh: Gh;
    git: GitRun;
    now?: () => Date;
}): ConfigPrRecord;
/** The config PRs this page knows, oldest first. */
export declare function readConfigPrs(stateDir: string): ConfigPrRecord[];
export declare function writeConfigPrs(stateDir: string, prs: ConfigPrRecord[]): void;
/** A PR the page proposed (or found init's setup PR): kept once, by number. */
export declare function trackConfigPr(stateDir: string, p: {
    number: number;
    url: string;
    kind: ConfigPrRecord['kind'];
    base: string;
    head: string | null;
}): ConfigPrRecord;
/** Replace one record (by number) with its newer self. */
export declare function saveConfigPr(stateDir: string, r: ConfigPrRecord): void;
/** The repo's first allowed merge method gh can use, of merge, squash, rebase. */
export declare function mergeMethodOf(gh: Gh, repo: string): 'merge' | 'squash' | 'rebase';
/** The merge commit's subject: what it merges, and who approved it here. A login only: never an email, never in the body. */
export declare const approvalSubject: (n: number, title: string, approver: string) => string;
export interface MergePlan {
    number: number;
    url: string;
    /** Already merged (elsewhere): nothing to run; the checkout is brought to it. */
    merged: boolean;
    command: string[];
}
/**
 * The merge of a config PR, as the page does it: only one of the page's own branches into the default branch. An
 * open PR gets the gh command (the repo's first allowed method, the subject naming the approver); a merged one needs
 * none. Refused otherwise; nothing is merged here.
 */
export declare function planConfigPrMerge(o: {
    repo: string;
    base: string;
    number: unknown;
    approver: string;
    gh: Gh;
    records: readonly ConfigPrRecord[];
}): MergePlan;
/** Whether this gh login is an admin of the repo (GitHub's own answer). */
export declare function isRepoAdmin(gh: Gh, repo: string): boolean;
export {};
