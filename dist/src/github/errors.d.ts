export type GitHubErrorKind = 'rate_limited' | 'secondary_rate_limited' | 'sso_required' | 'insufficient_scope' | 'insufficient_role' | 'repo_blocked' | 'forbidden' | 'unauthenticated' | 'not_found' | 'conflict' | 'validation' | 'server_error' | 'unknown';
export interface ClassifiedError {
    kind: GitHubErrorKind;
    retryable: boolean;
    /** Seconds to wait before retrying, when GitHub says. */
    retryAfter?: number;
    message: string;
}
type Headers = Record<string, string | undefined>;
export declare function classifyGitHubError(status: number, headers?: Headers, body?: unknown): ClassifiedError;
/**
 * Whether a thrown error is a network-level failure (GitHub not reached, or no answer in time) rather than an answer
 * from GitHub. Read from the error's structure only (its name, code and cause), never its message text, so an HTTP
 * error (a 401, a 403, a revoked installation: GitHub answered) or a bad key on disk is never taken for one.
 */
export declare function isNetworkFailure(e: unknown): boolean;
export {};
