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
export {};
