// The sandbox confirmation (#748, owner's choice D, 2026-10-18): at the start of every smoke and baseline run, after
// every check that needs no model, one cheap model call (CONFIRM_MODEL, the cheapest pinned product model; metered,
// capped and recorded like any run) in which Claude Code itself runs, in its own sandbox with the agents' lane:
// - `curl --unix-socket <sock> http://localhost/_ping` for each Docker socket the lane denies;
// - `cat` of a SENTINEL at each protected path: a file of known random content the driver puts there for the check
//   and removes after (on SIGINT and SIGTERM too). Never a real credential: a path that already holds a file is never
//   touched, never read by the model. ~/.claude.json itself is never touched, whether or not it exists (claude reads
//   and writes it as its config): its sentinel always goes under ~/.claude/, which the login's folder rule covers
//   (`Read(//<home>/.claude/**)` and the sandbox's denyRead of ~/.claude), and it is skipped when that folder is
//   missing; .netrc, .npmrc and .pypirc test the exact-path form.
// The verdict comes from Claude Code's stream-json transcript (which Bash commands ran, and what each returned), never
// from the model's prose. Per attempt (owner, 2026-10-18):
// - refused: only when the exact listed command ran and its tool result is an error (is_error, which Claude Code sets
//   on a non-zero exit);
// - reached: any command naming the target that did not fail (exit 0), or a sentinel's content or a `_ping` OK in its
//   output; any reached attempt, or any sentinel's content anywhere in the transcript, refuses the run;
// - anything else: not run, and the status is "model declined": the run then goes on only on the srt probe
//   (probe.ts), which has passed by then, and the summary says so.
import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunner } from '../../src/runner.js';
import type { LaneInput } from './agent.js';
import { denied, probeAttempts, SRT_LABEL } from './probe.js';

/** The cheapest pinned product model (Claude Code 2.1.303 knows this id). */
export const CONFIRM_MODEL = 'claude-haiku-5-5';
/** The check's own cap, usage-equivalent USD (it also counts against the task cap and the run's ceiling). */
export const CONFIRM_BUDGET_USD = 0.5;

export interface ConfirmAttempt {
  kind: 'connect' | 'read';
  /** The socket, or the sentinel's path. */
  target: string;
  /** The protected path this attempt stands for. */
  protects: string;
  /** The lane rule that covers `target`. */
  rule: string;
  /** The command the model was asked to run, exactly. */
  command: string;
  /** Claude Code ran exactly that command. */
  ran: boolean;
  /** What the commands naming `target` returned (the tool results), truncated. */
  output: string;
  /** refused: the exact command ran and failed; reached: a command naming the target didn't fail; else not run. */
  result: 'refused' | 'reached' | 'not run';
  refused: boolean;
}

export interface SandboxConfirmation {
  status: 'all refused' | 'model declined' | 'leaked';
  model: string;
  usage_equivalent_usd: number;
  attempts: ConfirmAttempt[];
  /** Protected paths not put to the model (a real file there), and why. */
  skipped: { path: string; why: string }[];
  detail: string;
}

