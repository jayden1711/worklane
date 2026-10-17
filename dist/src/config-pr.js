// WHY (#468): every config PR the first-run page proposes (the setup PR in setup mode, each Repo config change after)
// ends the same way, whoever merges it and wherever: on this page's Merge, on GitHub, or from the CLI. One path:
// merged is seen, the checkout is fast-forwarded to it (src/checkout-sync.ts: only ever a fast-forward, never over
// the person's own work), and the step reads done, saying who merged it, when, and where the checkout is now. MERGED
// is never an error; a PR closed without merging, or a checkout that can't be fast-forwarded, says exactly why.
//
// The merge from this page is the same command for every config PR (only the page's own branches, into the default
// branch), recorded as the approval of the person who confirmed it: their login in the merge commit's subject (never
// in its body: the push gate's rule) and in the audit. Nothing reaches the default branch except through the PR.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SETUP_BRANCH } from './auto-config.js';
import { fastForwardCheckout } from './checkout-sync.js';
import { CONFIG_BRANCH_PREFIX, ConfigChangeError } from './config-change.js';
export const CONFIG_PRS_FILE = 'config-prs.json';
/** Whether a PR's head is one of the page's own branches (the setup branch, or a Repo config change's). */
export const ownBranch = (head) => !!head && (head === SETUP_BRANCH || head.startsWith(CONFIG_BRANCH_PREFIX));
export function readPr(gh, repo, n) {
    const v = gh(['pr', 'view', String(n), '--repo', repo, '--json', 'state,headRefName,headRefOid,baseRefName,url,title,mergedAt,mergedBy']);
    if (v.status !== 0)
        throw new ConfigChangeError(`can't read PR #${n} on ${repo}: ${v.stderr.trim().split('\n')[0] ?? ''}`);
    try {
        return JSON.parse(v.stdout);
    }
    catch {
        throw new ConfigChangeError(`GitHub's answer about PR #${n} could not be read`);
    }
}
/** The one line a merged PR's step shows: who, when, and where the checkout is now. */
export const mergedLine = (r) => `PR #${r.number} merged${r.mergedBy ? ` by @${r.mergedBy}` : ''}${r.mergedAt ? ` at ${r.mergedAt}` : ''}${r.synced && r.sha ? `, checkout at ${r.sha.slice(0, 7)}` : r.why ? `; the checkout isn't at it yet: ${r.why}` : ''}`;
/** Bring the checkout to a merged PR (a fast-forward only), recording what happened. */
export function syncMerged(r, git) {
    const ff = fastForwardCheckout(r.base, git);
    if (ff.ok)
        return { ...r, synced: true, sha: ff.to, why: null, retry: false, command: null };
    // Local changes: once committed or stashed, Fast-forward now can do it; anything else is the person's to reconcile.
    return { ...r, synced: false, sha: null, why: ff.detail, retry: ff.reason === 'dirty' || ff.reason === 'git', command: ff.command || null };
}
/**
 * Look at a PR again: open, closed without merging, or merged (wherever: this page, GitHub, the CLI), and then the
 * checkout fast-forwarded to it. A record already merged and synced is final: nothing is asked again.
 */
export function refreshConfigPr(r, o) {
    if (r.state === 'merged' && r.synced)
        return r;
    const at = (o.now ?? (() => new Date()))().toISOString();
    let v;
    try {
        v = readPr(o.gh, o.repo, r.number);
    }
    catch {
        return { ...r, checkedAt: at };
    }
    const base = v.baseRefName || r.base;
    if (v.state === 'MERGED')
        return syncMerged({ ...r, base, state: 'merged', mergedBy: v.mergedBy?.login ?? r.mergedBy, mergedAt: v.mergedAt ?? r.mergedAt, checkedAt: at }, o.git);
    if (v.state === 'CLOSED')
        return { ...r, state: 'closed', checkedAt: at, why: `PR #${r.number} was closed without merging: nothing changed; propose it again`, retry: false, command: null };
    return { ...r, base, state: v.state === 'OPEN' ? 'open' : 'unknown', checkedAt: at };
}
/** The config PRs this page knows, oldest first. */
export function readConfigPrs(stateDir) {
    try {
        const j = JSON.parse(readFileSync(join(stateDir, CONFIG_PRS_FILE), 'utf8'));
        return Array.isArray(j.prs) ? j.prs.filter((p) => Number.isInteger(p?.number)) : [];
    }
    catch {
        return [];
    }
}
export function writeConfigPrs(stateDir, prs) {
    const file = join(stateDir, CONFIG_PRS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ prs }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}
