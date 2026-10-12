// Asks: the one way the harness asks the owner for something it can't do itself, shown in the dashboard's
// setup console. An ask is an event (ask.created), answered at most once (ask.answered, with who answered and
// in what role) or withdrawn (ask.cancelled); its status is a fold over those events, like everything else.
//
//   const a = asks(log);
//   a.create({ kind: 'paste_secret', instance, title, detail, credential: 'intake-discord', where: 'credentials.yaml intake.discord_token' });
//   a.create({ kind: 'approve_link', instance, title, detail, url: 'https://github.com/settings/apps/new?...' });
//   a.create({ kind: 'question', instance, title, detail, options: ['yes', 'no'], writersMayAnswer: true });
//   a.create({ kind: 'root_step', instance, title, detail, command: 'set-slots', args: ['4'] });
//
// Kinds:
// - paste_secret: a credential's name and where it goes. The owner pastes the value in the console; it goes
//   straight to the credential store (secrets.ts) and never into an event, a response or a log.
// - approve_link: an https URL for the owner to open and approve (a GitHub App manifest or install link).
// - question: options, as in decisions; writers may answer one only when the ask says so.
// - root_step: one command of the machine helper with its arguments (root-steps.ts); one off its allowlist is
//   recorded, shown as needing the helper extended, and never run.
//
// Only the owner answers, except a question that allows writers. Viewers never answer.
import { randomBytes } from 'node:crypto';
import type { EventLog } from '../events/log.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { checkRootStep } from './root-steps.js';

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
export type AskInput = AskBase &
  (
    | { kind: 'paste_secret'; credential: string; where: string }
    | { kind: 'approve_link'; url: string }
    | { kind: 'question'; options: string[]; writersMayAnswer?: boolean }
    | { kind: 'root_step'; command: string; args: string[] }
  );

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
  cancelled: { by: string; why: string; at: string } | null;
} & (
    | { kind: 'paste_secret'; credential: string; where: string }
    | { kind: 'approve_link'; url: string }
    | { kind: 'question'; options: string[]; writersMayAnswer: boolean }
    | { kind: 'root_step'; command: string; args: string[]; allowed: boolean; refusal: string | null }
  );

export class AskError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export const ASK_EVENTS = ['ask.created', 'ask.answered', 'ask.cancelled'] as const;
export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_TITLE = 200;
const MAX_DETAIL = 4000;

/** The asks in these events, oldest first, each with its status. */
export function asksFrom(events: readonly StoredEvent[]): Ask[] {
  const byId = new Map<string, Ask>();
  for (const e of events) {
    if (e.type === 'ask.created') {
      const p = e.payload as EventPayload<'ask.created'>;
      const base = { id: p.id, instance: p.instance, title: p.title, detail: p.detail, createdAt: e.ts, createdBy: p.created_by, status: 'open' as AskStatus, answer: null, cancelled: null };
      const s = p.spec;
      let ask: Ask;
      if (s.kind === 'paste_secret') ask = { ...base, kind: s.kind, credential: s.credential, where: s.where };
      else if (s.kind === 'approve_link') ask = { ...base, kind: s.kind, url: s.url };
      else if (s.kind === 'question') ask = { ...base, kind: s.kind, options: s.options, writersMayAnswer: s.writers_may_answer };
      else {
        const c = checkRootStep(s.command, s.args);
        ask = { ...base, kind: s.kind, command: s.command, args: s.args, allowed: c.allowed, refusal: c.allowed ? null : c.why };
      }
      if (!byId.has(p.id)) byId.set(p.id, ask);
    } else if (e.type === 'ask.answered' || e.type === 'ask.cancelled') {
      const a = byId.get((e.payload as { id: string }).id);
      if (!a || a.status !== 'open') continue; // the first answer (or withdrawal) stands
      if (e.type === 'ask.answered') {
        const p = e.payload as EventPayload<'ask.answered'>;
        a.status = 'answered';
        a.answer = { by: p.by, role: p.role, answer: p.answer, detail: p.detail, at: e.ts };
      } else {
        const p = e.payload as EventPayload<'ask.cancelled'>;
        a.status = 'cancelled';
        a.cancelled = { by: p.by, why: p.why, at: e.ts };
      }
    }
  }
  return [...byId.values()];
}

/** Whether someone in this role may answer this ask: the owner any; a writer only a question that allows it; a viewer none. */
export function mayAnswerAsk(ask: Pick<Ask, 'kind'> & { writersMayAnswer?: boolean }, role: Role | null): boolean {
  if (role === 'owner') return true;
  return role === 'writer' && ask.kind === 'question' && ask.writersMayAnswer === true;
}

/** The answers each kind takes from the generic answer(); paste_secret and root_step answer through their own modules. */
function validAnswer(ask: Ask, answer: string): boolean {
  if (ask.kind === 'approve_link') return answer === 'approved' || answer === 'declined';
  if (ask.kind === 'question') return ask.options.includes(answer);
  if (ask.kind === 'root_step') return answer === 'declined';
  return false;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new AskError(`${what} is required`);
  if (v.length > max) throw new AskError(`${what} is longer than ${max} characters`);
  return v;
}

