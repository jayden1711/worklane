// Posting a test run's tiers as GitHub check runs, through the instance's App, one per check name (several tiers
// may share one: it passes only when all of them passed). Posting needs the App's Checks: read & write permission,
// which only the owner can add. Without it GitHub answers 403 and nothing is posted: that is recorded as
// `no_permission` and shown plainly in health and on the dashboard, never retried as if it might work.
import { appJwt } from '../github-app.js';
import { readFileSync } from 'node:fs';
import { classifyGitHubError } from '../github/errors.js';
import { redactString } from '../events/redact.js';
import { SANDBOX_STEP } from './run.js';
import { GPU_STEP } from './gpu.js';
export class ChecksPermissionMissing extends Error {
    constructor(detail) {
        super(`the App can't post checks (it needs Checks: read & write; the owner adds it in the App's settings): ${detail}`);
    }
}
const fmt = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);
/**
 * The checks a result posts: each check name, its tiers, and its conclusion. A tier whose PR predates the test-run
 * config is a failure too, not action_required: GitHub shows a failure's title in the PR's checks list, where the
 * predates title says what to do, while action_required wants a details page to act on (this check may have none),
 * and the engine's own gate reads action_required as a hold, waiting on something, where this is a fail to fix.
 */
export function checksFor(result, checkNames) {
    const by = new Map();
    for (const t of result.tiers) {
        const name = checkNames[t.tier] ?? `test-run/${t.tier}`;
        by.set(name, [...(by.get(name) ?? []), t]);
    }
    return [...by.entries()].map(([name, tiers]) => ({ name, conclusion: tiers.length && tiers.every((t) => t.ok) ? 'success' : 'failure', tiers }));
}
export const PREDATES_TITLE = 'This PR predates the test-run config: update it with main';
/** The title of the check on a head whose run was refused because the sandbox's check is failing (./sandbox-watch.ts). */
export const SANDBOX_TITLE = 'Not run: test runs are off (the test sandbox check is failing)';
/** The title of the failing check on the head of a GPU run cut off by a stop (src/coordinator/test-runs.ts recover). */
export const GPU_CUT_OFF_TITLE = 'Cut off (GPU run): not rerun automatically';
// GitHub takes a summary of at most 65535 characters.
const SUMMARY_MAX = 60_000;
/**
 * A check's title and summary. Each tier's pass or fail and how long it took, and its last lines of output (as the
 * run captured them, stdout and stderr together), redacted: a check is readable by everyone who can read the repo,
 * and the full log stays in the instance's state. A tier the PR's head is too old to run as configured gets the
 * predates title, what the head lacks, the config's commit, and the fix. A run that failed in setup says which step,
 * why, and the last lines of that step's stderr, redacted (never its stdout: db-start prints the database's
 * password there).
 */
