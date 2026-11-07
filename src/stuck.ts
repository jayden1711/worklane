// The stuck-run guard: a run that keeps making the same tool call (byte-identical tool name and input) is going
// nowhere. Flagged at FLAG_AT in a row whatever their results, or FLAG_AT identical failures in a row; stopped at
// STOP_AT identical failures in a row. A call with different input (the next page of a paginated read) breaks the
// streak; a call the permission rules or a hook denied is not the agent's doing and is left out entirely.
// Pure: it reads the run's stream-json lines (or a recorded feed) and says what it saw; the caller decides,
// and in dry-run mode only logs.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { redactCut } from './events/redact.js';
import { readFeed } from './run-feed.js';
import { RUNS_DIR } from './run-record.js';

export const STUCK_FLAG_AT = 5;
export const STUCK_STOP_AT = 8;

/** off: not run. dry-run: verdicts are logged, nothing is stopped. on: a stop verdict stops the run as "stuck". */
export type StuckMode = 'off' | 'dry-run' | 'on';

export interface StuckVerdict {
  kind: 'flag' | 'stop';
  tool: string;
  /** The repeated input, redacted and then clipped for display (#988). */
  input: string;
  /** Identical calls in a row (any result), and identical failures in a row, when the verdict was reached. */
  repeats: number;
  failures: number;
}

/** What the caller does with a verdict: dry-run only ever logs; a stop stops the run only when the mode is on. */
export function stuckAction(mode: StuckMode, v: StuckVerdict): 'log' | 'stop' | null {
  if (mode === 'off') return null;
  return mode === 'on' && v.kind === 'stop' ? 'stop' : 'log';
}

/** A refusal by permissions or a hook, not a failure of the call: these never count toward a streak. */
const DENIED = new RegExp(String.raw`has been denied|permission to use .* (?:was |has been )?denied|haven't granted|not allowed by|hook (?:error|blocked|denied)|^\[${BRAND.cli}\]`, 'i');
export const isDenial = (text: string) => DENIED.test(text.trim());

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text ?? '') : '')).join('') : '';

export class StuckDetector {
  private pending = new Map<string, { key: string; tool: string; input: string }>();
  private key: string | null = null;
  private repeats = 0;
  private failures = 0;
  private flagged = false;
  private stopped = false;
  /** The longest streaks seen, for the run record. */
  readonly longest = { repeats: 0, failures: 0, tool: '', input: '' };

  /** A tool call was made (from the stream: an assistant tool_use block, or a recorded feed's tool item). */
  call(id: string, tool: string, input: string): void {
    this.pending.set(id, { key: `${tool}\u0000${input}`, tool, input });
  }

  /** Its result arrived. Returns a verdict the first time the run crosses a threshold. */
  result(id: string, ok: boolean, output: string): StuckVerdict | null {
    const c = this.pending.get(id);
    if (!c) return null;
    this.pending.delete(id);
    if (!ok && isDenial(output)) return null; // a denial: neither counts nor breaks the streak
    if (c.key !== this.key) {
      this.key = c.key;
      this.repeats = 0;
      this.failures = 0;
      this.flagged = false;
    }
    this.repeats++;
    this.failures = ok ? 0 : this.failures + 1;
    if (this.repeats > this.longest.repeats || this.failures > this.longest.failures) {
      Object.assign(this.longest, { repeats: Math.max(this.longest.repeats, this.repeats), failures: Math.max(this.longest.failures, this.failures), tool: c.tool, input: redactCut(c.input, 300) });
    }
    const verdict = (kind: StuckVerdict['kind']): StuckVerdict => ({ kind, tool: c.tool, input: redactCut(c.input, 300), repeats: this.repeats, failures: this.failures });
    if (!this.stopped && this.failures >= STUCK_STOP_AT) {
      this.stopped = true;
      return verdict('stop');
    }
    if (!this.flagged && (this.repeats >= STUCK_FLAG_AT || this.failures >= STUCK_FLAG_AT)) {
      this.flagged = true;
      return verdict('flag');
    }
    return null;
  }

  /** One stream-json line from the runner: tool_use blocks are calls, tool_result blocks their results. */
  line(j: unknown): StuckVerdict[] {
    const out: StuckVerdict[] = [];
    const msg = (j as { message?: { content?: unknown } } | null)?.message;
    const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
    for (const b of content) {
      if (b?.type === 'tool_use') this.call(String(b.id), String(b.name), JSON.stringify(b.input ?? {}));
      else if (b?.type === 'tool_result') {
        const v = this.result(String(b.tool_use_id), b.is_error !== true, textOf(b.content));
        if (v) out.push(v);
      }
    }
    return out;
  }
}

/** A recorded feed (the run's `.feed.jsonl` items) replayed through a fresh detector: every verdict it would give. */
export function replayFeed(items: { kind: string; id?: string; tool?: string; input?: string; status?: string; output?: string }[]): { verdicts: StuckVerdict[]; longest: StuckDetector['longest'] } {
  const d = new StuckDetector();
  const verdicts: StuckVerdict[] = [];
  for (const it of items) {
    if (it.kind === 'tool' && it.id) d.call(it.id, String(it.tool ?? ''), String(it.input ?? ''));
    else if (it.kind === 'tool_result' && it.id) {
      const v = d.result(it.id, it.status !== 'error', String(it.output ?? ''));
      if (v) verdicts.push(v);
    }
  }
  return { verdicts, longest: d.longest };
}

export interface StuckScan {
  /** Runs with a recorded feed, replayed. */
  scanned: number;
  /** Runs the guard would have flagged (a stopped run was flagged first), and stopped. */
  flagged: number;
  stopped: number;
  /** Run records without a feed: their steps keep only commands and writes, too little to replay. */
  noFeed: number;
  examples: { run: string; kind: StuckVerdict['kind']; tool: string; input: string; failures: number }[];
}

/** Read-only: how many of the recorded runs in a state dir the guard would have flagged or stopped. */
export function scanStuck(stateDir: string): StuckScan {
  const dir = join(stateDir, RUNS_DIR);
  const out: StuckScan = { scanned: 0, flagged: 0, stopped: 0, noFeed: 0, examples: [] };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).sort();
  const feeds = new Set(files.filter((f) => f.endsWith('.feed.jsonl')).map((f) => f.slice(0, -'.feed.jsonl'.length)));
  out.noFeed = files.filter((f) => f.endsWith('.json') && !feeds.has(f.slice(0, -'.json'.length))).length;
  for (const run of feeds) {
    const feed = readFeed(stateDir, run);
    if (!feed) continue;
    out.scanned++;
    const { verdicts } = replayFeed(feed.items);
    const worst = verdicts.find((v) => v.kind === 'stop') ?? verdicts[0];
    if (!worst) continue;
    out.flagged++;
    if (worst.kind === 'stop') out.stopped++;
    out.examples.push({ run, kind: worst.kind, tool: worst.tool, input: worst.input.slice(0, 120), failures: worst.failures });
  }
  return out;
}
