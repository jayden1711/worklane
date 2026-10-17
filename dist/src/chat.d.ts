import type { Config } from './config/load.js';
import type { StoredEvent } from './events/types.js';
import { type RunSummary } from './run-record.js';
import type { AgentRunner } from './runner.js';
import { type ChatEffort, type ChatPick } from './chat-pick.js';
export declare const CHAT_HISTORY: string;
/** The only tools a chat run has: reading files. No shell, no network, no writes. */
export declare const CHAT_TOOLS: string[];
export interface ChatIssue {
    number: number;
    title: string;
    status: string;
    labels: string[];
}
export interface ChatPr {
    number: number;
    issue: number | null;
    title: string;
    state: string;
    url: string;
}
export interface OpenDecision {
    id: string;
    question: string;
    options: string[];
}
/** What one instance's bundle is built from. */
export interface ChatContext {
    instance: string;
    repo: string;
    events: StoredEvent[];
    runs: RunSummary[];
    health: unknown;
    issues: ChatIssue[];
    prs: ChatPr[];
    decisions: OpenDecision[];
}
/** The newest run records' summaries, oldest first (what the chat's runs file lists). */
export declare function recentRuns(stateDir: string, n?: number): RunSummary[];
/** Open issues, PRs and decisions from the event log, for a context. */
export declare function contextFromEvents(events: StoredEvent[]): Pick<ChatContext, 'issues' | 'prs' | 'decisions'>;
/**
 * The bundle files for one context: what the chat may know, nothing else. Each line carries the id the answer
 * cites. Everything is redacted again by writeBundle; nothing here comes from credentials or config files.
 */
