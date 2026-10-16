// Main watch: the harness's own guard for a default branch GitHub doesn't protect (a private repo on GitHub Free, where
// branch protection and rulesets return 403). On by default when the protection API says there is none (403 or 404).
// On the coordinator's timer, making at most one GitHub API call a minute, it checks every new commit on the default
// branch, oldest first along the first-parent line. A commit is accounted for when it is either
//   (a) a merge the harness itself did (merge.done), of a head whose required_checks were green when it merged, or
//   (b) a merge of a PR by a mapped admin or writer (their role from their repo permission, as the dashboard reads
//       it), with required_checks green on the PR's head at merge time.
// Anything else is unaccounted: a direct push, a PR merged with failing, missing or pending checks, an unknown actor
// or a bot, a rewritten history. The coordinator then stops auto-merge (the stop file), alerts, and opens a revert PR
// for a human (coordinator/merge-flow.ts). A commit that landed without a PR at all (GitHub's commit-to-PR link has
// no merged PR for it, or a force-push rewrote the branch) is also posted to the ops channel at once, mentioning the
// Discord owners (src/direct-push-alert.ts; config.yaml main_watch.direct_push_alert, on by default). The last checked commit is kept in a state file, so a restart neither
// checks a commit twice nor skips one; so is the time of the last call, so the limit holds across restarts too.
//
// Which PR a commit belongs to is GitHub's answer, never git's: the commit-to-PR link (GET /commits/{sha}/pulls),
// asked again for up to LINK_LAG_MS while it is still empty (GitHub links a merge a few seconds after it lands); the
// PR's merge_commit_sha; and for a commit inside a rebase merge, compare (GET /compare/{sha}...{merge commit}) against
// the PR's commit count. Git only reads the branch itself: its tip, whether it was rewritten, its first-parent line,
// a commit's parents and the config committed at a commit.
//
// A bootstrap merge: while a project's required check can't run yet, an admin's hand merge is unaccounted. An admin
// may accept such a commit on the dashboard before the watch judges it (acceptMerge): by its sha, once it is on the
// branch and not judged yet, or in advance by PR number, pinned to the PR's head as it is then. The watch then judges
// it accounted (how 'accepted'): no stop, no alert, no revert PR. A rewrite, a commit not on the branch and one
// already judged can't be accepted, and accepting never clears a stop.
//
// The required_checks a commit is judged by are the ones in force when it landed: config.yaml as committed at its
// first parent, read with git. Not the config loaded at startup: the clone's working tree isn't updated as the default
// branch moves, so a check dropped since would still be required of every later merge, and never report.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import { ProjectConfig } from './config/schema.js';
import { writeGroupOnly } from './os/index.js';
/** At most one GitHub API call per this long. */
export const MAIN_WATCH_CALL_MS = 60_000;
/**
 * How long an empty commit-to-PR link is asked again before it counts as "no PR": GitHub links a merge commit to its
 * PR a few seconds after the merge (main 09f60340 was judged 6 s after #307 landed, with the link still empty).
 */
export const LINK_LAG_MS = 120_000;
/** How often whether GitHub protects the branch is asked again. */
export const PROTECTION_RECHECK_MS = 6 * 3600_000;
/**
 * Each required check's outcome on a commit at time `at` (a merge): the check run that had started by then, latest
 * first, passed only if it had completed with success by then; else the commit status set by then. `unknown`: no
 * check run of that name, and the statuses aren't read yet.
 */
export function outcomesAt(required, runs, statuses, at) {
    const t = Date.parse(at);
    return required.map((name) => {
        const run = runs
            .filter((r) => r.name === name)
            .map((r) => ({ r, start: Date.parse(r.startedAt ?? r.completedAt ?? '') }))
            .filter((x) => Number.isFinite(x.start) && x.start <= t)
            .sort((a, b) => b.start - a.start)[0]?.r;
        if (run) {
            const done = Date.parse(run.completedAt ?? '');
            if (run.status !== 'completed' || !Number.isFinite(done) || done > t)
                return { name, outcome: 'pending' };
            return { name, outcome: run.conclusion === 'success' ? 'pass' : 'fail' };
        }
        if (!statuses)
            return { name, outcome: 'unknown' };
        const st = statuses
            .filter((s) => s.context === name && Date.parse(s.createdAt) <= t)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (!st)
            return { name, outcome: 'missing' };
        return { name, outcome: st.state === 'success' ? 'pass' : st.state === 'pending' ? 'pending' : 'fail' };
    });
}
/**
 * Is commit `sha` accounted for, given what is known? Or which one call would tell. Pure: the watch and the tests
 * share it. An empty commit-to-PR link is asked again until an answer LINK_LAG_MS after its first one (pullsAt).
 */
