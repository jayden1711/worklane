import type { EventLog } from '../events/log.js';
import type { StoredEvent } from '../events/types.js';
export type AskKind = 'paste_secret' | 'approve_link' | 'question' | 'root_step';
export type Role = 'owner' | 'writer' | 'viewer';
export type AskStatus = 'open' | 'answered' | 'cancelled';
interface AskBase {
    /** The instance the ask is for. */
    instance: string;
    /** One line: what is needed. */
    title: string;
    /** Why, and what happens once it's answered. */
    detail: string;
}
/** What asks.create takes. */
export type AskInput = AskBase & ({
    kind: 'paste_secret';
    credential: string;
    where: string;
} | {
    kind: 'approve_link';
    url: string;
} | {
    kind: 'question';
    options: string[];
    writersMayAnswer?: boolean;
} | {
    kind: 'root_step';
    command: string;
    args: string[];
});
export interface AskAnswer {
    by: string;
    role: 'owner' | 'writer';
    /** paste_secret: 'stored'; approve_link: 'approved' | 'declined'; question: the option; root_step: 'ran' | 'failed' | 'declined'. */
    answer: string;
    /** What came of it (a root step's output; empty for a secret). */
    detail: string;
    at: string;
}
/** An ask as the console shows it. */
export type Ask = AskBase & {
    id: string;
    createdAt: string;
    createdBy: string;
    status: AskStatus;
    answer: AskAnswer | null;
    cancelled: {
        by: string;
        why: string;
        at: string;
    } | null;
} & ({
    kind: 'paste_secret';
    credential: string;
    where: string;
} | {
    kind: 'approve_link';
    url: string;
} | {
    kind: 'question';
    options: string[];
    writersMayAnswer: boolean;
} | {
    kind: 'root_step';
    command: string;
    args: string[];
    allowed: boolean;
    refusal: string | null;
});
export declare class AskError extends Error {
    readonly status: 400 | 403 | 404 | 409;
    constructor(message: string, status?: 400 | 403 | 404 | 409);
}
export declare const ASK_EVENTS: readonly ["ask.created", "ask.answered", "ask.cancelled"];
export declare const CREDENTIAL_NAME: RegExp;
/** The asks in these events, oldest first, each with its status. */
export declare function asksFrom(events: readonly StoredEvent[]): Ask[];
/** Whether someone in this role may answer this ask: the owner any; a writer only a question that allows it; a viewer none. */
export declare function mayAnswerAsk(ask: Pick<Ask, 'kind'> & {
    writersMayAnswer?: boolean;
}, role: Role | null): boolean;
/**
 * Record an answer, once: inside one write transaction, so of two answers at once exactly one lands (a
 * second gets 409). Checks who may answer. Exported for secrets.ts and root-steps' runner, which answer
 * their kinds only after doing the step; everything else answers through asks(log).answer.
 */
export declare function recordAnswer(log: EventLog, id: string, a: {
    by: string;
    role: Role | null;
    answer: string;
    detail?: string;
}, check?: (ask: Ask) => string | void): Ask;
export interface Asks {
    /** Record a new ask; `by` is what created it (the coordinator, a setup step). */
    create(input: AskInput, by?: string): Ask;
    /** Answer an approve_link (approved|declined), a question (one of its options) or decline a root step, once. */
    answer(id: string, a: {
        by: string;
        role: Role | null;
        answer: string;
    }): Ask;
    /** Withdraw an open ask. */
    cancel(id: string, by: string, why: string): Ask;
    get(id: string): Ask | null;
    list(filter?: {
        instance?: string;
        status?: AskStatus;
    }): Ask[];
}
/** The ask API over an instance's event log. */
export declare function asks(log: EventLog): Asks;
export {};
