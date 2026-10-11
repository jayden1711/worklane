// Unknown domains: an agent's request to a host outside its lane's allowlist
// is refused (WebFetch by the guardrails hook, shell commands by the
// sandbox's proxy). Refused silently, a task just fails; instead each new
// host becomes a request the owner decides: allow it for this repo (a config
// change opened as a pull request, never an in-place widening), allow it once
// (the next run of that task only), or deny. Nothing changes until then.
// Pure: the coordinator reads the run's stream, records, asks and acts.
import { parseDocument, YAMLSeq } from 'yaml';
import { hostAllowed } from './guardrails/engine.js';

/** The guardrails hook's own refusal of a WebFetch (src/guardrails/engine.ts). */
const HOOK_REFUSAL = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+) is not on the network allowlist\b/i;
/**
 * What a shell command prints when the sandbox's proxy refuses its connection: curl and git through an
 * HTTP proxy that answers 403, pip's and npm's proxy errors, and the sandbox's own wording.
 */
const PROXY_REFUSAL = /CONNECT tunnel failed, response 403|Received HTTP code 403 from proxy|ProxyError|tunneling socket could not be established|blocked by (?:the )?(?:sandbox|network) (?:policy|allowlist)|not (?:in|on) the (?:sandbox |network )?allow ?list|domain (?:is )?not allowed/i;
/** Hosts a command names: URLs, scp-like git remotes. */
const COMMAND_HOSTS = /\b(?:https?|git|ssh|wss?):\/\/(?:[^@/\s'"]+@)?([a-z0-9.-]+\.[a-z]{2,})|\b[\w.-]+@([a-z0-9.-]+\.[a-z]{2,}):/gi;

export interface RefusedRequest {
  host: string;
  tool: string;
  /** The URL or command that was refused (clipped). */
  what: string;
}

type Content = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

const textOf = (c: unknown): string => (Array.isArray(c) ? c.map((x) => (x as { text?: string }).text ?? '').join('') : String(c ?? ''));

/**
 * Follows a run's stream-json lines and collects the hosts it was refused, each once per run. `allow` is the
 * lane's allowlist: a host on it was not refused for the network (another failure), so it is never reported.
 */
export class RefusalTracker {
  private calls = new Map<string, { tool: string; input: Record<string, unknown> }>();
  private seen = new Set<string>();
  readonly refused: RefusedRequest[] = [];
  constructor(private allow: string[]) {}

  line(j: unknown): void {
    const content = (j as { message?: { content?: unknown } })?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content as Content[]) {
      if (c.type === 'tool_use' && c.id) this.calls.set(c.id, { tool: c.name ?? '', input: c.input ?? {} });
      else if (c.type === 'tool_result' && c.tool_use_id) {
        const call = this.calls.get(c.tool_use_id);
        if (call) for (const r of refusedIn(call.tool, call.input, textOf(c.content))) this.add(r);
      }
    }
  }

  private add(r: RefusedRequest) {
    const h = r.host.toLowerCase();
    if (this.seen.has(h) || hostAllowed(h, this.allow)) return;
    this.seen.add(h);
    this.refused.push({ ...r, host: h });
  }
}

/** The hosts one tool call was refused, from its input and what it returned. */
export function refusedIn(tool: string, input: Record<string, unknown>, result: string): RefusedRequest[] {
  if (tool === 'WebFetch') {
    const m = HOOK_REFUSAL.exec(result);
    return m ? [{ host: m[1]!, tool, what: String(input.url ?? '').slice(0, 300) }] : [];
  }
  if (tool === 'Bash' && PROXY_REFUSAL.test(result)) {
    const command = String(input.command ?? '');
    const hosts = new Set<string>();
    for (const m of command.matchAll(COMMAND_HOSTS)) hosts.add((m[1] ?? m[2])!.toLowerCase());
    return [...hosts].map((host) => ({ host, tool, what: command.slice(0, 300) }));
  }
  return [];
}

/** One word each: a decision is answered by a `/<cli> <option>` comment. */
export const DOMAIN_OPTIONS = ['allow-repo', 'allow-once', 'deny'] as const;
export type DomainAnswer = (typeof DOMAIN_OPTIONS)[number];

/** The owner's decision for a refused host: what was refused, by which run, and what each answer does. */
export function domainDecision(r: RefusedRequest & { issue: number; role: string; run: string }, configFile: string) {
  return {
    question: `Allow agents to reach ${r.host}?`,
    options: [...DOMAIN_OPTIONS],
    // Fail closed: a new host is not reached unless the owner says so.
    recommendation: 'deny' as DomainAnswer,
    receipts: [
      `${r.role} run ${r.run} on #${r.issue} was refused ${r.host} (${r.tool}: ${r.what})`,
      `allow-repo: opens a pull request adding ${r.host} to ${configFile} network.allow; it applies once merged`,
      'allow-once: only the next run of this task may reach it',
      'deny: nothing changes; the task carries on without it',
    ],
  };
}

/**
 * guardrails.yaml with `host` added to network.allow, comments and order kept: the change an "allow-repo"
 * answer proposes as a pull request. Null if the host is already allowed.
 */
export function withAllowedHost(yamlText: string, host: string): string | null {
  const doc = parseDocument(yamlText);
  const current = (doc.getIn(['network', 'allow']) as YAMLSeq | undefined)?.toJSON?.() as string[] | undefined;
  if (current && hostAllowed(host, current)) return null;
  if (!current) doc.setIn(['network', 'allow'], [host]);
  else (doc.getIn(['network', 'allow']) as YAMLSeq).add(host);
  return String(doc);
}

/**
 * Hosts allowed once for an issue's next run and not used yet: an "allow-once" answer, until a run of that
 * issue starts after it. Events in log order.
 */
export function allowedOnce(events: { type: string; payload: unknown }[], issue: number): string[] {
  const out = new Map<string, boolean>();
  for (const e of events) {
    const p = e.payload as { issue?: number; host?: string; answer?: string; role?: string };
    if (p.issue !== issue) continue;
    if (e.type === 'network.domain_decided' && p.answer === 'allow-once' && p.host) out.set(p.host, true);
    if (e.type === 'run.started' && (p.role === 'worker' || p.role === 'ci-fix' || p.role === 'conflict-fix')) for (const h of out.keys()) if (out.get(h)) out.set(h, false);
  }
  return [...out].filter(([, open]) => open).map(([h]) => h);
}
