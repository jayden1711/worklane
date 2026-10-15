import type { Role } from './dashboard-auth.js';
/** At most one GitHub API call per this long. */
export declare const MAIN_WATCH_CALL_MS = 60000;
/**
 * How long an empty commit-to-PR link is asked again before it counts as "no PR": GitHub links a merge commit to its
 * PR a few seconds after the merge (main 09f60340 was judged 6 s after #307 landed, with the link still empty).
 */
export declare const LINK_LAG_MS = 120000;
/** How often whether GitHub protects the branch is asked again. */
export declare const PROTECTION_RECHECK_MS: number;
/** github: GitHub enforces the branch's protection; main_watch: it doesn't, and this watch guards it; off: neither. */
export type ProtectionMode = 'github' | 'main_watch' | 'off';
export interface CheckRunAt {
    name: string;
    status: string;
    conclusion: string | null;
    startedAt: string | null;
    completedAt: string | null;
}
export interface StatusAt {
    context: string;
    state: string;
    createdAt: string;
}
export interface MergedPull {
    number: number;
    url: string;
    mergedAt: string | null;
    mergeCommit: string | null;
    mergedBy: string | null;
    mergedByBot: boolean;
    head: string;
    base: string;
    /** How many commits the PR has (GET /pulls/{n} only; the commit-to-PR list leaves it out). */
    commits?: number;
}
/** GitHub's compare of two commits (GET /compare/{base}...{head}): how far `head` is ahead of and behind `base`. */
export interface Compared {
    status: string;
    aheadBy: number;
    behindBy: number;
}
/** The calls the watch makes: one REST request each (github/main-watch-api.ts). */
export interface MainWatchApi {
    protection(branch: string): Promise<'enforced' | 'none'>;
    commitPulls(sha: string): Promise<MergedPull[]>;
    pull(n: number): Promise<MergedPull>;
    checkRuns(sha: string): Promise<CheckRunAt[]>;
    statuses(sha: string): Promise<StatusAt[]>;
    role(login: string): Promise<Role | null>;
    compare(base: string, head: string): Promise<Compared>;
    /**
     * Who pushed `sha` to `branch`: the GitHub login of the push that made it the branch's tip (the repo's activity),
     * else the commit's own GitHub author (`from: 'commit'`); null when neither is known. A login only, never an email.
     */
    pusher?(branch: string, sha: string): Promise<{
        login: string;
        from: 'activity' | 'commit';
    } | null>;
}
/** What is known about the commit being checked; each field is one API call's answer (harness: the log's). */
export interface Facts {
    harness: {
        number: number;
        head: string;
        at: string;
    } | null;
    pulls?: MergedPull[];
    /** When the pulls call was first and last answered (ms): an empty link is asked again until an answer LINK_LAG_MS after the first. */
    pullsAt?: number;
    pullsLastAt?: number;
    /** A merge commit's own subject names this PR ("Merge #N: …", "Merge pull request #N …"): asked directly when the pulls link is empty. */
    subjectPr?: number | null;
    pr?: MergedPull;
    /** compare(base, head): whether `base` (the commit) is inside the rebase merge ending at `head` (the PR's merge commit). */
    compare?: Compared & {
        base: string;
        head: string;
    };
    role?: Role | null;
    runs?: CheckRunAt[];
    statuses?: StatusAt[];
}
export type Need = {
    call: 'pulls';
} | {
    call: 'pull';
    number: number;
} | {
    call: 'compare';
    base: string;
    head: string;
} | {
    call: 'role';
    login: string;
} | {
    call: 'runs';
    sha: string;
} | {
    call: 'statuses';
    sha: string;
};
export type Verdict = {
    done: true;
    accounted: true;
    how: 'harness' | 'person';
    number: number;
} | {
    done: true;
    accounted: true;
    how: 'accepted';
    number: number | null;
    acceptance: Acceptance;
} | {
    done: true;
    accounted: false;
    reason: string;
    number: number | null;
    direct?: true;
} | {
    done: false;
    need: Need;
};
/**
 * A commit an admin accepted as a bootstrap merge before the watch judged it: by `sha` (a commit already on the
 * branch), or by `pr` with `head` its head when accepted (the merge of that PR at that head counts, however it was
 * merged: merge commit, squash or rebase). `base` is the last commit checked when it was accepted: what it accepts
 * must descend from it, so a rewrite of the branch voids it.
 */
