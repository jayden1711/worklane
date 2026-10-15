import { mayAnswerKind, OWNER_DECISIONS } from './dashboard-auth.js';
import { BY_VOICE, voiceExclusion } from './voice.js';
/** Every write a person makes, recorded with who (login and role), how they came in, the instance and what was done. */
export function auditWrite(log, who, instance, action, detail) {
    log.append('dashboard.audit', { login: who.login, role: who.role, via: who.via, instance, action, detail }, who.login, 'human');
}
/** The first recorded answer to a decision, if any. */
export function firstAnswer(log, id) {
    return (log.read(0, ['decision.answered']).map((e) => e.payload).find((a) => a.id === id) ?? null);
}
/**
 * Answer decision `id` with `answer` as `who`: refused unless they may answer its kind (mayAnswerKind) and the answer
 * is one of its options; refused with 409 (naming who decided) when it is answered already. Records
 * decision.answered and the audit entry together.
 */
export function answerDecision(log, o) {
    const { who } = o;
    log.db.exec('BEGIN IMMEDIATE');
    try {
        const q = log.read(0, ['decision.asked']).find((e) => e.payload.id === o.id)?.payload;
        const refuse = (status, error, extra = {}) => {
            log.db.exec('ROLLBACK');
            return { ok: false, status, error, ...extra };
        };
        if (!q)
            return refuse(404, `no decision ${o.id}`);
        if (!mayAnswerKind(q.kind, who.role)) {
            return refuse(403, OWNER_DECISIONS.has(q.kind) ? `@${who.login} can't answer this: a ${q.kind === 'plan' ? 'held plan' : 'high-risk merge'} is for the instance's owners (admin on ${o.repo}); @${who.login} is a ${who.role}` : `@${who.login} can't answer this: the owners and writers of ${o.repo} answer it; @${who.login} is a ${who.role}`);
        }
        if (!o.answer || !q.options.includes(o.answer))
            return refuse(400, `answer must be one of ${q.options.join(', ')}`);
        // By voice (src/voice.ts): an owner's approval only, and never of what voice may not approve. Checked here, on the
        // decision as recorded, so no route and no client can answer one by voice that the rule refuses.
        if (o.voice) {
            if (who.role !== 'owner')
                return refuse(403, `@${who.login} can't approve by voice: voice approvals are the instance's owners' only (admin on ${o.repo})`);
            if (o.answer !== 'approve')
                return refuse(400, 'by voice, a decision can only be approved; answer it otherwise with a click');
            const never = voiceExclusion(q, log.read(0, ['plan.posted']).map((e) => e.payload));
            if (never)
                return refuse(403, `not approvable by voice: ${never}`);
        }
        const first = firstAnswer(log, o.id);
        if (first)
            return refuse(409, `already answered by @${first.by} (${first.answer})`, { by: first.by, answer: first.answer });
        // With the role this server read, so the coordinator acts on a writer's answer (an intake approval) too.
        const e = log.append('decision.answered', { id: o.id, by: who.login, answer: o.answer, role: who.role === 'owner' ? 'owner' : 'writer' }, who.login, 'human');
        auditWrite(log, who, o.instance, 'decision.answered', { id: o.id, kind: q.kind, answer: o.answer, ...(o.voice ? { by: BY_VOICE } : {}) });
        log.db.exec('COMMIT');
        return { ok: true, event: e.id, kind: q.kind };
    }
    catch (e) {
        try {
            log.db.exec('ROLLBACK');
        }
        catch {
            // already rolled back
        }
        throw e;
    }
}
/** The first owner approval of PR `number` at `head`, if any (merge.approved). */
export function mergeApproval(log, number, head) {
    return log.read(0, ['merge.approved']).map((e) => e.payload).find((a) => a.number === number && a.head === head) ?? null;
}
/**
 * Record an owner's approval of a PR the merge policy left to them, at `head`: refused unless `who` is an owner
 * (admin on the repo); refused with 409, naming who, when it is approved at this head already. The approval and
 * its audit entry are written together. The merge itself is the merge flow's, on its next pass, with its own
 * checks (src/coordinator/merge-flow.ts): nothing here merges.
 */
export function approveMerge(log, o) {
    const { who } = o;
    if (who.role !== 'owner')
        return { ok: false, status: 403, error: `@${who.login} can't approve this: a high-risk merge is for the instance's owners (admin on ${o.repo}); @${who.login} is a ${who.role}` };
    log.db.exec('BEGIN IMMEDIATE');
    try {
        const first = mergeApproval(log, o.number, o.head);
        if (first) {
            log.db.exec('ROLLBACK');
            return { ok: false, status: 409, error: `already approved by @${first.by}`, by: first.by, answer: 'approve' };
        }
        const e = log.append('merge.approved', { issue: o.issue, number: o.number, head: o.head, by: who.login, via: who.via }, who.login, 'human');
        auditWrite(log, who, o.instance, 'merge.approved', { number: o.number, head: o.head });
        log.db.exec('COMMIT');
        return { ok: true, event: e.id, kind: 'merge' };
    }
    catch (e) {
        try {
            log.db.exec('ROLLBACK');
        }
        catch {
            // already rolled back
        }
        throw e;
    }
}
//# sourceMappingURL=decide.js.map