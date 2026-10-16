// Merge posts: every merge to the default branch, whoever made it (the harness, an owner, an agent through GitHub's UI
// or CLI), posted once to the Discord ops channel (intake.yaml discord.ops_channel; discord.post_merges, on by
// default). The post names the PR (linked), who merged it (a GitHub login, never an email), the merge commit's short
// sha, and the first line of the PR's intent: the first line of the body's first paragraph, redacted, at most
// INTENT_CHARS; the PR's title when the body has none. Nothing else of the body is ever posted.
//
// On the coordinator's timer, it walks each new commit on the default branch's first-parent line, oldest first, and
// asks GitHub which PR it is the merge commit of (GET /repos/{o}/{r}/commits/{sha}/pulls), then that PR for who merged
// it: at most one API call per MERGE_POSTS_CALL_MS. An answer with no merged PR is asked again until LINK_LAG_MS after
// the first (GitHub links a merge to its PR a few seconds after it lands: asked at once, a merge went unposted). A
// commit no merged PR has as its merge commit (a direct push, which the main watch alerts on; a commit inside a rebase
// merge, whose last commit is the one posted) gets no post here.
// The last commit walked, and what is known about the next, are kept in a state file in the instance's state dir, so a
// restart neither posts a merge twice nor skips one; each post is also sent once per key (merge-post:<sha>).
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { LINK_LAG_MS } from './main-watch.js';
import { writeGroupOnly } from './os/index.js';
/** At most one GitHub API call per this long. */
export const MERGE_POSTS_CALL_MS = 30_000;
/** The intent line is cut to this many characters. */
export const INTENT_CHARS = 200;
const EMPTY = { version: 1, last: null, lastCallAt: 0, pending: null };
export function readMergePostsState(file) {
    if (!existsSync(file))
        return { ...EMPTY };
    try {
        return { ...EMPTY, ...JSON.parse(readFileSync(file, 'utf8')) };
    }
    catch {
        return { ...EMPTY };
    }
}
function writeState(file, s) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeGroupOnly(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, file);
}
/** The key a merge's post is sent under, once. */
export const mergePostKey = (sha) => `merge-post:${sha}`;
/**
 * The PR's intent line: the first line of the body's first paragraph (HTML comments, as templates leave them, and a
 * heading's #s taken off), redacted by `redact`, then cut to INTENT_CHARS. The title when the body gives no line.
 */
export function intentLine(body, title, redact) {
    const text = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '');
    const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    const line = first.replace(/^#{1,6}\s+/, '').trim() || String(title ?? '').replace(/\s+/g, ' ').trim();
    const out = redact(line).replace(/\s+/g, ' ').trim();
    return out.length > INTENT_CHARS ? `${out.slice(0, INTENT_CHARS - 1)}…` : out;
}
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
/** The post for one merge. Only the login (when it is one), the number, the link, the short sha and the intent line. */
export function mergePostText(pr, sha, redact) {
    const by = pr.mergedBy && LOGIN.test(pr.mergedBy) ? `@${pr.mergedBy}` : 'an unknown account';
    const link = /^https:\/\/\S+$/.test(pr.url) ? `[#${pr.number}](<${pr.url}>)` : `#${pr.number}`;
    const intent = intentLine(pr.body, pr.title, redact).replace(/`/g, "'");
    return `**Merged** ${link} by ${by} (\`${sha.slice(0, 8)}\`): ${intent}`.slice(0, 1900);
}
export class MergePosts {
    d;
    listedAt = -Infinity;
    constructor(d) {
        this.d = d;
    }
    get now() {
        return this.d.now?.() ?? Date.now();
    }
    state() {
        return readMergePostsState(this.d.stateFile);
    }
    /** Turned off (or nowhere to post): forget the place, so turning it on starts from the tip, not a backlog. */
    off() {
        const s = this.state();
        if (s.last === null && s.pending === null)
            return;
        writeState(this.d.stateFile, { ...s, last: null, pending: null });
    }
    take(s) {
        if (this.now - s.lastCallAt < MERGE_POSTS_CALL_MS)
            return false;
        s.lastCallAt = this.now;
        writeState(this.d.stateFile, s);
        return true;
    }
    /** One pass: at most one API call, and at most one post. */
    async step() {
        const s = this.state();
        if (!s.pending) {
            // A fetch (git, not the API) at most as often as a call, too.
            if (this.now - this.listedAt < MERGE_POSTS_CALL_MS)
                return;
            this.listedAt = this.now;
            const tip = this.d.git.tip();
            if (!tip || tip === s.last)
                return;
            // First start, or the branch was rewritten (the main watch reports that): the tip is where posting starts.
            if (!s.last || !this.d.git.isAncestor(s.last, tip))
                return writeState(this.d.stateFile, { ...s, last: tip, pending: null });
            const next = this.d.git.firstParents(s.last, tip)[0];
            if (!next)
                return;
            s.pending = { sha: next };
            writeState(this.d.stateFile, s);
        }
        const p = s.pending;
        const linked = (l) => l.some((x) => x.mergedAt && x.base === this.d.branch);
        const lagging = () => !!p.pulls && !linked(p.pulls) && p.pullsAt !== undefined && (p.pullsLastAt ?? p.pullsAt) - p.pullsAt < LINK_LAG_MS;
        if (!p.pulls || lagging()) {
            if (!this.take(s))
                return;
            p.pulls = await this.d.api.commitPulls(p.sha);
            p.pullsAt ??= this.now;
            p.pullsLastAt = this.now;
            writeState(this.d.stateFile, s);
            if (lagging())
                return;
        }
        const cand = p.pulls.find((x) => x.mergedAt && x.base === this.d.branch && x.mergeCommit === p.sha);
        if (cand) {
            if (!p.pr || p.pr.number !== cand.number) {
                if (!this.take(s))
                    return;
                p.pr = await this.d.api.pull(cand.number);
                writeState(this.d.stateFile, s);
            }
            if ((await this.d.send(mergePostKey(p.sha), mergePostText(p.pr, p.sha, this.d.redact))) === 'limited')
                return;
        }
        // No merged PR has it as its merge commit: a direct push or a commit inside a rebase merge; not posted here.
        writeState(this.d.stateFile, { ...s, last: p.sha, pending: null });
    }
}
//# sourceMappingURL=merge-posts.js.map