export interface Acceptance {
    id: string;
    sha: string | null;
    pr: number | null;
    head: string | null;
    base: string;
    by: string;
    reason: string;
    at: string;
}
export type Outcome = 'pass' | 'fail' | 'pending' | 'missing' | 'unknown';
/**
 * Each required check's outcome on a commit at time `at` (a merge): the check run that had started by then, latest
 * first, passed only if it had completed with success by then; else the commit status set by then. `unknown`: no
 * check run of that name, and the statuses aren't read yet.
 */
export declare function outcomesAt(required: string[], runs: CheckRunAt[], statuses: StatusAt[] | null, at: string): {
    name: string;
    outcome: Outcome;
}[];
/**
 * Is commit `sha` accounted for, given what is known? Or which one call would tell. Pure: the watch and the tests
 * share it. An empty commit-to-PR link is asked again until an answer LINK_LAG_MS after its first one (pullsAt).
 */
export declare function judge(sha: string, f: Facts, o: {
    branch: string;
    required: string[];
    accepted?: Acceptance[];
}): Verdict;
/** What the watch keeps between ticks and restarts. */
export interface WatchState {
    version: 1;
    mode: ProtectionMode | null;
    detail: string;
    /** When protection was last asked (ms). */
    protectionAt: number;
    /** The last commit checked: everything up to it (first parents) is done. Null: not started (the next tip is the baseline). */
    last: string | null;
    lastAt: string | null;
    /** When the last API call was made (ms): the next waits MAIN_WATCH_CALL_MS. */
    lastCallAt: number;
    /** The commit being checked, and what is known about it so far. */
    pending: {
        sha: string;
        facts: Facts;
    } | null;
}
export declare function readWatchState(file: string): WatchState;
/** Where the admins' acceptances are kept, next to the watch's state file: the dashboard writes it, the watch reads it. */
export declare function acceptedFileFor(stateFile: string): string;
export declare function readAccepted(file: string): Acceptance[];
/** The default branch's commits, read with git (no API call). */
export interface WatchGit {
    /** Fetch the default branch and return its tip, or null. */
    tip(): string | null;
    isAncestor(a: string, b: string): boolean;
    /** The first-parent commits after `from` up to `to`, oldest first. */
    firstParents(from: string, to: string): string[];
    /** The content of `path` (from the repo root) as committed at `rev`, or null when git can't read it. */
    show(rev: string, path: string): string | null;
    /** For a merge commit (two parents), the PR number its subject names, or null. */
    mergeSubjectPr?(sha: string): number | null;
}
/** The config file whose required_checks judge a commit, from the repo root. */
export declare const CONFIG_PATH: string;
/**
 * The required_checks in force when commit `sha` landed: config.yaml as committed at its first parent (the default
 * branch just before it). An error when that can't be read or isn't valid; the caller falls back, and says so.
 */
export declare function requiredAt(git: WatchGit, sha: string): {
    required: string[];
} | {
    error: string;
};
/**
 * Whether a commit that landed without a PR is posted to the ops channel (config.yaml main_watch.direct_push_alert),
 * as committed at `rev`: the config in force before the push, so a push can't turn off its own alert. On unless it
 * says false; on too when the config can't be read (the alert fails open).
 */