function specOf(input: AskInput): EventPayload<'ask.created'>['spec'] {
  switch (input.kind) {
    case 'paste_secret':
      if (!CREDENTIAL_NAME.test(String(input.credential))) throw new AskError(`credential must match ${CREDENTIAL_NAME} (a name, not a path)`);
      return { kind: 'paste_secret', credential: input.credential, where: text(input.where, 'where', 500) };
    case 'approve_link': {
      let u: URL;
      try {
        u = new URL(String(input.url));
      } catch {
        throw new AskError('url is not a URL');
      }
      // https, or plain http on this machine's loopback only: GitHub's App manifest flow starts from a form post, so its
      // page is served by the setup on 127.0.0.1 (src/onboard/manifest.ts).
      const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      if (u.protocol !== 'https:' && !loopback) throw new AskError('an approve_link url must be https (or http on 127.0.0.1)');
      return { kind: 'approve_link', url: u.toString() };
    }
    case 'question': {
      const options = Array.isArray(input.options) ? input.options : [];
      if (options.length < 1 || options.length > 10 || options.some((o) => typeof o !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(o)) || new Set(options).size !== options.length) {
        throw new AskError('a question takes 1 to 10 distinct options, each a short word (letters, digits, - _ .)');
      }
      return { kind: 'question', options: [...options], writers_may_answer: input.writersMayAnswer === true };
    }
    case 'root_step':
      if (typeof input.command !== 'string' || !Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string')) throw new AskError('a root_step takes a command and its arguments (strings)');
      return { kind: 'root_step', command: input.command, args: [...input.args] };
    default:
      throw new AskError(`unknown ask kind ${(input as { kind: unknown }).kind}`);
  }
}

/**
 * Record an answer, once: inside one write transaction, so of two answers at once exactly one lands (a
 * second gets 409). Checks who may answer. Exported for secrets.ts and root-steps' runner, which answer
 * their kinds only after doing the step; everything else answers through asks(log).answer.
 */
export function recordAnswer(log: EventLog, id: string, a: { by: string; role: Role | null; answer: string; detail?: string }, check: (ask: Ask) => void = () => {}): Ask {
  if (!a.by) throw new AskError('who is answering is unknown', 403);
  log.db.exec('BEGIN IMMEDIATE');
  try {
    const ask = asksFrom(log.read(0, [...ASK_EVENTS])).find((x) => x.id === id);
    if (!ask) throw new AskError(`no ask ${id}`, 404);
    if (!mayAnswerAsk(ask, a.role)) throw new AskError(ask.kind === 'question' && ask.writersMayAnswer ? `@${a.by} (${a.role ?? 'no role'}) may not answer this; the owner or a writer may` : `only the owner may answer this ask; @${a.by} (${a.role ?? 'no role'}) may not`, 403);
    if (ask.status !== 'open') throw new AskError(`ask ${id} is already ${ask.status}`, 409);
    check(ask);
    log.append('ask.answered', { id, by: a.by, role: a.role as 'owner' | 'writer', answer: a.answer, detail: (a.detail ?? '').slice(0, 2000) }, a.by, 'human');
    log.db.exec('COMMIT');
  } catch (e) {
    log.db.exec('ROLLBACK');
    throw e;
  }
  return asksFrom(log.read(0, [...ASK_EVENTS])).find((x) => x.id === id)!;
}

export interface Asks {
  /** Record a new ask; `by` is what created it (the coordinator, a setup step). */
  create(input: AskInput, by?: string): Ask;
  /** Answer an approve_link (approved|declined), a question (one of its options) or decline a root step, once. */
  answer(id: string, a: { by: string; role: Role | null; answer: string }): Ask;
  /** Withdraw an open ask. */
  cancel(id: string, by: string, why: string): Ask;
  get(id: string): Ask | null;
  list(filter?: { instance?: string; status?: AskStatus }): Ask[];
}

/** The ask API over an instance's event log. */
export function asks(log: EventLog): Asks {
  const all = () => asksFrom(log.read(0, [...ASK_EVENTS]));
  const get = (id: string) => all().find((a) => a.id === id) ?? null;
  return {
    create(input, by = 'coordinator') {
      if (!INSTANCE_NAME.test(String(input.instance))) throw new AskError('instance must be an instance name');
      const id = `ask-${randomBytes(6).toString('hex')}`;
      log.append('ask.created', { id, instance: input.instance, title: text(input.title, 'title', MAX_TITLE), detail: text(input.detail, 'detail', MAX_DETAIL), created_by: by, spec: specOf(input) }, by, 'coordinator');
      return get(id)!;
    },
    answer(id, a) {
      return recordAnswer(log, id, a, (ask) => {
        if (ask.kind === 'paste_secret') throw new AskError('a secret is answered by pasting it in the console (POST .../secret), never as an answer', 400);
        if (!validAnswer(ask, a.answer)) throw new AskError(ask.kind === 'question' ? `answer must be one of ${ask.options.join(', ')}` : ask.kind === 'root_step' ? 'a root step is run (POST .../run) or declined' : 'answer must be approved or declined', 400);
      });
    },
    cancel(id, by, why) {
      log.db.exec('BEGIN IMMEDIATE');
      try {
        const ask = get(id);
        if (!ask) throw new AskError(`no ask ${id}`, 404);
        if (ask.status !== 'open') throw new AskError(`ask ${id} is already ${ask.status}`, 409);
        log.append('ask.cancelled', { id, by, why: why.slice(0, 500) }, by, 'coordinator');
        log.db.exec('COMMIT');
      } catch (e) {
        log.db.exec('ROLLBACK');
        throw e;
      }
      return get(id)!;
    },
    get,
    list(filter = {}) {
      return all().filter((a) => (!filter.instance || a.instance === filter.instance) && (!filter.status || a.status === filter.status));
    },
  };
}
