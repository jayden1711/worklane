// One answer to a decision, wherever it comes from: the dashboard's decide route and a reply in a chat thread
// (src/intake/channel.ts) both answer through answerDecision, so the checks (who may answer which kind, the
// options), the record (decision.answered, with the role read from the repo) and the audit are one code path.
// The first recorded answer stands: the check and the write share one write transaction, so of two answers at
// once exactly one lands, and the other is told who decided. Nothing overwrites an answer.
import { loadConfigAt } from './config/load.js';
import { configTree } from './config/live.js';
import type { ReviewConfig } from './config/schema.js';
import type { EventLog } from './events/log.js';
import type { EventPayload } from './events/types.js';
import { mayAnswerKind, OWNER_DECISIONS, type Role } from './dashboard-auth.js';
import { BY_VOICE, voiceExclusion } from './voice.js';

/** How the person came in: a hub session, the owner's break-glass on this machine, a chat thread, or the CLI as root or the coordinator user. */
export type Via = 'session' | 'break-glass' | 'discord' | 'cli';

const approvalsRead = new Map<string, { tree: string; approvals: ReviewConfig['approvals'] }>();

/**
 * Who may approve a high-risk merge (review.yaml `approvals`) as the default branch says it: read at `ref` in `repo`
 * with git, never from a working tree, as the coordinator's live config is (#715). Missing, invalid or unreadable:
 * undefined, so it is the owners' alone (fail closed). Read again only when the config's tree there changes.
 * `rootLetsWriters`: an instance's policy.yaml writers_approve_land (a loosening is root's: without it, as the
 * coordinator refuses such a config, writers are never let in); a local site, which has no policy, passes true.
 */