export declare function directPushAlertAt(git: WatchGit, rev: string): boolean;
/** WatchGit over a clone: fetches `branch` from `remote` for the tip. */
/** The PR number a merge subject names: "Merge #N: …" (this repo's merges) or GitHub's "Merge pull request #N from …". */
export declare function subjectPrNumber(subject: string): number | null;
export declare function repoGit(repo: string, remote: string, branch: string): WatchGit;
export interface MainWatchDeps {
    stateFile: string;
    branch: string;
    /** The loaded config's required_checks: whether to watch at all, and the fallback when a commit's own can't be read. */
    required: () => string[];
    api: MainWatchApi;
    git: WatchGit;
    /** The harness's own merge whose merge commit is `sha` (merge.done), or null. */
    harnessMerge(sha: string): {
        number: number;
        head: string;
        at: string;
    } | null;
    now?: () => number;
    /** The mode changed (or its detail): recorded as main_watch.mode. */
    mode(mode: ProtectionMode, detail: string): void;
    checked(sha: string, how: 'harness' | 'person', number: number): void;
    /** An admin accepted it as a bootstrap merge (acceptMerge): accounted, recorded as main_watch.accepted. */
    accepted(sha: string, number: number | null, a: Acceptance): void;
    /**
     * Stop auto-merge, alert, open the revert PR (`revert`: whether one can be made: not for a rewritten history).
     * `push`: it landed without a PR, pushed directly (GitHub confirms no merged PR has it) or by a rewrite (a
     * force-push), with `alert` whether that is posted to the ops channel (directPushAlertAt); null otherwise.
     */
    unaccounted(o: {
        sha: string;
        reason: string;
        number: number | null;
        revert: boolean;
        push: {
            kind: 'direct' | 'rewrite';
            alert: boolean;
        } | null;
    }): Promise<void>;
}
export declare class MainWatch {
    private readonly d;
    private listedAt;
    /** The required_checks the pending commit is judged by: read with git once per commit. */
    private judgedBy;
    constructor(d: MainWatchDeps);
    private get now();
    state(): WatchState;
    private setMode;
    /** Not watching (land_mode direct, or turned off): recorded, with no API call. */
    off(detail: string): void;
    /** May an API call be made now? If so, it is recorded as made before it is (a crash after it still counts). */
    private take;
    /** One pass: at most one API call. */
    step(): Promise<void>;
}
/** The protection as the dashboard shows it, from the watch's state file: the mode, and the last commit checked. */
export declare function protectionView(file: string, repo: string): {
    mode: "unknown" | ProtectionMode;
    detail: string;
    lastChecked: {
        sha: string;
        url: string;
        at: string | null;
    } | null;
    accepted: Acceptance[];
};
/** What acceptMerge reads with git: the watch's own, a commit's full sha, and an open PR's head on the remote. */
export interface AcceptGit extends WatchGit {
    /** The full sha of commit `ref` in the clone, or null. */
    resolve(ref: string): string | null;
    /** PR `n`'s head on the remote (refs/pull/n/head), or null. */
    prHead(n: number): string | null;
}
/** AcceptGit over a clone (the instance's repo): the tip is fetched as the watch fetches it. */
export declare function acceptGit(repo: string, remote: string, branch: string): AcceptGit;
export type AcceptTarget = {
    sha: string;
} | {
    pr: number;
};
export type AcceptResult = {
    ok: true;
    acceptance: Acceptance;
} | {
    ok: false;
    status: 400 | 404 | 409;
    error: string;
};
/**
 * An admin accepts a commit as a bootstrap merge, before the watch judges it (the caller checks they are an admin
 * and audits it). By sha: a commit on the branch's first-parent line after the last one checked, or the one being
 * checked. By PR number: the PR's merge to come (or not judged yet), pinned to its head now, so a push to the PR
 * after it needs accepting again. Refused: a branch rewritten since the last check, a commit not on the branch, one
 * already judged (`judgedPrs`: the PRs the watch has judged already), one accepted already. A stop stays.
 */
export declare function acceptMerge(o: {
    stateFile: string;
    git: AcceptGit;
    branch: string;
    target: AcceptTarget;
    reason: string;
    by: string;
    judgedPrs: number[];
    now?: () => number;
}): AcceptResult;