export declare function bundleFiles(c: ChatContext, prefix?: string): Record<string, string>;
export interface Citation {
    kind: 'event' | 'run' | 'pr' | 'issue';
    id: string;
    instance: string;
    label: string;
    /** GitHub for pull requests and issues; dashboard-relative for events and runs. */
    href: string;
}
export type ActionRef = {
    kind: 'settings';
    key: string;
    value: unknown;
    confirm: 'settings.change';
    why?: string;
} | {
    kind: 'decision';
    id: string;
    answer: string;
    confirm: 'decision.answer';
    why?: string;
} | {
    kind: 'pause' | 'resume';
    confirm: 'emergency.pause' | 'emergency.resume';
    why?: string;
};
export type IssueDraft = {
    ok: true;
    title: string;
    body: string;
    labels: ['ready'];
} | {
    ok: false;
    title: string;
    body: string;
    why: string;
};
export interface ChatAnswer {
    turn: string;
    instance: string;
    answer: string;
    citations: Citation[];
    /** Citations that matched nothing in the context: left out. */
    unknownCitations: string[];
    /** A preview for the owner to confirm before it's filed with `ready`; never filed here. */
    issueDraft: IssueDraft | null;
    /** Proposals as references to confirm flows; the dashboard asks the owner for each. */
    actions: ActionRef[];
    refusedActions: string[];
    /** Not the owner: no drafts and no proposals. */
    readOnly: boolean;
    costUsd: number;
    /** What the answer ran on (src/chat-pick.ts), and its conversation's spend after it against the cap. */
    model?: string;
    effort?: ChatEffort;
    conversation?: {
        id: string;
        spentUsd: number;
        capUsd: number;
    };
}
/** A draft issue the harness can check: the five parts, checked by the contract parser (checkDraftedIssue). */
export declare function validateDraft(title: string, body: string): IssueDraft;
/** The last turns of this instance's chat, for the next prompt. */
export declare function chatHistory(stateDir: string, turns?: number): {
    at: string;
    by: string;
    question: string;
    answer: string;
}[];
export interface ChatTurnOptions {
    cfg: Config;
    context: ChatContext;
    question: string;
    by: string;
    runner: AgentRunner;
    /** The instance's state dir: history lives here (the agent can't read it). */
    stateDir: string;
    /** Where bundles go (agents' group readable), and that group. */
    bundleRoot: string;
    gid: number;
    /** The repository the chat may read. */
    repo: string;
    /** What's left of today's budget: the turn's cap is at most this. */
    remainingUsd: number;
    /** Attachment ids on the question (src/chat-attachments.ts): read from the instance's state, given as data. */
    attachments?: string[];
    /** The answer's model, effort and cap, from chatRunOptions (src/chat-pick.ts); unset: chief_of_staff's model and remainingUsd. */
    run?: {
        model: string;
        effort?: ChatEffort;
        maxBudgetUsd: number;
    };
    /** Records the turn's cost (the coordinator emits run.cost with role chat). */
    onCost?: (r: {
        costUsd: number;
        model: string;
        turns: number;
    }) => void;
    /**
     * A turn in a conversation (src/chat-conversations.ts): its data block (the earlier turns in the window and the
     * Project's instructions, between random-nonce markers), in the prompt, never the system prompt. Such a turn
     * neither reads nor writes the single-shot chat's summary and history: its memory is its own thread.
     */
    conversation?: string;
    /** The run's record id, once the runner has one (a conversation removes its turns' run records). */
    onRun?: (runId: string) => void;
    now?: () => Date;
}
/** One chat turn for one instance. */
export declare function chatTurn(o: ChatTurnOptions): Promise<ChatAnswer>;
export declare class ChatError extends Error {
}
export declare const MAX_QUESTION = 4000;
export declare const CHAT_ID: RegExp;
/** A conversation's id (src/chat-conversations.ts). */
export declare const CONVERSATION_ID: RegExp;
export interface ChatRequest {
    v: 1;
    id: string;
    at: string;
    by: string;
    question: string;
    /** Attachment ids (src/chat-attachments.ts), checked by the dashboard when asked. */
    attachments?: string[];
    /** The picker's choice (src/chat-pick.ts), and the role the dashboard read for the asker; checked again before the turn. */
    pick?: ChatPick;
    picker?: 'owner' | 'writer';
    /**
     * A turn in this conversation (src/chat-conversations.ts): answered into the conversation, not chat/answers. Written
     * only by askInConversation, after checking the conversation is the asker's; its spend counts against it (unset:
     * MAIN_CONVERSATION, the single-shot stream).
     */
    conversation?: string;
}
export type ChatAnswerFile = {
    v: 1;
    id: string;
    at: string;
} & ({
    state: 'pending';
} | {
    state: 'answered';
    answer: ChatAnswer;
} | {
    state: 'refused';
    why: string;
});
export declare const chatDirs: (stateDir: string) => {
    requests: string;
    answers: string;
    keys: string;
};
export declare function writeJson(dir: string, id: string, v: unknown): void;
/** A pick's shape (which models a person may pick is chatRunOptions'): a model name and a listed effort; null when it isn't one. */
export declare function cleanPick(p: unknown): ChatPick | null;
/** A client's request key: the same (asker, key) is one question, however often it is sent. */
export declare const CHAT_KEY: RegExp;
/**
 * Ask the chat (anyone with dashboard access; only the owner gets drafts and proposals). Returns the request id.
 * With a `key`, a retried or double-submitted ask returns the first one's id and runs no second turn.
 */
export declare function askChat(o: {
    stateDir: string;
    question: string;
    by: string;
    key?: string;
    attachments?: string[];
    pick?: ChatPick;
    picker?: 'owner' | 'writer';
    now?: Date;
}): {
    id: string;
};
/**
 * At start-up: a question whose turn was cut off by a restart (its request was taken, its answer still pending) is
 * refused once, never run again. Returns the ids refused.
 */
export declare function refuseInterruptedChats(stateDir: string, now?: Date): string[];
/** The answer file for a request (pending until the coordinator has run the turn), or null. */
export declare function chatAnswer(stateDir: string, id: string): ChatAnswerFile | null;
/** The coordinator's side: requests waiting, oldest first; each removed as it's taken (a malformed one too). */
export declare function takeChatRequests(stateDir: string): ChatRequest[];
/** The coordinator's side: the answer (or refusal) where the dashboard reads it. */
export declare function writeChatAnswer(stateDir: string, id: string, a: {
    answer: ChatAnswer;
} | {
    refused: string;
}, now?: Date): void;
/** A hub question: one turn per selected instance, each from its own bundle, as its own agent user. */
export declare function hubChat(question: string, by: string, instances: Omit<ChatTurnOptions, 'question' | 'by'>[]): Promise<ChatAnswer[]>;