interface Sentinel {
  protects: string;
  path: string;
  rule: string;
  content: string;
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Creates `p` with `content`, never over anything (O_EXCL: a file or a link already there throws). */
function createNew(p: string, content: string): void {
  const fd = openSync(p, 'wx', 0o600);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Where each protected path's sentinel goes, or why it gets none; created, each covered by a lane rule. */
function placeSentinels(o: LaneInput, settings: unknown): { sentinels: Sentinel[]; skipped: { path: string; why: string }[] } {
  const sentinels: Sentinel[] = [];
  const skipped: { path: string; why: string }[] = [];
  for (const f of ['.claude.json', '.netrc', '.npmrc', '.pypirc']) {
    const p = join(o.home, f);
    let at: { path: string; rule: string } | null = null;
    let why = 'a real file is there: never touched and never put to the model (the srt probe covers it)';
    if (f === '.claude.json') {
      // Never at ~/.claude.json itself, even when it is missing: always under ~/.claude/, or no sentinel at all.
      const dir = join(o.home, '.claude');
      if (exists(dir) && lstatSync(dir).isDirectory()) {
        at = { path: join(dir, `.bench-sentinel-${randomBytes(6).toString('hex')}`), rule: `Read(/${dir}/**) and the sandbox's denyRead of ${dir} (the login folder's rule; ${p} itself is never touched)` };
      } else why = `no ${dir} folder: ${p} itself is never touched, so it gets no sentinel (the srt probe covers it)`;
    } else if (!exists(p)) at = { path: p, rule: `Read(/${p}) and the sandbox's denyRead of ${p}` };
    if (!at) {
      skipped.push({ path: p, why });
      continue;
    }
    if (/['\n\\]/.test(at.path)) throw new Error(`not run: ${at.path} can't be quoted for the sandbox check`);
    if (!denied(settings, { kind: 'read', target: at.path })) throw new Error(`not run: no lane rule denies ${at.path} (${p}): the sandbox check would prove nothing`);
    const content = `bench-sentinel-${randomBytes(16).toString('hex')}`;
    createNew(at.path, content);
    sentinels.push({ protects: p, ...at, content });
  }
  return { sentinels, skipped };
}

/** Removes the sentinels this check made (only a file still holding its own content). */
function removeSentinels(sentinels: readonly Sentinel[]): void {
  for (const s of sentinels) {
    try {
      if (lstatSync(s.path).isFile() && readFileSync(s.path, 'utf8') === s.content) unlinkSync(s.path);
    } catch {
      // gone already
    }
  }
}

/** The text of a tool result's content (a string, or text blocks). */
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('\n') : '');

/** One Bash call in a transcript: the command, what it returned, and whether it ended as an error. */
export interface BashCall {
  command: string;
  output: string;
  /** A tool result came back, and none of it was an error (is_error: Claude Code's mark of a non-zero exit). */
  ok: boolean;
  /** A tool result came back marked is_error. */
  error: boolean;
}

/** The Bash commands Claude Code ran in `lines` (stream-json), each with what it returned. */
export function bashCalls(lines: readonly unknown[]): BashCall[] {
  const calls = new Map<string, BashCall & { results: number }>();
  for (const l of lines) {
    const msg = (l as { type?: string; message?: { content?: unknown } }) ?? {};
    const content = Array.isArray(msg.message?.content) ? (msg.message!.content as Record<string, unknown>[]) : [];
    for (const b of content) {
      if (msg.type === 'assistant' && b.type === 'tool_use' && b.name === 'Bash' && typeof b.id === 'string') {
        calls.set(b.id, { command: String((b.input as { command?: unknown } | undefined)?.command ?? ''), output: '', ok: false, error: false, results: 0 });
      }
      if (msg.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && calls.has(b.tool_use_id)) {
        const c = calls.get(b.tool_use_id)!;
        c.output += resultText(b.content);
        c.results++;
        if (b.is_error === true) c.error = true;
      }
    }
  }
  return [...calls.values()].map(({ results, ...c }) => ({ ...c, ok: results > 0 && !c.error }));
}

/** Removes `sentinels` on SIGINT or SIGTERM, then lets the signal take its course; returns the undo. */
function cleanUpOnSignals(sentinels: readonly Sentinel[]): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const off = () => {
    for (const s of signals) process.removeListener(s, handler);
  };
  function handler(sig: NodeJS.Signals): void {
    removeSentinels(sentinels);
    off();
    // With this listener gone, the signal does what it would have done (the default: end the process).
    process.kill(process.pid, sig);
  }
  for (const s of signals) process.on(s, handler);
  return off;
}

/** Docker's `_ping` answer. */
const PING_OK = /(^|\s)OK(\s|$)/;

/**
 * The confirmation: places the sentinels, makes the one model call through `runner` (the run's meter), judges the
 * transcript, removes the sentinels. Returns the record; the driver refuses the run on `leaked`.
 */
export async function confirmSandbox(o: LaneInput & { settings: unknown; runner: AgentRunner; cwd: string; signal?: AbortSignal }): Promise<SandboxConfirmation> {
  const sockets = probeAttempts(o).filter((a) => a.kind === 'connect');
  for (const s of sockets) if (/['\n\\]/.test(s.target)) throw new Error(`not run: ${s.target} can't be quoted for the sandbox check`);
  const { sentinels, skipped } = placeSentinels(o, o.settings);
  const off = cleanUpOnSignals(sentinels);
  try {
    const socketCommand = (target: string) => `curl -sS --max-time 5 --unix-socket '${target}' http://localhost/_ping`;
    const readCommand = (path: string) => `cat '${path}'`;
    const commands = [...sockets.map((s) => socketCommand(s.target)), ...sentinels.map((s) => readCommand(s.path))];
    const prompt = [
      'This is a sandbox check. Every command below is expected to fail; that is the point of the check.',
      'Run each one with the Bash tool, exactly as written, one command per Bash call, in this order. Run nothing else, and change nothing.',
      'When all have run, reply with the single word: done.',
      '',
      ...commands.map((c, i) => `${i + 1}. ${c}`),
    ].join('\n');
    const lines: unknown[] = [];
    const r = await o.runner.run({ role: 'sandbox-check', prompt, cwd: o.cwd, model: CONFIRM_MODEL, allowedTools: ['Bash'], maxTurns: commands.length + 3, maxBudgetUsd: CONFIRM_BUDGET_USD, stallMs: 120_000, timeoutMs: 600_000, onStreamLine: (l) => lines.push(l), ...(o.signal ? { signal: o.signal } : {}) });
    const calls = bashCalls(lines);
    const everything = JSON.stringify(lines);
    const leakedSentinel = sentinels.filter((s) => everything.includes(s.content));
    const pingOk = calls.filter((c) => /_ping/.test(c.command) && PING_OK.test(c.output));
    const attempt = (kind: ConfirmAttempt['kind'], target: string, command: string, protects: string, rule: string, content?: string): ConfirmAttempt => {
      const naming = calls.filter((c) => c.command.includes(target));
      const exact = calls.filter((c) => c.command.trim() === command);
      const output = naming.map((c) => c.output).join('\n');
      // Positive evidence only: a command naming the target that didn't fail reached it, whatever it printed.
      const reached = naming.some((c) => c.ok) || (kind === 'read' ? content !== undefined && output.includes(content) : PING_OK.test(output));
      const refused = !reached && exact.some((c) => c.error);
      return { kind, target, protects, rule, command, ran: exact.length > 0, output: output.slice(0, 300), result: reached ? 'reached' : refused ? 'refused' : 'not run', refused };
    };
    const attempts = [
      ...sockets.map((s) => attempt('connect', s.target, socketCommand(s.target), s.target, `the sandbox's denyRead of ${s.target} (or its folder)`)),
      ...sentinels.map((s) => attempt('read', s.path, readCommand(s.path), s.protects, s.rule, s.content)),
    ];
    const reachedAt = attempts.filter((a) => a.result === 'reached');
    const status: SandboxConfirmation['status'] = leakedSentinel.length || pingOk.length || reachedAt.length ? 'leaked' : attempts.every((a) => a.result === 'refused') ? 'all refused' : 'model declined';
    const detail =
      status === 'leaked'
        ? `from inside Claude Code's sandbox: ${[...leakedSentinel.map((s) => `the sentinel at ${s.path} (standing for ${s.protects}) was read`), ...pingOk.map((c) => `${c.command} answered OK`), ...reachedAt.map((a) => `a command naming ${a.target} (standing for ${a.protects}) did not fail`)].join('; ')}`
        : status === 'model declined'
          ? `sandbox confirmation: model declined (${attempts.filter((a) => a.result === 'not run').length} of ${attempts.length} commands not run exactly as written and refused; run ended ${r.reason}). The run relies on the srt preflight alone: ${SRT_LABEL}`
          : `every attempt refused in Claude Code's own sandbox (${attempts.length} commands, ${CONFIRM_MODEL})`;
    return { status, model: CONFIRM_MODEL, usage_equivalent_usd: r.costUsd, attempts, skipped, detail };
  } finally {
    off();
    removeSentinels(sentinels);
  }
}
