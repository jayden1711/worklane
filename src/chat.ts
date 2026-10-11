// The dashboard chat: the chief_of_staff role answering the owner's questions
// about an instance. It runs like any agent (the instance's agent user,
// sandboxed: the lane's denyRead covers the instance's private state and every
// credential store), with no shell, no network and no write tools. What it
// knows comes from a per-turn context bundle the coordinator writes (recent
// events, run records, machine health, pull requests and issues, all redacted;
// bundle.ts) plus the repository. It never acts: an issue draft is validated
// and returned as a preview for the owner to file; a proposed action is only a
// reference to an existing confirm flow (a settings change, a decision answer,
// pause/resume). Anyone who isn't the owner gets a read-only answer. Turns are
// kept per instance in its state (0600, redacted).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseContract } from './backlog/types.js';
import { writeBundle } from './bundle.js';
import type { Config } from './config/load.js';
import { redact, redactString } from './events/redact.js';
import type { StoredEvent } from './events/types.js';
import { groupOnlyDir } from './os/index.js';
import { CHAT_SCHEMA, rolePrompt } from './roles.js';
import type { RunSummary } from './run-record.js';
import type { AgentRunner } from './runner.js';
import { SETTING_KEYS } from './settings.js';

export const CHAT_HISTORY = join('chat', 'history.jsonl');
const RECENT_EVENTS = 200;
const HISTORY_TURNS = 6;
const QUIET = new Set(['coordinator.tick', 'run.heartbeat']);
/** The only tools a chat run has: reading files. No shell, no network, no writes. */
export const CHAT_TOOLS = ['Read', 'Glob', 'Grep'];
const NOT_ALLOWED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

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

/** Open issues, PRs and decisions from the event log, for a context. */
export function contextFromEvents(events: StoredEvent[]): Pick<ChatContext, 'issues' | 'prs' | 'decisions'> {
  const issues = new Map<number, ChatIssue>();
  const prs = new Map<number, ChatPr>();
  const asked = new Map<string, OpenDecision>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'issue.seen') issues.set(p.issue as number, { number: p.issue as number, title: String(p.title), status: 'seen', labels: (p.labels as string[]) ?? [] });
    const i = typeof p.issue === 'number' ? issues.get(p.issue) : undefined;
    if (i && ['issue.claimed', 'issue.blocked', 'issue.released', 'land.queued'].includes(e.type)) i.status = e.type.split('.')[1]!;
    if (e.type === 'pr.opened') prs.set(p.number as number, { number: p.number as number, issue: (p.issue as number) ?? null, title: issues.get(p.issue as number)?.title ?? `#${p.issue}`, state: 'open', url: String(p.url) });
    const pr = typeof p.number === 'number' ? prs.get(p.number) : undefined;
    if (pr && e.type === 'pr.ready') pr.state = 'ready';
    if (pr && e.type === 'merge.decided') pr.state = (p.auto as boolean) ? 'merging' : 'waiting for the owner';
    if (pr && e.type === 'pr.closed') pr.state = (p.merged as boolean) ? 'merged' : 'closed';
    if (e.type === 'decision.asked') asked.set(String(p.id), { id: String(p.id), question: String(p.question), options: (p.options as string[]) ?? [] });
    if (e.type === 'decision.answered') asked.delete(String(p.id));
  }
  return { issues: [...issues.values()], prs: [...prs.values()], decisions: [...asked.values()] };
}

/**
 * The bundle files for one context: what the chat may know, nothing else. Each line carries the id the answer
 * cites. Everything is redacted again by writeBundle; nothing here comes from credentials or config files.
 */
