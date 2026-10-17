import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
import { type Role } from './dashboard-auth.js';
/** How the person came in: a hub session, the owner's break-glass on this machine, or a chat thread. */
export type Via = 'session' | 'break-glass' | 'discord';
export interface Answerer {
    login: string;
    role: Role;
    via: Via;
}
export type DecideResult = {
    ok: true;
    event: number;
    kind: string;
}
/** `by`/`answer`: on 409, who decided first and what. */
 | {
    ok: false;
    status: 400 | 403 | 404 | 409;
    error: string;
    by?: string;
    answer?: string;
};
/** Every write a person makes, recorded with who (login and role), how they came in, the instance and what was done. */
export declare function auditWrite(log: EventLog, who: Answerer, instance: string | null, action: string, detail: Record<string, unknown>): void;
/** The first recorded answer to a decision, if any. */
export declare function firstAnswer(log: EventLog, id: string): EventPayload<'decision.answered'> | null;
/**
 * Answer decision `id` with `answer` as `who`: refused unless they may answer its kind (mayAnswerKind) and the answer
 * is one of its options; refused with 409 (naming who decided) when it is answered already. Records
 * decision.answered and the audit entry together.
 */
export declare function answerDecision(log: EventLog, o: {
    id: string;
    answer: string;
    who: Answerer;
    instance: string | null;
    repo: string;
    voice?: boolean;
}): DecideResult;
/** The first owner approval of PR `number` at `head`, if any (merge.approved). */
export declare function mergeApproval(log: EventLog, number: number, head: string): EventPayload<'merge.approved'> | null;
/**
 * Record an owner's approval of a PR the merge policy left to them, at `head`: refused unless `who` is an owner
 * (admin on the repo); refused with 409, naming who, when it is approved at this head already. The approval and
 * its audit entry are written together. The merge itself is the merge flow's, on its next pass, with its own
 * checks (src/coordinator/merge-flow.ts): nothing here merges.
 */
export declare function approveMerge(log: EventLog, o: {
    issue: number;
    number: number;
    head: string;
    who: Answerer & {
        via: 'discord';
    };
    instance: string | null;
    repo: string;
}): DecideResult;
