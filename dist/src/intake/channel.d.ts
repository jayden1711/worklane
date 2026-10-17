import type { Ask } from '../console/asks.js';
import type { EventPayload } from '../events/types.js';
import { type UsagePause } from '../usage-limit.js';
/** A post: a thread of its own (answered in it), or a notice in the channel that nothing answers. */
export type ChannelPost = {
    kind: 'thread';
    name: string;
    text: string;
} | {
    kind: 'notice';
    text: string;
    mentions?: string[];
};
/**
 * The usage-limit pause's notice, once per pause: when it resets (and whether claude said so or it's the default
 * wait), that the task was requeued, and the dashboard's Overview, where the pause counts down. No thread: nothing
 * in chat ends it; it ends on its own.
 */
export declare function usagePausePost(p: Pick<UsagePause, 'resetAt' | 'source' | 'issue'>, o: {
    dashboardUrl: string;
    instance: string;
    now: number;
}): ChannelPost;
/**
 * The main watch's alert: a notice, no thread (nothing in chat resumes auto-merge; an admin does on the dashboard).
 * The commit's link, why it is unaccounted (redacted), and the revert PR's link: no secrets, nobody's credentials.
 */
export declare function mainWatchPost(u: Pick<EventPayload<'main_watch.unaccounted'>, 'sha' | 'url' | 'reason' | 'revert'>, o: {
    dashboardUrl: string;
}): ChannelPost;
/**
 * What a decision posts. A high-risk merge: with Discord owners (`owners`), a thread they approve in by its number;
 * without, only a notice with links. Never its options as answerable by anyone else.
 */
export declare function decisionPost(q: Pick<EventPayload<'decision.asked'>, 'id' | 'kind' | 'issue' | 'question' | 'options' | 'recommendation'> & {
    receipts?: string[];
}, o: {
    dashboardUrl: string;
    repo: string;
    owners?: boolean;
}): ChannelPost;
/**
 * A PR the merge policy left to an owner (merge.decided auto false), with Discord owners: a thread they approve the
 * merge in by its number. Its reasons are redacted and cut first.
 */
export declare function mergePost(p: {
    number: number;
    issue: number;
    head: string;
    url: string;
    reasons: string[];
}, o: {
    dashboardUrl: string;
}): ChannelPost;
/**
 * What a setup-console ask posts. A secret or a root step: only a link to the console, nothing of the ask; with
 * Discord owners (`owners`), in a thread where one of them may ask for a one-time link by DM.
 */
export declare function askPost(a: Ask, o: {
    dashboardUrl: string;
    owners?: boolean;
}): ChannelPost;
/**
 * The option a reply chooses, or why it chooses none. A reply chooses an option only when its first word is that
 * option (case aside, `/cli` or punctuation around it allowed) and it names no other option anywhere: "approve" or
 * "Approve, looks good" choose approve; "approve or reject?", "yes" or "I wouldn't approve" choose nothing.
 * On a held plan (`plan`: its issue's number), "approve plan <n>" is the same as "approve" when n is that number,
 * and chooses nothing (`wrongNumber`) when it names another.
 */
export declare function parseChoice(text: string, options: string[], o?: {
    plan?: number;
}): {
    answer: string;
} | {
    ambiguous: true;
    wrongNumber?: number;
};
/** The ask-back for a reply that chose nothing: the exact options. */
export declare const askBack: (options: string[]) => string;
/** The thread's word that it is decided, and by whom. */
export declare const decidedText: (answer: string, by: string) => string;
/** A later answer to something decided already: refused, naming who decided. */
export declare const alreadyText: (answer: string, by: string) => string;
/**
 * A reply in a high-risk thread: "approve <number>" or "reject <number>" ("#" and "PR" allowed before the number;
 * a bare "reject" too), or nothing. A plain "approve" names no number and approves nothing.
 */
export declare function parseHighRisk(text: string): {
    act: 'approve' | 'reject';
    number: number | null;
} | null;
/** The ask-back for a high-risk reply that names no number, or isn't an approval. */
export declare const highRiskAskBack: (n: number, reject: boolean) => string;
/** A high-risk approval naming another number. */
export declare const wrongNumberText: (n: number, said: number) => string;
/** A high-risk thread's word that it is approved, by whom: the other owners are pinged on it. */
export declare const approvedText: (n: number, by: string, merge: boolean) => string;
/** Someone who may not approve a high-risk merge: their reply is a comment. */
export declare const notOwnerText: (login: string) => string;
/** A setup step's thread: what a reply other than "link" gets. Nothing typed there is kept. */
export declare const SETUP_THREAD_TEXT = "Reply \"link\" for a one-time link to this step on the dashboard, by DM. Never paste a secret here: nothing typed in this thread is kept or used.";
/** A setup step's thread: someone who may not ask for its link. */
export declare const SETUP_NOT_OWNER_TEXT = "Only an owner listed for Discord approvals can ask for this step's link. Nothing typed in this thread is kept or used.";
/** Is this reply a request for the step's link? */
export declare const asksForLink: (text: string) => boolean;
/**
 * The DM with a setup step's one-time link: the step's title (redacted, one line) and the link, nothing else of the
 * ask. The token is in the link's path, never its query.
 */
export declare function dmText(o: {
    title: string;
    login: string;
    url: string;
    minutes: number;
}): string;
/** A reply from someone who may not answer this: kept as a comment. */
export declare const commentText: (login: string, who: string) => string;
/**
 * What a reply to a shown draft says: an explicit yes ("yes", "yes, file it"); a no ("no", "cancel", "drop it");
 * something vague that might mean yes ("ok", "sure", "sounds good", "lgtm", a thumbs-up), which files nothing and
 * is asked back; or anything else, which is a change to the draft.
 */
export declare function readConfirm(text: string): 'yes' | 'no' | 'vague' | 'change';
export declare const CONFIRM_TEXT = "Reply **yes** to file it as ready, **no** to drop it, or tell me what to change.";
export declare const VAGUE_TEXT = "I need an explicit yes before I file anything. Reply **yes** to file it as ready, **no** to drop it, or tell me what to change.";
/** The most messages a draft is shown in; past that it is cut, with the rest left to the issue. */
export declare const DRAFT_MESSAGES = 8;
/** A draft as thread messages, each at most REPLY_CHARS, cut on line breaks, ending with how to confirm. */
export declare function draftPosts(draft: {
    title: string;
    body: string;
}): string[];
/**
 * The bot's questions as a person gets them: the triage run's reply, at most REPLY_CHARS, with no link or mention
 * (it was written from people's text); anything else gets the fixed question.
 */
export declare function questionText(reply: string | undefined, fallback: string): string;
export type IdeaStage = 'planned' | 'pr' | 'merged' | 'live';
/** A progress post in the idea's thread. */
export declare function progressText(stage: IdeaStage, o: {
    issue: number;
    repo: string;
    held?: boolean;
    prUrl?: string;
    env?: string;
}): string;