export function bundleFiles(c: ChatContext, prefix = ''): Record<string, string> {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);
  const events = c.events.filter((e) => !QUIET.has(e.type)).slice(-RECENT_EVENTS);
  return {
    [`${prefix}README.md`]: `Context for instance ${c.instance} (${c.repo}). Cite by the ids shown: event:<n>, run:<id>, pr:#<n>, issue:#<n>.\nFiles: ${prefix}events.md, ${prefix}runs.md, ${prefix}health.json, ${prefix}prs.md, ${prefix}issues.md, ${prefix}decisions.md.\n`,
    [`${prefix}events.md`]: events.map((e) => `event:${e.id} ${e.ts} ${e.type} ${clip(JSON.stringify(redact(e.payload)), 400)}`).join('\n') + '\n',
    [`${prefix}runs.md`]: c.runs.map((r) => `run:${r.id} ${r.role}${r.issue !== null ? ` issue #${r.issue}` : ''} ${r.reason ?? 'running'} ~$${(r.costUsd ?? 0).toFixed(2)} commands ${r.commands} (failed ${r.failedCommands}) files ${r.files.length}`).join('\n') + '\n',
    [`${prefix}health.json`]: `${JSON.stringify(c.health ?? null, null, 2)}\n`,
    [`${prefix}prs.md`]: c.prs.map((p) => `pr:#${p.number} ${p.state}${p.issue !== null ? ` for issue #${p.issue}` : ''}: ${p.title}`).join('\n') + '\n',
    [`${prefix}issues.md`]: c.issues.map((i) => `issue:#${i.number} ${i.status}: ${i.title}${i.labels.length ? ` [${i.labels.join(', ')}]` : ''}`).join('\n') + '\n',
    [`${prefix}decisions.md`]: c.decisions.map((d) => `decision ${d.id}: ${d.question} (options: ${d.options.join(', ')})`).join('\n') + '\n',
  };
}

export interface Citation {
  kind: 'event' | 'run' | 'pr' | 'issue';
  id: string;
  instance: string;
  label: string;
  /** GitHub for pull requests and issues; dashboard-relative for events and runs. */
  href: string;
}

export type ActionRef =
  | { kind: 'settings'; key: string; value: unknown; confirm: 'settings.change'; why?: string }
  | { kind: 'decision'; id: string; answer: string; confirm: 'decision.answer'; why?: string }
  | { kind: 'pause' | 'resume'; confirm: 'emergency.pause' | 'emergency.resume'; why?: string };

export type IssueDraft = { ok: true; title: string; body: string; labels: ['ready'] } | { ok: false; title: string; body: string; why: string };

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
}

/** A draft issue the harness can check: a ```done_when block parseContract accepts, commands as block scalars. */
export function validateDraft(title: string, body: string): IssueDraft {
  if (!title.trim()) return { ok: false, title, body, why: 'no title' };
  const block = body.match(/```done_when\s*\n([\s\S]*?)\n```/)?.[1];
  if (block !== undefined) {
    const inline = block.split('\n').filter((l) => /^\s*-\s*command:\s*\S/.test(l) && !/^\s*-\s*command:\s*[|>][-+]?\s*$/.test(l));
    if (inline.length) return { ok: false, title, body, why: `commands must be YAML block scalars ("- command: |"), not inline: ${inline[0]!.trim()}` };
  }
  const c = parseContract(body);
  return c.ok ? { ok: true, title: title.trim(), body, labels: ['ready'] } : { ok: false, title, body, why: c.why };
}

function validateAction(a: Record<string, unknown>, decisions: OpenDecision[]): ActionRef | string {
  const why = typeof a.why === 'string' ? { why: a.why.slice(0, 300) } : {};
  if (a.kind === 'settings') {
    if (!(SETTING_KEYS as readonly string[]).includes(String(a.key))) return `settings ${String(a.key)}: not a setting (${SETTING_KEYS.join(', ')})`;
    return { kind: 'settings', key: String(a.key), value: a.value, confirm: 'settings.change', ...why };
  }
  if (a.kind === 'decision') {
    const d = decisions.find((x) => x.id === a.id);
    if (!d) return `decision ${String(a.id)}: not an open decision`;
    if (!d.options.includes(String(a.answer))) return `decision ${d.id}: "${String(a.answer)}" is not one of ${d.options.join(', ')}`;
    return { kind: 'decision', id: d.id, answer: String(a.answer), confirm: 'decision.answer', ...why };
  }
  if (a.kind === 'pause' || a.kind === 'resume') return { kind: a.kind, confirm: a.kind === 'pause' ? 'emergency.pause' : 'emergency.resume', ...why };
  return `${String(a.kind)}: not an action the chat may propose`;
}

function citationsOf(raw: { kind?: string; id?: string }[], c: ChatContext): { kept: Citation[]; unknown: string[] } {
  const kept: Citation[] = [];
  const unknown: string[] = [];
  const events = new Set(c.events.map((e) => String(e.id)));
  const runs = new Set(c.runs.map((r) => r.id));
  for (const x of raw) {
    const id = String(x.id ?? '').replace(/^#/, '');
    const n = Number(id);
    if (x.kind === 'event' && events.has(id)) kept.push({ kind: 'event', id, instance: c.instance, label: `event ${id}`, href: `/events/${id}` });
    else if (x.kind === 'run' && runs.has(id)) kept.push({ kind: 'run', id, instance: c.instance, label: `run ${id}`, href: `/runs/${id}` });
    else if (x.kind === 'pr' && c.prs.some((p) => p.number === n)) kept.push({ kind: 'pr', id, instance: c.instance, label: `PR #${id}`, href: c.prs.find((p) => p.number === n)!.url });
    else if (x.kind === 'issue' && c.issues.some((i) => i.number === n)) kept.push({ kind: 'issue', id, instance: c.instance, label: `issue #${id}`, href: `https://github.com/${c.repo}/issues/${id}` });
    else unknown.push(`${String(x.kind)}:${id}`);
  }
  return { kept, unknown };
}

/** The last turns of this instance's chat, for the next prompt. */
export function chatHistory(stateDir: string, turns = HISTORY_TURNS): { at: string; by: string; question: string; answer: string }[] {
  const f = join(stateDir, CHAT_HISTORY);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { at: string; by: string; question: string; answer: string }];
      } catch {
        return [];
      }
    })
    .slice(-turns);
}

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
  /** Records the turn's cost (the coordinator emits run.cost with role chat). */
  onCost?: (r: { costUsd: number; model: string; turns: number }) => void;
  now?: () => Date;
}

