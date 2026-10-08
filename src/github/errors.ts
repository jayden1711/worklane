// Classify GitHub API errors by cause. A 403 has many causes (rate limits,
// SSO, blocked repos, token scope, missing role); reporting them all as
// "missing permission" sends people to fix the wrong thing.

export type GitHubErrorKind =
  | 'rate_limited'
  | 'secondary_rate_limited'
  | 'sso_required'
  | 'insufficient_scope'
  | 'insufficient_role'
  | 'repo_blocked'
  | 'forbidden'
  | 'unauthenticated'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'server_error'
  | 'unknown';

export interface ClassifiedError {
  kind: GitHubErrorKind;
  retryable: boolean;
  /** Seconds to wait before retrying, when GitHub says. */
  retryAfter?: number;
  message: string;
}

type Headers = Record<string, string | undefined>;

const lower = (h: Headers): Headers => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

export function classifyGitHubError(status: number, headers: Headers = {}, body: unknown = {}): ClassifiedError {
  const h = lower(headers);
  const message = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : String(body ?? '');
  const msg = message.toLowerCase();
  const retryAfter = h['retry-after'] ? Number(h['retry-after']) : undefined;
  const withRetry = (kind: GitHubErrorKind, wait?: number): ClassifiedError =>
    wait !== undefined && !Number.isNaN(wait) ? { kind, retryable: true, retryAfter: wait, message } : { kind, retryable: true, message };

  if (status === 401) return { kind: 'unauthenticated', retryable: false, message };
  if (status === 404) return { kind: 'not_found', retryable: false, message };
  if (status === 409) return { kind: 'conflict', retryable: false, message };
  if (status === 422) return { kind: 'validation', retryable: false, message };
  if (status >= 500) return withRetry('server_error', retryAfter);

  if (status === 403 || status === 429) {
    if (msg.includes('secondary rate limit') || (status === 429 && h['x-ratelimit-remaining'] !== '0')) {
      return withRetry('secondary_rate_limited', retryAfter ?? 60);
    }
    if (h['x-ratelimit-remaining'] === '0' || msg.includes('api rate limit exceeded')) {
      const reset = Number(h['x-ratelimit-reset']);
      const wait = Number.isFinite(reset) ? Math.max(0, reset - Math.floor(Date.now() / 1000)) : retryAfter;
      return withRetry('rate_limited', wait);
    }
    if (h['x-github-sso'] || msg.includes('saml') || msg.includes('sso')) {
      return { kind: 'sso_required', retryable: false, message };
    }
    if (msg.includes('repository access blocked') || msg.includes('access to this repository has been disabled') || msg.includes('dmca')) {
      return { kind: 'repo_blocked', retryable: false, message };
    }
    const accepted = h['x-accepted-oauth-scopes'];
    const granted = h['x-oauth-scopes'];
    if (accepted && granted !== undefined) {
      const have = new Set(granted.split(',').map((s) => s.trim()).filter(Boolean));
      const need = accepted.split(',').map((s) => s.trim()).filter(Boolean);
      if (need.length && !need.some((s) => have.has(s))) return { kind: 'insufficient_scope', retryable: false, message };
    }
    if (msg.includes('resource not accessible by') || msg.includes('must have admin rights') || msg.includes('must have push access')) {
      return { kind: 'insufficient_role', retryable: false, message };
    }
    return { kind: 'forbidden', retryable: false, message };
  }
  return { kind: 'unknown', retryable: false, message };
}
