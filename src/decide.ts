// One answer to a decision, wherever it comes from: the dashboard's decide route and a reply in a chat thread
// (src/intake/channel.ts) both answer through answerDecision, so the checks (who may answer which kind, the
// options), the record (decision.answered, with the role read from the repo) and the audit are one code path.
// The first recorded answer stands: the check and the write share one write transaction, so of two answers at
// once exactly one lands, and the other is told who decided. Nothing overwrites an answer.
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
import { mayAnswerKind, OWNER_DECISIONS, type Role } from './dashboard-auth.js';

/** How the person came in: a hub session, the owner's break-glass on this machine, or a chat thread. */
export type Via = 'session' | 'break-glass' | 'discord';

export interface Answerer {
  login: string;
  role: Role;
  via: Via;
}

export type DecideResult =
  | { ok: true; event: number; kind: string }
  /** `by`/`answer`: on 409, who decided first and what. */
  | { ok: false; status: 400 | 403 | 404 | 409; error: string; by?: string; answer?: string };

/** Every write a person makes, recorded with who (login and role), how they came in, the instance and what was done. */
export function auditWrite(log: EventLog, who: Answerer, instance: string | null, action: string, detail: Record<string, unknown>) {
  log.append('dashboard.audit', { login: who.login, role: who.role, via: who.via, instance, action, detail }, who.login, 'human');
}

/** The first recorded answer to a decision, if any. */
export function firstAnswer(log: EventLog, id: string): EventPayload<'decision.answered'> | null {
  return (log.read(0, ['decision.answered']).map((e) => e.payload as EventPayload<'decision.answered'>).find((a) => a.id === id) ?? null);
}

/**
 * Answer decision `id` with `answer` as `who`: refused unless they may answer its kind (mayAnswerKind) and the answer
 * is one of its options; refused with 409 (naming who decided) when it is answered already. Records
 * decision.answered and the audit entry together.
 */
export function answerDecision(log: EventLog, o: { id: string; answer: string; who: Answerer; instance: string | null; repo: string }): DecideResult {
  const { who } = o;
  log.db.exec('BEGIN IMMEDIATE');
  try {
    const q = log.read(0, ['decision.asked']).find((e) => (e.payload as { id: string }).id === o.id)?.payload as EventPayload<'decision.asked'> | undefined;
    const refuse = (status: 400 | 403 | 404 | 409, error: string, extra: { by?: string; answer?: string } = {}): DecideResult => {
      log.db.exec('ROLLBACK');
      return { ok: false, status, error, ...extra };
    };
    if (!q) return refuse(404, `no decision ${o.id}`);
    if (!mayAnswerKind(q.kind, who.role)) {
      return refuse(403, OWNER_DECISIONS.has(q.kind) ? `@${who.login} can't answer this: a ${q.kind === 'plan' ? 'held plan' : 'high-risk merge'} is for the instance's owners (admin on ${o.repo}); @${who.login} is a ${who.role}` : `@${who.login} can't answer this: the owners and writers of ${o.repo} answer it; @${who.login} is a ${who.role}`);
    }
    if (!o.answer || !q.options.includes(o.answer)) return refuse(400, `answer must be one of ${q.options.join(', ')}`);
    const first = firstAnswer(log, o.id);
    if (first) return refuse(409, `already answered by @${first.by} (${first.answer})`, { by: first.by, answer: first.answer });
    // With the role this server read, so the coordinator acts on a writer's answer (an intake approval) too.
    const e = log.append('decision.answered', { id: o.id, by: who.login, answer: o.answer, role: who.role === 'owner' ? 'owner' : 'writer' }, who.login, 'human');
    auditWrite(log, who, o.instance, 'decision.answered', { id: o.id, kind: q.kind, answer: o.answer });
    log.db.exec('COMMIT');
    return { ok: true, event: e.id, kind: q.kind };
  } catch (e) {
    try {
      log.db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw e;
  }
}
