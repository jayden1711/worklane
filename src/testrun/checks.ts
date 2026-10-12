// Posting a test run's tiers as GitHub check runs, through the instance's App, one per check name (several tiers
// may share one: it passes only when all of them passed). Posting needs the App's Checks: read & write permission,
// which only the owner can add. Without it GitHub answers 403 and nothing is posted: that is recorded as
// `no_permission` and shown plainly in health and on the dashboard, never retried as if it might work.
import { appJwt, type AppCredentials } from '../github-app.js';
import { readFileSync } from 'node:fs';
import { classifyGitHubError } from '../github/errors.js';
import type { EventLog } from '../events/log.js';
import type { TestRunResult } from './run.js';

type Fetch = typeof fetch;

export interface ChecksDeps {
  repo: string;
  token: () => Promise<string>;
  log: EventLog;
  actor: string;
  fetch?: Fetch;
  api?: string;
  /** Where a check's details link points (the instance's dashboard), if anywhere. */
  detailsUrl?: string;
}

export class ChecksPermissionMissing extends Error {
  constructor(detail: string) {
    super(`the App can't post checks (it needs Checks: read & write; the owner adds it in the App's settings): ${detail}`);
  }
}

const fmt = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);

/** The checks a result posts: each check name, its tiers, and its conclusion. */
export function checksFor(result: TestRunResult, checkNames: Record<string, string>): { name: string; conclusion: 'success' | 'failure'; tiers: TestRunResult['tiers'] }[] {
  const by = new Map<string, TestRunResult['tiers']>();
  for (const t of result.tiers) {
    const name = checkNames[t.tier] ?? `test-run/${t.tier}`;
    by.set(name, [...(by.get(name) ?? []), t]);
  }
  return [...by.entries()].map(([name, tiers]) => ({ name, conclusion: tiers.length && tiers.every((t) => t.ok) ? 'success' : 'failure', tiers }));
}

/**
 * Post one completed check run per check name on `sha`. The output names each tier's pass or fail and how long it
 * took; never its log (a check is readable by everyone who can read the repo). Throws ChecksPermissionMissing when
 * the App lacks Checks: write, after recording it.
 */
export async function postChecks(d: ChecksDeps, sha: string, result: TestRunResult, checkNames: Record<string, string>): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`a check needs the full commit, not ${sha}`);
  const f = d.fetch ?? fetch;
  const api = d.api ?? 'https://api.github.com';
  const posted: { name: string; conclusion: 'success' | 'failure' }[] = [];
  for (const c of checksFor(result, checkNames)) {
    const lines = c.tiers.map((t) => `- ${t.ok ? 'passed' : 'failed'}: ${t.tier} (${fmt(t.durationMs)})`);
    const body = {
      name: c.name,
      head_sha: sha,
      status: 'completed',
      conclusion: c.conclusion,
      completed_at: new Date().toISOString(),
      external_id: result.id,
      ...(d.detailsUrl ? { details_url: d.detailsUrl } : {}),
      output: { title: c.conclusion === 'success' ? 'Passed' : 'Failed', summary: `${result.kind} test run ${result.id}\n\n${lines.join('\n')}\n\nLogs are on the instance's dashboard.` },
    };
    const res = await f(`${api}/repos/${d.repo}/check-runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await d.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      posted.push({ name: c.name, conclusion: c.conclusion });
      continue;
    }
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    const k = classifyGitHubError(res.status, Object.fromEntries(res.headers.entries()), json);
    const noPermission = res.status === 403 && (k.kind === 'insufficient_role' || k.kind === 'forbidden');
    d.log.append('testrun.checks_failed', { id: result.id, sha, reason: noPermission ? 'no_permission' : 'error', detail: `${res.status} ${k.message}`.slice(0, 1000) }, d.actor);
    if (posted.length) d.log.append('testrun.checks_posted', { id: result.id, sha, checks: posted }, d.actor);
    if (noPermission) throw new ChecksPermissionMissing(k.message);
    throw new Error(`GitHub ${res.status} posting the check ${c.name}: ${k.message}`);
  }
  d.log.append('testrun.checks_posted', { id: result.id, sha, checks: posted }, d.actor);
}

/**
 * The App's Checks permission on its installation, as GitHub reports it (App JWT, GET /app/installations/<id>).
 * Recorded so health and the dashboard can say plainly when posting checks can't work yet.
 */
export async function checksPermission(c: AppCredentials, o: { fetch?: Fetch; api?: string } = {}): Promise<{ level: 'write' | 'read' | 'none' | 'unknown'; detail: string }> {
  try {
    const res = await (o.fetch ?? fetch)(`${o.api ?? 'https://api.github.com'}/app/installations/${c.installationId}`, {
      headers: { authorization: `Bearer ${appJwt(c.appId, readFileSync(c.keyPath, 'utf8'))}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    if (!res.ok) return { level: 'unknown', detail: `GitHub ${res.status} reading the installation` };
    const p = ((await res.json()) as { permissions?: Record<string, string> }).permissions ?? {};
    const level = p.checks === 'write' ? 'write' : p.checks === 'read' ? 'read' : 'none';
    return { level, detail: level === 'write' ? 'the App may post checks' : `the App has Checks: ${level}; posting checks needs read & write (the owner adds it in the App's permissions, then accepts it on the installation)` };
  } catch (e) {
    return { level: 'unknown', detail: (e as Error).message.slice(0, 300) };
  }
}
