// The GitHub calls the CI metrics make (src/ci-metrics.ts), one REST request each, with the instance's own token.
// Read-only. The metrics decide when to call: at most one of these per CI_METRICS_CALL_MS.
import type { CiCheckRun, CiMetricsApi } from '../ci-metrics.js';

type Fetch = typeof fetch;

/** A job log is read up to this many characters (its end, where a runner prints its results). */
export const JOB_LOG_CHARS = 20_000_000;

export class GitHubCiMetricsApi implements CiMetricsApi {
  constructor(
    private readonly repo: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch = fetch,
    private readonly api = 'https://api.github.com',
  ) {}

  private async get(path: string, what: string): Promise<Response> {
    // A job log redirects to a signed download URL on another host; fetch drops the token on that cross-origin hop.
    const res = await this.fetchImpl(`${this.api.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${what}`);
    return res;
  }

  async checkRuns(sha: string): Promise<CiCheckRun[]> {
    const r = (await (await this.get(`/repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100`, `the check runs on ${sha.slice(0, 8)}`)).json()) as {
      check_runs: { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; app?: { slug?: string } | null }[];
    };
    return r.check_runs.map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, startedAt: c.started_at ?? null, completedAt: c.completed_at ?? null, app: c.app?.slug ?? null }));
  }

  async jobLog(id: number): Promise<string> {
    const text = await (await this.get(`/repos/${this.repo}/actions/jobs/${id}/logs`, `the log of job ${id}`)).text();
    return text.length > JOB_LOG_CHARS ? text.slice(-JOB_LOG_CHARS) : text;
  }
}