/** One chat turn for one instance. */
export async function chatTurn(o: ChatTurnOptions): Promise<ChatAnswer> {
  const owner = o.cfg.project.owners.default;
  const readOnly = !o.by || o.by.toLowerCase() !== owner.toLowerCase();
  const turn = `${(o.now ?? (() => new Date()))().getTime()}-${randomBytes(3).toString('hex')}`;
  const dir = writeBundle(o.bundleRoot, turn, o.gid, bundleFiles(o.context));
  const history = chatHistory(o.stateDir)
    .map((h) => `Q (@${h.by}): ${h.question}\nA: ${h.answer}`)
    .join('\n\n');
  const role = o.cfg.agents.roles.chief_of_staff;
  const model = role?.model ?? 'sonnet';
  const r = await o.runner.run({
    role: 'chat',
    stateDir: o.stateDir,
    prompt: [
      `Context files for instance ${o.context.instance}: ${dir} (start with README.md). The repository is the current directory.`,
      ...(history ? ['', 'Earlier in this conversation:', history] : []),
      '',
      readOnly ? `Asked by @${o.by || 'unknown'}, who is not the owner: answer only; no issue drafts and no proposed actions.` : `Asked by the owner, @${owner}.`,
      '',
      `Question: ${o.question}`,
    ].join('\n'),
    appendSystemPrompt: rolePrompt(o.cfg.dir, 'chief_of_staff'),
    cwd: o.repo,
    model,
    allowedTools: CHAT_TOOLS,
    disallowedTools: NOT_ALLOWED,
    maxTurns: 30,
    maxBudgetUsd: Math.max(0.05, Math.min(role?.budget_usd ?? 1, o.remainingUsd)),
    jsonSchema: CHAT_SCHEMA,
    stallMs: 10 * 60_000,
    timeoutMs: 20 * 60_000,
  });
  o.onCost?.({ costUsd: r.costUsd, model: r.model, turns: r.turns });
  const s = (r.reason === 'succeeded' ? r.structured : undefined) as { answer?: string; citations?: { kind?: string; id?: string }[]; issue_draft?: { title?: string; body?: string }; actions?: Record<string, unknown>[] } | undefined;
  const answer = s?.answer ? redactString(s.answer) : `The chat run ended without an answer (${r.reason}).`;
  const { kept, unknown } = citationsOf(s?.citations ?? [], o.context);
  const acts = readOnly ? [] : (s?.actions ?? []).map((a) => validateAction(a, o.context.decisions));
  const out: ChatAnswer = {
    turn,
    instance: o.context.instance,
    answer,
    citations: kept,
    unknownCitations: unknown,
    issueDraft: !readOnly && s?.issue_draft ? validateDraft(String(s.issue_draft.title ?? ''), String(s.issue_draft.body ?? '')) : null,
    actions: acts.filter((a): a is ActionRef => typeof a !== 'string'),
    refusedActions: acts.filter((a): a is string => typeof a === 'string'),
    readOnly,
    costUsd: r.costUsd,
  };
  // The conversation, kept per instance: only the owner's turns, redacted, 0600.
  if (!readOnly) {
    try {
      groupOnlyDir(join(o.stateDir, 'chat'));
      appendFileSync(join(o.stateDir, CHAT_HISTORY), `${JSON.stringify(redact({ at: (o.now ?? (() => new Date()))().toISOString(), by: o.by, question: o.question, answer: out.answer, citations: kept.map((c) => `${c.kind}:${c.id}`) }))}\n`, { mode: 0o600 });
    } catch {
      // history is best effort
    }
  }
  return out;
}

/** A hub question: one turn per selected instance, each from its own bundle, as its own agent user. */
export async function hubChat(question: string, by: string, instances: Omit<ChatTurnOptions, 'question' | 'by'>[]): Promise<ChatAnswer[]> {
  const out: ChatAnswer[] = [];
  for (const i of instances) out.push(await chatTurn({ ...i, question, by }));
  return out;
}