export function approvalsAt(repo: string, ref: string, rootLetsWriters: boolean): ReviewConfig['approvals'] {
  const tree = configTree(repo, ref);
  if (tree === null) return undefined;
  let hit = approvalsRead.get(repo);
  if (hit?.tree !== tree) {
    let approvals: ReviewConfig['approvals'];
    try {
      approvals = loadConfigAt(repo, ref).review?.approvals;
    } catch {
      approvals = undefined;
    }
    hit = { tree, approvals };
    approvalsRead.set(repo, hit);
  }
  return hit.approvals?.land === 'writers' && !rootLetsWriters ? undefined : hit.approvals;
}

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
 * Answer decision `id` with `answer` as `who`: refused unless they may answer its kind (mayAnswerKind, with
 * `approvals` as the default branch's review.yaml says; absent, a high-risk merge is the owners' alone) and the answer
 * is one of its options; refused with 409 (naming who decided) when it is answered already. Records
 * decision.answered and the audit entry together (`audit`: more for the audit entry, such as the CLI's OS user).
 */
export function answerDecision(log: EventLog, o: { id: string; answer: string; who: Answerer; instance: string | null; repo: string; voice?: boolean; approvals?: ReviewConfig['approvals']; audit?: Record<string, unknown> }): DecideResult {
  const { who } = o;
  log.db.exec('BEGIN IMMEDIATE');
  try {
    const q = log.read(0, ['decision.asked']).find((e) => (e.payload as { id: string }).id === o.id)?.payload as EventPayload<'decision.asked'> | undefined;
    const refuse = (status: 400 | 403 | 404 | 409, error: string, extra: { by?: string; answer?: string } = {}): DecideResult => {
      log.db.exec('ROLLBACK');
      return { ok: false, status, error, ...extra };
    };
    if (!q) return refuse(404, `no decision ${o.id}`);
    if (!mayAnswerKind(q.kind, who.role, o.approvals)) {
      return refuse(403, OWNER_DECISIONS.has(q.kind) ? `@${who.login} can't answer this: ${q.kind === 'plan' ? 'a held plan' : q.kind === 'automation' ? "an automation's run" : 'a high-risk merge'} is for the instance's owners (admin on ${o.repo}); @${who.login} is a ${who.role}` : `@${who.login} can't answer this: the owners and writers of ${o.repo} answer it; @${who.login} is a ${who.role}`);
    }
    if (!o.answer || !q.options.includes(o.answer)) return refuse(400, `answer must be one of ${q.options.join(', ')}`);
    // By voice (src/voice.ts): an owner's approval only, and never of what voice may not approve. Checked here, on the
    // decision as recorded, so no route and no client can answer one by voice that the rule refuses.
    if (o.voice) {
      if (who.role !== 'owner') return refuse(403, `@${who.login} can't approve by voice: voice approvals are the instance's owners' only (admin on ${o.repo})`);
      if (o.answer !== 'approve') return refuse(400, 'by voice, a decision can only be approved; answer it otherwise with a click');
      const never = voiceExclusion(q, log.read(0, ['plan.posted']).map((e) => e.payload as EventPayload<'plan.posted'>));
      if (never) return refuse(403, `not approvable by voice: ${never}`);
    }
    const first = firstAnswer(log, o.id);
    if (first) return refuse(409, `already answered by @${first.by} (${first.answer})`, { by: first.by, answer: first.answer });
    // With the role this server read, so the coordinator acts on a writer's answer (an intake approval) too.
    const e = log.append('decision.answered', { id: o.id, by: who.login, answer: o.answer, role: who.role === 'owner' ? 'owner' : 'writer' }, who.login, 'human');
    auditWrite(log, who, o.instance, 'decision.answered', { ...o.audit, id: o.id, kind: q.kind, answer: o.answer, ...(o.voice ? { by: BY_VOICE } : {}) });
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

/** The first owner approval of PR `number` at `head`, if any (merge.approved). */
export function mergeApproval(log: EventLog, number: number, head: string): EventPayload<'merge.approved'> | null {
  return log.read(0, ['merge.approved']).map((e) => e.payload as EventPayload<'merge.approved'>).find((a) => a.number === number && a.head === head) ?? null;
}

/**
 * Record an owner's approval of a PR the merge policy left to them, at `head`: refused unless `who` is an owner
 * (admin on the repo); refused with 409, naming who, when it is approved at this head already. The approval and
 * its audit entry are written together. The merge itself is the merge flow's, on its next pass, with its own
 * checks (src/coordinator/merge-flow.ts): nothing here merges.
 */
export function approveMerge(log: EventLog, o: { issue: number; number: number; head: string; who: Answerer & { via: 'discord' }; instance: string | null; repo: string }): DecideResult {
  const { who } = o;
  // The one rule (mayAnswerKind), with no `approvals`: a merge approved from a chat thread stays the owners' alone,
  // whatever review.yaml says, as the thread's own gate (intake/people.ts mayApproveHighRisk) already holds it.
  if (!mayAnswerKind('land', who.role)) return { ok: false, status: 403, error: `@${who.login} can't approve this: a high-risk merge is for the instance's owners (admin on ${o.repo}); @${who.login} is a ${who.role}` };
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
  } catch (e) {
    try {
      log.db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw e;
  }
}

/** Who runs the CLI, as the OS says (never the environment): the user's name and uid, and whether it is root. */
export interface CliCaller {
  user: string;
  uid: number | null;
  root: boolean;
}

/**
 * Why `decide` from the CLI is refused to this caller, or null (#715). Only root, or the coordinator user (an
 * instance's own OS user, `coordinatorUser`; a local site's, the user whose event log it is, `logUid`), may answer,
 * and the answer is then recorded as the instance's owner's (cli.ts). Being able to write the event log isn't
 * enough: anyone else, an agent user included, is refused before anything is read or written.
 */
export function cliDecideRefusal(caller: CliCaller, o: { instance: string | null; coordinatorUser: string | null; logUid: number | null }): string | null {
  if (caller.root) return null;
  const who = caller.user || `uid ${caller.uid ?? 'unknown'}`;
  if (o.instance !== null) return caller.user !== '' && caller.user === o.coordinatorUser ? null : `only root or ${o.instance}'s coordinator user (${o.coordinatorUser}) may answer its decisions from the CLI, not ${who}`;
  return caller.uid !== null && caller.uid === o.logUid ? null : `only root or the user whose event log it is may answer its decisions from the CLI, not ${who}`;
}
