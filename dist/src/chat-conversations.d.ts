import { chatTurn, CONVERSATION_ID, type ChatAnswer, type ChatRequest, type ChatTurnOptions } from './chat.js';
import { type AttachmentCaps, type AttachmentMeta, type AttachmentView } from './chat-attachments.js';
import { type RoleOf } from './dashboard-auth.js';
import type { ChatPick } from './chat-pick.js';
export { CONVERSATION_ID };
export declare const PROJECT_ID: RegExp;
export declare const MAX_TITLE = 200;
export declare const MAX_PROJECT_NAME = 100;
export declare const MAX_INSTRUCTIONS = 8000;
export declare const DEFAULT_TITLE = "New conversation";
/** How long a person's conversations and Projects are kept after they lose their role, before they are deleted. */
export declare const REMOVED_MEMBER_DAYS = 30;
/**
 * The context window a turn gets of its own conversation: the newest earlier turns, at most `turns` of them and
 * `chars` characters in all (each question and answer clipped to `perTurn` first). Older turns are left out, and
 * the prompt says how many.
 */
export declare const CONVERSATION_WINDOW: {
    turns: number;
    chars: number;
    perTurn: number;
};
/** A page of a list: this many by default, never more than the max. */
export declare const PAGE: {
    default: number;
    max: number;
};
export declare class ConversationError extends Error {
    readonly status: 400 | 403 | 404 | 409;
    constructor(status: 400 | 403 | 404 | 409, message: string);
}
export interface Conversation {
    v: 1;
    id: string;
    /** Who started it: the only person who may read or use it. */
    owner: string;
    title: string;
    project: string | null;
    createdAt: string;
    updatedAt: string;
}
export type TurnState = 'pending' | 'answered' | 'refused';
export interface ConversationTurn {
    v: 1;
    id: string;
    at: string;
    by: string;
    text: string;
    attachments: string[];
    state: TurnState;
    answer?: ChatAnswer;
    why?: string;
}
export interface Project {
    v: 1;
    id: string;
    owner: string;
    name: string;
    instructions: string;
    /** Attachment ids (src/chat-attachments.ts), its creator's own uploads. */
    files: string[];
    /** Shared by an owner with the instance's owners and writers; otherwise its creator's alone. */
    shared: boolean;
    createdAt: string;
    updatedAt: string;
}
/**
 * Whether a shared Project's creator is still an owner of the instance (sharing is an owner's act): when they are
 * not, their shared Projects are nobody else's from then on. Built per request by `sharers`.
 */
export type SharerCheck = (login: string) => boolean;
/** The attachments still there among these ids, as the browser sees them. */
export declare const attachmentViews: (stateDir: string, ids: string[]) => AttachmentView[];
export declare function readProject(stateDir: string, id: string): Project | null;
/**
 * Who may still share: the creators of shared Projects who are owners now, by `roleOf` (cached as every role is,
 * src/dashboard-auth.ts). Without a role lookup (this machine's own dashboard, its owner alone), everyone.
 */
export declare function sharers(stateDir: string, roleOf: RoleOf | undefined): Promise<SharerCheck>;
/** A Project this person may see and use, or a 404 (someone else's private one reads as not there). */
export declare function projectFor(stateDir: string, id: string, by: string, sharer: SharerCheck): Project;
/** A Project as the browser sees it: its files as attachment views (the ones still there). */
export declare const projectView: (stateDir: string, p: Project) => {
    files: AttachmentView[];
    v: 1;
    id: string;
    owner: string;
    name: string;
    instructions: string;
    /** Shared by an owner with the instance's owners and writers; otherwise its creator's alone. */
    shared: boolean;
    createdAt: string;
    updatedAt: string;
};
export declare function listProjects(stateDir: string, by: string, sharer: SharerCheck, o?: {
    cursor?: unknown;
    limit?: unknown;
}): {
    items: {
        id: string;
        name: string;
        owner: string;
        shared: boolean;
        files: number;
        updatedAt: string;
        mine: boolean;
    }[];
    next: string | null;
};
/** Every attachment id a Project holds: kept past the retention days (sweepAttachments). */
export declare function projectFileIds(stateDir: string): Set<string>;
/**
 * Whether this person may download an attachment: its uploader, or someone who can see a Project that holds it.
 * Anyone else (an owner included) can't, even knowing its id; a file in a conversation is its creator's own upload.
 */
export declare function mayDownload(stateDir: string, m: AttachmentMeta, by: string, sharer: SharerCheck): boolean;
/**
 * Whether this person may delete an attachment: its uploader, or the creator of a Project that holds it. Nobody
 * else, owners included, may delete a file in someone else's conversation or Project (the sweeps still run).
 */
