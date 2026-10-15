import { type Role, type RoleOf } from '../dashboard-auth.js';
import { type Ask } from '../console/asks.js';
import type { IntakeConfig } from './report.js';
export interface ChatPerson {
    /** The Discord user id. */
    id: string;
    /** The GitHub login it stands for. */
    login: string;
    /** Their role on the instance's repo now (null: no access, or the lookup failed: fail closed). */
    role: Role | null;
}
/** The GitHub login a Discord user stands for, or null when they aren't both allowed and mapped. */
export declare function loginOf(cfg: IntakeConfig, discordId: string): string | null;
/** The person behind a Discord user id, with their repo role; null when unmapped (ignored). */
export declare function personOf(cfg: IntakeConfig, discordId: string, roleOf: RoleOf | undefined): Promise<ChatPerson | null>;
/**
 * Decision kinds no ordinary chat reply ever answers: high-risk (L3) merges. Only an owner listed in discord.owners
 * approves one from a thread, naming its number (mayApproveHighRisk; src/coordinator/channel.ts).
 */
export declare const NEVER_FROM_CHAT: ReadonlySet<string>;
/**
 * THE rule for answering a decision from a chat thread: the dashboard's own (mayAnswerKind: an admin answers owner
 * decisions, a writer the rest), except the kinds that never come from chat. Anyone else's reply is a comment.
 */
export declare function mayAnswerFromChat(kind: string, role: Role | null): boolean;
/**
 * THE rule for a high-risk (L3) approval from a thread, and for a setup step's one-time link: the sender is in
 * intake.yaml discord.owners AND their mapped login is an admin on the repo now. A mapped writer, a mapped admin
 * who isn't listed, or anyone else: never (their reply is a comment).
 */
export declare function mayApproveHighRisk(cfg: IntakeConfig, discordId: string, role: Role | null): boolean;
/** Setup-console asks a thread reply may answer: questions and approval links, by the console's own rule. */
export declare function mayAnswerAskFromChat(ask: Pick<Ask, 'kind'> & {
    writersMayAnswer?: boolean;
}, role: Role | null): boolean;
/** Who may add an idea (open a conversation): an admin or a writer. A viewer's or an unmapped person's never opens one. */
export declare const mayAddIdea: (role: Role | null) => boolean;
/**
 * THE rule for filing an idea `ready` by a yes: the person who posted it (an admin or a writer), or any admin. A
 * viewer's yes, another writer's, or an unmapped person's files nothing.
 */
export declare const mayFileReady: (role: Role | null, isPoster: boolean) => boolean;
