// WHY: an issue names what it waits on ("Depends on #12", "Blocked by #3, #4"); it
// must not start while any of those is open, and must start on its own once they close.
// INVARIANT: a cycle can never unblock, so it is reported to the owner, never waited on.
import type { Issue } from './backlog/types.js';

/** INVARIANT: matches "Depends on #12", "depends on: #3, #4 and #5", "Blocked by #7 & #8", any case. */
const DEP_PHRASE = /\b(?:depends\s+on|blocked\s+by)\b\s*:?\s*((?:#\d+)(?:\s*(?:,|&|\band\b)\s*#\d+)*)/gi;

/** WHY: code (fenced or inline) and HTML comments are skipped, so an example in a code block is never an edge. */
export function dependsOn(body: string): number[] {
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const out: number[] = [];
  for (const m of text.matchAll(DEP_PHRASE)) for (const n of m[1]!.matchAll(/#(\d+)/g)) if (!out.includes(Number(n[1]))) out.push(Number(n[1]));
  return out;
}

/** INVARIANT: returns a cycle reachable from `start` (one behind it blocks it just the same), in order; null when none. */
export function findCycle(start: number, edges: (n: number) => readonly number[]): number[] | null {
  const path: number[] = [];
  const done = new Set<number>();
  const visit = (n: number): number[] | null => {
    const at = path.indexOf(n);
    if (at >= 0) return path.slice(at);
    if (done.has(n)) return null;
    path.push(n);
    for (const d of edges(n)) {
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    done.add(n);
    return null;
  };
  return visit(start);
}

export const cycleWords = (cycle: readonly number[]) => [...cycle, cycle[0]!].map((n) => `#${n}`).join(' -> ');

export type DepState = { open: number[]; unreadable: number[]; cycle: number[] | null };

/** WHY: one wording for the hold line, shared by the event, the dashboard and the digest. */
export function dependencyReason(s: DepState): string {
  if (s.cycle) return `dependency cycle ${cycleWords(s.cycle)}: none of them can start until the owner removes one "Depends on"`;
  const parts = [...(s.open.length ? [`waits for ${s.open.map((n) => `#${n}`).join(', ')} to close`] : []), ...(s.unreadable.length ? [`could not read ${s.unreadable.map((n) => `#${n}`).join(', ')}`] : [])];
  return parts.join('; ');
}

/** WHY: bounds tracker reads per issue; a longer chain is still held, only not searched for a cycle past this. */
const MAX_WALK = 50;

/**
 * WHY: a closed dependency is cached for good (it stays satisfied) and an open one only for `openTtlMs`,
 * so a close is seen within that without reading every dependency on every tick.
 */
export class DependencyGate {
  private known = new Map<number, { open: boolean; deps: number[]; at: number }>();

  constructor(
    private readonly get: (n: number) => Promise<Pick<Issue, 'number' | 'state' | 'body'>>,
    private readonly now: () => number = Date.now,
    private readonly openTtlMs = 60_000,
  ) {}

  /** WHY: the ready list is already in hand; seeding it saves a tracker read per ready issue. */
  seed(issues: readonly Pick<Issue, 'number' | 'state' | 'body'>[]): void {
    for (const i of issues) this.known.set(i.number, { open: i.state === 'open', deps: dependsOn(i.body), at: this.now() });
  }

  private async read(n: number): Promise<{ open: boolean; deps: number[] } | null> {
    const k = this.known.get(n);
    if (k && (!k.open || this.now() - k.at < this.openTtlMs)) return k;
    try {
      const i = await this.get(n);
      const v = { open: i.state === 'open', deps: dependsOn(i.body), at: this.now() };
      this.known.set(n, v);
      return v;
    } catch {
      return null;
    }
  }

  /** INVARIANT: an unreadable dependency holds the issue (reported) rather than being taken as closed. */
  async check(issue: Pick<Issue, 'number' | 'body'>): Promise<DepState> {
    const deps = dependsOn(issue.body);
    const open: number[] = [];
    const unreadable: number[] = [];
    for (const d of deps) {
      if (d === issue.number) continue;
      const r = await this.read(d);
      if (!r) unreadable.push(d);
      else if (r.open) open.push(d);
    }
    if (!deps.length) return { open, unreadable, cycle: null };
    const edges = new Map<number, number[]>([[issue.number, deps.filter((d) => d === issue.number || open.includes(d))]]);
    const queue = [...edges.get(issue.number)!];
    while (queue.length && edges.size < MAX_WALK) {
      const n = queue.shift()!;
      if (edges.has(n)) continue;
      const r = await this.read(n);
      const next: number[] = [];
      for (const d of r?.open ? r.deps : []) {
        const dr = d === n ? r : await this.read(d);
        if (dr?.open) next.push(d);
      }
      edges.set(n, next);
      queue.push(...next);
    }
    return { open, unreadable, cycle: findCycle(issue.number, (n) => edges.get(n) ?? []) };
  }
}
