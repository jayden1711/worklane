import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ChatAnswer, type ChatAnswerFile } from './chat.js';
import { type AttachmentCaps } from './chat-attachments.js';
import type { ChatPick } from './chat-pick.js';
import { type Role, type RoleOf } from './dashboard-auth.js';
export interface ConversationRouteContext {
    stateDir: string;
    who: {
        login: string;
        role: Role;
    };
    /** People's roles on the instance (a shared Project needs its creator to be an owner still); absent: this machine's owner alone. */
    roleOf: RoleOf | undefined;
    /** The chat attachments' caps (src/chat-attachments.ts), for a message's files and a Project's. */
    caps: AttachmentCaps;
    readBody: (req: IncomingMessage) => Promise<unknown>;
    json: (res: ServerResponse, status: number, body: unknown) => void;
    audit: (action: string, detail: Record<string, unknown>) => void;
    /** As the single-shot chat: what this person may see of an answer (an owner whole; others without drafts or proposals). */
    answerFor: (f: ChatAnswerFile, owner: boolean) => ChatAnswerFile;
    /** Whether a turn's draft was filed, and its number. */
    filed: (id: string) => {
        number: number;
    } | null;
    /** The single-shot chat's own filing of a draft (owner only, checked again, once): the same confirm flow. */
    fileDraft: (id: string, answer: ChatAnswer | null) => Promise<{
        status: number;
        body: unknown;
    }>;
    /** The model and effort picker (src/chat-pick.ts): a message's pick checked for this person, or why not; null: no pick. */
    pick?: (raw: unknown) => {
        pick: ChatPick;
        picker: 'owner' | 'writer';
    } | {
        error: string;
    } | null;
}
/** Handles a conversations or Projects route; false for any other path. */
export declare function handleConversationRoute(req: IncomingMessage, res: ServerResponse, url: URL, c: ConversationRouteContext): Promise<boolean>;
