type Fetch = typeof fetch;
/** A GitHub user or organization name. */
export declare const ACCOUNT: RegExp;
export interface PickableRepo {
    /** owner/name. */
    fullName: string;
    private: boolean;
    /** Whether the App can be installed on it and do its work there; when not, `why`. */
    installable: boolean;
    why: string | null;
    pushedAt: string | null;
}
export interface RepoPickerView {
    /** The account listed. */
    owner: string;
    ownerType: 'User' | 'Organization' | null;
    /** Accounts to pick from: the signed-in person's own, then the organizations GitHub shows publicly for them. */
    accounts: string[];
    repos: PickableRepo[];
    /** What the list can't show, or why there is none. */
    note: string;
    error: string | null;
}
/** GitHub allows 60 unauthenticated requests an hour per address: a list is kept this long. */
export declare const REPO_LIST_TTL_MS: number;
/**
 * The repos of `owner` (a user or an organization) to pick from, most recently pushed first, with the accounts to
 * switch to. `login` is the signed-in person, whose organizations are offered. Never throws: a GitHub error is the
 * view's `error`, and the page still takes a typed owner/name.
 */
export declare function listInstallableRepos(o: {
    owner: string;
    login?: string | null;
    api?: string;
    fetch?: Fetch;
    now?: () => number;
}): Promise<RepoPickerView>;
/** Forget the cached lists (tests). */
export declare function clearRepoListCache(): void;
export {};