export function judge(sha, f, o) {
    const short = sha.slice(0, 8);
    const bySha = o.accepted?.find((a) => a.sha === sha);
    if (bySha)
        return { done: true, accounted: true, how: 'accepted', number: null, acceptance: bySha };
    const byPr = (n, h) => {
        const a = o.accepted?.find((x) => x.pr === n && x.head === h);
        return a ? { done: true, accounted: true, how: 'accepted', number: n, acceptance: a } : null;
    };
    let head;
    let at;
    let number;
    let who;
    if (f.harness) {
        ({ head, at, number } = f.harness);
        who = `the harness merged #${number}`;
        const ok = byPr(number, head);
        if (ok)
            return ok;
    }
    else {
        if (!f.pulls)
            return { done: false, need: { call: 'pulls' } };
        const merged = f.pulls.filter((p) => p.mergedAt && p.base === o.branch);
        let cand = merged.find((p) => p.mergeCommit === sha);
        let notIn = '';
        // A rebase merge puts the PR's commits on the branch one by one, and its merge_commit_sha is the last of them. This
        // commit is one of them when that merge commit is ahead of it by fewer commits than the PR has: GitHub's compare,
        // not git ancestry (every earlier commit on the branch, a direct push too, is an ancestor of a later merge).
        const rebased = cand ? undefined : merged.find((p) => p.mergeCommit);
        if (rebased) {
            if (!f.pr || f.pr.number !== rebased.number)
                return { done: false, need: { call: 'pull', number: rebased.number } };
            const m = f.pr.mergeCommit;
            if (m && m !== sha && f.pr.mergedAt && f.pr.base === o.branch) {
                if (!f.compare || f.compare.base !== sha || f.compare.head !== m)
                    return { done: false, need: { call: 'compare', base: sha, head: m } };
                const c = f.compare;
                if (c.status === 'ahead' && c.behindBy === 0 && typeof f.pr.commits === 'number' && c.aheadBy < f.pr.commits)
                    cand = f.pr;
                else
                    notIn = ` (#${f.pr.number}'s merge ${m.slice(0, 8)} doesn't include it: ${c.aheadBy} commit(s) ahead of it, and the PR has ${f.pr.commits ?? 'an unknown number of'} commit(s))`;
            }
        }
        // GitHub links a merge commit to its PR a few seconds after the merge, so the pulls call can be empty for a normal
        // merge (main 09f60340, judged 6 s after #307 landed). A merge commit whose subject names a PR: ask that PR, and
        // take it only when its own merge commit is this one (a made-up subject still counts as a direct push).
        if (!cand && !merged.length && f.subjectPr) {
            if (!f.pr || f.pr.number !== f.subjectPr)
                return { done: false, need: { call: 'pull', number: f.subjectPr } };
            if (f.pr.mergedAt && f.pr.base === o.branch && f.pr.mergeCommit === sha)
                cand = f.pr;
        }
        if (!cand) {
            // The link is still empty: a squash or rebase merge (no merge subject to go by), or a merge whose subject was
            // edited, may just not be linked yet. Asked again, within the call budget, until an answer LINK_LAG_MS after the first.
            if (!merged.length && f.pullsAt !== undefined && (f.pullsLastAt ?? f.pullsAt) - f.pullsAt < LINK_LAG_MS)
                return { done: false, need: { call: 'pulls' } };
            const other = f.pulls.find((p) => !p.mergedAt);
            // GitHub's own commit-to-PR link (the pulls call) says no merged PR has it: a direct push.
            return { done: true, accounted: false, number: null, direct: true, reason: `${short} was pushed to ${o.branch} directly: no merged PR has it${notIn}${other ? ` (#${other.number} has it, unmerged)` : ''}` };
        }
        if (!f.pr || f.pr.number !== cand.number)
            return { done: false, need: { call: 'pull', number: cand.number } };
        number = f.pr.number;
        const ok = byPr(number, f.pr.head);
        if (ok)
            return ok;
        if (!f.pr.mergedBy)
            return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by an unknown actor` };
        if (f.pr.mergedByBot)
            return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by a bot, not a mapped admin or writer` };
        if (f.role === undefined)
            return { done: false, need: { call: 'role', login: f.pr.mergedBy } };
        if (f.role !== 'owner' && f.role !== 'writer')
            return { done: true, accounted: false, number, reason: `#${number} was merged into ${o.branch} by someone who isn't a mapped admin or writer on the repo` };
        head = f.pr.head;
        at = f.pr.mergedAt ?? '';
        who = `#${number} was merged`;
    }
    if (!o.required.length)
        return { done: true, accounted: false, number, reason: `${who}, but no required_checks are configured to judge it by` };
    if (!f.runs)
        return { done: false, need: { call: 'runs', sha: head } };
    let out = outcomesAt(o.required, f.runs, f.statuses ?? null, at);
    if (out.some((c) => c.outcome === 'unknown')) {
        if (!f.statuses)
            return { done: false, need: { call: 'statuses', sha: head } };
        out = outcomesAt(o.required, f.runs, f.statuses, at);
    }
    const bad = out.filter((c) => c.outcome !== 'pass');
    if (bad.length)
        return { done: true, accounted: false, number, reason: `${who} into ${o.branch} with required checks not green on ${head.slice(0, 8)} at merge time: ${bad.map((c) => `${c.name} ${c.outcome}`).join(', ')}` };
    return { done: true, accounted: true, how: f.harness ? 'harness' : 'person', number };
}
const EMPTY = { version: 1, mode: null, detail: '', protectionAt: 0, last: null, lastAt: null, lastCallAt: 0, pending: null };
export function readWatchState(file) {
    if (!existsSync(file))
        return { ...EMPTY };
    try {
        return { ...EMPTY, ...JSON.parse(readFileSync(file, 'utf8')) };
    }
    catch {
        return { ...EMPTY };
    }
}
function writeWatchState(file, s) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeGroupOnly(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, file);
}
/** Where the admins' acceptances are kept, next to the watch's state file: the dashboard writes it, the watch reads it. */
export function acceptedFileFor(stateFile) {
    return join(dirname(stateFile), 'main-watch-accepted.json');
}
export function readAccepted(file) {
    if (!existsSync(file))
        return [];
    try {
        const j = JSON.parse(readFileSync(file, 'utf8'));
        return Array.isArray(j) ? j : [];
    }
    catch {
        return [];
    }
}
/** The config file whose required_checks judge a commit, from the repo root. */
export const CONFIG_PATH = `${BRAND.configDir}/config.yaml`;
/**
 * The required_checks in force when commit `sha` landed: config.yaml as committed at its first parent (the default
 * branch just before it). An error when that can't be read or isn't valid; the caller falls back, and says so.
 */