/** A PR the page proposed (or found init's setup PR): kept once, by number. */
export function trackConfigPr(stateDir, p) {
    const prs = readConfigPrs(stateDir);
    const have = prs.find((x) => x.number === p.number);
    if (have)
        return have;
    const r = { ...p, state: 'open', mergedBy: null, mergedAt: null, synced: false, sha: null, why: null, retry: false, command: null, checkedAt: null };
    writeConfigPrs(stateDir, [...prs, r]);
    return r;
}
/** Replace one record (by number) with its newer self. */
export function saveConfigPr(stateDir, r) {
    const prs = readConfigPrs(stateDir);
    writeConfigPrs(stateDir, prs.some((x) => x.number === r.number) ? prs.map((x) => (x.number === r.number ? r : x)) : [...prs, r]);
}
/** The repo's first allowed merge method gh can use, of merge, squash, rebase. */
export function mergeMethodOf(gh, repo) {
    const methods = gh(['api', `repos/${repo}`, '--jq', '[.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge] | @csv']);
    if (methods.status !== 0)
        throw new ConfigChangeError(`can't read ${repo}'s merge settings: ${methods.stderr.trim().split('\n')[0] ?? ''}`);
    const i = methods.stdout.trim().split(',').findIndex((x) => x === 'true');
    if (i < 0)
        throw new ConfigChangeError(`${repo} allows no merge method gh can use`);
    return ['merge', 'squash', 'rebase'][i];
}
/** The merge commit's subject: what it merges, and who approved it here. A login only: never an email, never in the body. */
export const approvalSubject = (n, title, approver) => `${title.replace(/[\r\n]+/g, ' ').slice(0, 120)} (#${n}), approved by ${approver} on the first-run page`;
/**
 * The merge of a config PR, as the page does it: only one of the page's own branches into the default branch. An
 * open PR gets the gh command (the repo's first allowed method, the subject naming the approver); a merged one needs
 * none. Refused otherwise; nothing is merged here.
 */
export function planConfigPrMerge(o) {
    const n = Number(o.number);
    if (!Number.isInteger(n) || n <= 0)
        throw new ConfigChangeError('number: the PR number the page proposed');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o.approver))
        throw new ConfigChangeError('the approver must be a GitHub login');
    // INVARIANT (#468, the owner): only a PR this page opened itself, as its own record has it (number and the head it
    // pushed), never one matched by its branch name: anyone who can push a branch can give it the page's branch prefix.
    const own = o.records.find((r) => r.number === n);
    if (!own?.head)
        throw new ConfigChangeError(`PR #${n} isn't one this page opened: merge it on GitHub`);
    const pr = readPr(o.gh, o.repo, n);
    if (pr.headRefOid !== own.head)
        throw new ConfigChangeError(`PR #${n}'s head is ${(pr.headRefOid ?? 'unknown').slice(0, 7)}, not ${own.head.slice(0, 7)}, the commit this page pushed for it: something else was pushed to it, so merge it on GitHub`);
    if (!ownBranch(pr.headRefName))
        throw new ConfigChangeError(`PR #${n} isn't one this page proposed (its branch is ${pr.headRefName ?? 'unknown'}, not ${SETUP_BRANCH} or ${CONFIG_BRANCH_PREFIX}...): merge it on GitHub`);
    if (pr.baseRefName !== o.base)
        throw new ConfigChangeError(`PR #${n} is against ${pr.baseRefName ?? 'unknown'}, not ${o.base}`);
    if (pr.state === 'MERGED')
        return { number: n, url: pr.url ?? '', merged: true, command: [] };
    if (pr.state !== 'OPEN')
        throw new ConfigChangeError(`PR #${n} was closed without merging: nothing to merge; propose it again`);
    const method = mergeMethodOf(o.gh, o.repo);
    const subject = method === 'rebase' ? [] : ['--subject', approvalSubject(n, pr.title ?? 'Config change', o.approver), '--body', ''];
    return { number: n, url: pr.url ?? '', merged: false, command: ['gh', 'pr', 'merge', String(n), '--repo', o.repo, `--${method}`, ...subject] };
}
/** Whether this gh login is an admin of the repo (GitHub's own answer). */
export function isRepoAdmin(gh, repo) {
    const r = gh(['api', `repos/${repo}`, '--jq', '.permissions.admin']);
    return r.status === 0 && r.stdout.trim() === 'true';
}
//# sourceMappingURL=config-pr.js.map