export declare function mayRemove(stateDir: string, m: AttachmentMeta, by: string): boolean;
export interface ProjectInput {
    name?: unknown;
    instructions?: unknown;
    files?: unknown;
    shared?: unknown;
}
export declare function createProject(o: {
    stateDir: string;
    by: string;
    owner: boolean;
    input: ProjectInput;
    caps: AttachmentCaps;
    now?: Date;
}): Project;
/** Only its creator changes a Project; only an owner shares one (anyone may stop sharing their own). */
export declare function updateProject(o: {
    stateDir: string;
    id: string;
    by: string;
    owner: boolean;
    sharer: SharerCheck;
    input: ProjectInput;
    caps: AttachmentCaps;
    now?: Date;
}): Project;
/** Deleted outright, with its files. Conversations in it stay their creators', with no Project from then on. */
export declare function deleteProject(o: {
    stateDir: string;
    id: string;
    by: string;
    sharer: SharerCheck;
}): void;
export declare function readConversation(stateDir: string, id: string): Conversation | null;
/** This person's own conversation; anyone else's reads as not there at all. */
export declare function conversationFor(stateDir: string, id: string, by: string): Conversation;
export declare function createConversation(o: {
    stateDir: string;
    by: string;
    sharer: SharerCheck;
    title?: unknown;
    project?: unknown;
    now?: Date;
}): Conversation;
/** This person's conversations, the most recently active first; reads each one's meta, never its turns. */
export declare function listConversations(stateDir: string, by: string, sharer: SharerCheck, o?: {
    cursor?: unknown;
    limit?: unknown;
    project?: unknown;
}): {
    items: {
        id: string;
        title: string;
        project: string | null;
        updatedAt: string;
        createdAt: string;
    }[];
    next: string | null;
};
/** One conversation's turns, oldest first: read from its own directory only. */
export declare function conversationTurns(stateDir: string, id: string): ConversationTurn[];
/** A conversation as its creator opens it: the meta, its Project (when they may still see it) and every turn. */
export declare function openConversation(stateDir: string, id: string, by: string, sharer: SharerCheck): {
    conversation: {
        project: string | null;
        v: 1;
        id: string;
        /** Who started it: the only person who may read or use it. */
        owner: string;
        title: string;
        createdAt: string;
        updatedAt: string;
    };
    project: {
        id: string;
        name: string;
    } | null;
    turns: ConversationTurn[];
};
/** One turn of this person's conversation (for filing its draft), or a 404. */
export declare function turnFor(stateDir: string, id: string, turn: string, by: string): ConversationTurn;
/** Rename, or move into (or out of) a Project this person may use. */
export declare function updateConversation(o: {
    stateDir: string;
    id: string;
    by: string;
    sharer: SharerCheck;
    title?: unknown;
    project?: unknown;
    now?: Date;
}): Conversation;
/**
 * Delete a conversation outright. Nothing of it is in the event log to begin with: events and the audit carry its
 * id only.
 */
export declare function deleteConversation(o: {
    stateDir: string;
    id: string;
    by: string;
}): void;
/**
 * Ask in a conversation: the turn is written pending in the conversation, and a request (ids only, plus the
 * question the coordinator needs) goes to the same queue the single-shot chat uses. Attachments are the asker's
 * own uploads, within the per-message caps. With a `key`, a retried ask returns the first one's id.
 */
export declare function askInConversation(o: {
    stateDir: string;
    id: string;
    by: string;
    text: unknown;
    attachments?: unknown;
    key?: unknown;
    pick?: ChatPick;
    picker?: 'owner' | 'writer';
    caps: AttachmentCaps;
    now?: Date;
}): {
    id: string;
};
/** The earlier turns a new turn gets: the newest that fit the window, oldest first, and how many were left out. */
export declare function conversationWindow(turns: ConversationTurn[], w?: {
    turns: number;
    chars: number;
    perTurn: number;
}): {
    kept: {
        n: number;
        turn: ConversationTurn;
        q: string;
        a: string;
    }[];
    omitted: number;
};
/**
 * The data block a conversation turn's prompt carries: the earlier turns in the window and the Project's
 * instructions, each between markers with this turn's random nonce (as chat attachments are framed), and how the
 * turn's attachments are split between the message's and the Project's. All of it is marked as data: the people who
 * wrote it can't change the chat's rules with it.
 */
export declare function conversationContext(o: {
    turns: ConversationTurn[];
    project: Project | null;
    messageFiles: number;
    projectFiles: number;
    nonce?: string;
    window?: typeof CONVERSATION_WINDOW;
}): string;
/** Thrown when a conversation turn can't run: its conversation is gone, isn't the asker's, or the asker lost access. */
export declare class ConversationGone extends Error {
}
/**
 * Answer one conversation turn: the conversation's earlier turns (in the window) and its Project's instructions as
 * fenced data, this message's files and the Project's as attachments, through the single-shot chat's own turn
 * (chatTurn: same tools, same read-only rule, same drafts and proposals). Its bundle and run record are removed once
 * it ends. `roleOf`: the asker must still be an owner or a writer, and a shared Project's creator still an owner.
 */
export declare function conversationTurn(o: Omit<ChatTurnOptions, 'conversation' | 'onRun' | 'attachments'> & {
    request: ChatRequest;
    roleOf?: RoleOf;
    turn?: typeof chatTurn;
}): Promise<ChatAnswer>;
/**
 * The coordinator's answer (or refusal) for a conversation turn, into the turn's own file; nothing when the
 * conversation was deleted meanwhile (and if it is deleted while this writes, what was written goes with it).
 */
export declare function writeConversationAnswer(stateDir: string, cid: string, id: string, a: {
    answer: ChatAnswer;
} | {
    refused: string;
}, now?: Date): boolean;
/**
 * At start-up: a conversation turn cut off by a restart (its request was taken, the turn still pending) is refused
 * once, never run again. Returns the turn ids refused.
 */
export declare function refuseInterruptedTurns(stateDir: string, now?: Date): string[];
/**
 * The hourly sweep (run by the coordinator): a person with conversations or Projects here who is no longer an owner
 * or a writer is noted with the time first seen so, and everything of theirs is deleted once that is
 * REMOVED_MEMBER_DAYS old; a role given back before then clears the note. If the instance's default owner doesn't
 * read as an owner, the role lookup can't be trusted (GitHub down, a broken token) and nothing is noted or deleted.
 */
export declare function sweepRemovedMembers(o: {
    stateDir: string;
    roleOf: RoleOf;
    defaultOwner: string;
    now?: Date;
}): Promise<{
    noted: string[];
    deleted: string[];
}>;