export function requiredAt(git, sha) {
    const at = `${sha.slice(0, 8)}^1`;
    const text = git.show(`${sha}^1`, CONFIG_PATH);
    if (text === null)
        return { error: `${CONFIG_PATH} could not be read at ${at}` };
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length)
        return { error: `${CONFIG_PATH} at ${at} is not valid YAML` };
    const raw = doc.toJS();
    const r = ProjectConfig.shape.required_checks.safeParse(raw && typeof raw === 'object' ? raw.required_checks : undefined);
    if (!r.success)
        return { error: `${CONFIG_PATH} at ${at} has an invalid required_checks` };
    return { required: r.data };
}
/**
 * Whether a commit that landed without a PR is posted to the ops channel (config.yaml main_watch.direct_push_alert),
 * as committed at `rev`: the config in force before the push, so a push can't turn off its own alert. On unless it
 * says false; on too when the config can't be read (the alert fails open).
 */
export function directPushAlertAt(git, rev) {
    const text = git.show(rev, CONFIG_PATH);
    if (text === null)
        return true;
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length)
        return true;
    const raw = doc.toJS();
    const mw = raw && typeof raw === 'object' ? raw.main_watch : undefined;
    return !(mw && typeof mw === 'object' && mw.direct_push_alert === false);
}
/** WatchGit over a clone: fetches `branch` from `remote` for the tip. */
/** The PR number a merge subject names: "Merge #N: …" (this repo's merges) or GitHub's "Merge pull request #N from …". */
export function subjectPrNumber(subject) {
    const m = /^Merge (?:pull request )?#(\d{1,7})\b/.exec(subject);
    return m ? Number(m[1]) : null;
}
export function repoGit(repo, remote, branch) {
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    return {
        tip: () => {
            git('fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
            const r = git('rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`);
            return r.status === 0 ? r.stdout.trim() || null : null;
        },
        isAncestor: (a, b) => git('merge-base', '--is-ancestor', a, b).status === 0,
        firstParents: (from, to) => git('rev-list', '--first-parent', '--reverse', `${from}..${to}`).stdout.split('\n').filter(Boolean),
        show: (rev, path) => {
            const r = git('show', `${rev}:${path}`);
            return r.status === 0 ? r.stdout : null;
        },
        mergeSubjectPr: (sha) => {
            const r = git('log', '-1', '--format=%P%n%s', sha);
            if (r.status !== 0)
                return null;
            const [parents = '', subject = ''] = r.stdout.split('\n');
            return parents.trim().split(' ').length === 2 ? subjectPrNumber(subject) : null;
        },
    };
}
export class MainWatch {
    d;
    listedAt = -Infinity;
    /** The required_checks the pending commit is judged by: read with git once per commit. */
    judgedBy = null;
    constructor(d) {
        this.d = d;
    }
    get now() {
        return this.d.now?.() ?? Date.now();
    }
    state() {
        return readWatchState(this.d.stateFile);
    }
    setMode(s, mode, detail) {
        if (s.mode === mode && s.detail === detail)
            return;
        // Guarding from now on (first start, or the protection went away): the tip now is the baseline.
        if (mode === 'main_watch' && s.mode !== 'main_watch') {
            s.last = null;
            s.pending = null;
        }
        s.mode = mode;
        s.detail = detail;
        this.d.mode(mode, detail);
    }
    /** Not watching (land_mode direct, or turned off): recorded, with no API call. */
    off(detail) {
        const s = this.state();
        if (s.mode === 'off' && s.detail === detail)
            return;
        this.setMode(s, 'off', detail);
        writeWatchState(this.d.stateFile, s);
    }
    /** May an API call be made now? If so, it is recorded as made before it is (a crash after it still counts). */
    take(s) {
        if (this.now - s.lastCallAt < MAIN_WATCH_CALL_MS)
            return false;
        s.lastCallAt = this.now;
        writeWatchState(this.d.stateFile, s);
        return true;
    }
    /** One pass: at most one API call. */
    async step() {
        const s = this.state();
        const required = this.d.required();
        if (!required.length) {
            this.setMode(s, 'off', this.d.offWhy?.() ?? 'no required_checks in config.yaml to judge commits by');
            return writeWatchState(this.d.stateFile, s);
        }
        if (s.mode === null || s.mode === 'off' || this.now - s.protectionAt >= PROTECTION_RECHECK_MS) {
            if (!this.take(s))
                return;
            const p = await this.d.api.protection(this.d.branch);
            s.protectionAt = this.now;
            if (p === 'enforced')
                this.setMode(s, 'github', `GitHub enforces ${this.d.branch}'s protection`);
            else
                this.setMode(s, 'main_watch', `GitHub doesn't protect ${this.d.branch} (its protection API says none)`);
            return writeWatchState(this.d.stateFile, s);
        }
        if (s.mode !== 'main_watch')
            return;
        if (!s.pending) {
            // A fetch (git, not the API) at most as often as a call, too.
            if (this.now - this.listedAt < MAIN_WATCH_CALL_MS)
                return;
            this.listedAt = this.now;
            const tip = this.d.git.tip();
            if (!tip || tip === s.last)
                return;
            if (!s.last) {
                s.last = tip;
                s.lastAt = new Date(this.now).toISOString();
                return writeWatchState(this.d.stateFile, s);
            }
            if (!this.d.git.isAncestor(s.last, tip)) {
                const was = s.last;
                await this.d.unaccounted({ sha: tip, reason: `${this.d.branch} was rewritten: ${was.slice(0, 8)}, checked before, is no longer in its history (a force-push)`, number: null, revert: false, push: { kind: 'rewrite', alert: directPushAlertAt(this.d.git, was) } });
                s.last = tip;
                s.lastAt = new Date(this.now).toISOString();
                return writeWatchState(this.d.stateFile, s);
            }
            const next = this.d.git.firstParents(s.last, tip)[0];
            if (!next)
                return;
            s.pending = { sha: next, facts: { harness: this.d.harnessMerge(next), subjectPr: this.d.git.mergeSubjectPr?.(next) ?? null } };
            writeWatchState(this.d.stateFile, s);
        }
        const p = s.pending;
        if (this.judgedBy?.sha !== p.sha) {
            const at = requiredAt(this.d.git, p.sha);
            this.judgedBy = 'required' in at ? { sha: p.sha, required: at.required, note: '' } : { sha: p.sha, required, note: ` (judged by the required_checks loaded at startup: ${at.error})` };
        }
        const { required: judgedBy, note } = this.judgedBy;
        // What admins accepted, as long as it descends from the commit checked when they did (a rewrite voids it).
        const accepted = readAccepted(acceptedFileFor(this.d.stateFile)).filter((a) => a.base !== p.sha && this.d.git.isAncestor(a.base, p.sha));
        const ctx = { branch: this.d.branch, required: judgedBy, accepted };
        let v = judge(p.sha, p.facts, ctx);
        if (!v.done) {
            if (!this.take(s))
                return;
            const n = v.need;
            if (n.call === 'pulls') {
                p.facts.pulls = await this.d.api.commitPulls(p.sha);
                p.facts.pullsAt ??= this.now;
                p.facts.pullsLastAt = this.now;
            }
            else if (n.call === 'compare')
                p.facts.compare = { ...(await this.d.api.compare(n.base, n.head)), base: n.base, head: n.head };
            else if (n.call === 'pull')
                p.facts.pr = await this.d.api.pull(n.number);
            else if (n.call === 'role')
                p.facts.role = await this.d.api.role(n.login);
            else if (n.call === 'runs')
                p.facts.runs = await this.d.api.checkRuns(n.sha);
            else
                p.facts.statuses = await this.d.api.statuses(n.sha);
            writeWatchState(this.d.stateFile, s);
            v = judge(p.sha, p.facts, ctx);
            if (!v.done)
                return;
        }
        if (v.accounted && v.how === 'accepted')
            this.d.accepted(p.sha, v.number, v.acceptance);
        else if (v.accounted)
            this.d.checked(p.sha, v.how, v.number);
        else
            await this.d.unaccounted({ sha: p.sha, reason: v.reason + note, number: v.number, revert: true, push: v.direct ? { kind: 'direct', alert: directPushAlertAt(this.d.git, `${p.sha}^1`) } : null });
        this.judgedBy = null;
        s.last = p.sha;
        s.lastAt = new Date(this.now).toISOString();
        s.pending = null;
        writeWatchState(this.d.stateFile, s);
    }
}
/** The protection as the dashboard shows it, from the watch's state file: the mode, and the last commit checked. */
export function protectionView(file, repo) {
    const s = readWatchState(file);
    return {
        mode: s.mode ?? 'unknown',
        detail: s.detail,
        lastChecked: s.last ? { sha: s.last, url: `https://github.com/${repo}/commit/${s.last}`, at: s.lastAt } : null,
        accepted: readAccepted(acceptedFileFor(file)),
    };
}
/** AcceptGit over a clone (the instance's repo): the tip is fetched as the watch fetches it. */
export function acceptGit(repo, remote, branch) {
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    return {
        ...repoGit(repo, remote, branch),
        resolve: (ref) => {
            const r = git('rev-parse', '--verify', '-q', `${ref}^{commit}`);
            return r.status === 0 ? r.stdout.trim() || null : null;
        },
        prHead: (n) => {
            const r = git('ls-remote', remote, `refs/pull/${n}/head`);
            const sha = r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? '') : '';
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
        },
    };
}
/**
 * An admin accepts a commit as a bootstrap merge, before the watch judges it (the caller checks they are an admin
 * and audits it). By sha: a commit on the branch's first-parent line after the last one checked, or the one being
 * checked. By PR number: the PR's merge to come (or not judged yet), pinned to its head now, so a push to the PR
 * after it needs accepting again. Refused: a branch rewritten since the last check, a commit not on the branch, one
 * already judged (`judgedPrs`: the PRs the watch has judged already), one accepted already. A stop stays.
 */
export function acceptMerge(o) {
    const reason = String(o.reason ?? '').trim();
    if (!reason)
        return { ok: false, status: 400, error: 'a reason is required' };
    if (reason.length > 500)
        return { ok: false, status: 400, error: 'the reason is too long (at most 500 characters)' };
    const s = readWatchState(o.stateFile);
    if (s.mode !== 'main_watch')
        return { ok: false, status: 409, error: `the main watch isn't guarding ${o.branch} (${s.mode ?? 'not started'}): there is nothing to accept` };
    if (!s.last)
        return { ok: false, status: 409, error: `the main watch has no starting commit yet: the next tip of ${o.branch} is the baseline, and is not judged` };
    const tip = o.git.tip();
    if (!tip)
        return { ok: false, status: 409, error: `${o.branch} can't be read from the remote` };
    if (!o.git.isAncestor(s.last, tip))
        return { ok: false, status: 409, error: `${o.branch} was rewritten since the last commit checked (${s.last.slice(0, 8)}): a force-push can't be accepted` };
    const file = acceptedFileFor(o.stateFile);
    const list = readAccepted(file);
    const base = { id: randomBytes(6).toString('hex'), base: s.last, by: o.by, reason, at: new Date(o.now?.() ?? Date.now()).toISOString() };
    let a;
    if ('sha' in o.target) {
        const given = String(o.target.sha).trim().toLowerCase();
        if (!/^[0-9a-f]{7,40}$/.test(given))
            return { ok: false, status: 400, error: 'a commit sha is 7 to 40 hex characters' };
        const sha = o.git.resolve(given);
        if (!sha)
            return { ok: false, status: 404, error: `${given.slice(0, 12)} is not a commit on ${o.branch}` };
        if (sha === s.last || o.git.isAncestor(sha, s.last))
            return { ok: false, status: 409, error: `${sha.slice(0, 8)} was judged already (the last commit checked is ${s.last.slice(0, 8)})` };
        if (sha !== s.pending?.sha) {
            if (!o.git.isAncestor(sha, tip))
                return { ok: false, status: 404, error: `${sha.slice(0, 8)} is not a commit on ${o.branch}` };
            if (!o.git.firstParents(s.last, tip).includes(sha))
                return { ok: false, status: 409, error: `${sha.slice(0, 8)} is on ${o.branch}, but not on its first-parent line: the watch judges the merge commit that brought it in; accept that, or the PR` };
        }
        if (list.some((x) => x.sha === sha))
            return { ok: false, status: 409, error: `${sha.slice(0, 8)} is accepted already` };
        a = { ...base, sha, pr: null, head: null };
    }
    else {
        const n = Number(o.target.pr);
        if (!Number.isSafeInteger(n) || n <= 0)
            return { ok: false, status: 400, error: 'a PR number is a positive whole number' };
        if (o.judgedPrs.includes(n))
            return { ok: false, status: 409, error: `#${n}'s merge was judged already` };
        const head = o.git.prHead(n);
        if (!head)
            return { ok: false, status: 404, error: `no PR #${n} on the remote` };
        if (o.git.resolve(head) && (head === s.last || o.git.isAncestor(head, s.last)))
            return { ok: false, status: 409, error: `#${n}'s head ${head.slice(0, 8)} is on ${o.branch} already, at or before the last commit checked: judged already` };
        if (list.some((x) => x.pr === n && x.head === head))
            return { ok: false, status: 409, error: `#${n} at ${head.slice(0, 8)} is accepted already` };
        a = { ...base, sha: null, pr: n, head };
    }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeGroupOnly(tmp, JSON.stringify([...list, a], null, 2));
    renameSync(tmp, file);
    return { ok: true, acceptance: a };
}
//# sourceMappingURL=main-watch.js.map