export function checkOutput(result, tiers, conclusion, detailsUrl) {
    const head = `${result.kind} test run ${result.id}`;
    const foot = `${result.note ? `${redactString(result.note)}\n\n` : ''}${detailsUrl ? `Full logs: [the instance's dashboard](${detailsUrl})` : "Full logs are on the instance's dashboard."}`;
    const clean = (x) => redactString(x).replace(/```/g, "'''");
    const s = result.setup;
    if (!s) {
        const lines = tiers.map((t) => `- ${t.ok ? 'passed' : t.predates?.notRun ? 'not run' : 'failed'}: ${t.tier} (${fmt(t.durationMs)})`);
        const old = tiers.filter((t) => t.predates);
        let why = '';
        if (old.length) {
            const commits = [...new Set(old.map((t) => t.predates.configCommit))];
            why =
                `This PR's head is older than the test-run config: it doesn't contain ${commits.map((c) => `\`${c}\``).join(', ')}, the commit that last changed \`test_run\` in tests.yaml on the default branch. So:\n\n` +
                    old.map((t) => `- ${t.tier}: ${t.predates.what}${t.predates.notRun ? ' (not run)' : ''}`).join('\n') +
                    '\n\nTo update it: merge main into the branch (for a Dependabot PR, comment `@dependabot rebase`).\n\n';
        }
        const outputs = tiers
            .filter((t) => !t.predates?.notRun)
            .map((t) => `**${t.tier}**, its last lines of output (redacted):\n\n\`\`\`\n${t.summary.trim() ? clean(t.summary.trim()).slice(-4000) : '(no output)'}\n\`\`\``)
            .join('\n\n');
        const title = old.length ? PREDATES_TITLE : conclusion === 'success' ? 'Passed' : 'Failed';
        const body = `${head}\n\n${why}${lines.join('\n')}${outputs ? `\n\n${outputs}` : ''}`;
        return { title, summary: `${body.slice(0, SUMMARY_MAX)}\n\n${foot}` };
    }
    const said = s.step === SANDBOX_STEP ? 'What the check said (redacted)' : 'The last lines of its stderr (redacted)';
    const err = s.stderr.trim() ? `\n\n${said}:\n\n\`\`\`\n${clean(s.stderr.trim()).slice(-4000)}\n\`\`\`` : '';
    const lines = tiers.map((t) => `- not run: ${t.tier}`);
    const title = s.step === 'helper' ? 'Not run: the test sandbox helper is outdated' : s.step === SANDBOX_STEP ? SANDBOX_TITLE : s.step === GPU_STEP ? GPU_CUT_OFF_TITLE : `Failed in setup: ${s.step}`.slice(0, 200);
    return { title, summary: `${head}\n\nSetup failed at **${clean(s.step)}**: ${clean(s.detail)}${err}\n\n${lines.join('\n')}\n\n${foot}` };
}
/**
 * Post one completed check run per check name on `sha` (its output: checkOutput). Throws ChecksPermissionMissing
 * when the App lacks Checks: write, after recording it.
 */
export async function postChecks(d, sha, result, checkNames) {
    if (!/^[0-9a-f]{40}$/.test(sha))
        throw new Error(`a check needs the full commit, not ${sha}`);
    const f = d.fetch ?? fetch;
    const api = d.api ?? 'https://api.github.com';
    const posted = [];
    for (const c of checksFor(result, checkNames)) {
        const body = {
            name: c.name,
            head_sha: sha,
            status: 'completed',
            conclusion: c.conclusion,
            completed_at: new Date().toISOString(),
            external_id: result.id,
            ...(d.detailsUrl ? { details_url: d.detailsUrl } : {}),
            output: checkOutput(result, c.tiers, c.conclusion, d.detailsUrl),
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
        let json = text;
        try {
            json = JSON.parse(text);
        }
        catch {
            // not JSON
        }
        const k = classifyGitHubError(res.status, Object.fromEntries(res.headers.entries()), json);
        const noPermission = res.status === 403 && (k.kind === 'insufficient_role' || k.kind === 'forbidden');
        d.log.append('testrun.checks_failed', { id: result.id, sha, reason: noPermission ? 'no_permission' : 'error', detail: `${res.status} ${k.message}`.slice(0, 1000) }, d.actor);
        if (posted.length)
            d.log.append('testrun.checks_posted', { id: result.id, sha, checks: posted }, d.actor);
        if (noPermission)
            throw new ChecksPermissionMissing(k.message);
        throw new Error(`GitHub ${res.status} posting the check ${c.name}: ${k.message}`);
    }
    d.log.append('testrun.checks_posted', { id: result.id, sha, checks: posted }, d.actor);
}
/**
 * The App's Checks permission on its installation, as GitHub reports it (App JWT, GET /app/installations/<id>).
 * Recorded so health and the dashboard can say plainly when posting checks can't work yet.
 */
export async function checksPermission(c, o = {}) {
    try {
        const res = await (o.fetch ?? fetch)(`${o.api ?? 'https://api.github.com'}/app/installations/${c.installationId}`, {
            headers: { authorization: `Bearer ${appJwt(c.appId, readFileSync(c.keyPath, 'utf8'))}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        });
        if (!res.ok)
            return { level: 'unknown', detail: `GitHub ${res.status} reading the installation` };
        const p = (await res.json()).permissions ?? {};
        const level = p.checks === 'write' ? 'write' : p.checks === 'read' ? 'read' : 'none';
        return { level, detail: level === 'write' ? 'the App may post checks' : `the App has Checks: ${level}; posting checks needs read & write (the owner adds it in the App's permissions, then accepts it on the installation)` };
    }
    catch (e) {
        return { level: 'unknown', detail: e.message.slice(0, 300) };
    }
}
//# sourceMappingURL=checks.js.map