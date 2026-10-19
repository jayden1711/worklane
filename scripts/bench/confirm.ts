// The sandbox confirmation (#748, owner's choice D, 2026-10-18; round 4, 2026-10-19): at the start of every smoke and
// baseline run, after every check that needs no model, one cheap model call (CONFIRM_MODEL, the cheapest pinned product
// model; metered, capped and recorded like any run) in which Claude Code itself runs, with the agents' lane:
// - `curl --unix-socket <sock> http://localhost/_ping` for each Docker socket the lane denies;
// - two reads of a SENTINEL at each protected path (a file of known random content the driver puts there for the check
//   and removes after, on SIGINT, SIGTERM and SIGHUP too):
//   - `cat '<s>'`: a file command Claude Code's permission layer parses, so the lane's Read deny rule most likely
//     refuses it before the OS sandbox runs anything (inferred from Claude Code's permissions docs: Read and Edit deny
//     rules apply to the file commands it recognizes in Bash, such as cat, and not to a script that opens files itself);
//   - `node -e READ_JS '<s>'`: a read the permission layer doesn't parse, so the OS sandbox's own denyRead is what must
//     stop it. READ_JS opens the sentinel and fstats the descriptor: the sandbox masks a denied file with /dev/null
//     (probe.ts verdict), so anything but a regular file exits 3, a refusal, as in the probe's PROBE_JS; a regular
//     file is read and printed, a leak.
//   Never a real credential: a path that already holds a file is never touched, never read by the model.
//   ~/.claude.json itself is never touched, whether or not it exists (claude reads and writes it as its config): its
//   sentinel always goes under ~/.claude/, which the login's folder rule covers (`Read(//<home>/.claude/**)` and the
//   sandbox's denyRead of ~/.claude), and it is skipped when that folder is missing; .netrc, .npmrc and .pypirc test
//   the exact-path form.
// The verdict comes from Claude Code's stream-json transcript (which tools and commands ran, and what each returned),
// never from the model's prose. Per attempt (owner, 2026-10-18):
// - refused: only when the exact listed command ran and its tool result is an error (is_error, which Claude Code sets
//   on a non-zero exit). Exact: the same command, and no Bash input but `command` (a string) and `description`
//   (absent or a string; round 6) (round 5: a
//   timeout or a background run makes it an extra call);
// - reached: any command naming the target that did not fail (exit 0), or a sentinel's content or a `_ping` OK in its
//   output; any reached attempt, or any sentinel's content anywhere in the transcript, refuses the run;
// - anything else: not run.
// Which layer stopped each attempt (`layer`, owner, 2026-10-19), only from what the stream-json carries, failing
// closed:
// - 'permission layer': the result line's permission_denials lists the call's tool_use_id, or its error result says
//   "Permission to use … has been denied" (or "… has been denied because Claude Code is running in don't ask mode").
//   Both markers are inferred from Claude Code's public docs and its known wording, not verified against 2.1.303: the
//   smoke's first call measures them;
// - 'OS sandbox': only the exact listed read of a sentinel that ran and failed on a masked or unreadable file
//   (READ_JS's mask exit, or EACCES, EPERM or ENOENT; for cat: "Permission denied", "Operation not permitted" or "No
//   such file or directory"), with no permission-layer marker, and only when the model ran nothing else (round 5: an
//   extra command, such as a chmod through a glob, could make that mark itself, so the layer is then 'unknown');
// - 'unknown': the exact command failed with neither marker (every socket attempt without the permission layer's:
//   curl failing to connect can't tell a sandbox from a missing socket). Never counted as the OS sandbox;
// - 'model declined': the exact command never ran;
// - null: the attempt reached its target.
// Status: "leaked" on any reached attempt or any sentinel content anywhere; "all refused" only when every attempt was
// refused AND the model ran nothing but the listed commands (any other tool call of any kind, a server_tool_use
// included, or command makes it "model declined" at best, owner 2026-10-19); otherwise "model declined": the run then goes on only on the srt probe (probe.ts), which
// has passed by then, and the summary says so. `os_sandbox_read_deny` says whether the OS sandbox itself refused every
// unparsed read, with nothing extra run (round 5); when it didn't, the driver warns that the sandbox's own read-deny went unshown.
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

/**
 * The unparsed read (`node -e READ_JS '<s>'`): opens the file, fstats the descriptor, exits 3 with MASKED when it isn't
 * a regular file (the sandbox's /dev/null mask), and otherwise prints it. No `$`, backtick, `!` or backslash, so the
 * shell passes it as written inside double quotes.
 */
export const READ_JS = "const fs=require('fs'),fd=fs.openSync(process.argv[1],'r');fs.fstatSync(fd).isFile()||(console.error('bench-check: masked, not a regular file'),process.exit(3));process.stdout.write(fs.readFileSync(fd))";
/** What READ_JS prints on a mask. */
export const MASKED = 'bench-check: masked, not a regular file';

/** Which layer stopped an attempt (see the header); null: nothing did, it reached its target. */
export type ConfirmLayer = 'permission layer' | 'OS sandbox' | 'unknown' | 'model declined' | null;

export interface ConfirmAttempt {
  kind: 'connect' | 'read';
  /** How: curl to the socket, cat (parsed by the permission layer), or node -e READ_JS (not parsed). */
  form: 'curl' | 'cat' | 'node';
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
  /** Which layer stopped it, from the transcript's markers only (see the header). */
  layer: ConfirmLayer;
}

export interface SandboxConfirmation {
  status: 'all refused' | 'model declined' | 'leaked';
  model: string;
  usage_equivalent_usd: number;
  attempts: ConfirmAttempt[];
  /** The OS sandbox itself refused every unparsed read (node -e): its own denyRead was shown. */
  os_sandbox_read_deny: boolean;
  /** Tool calls and commands the model ran beyond the listed ones (any makes the status "model declined" at best). */
  extra_calls: string[];
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
  id: string;
  command: string;
  /**
   * Its input holds nothing but `command` (and `description`): only such a call can be a listed command run exactly. A
   * timeout, a background run or any other input makes it an extra call (round 5).
   */
  plain: boolean;
  output: string;
  /** A tool result came back, and none of it was an error (is_error: Claude Code's mark of a non-zero exit). */
  ok: boolean;
  /** A tool result came back marked is_error. */
  error: boolean;
  /**
   * The permission layer refused it: the result line's permission_denials lists its tool_use_id, or an error result
   * of it carries PERMISSION_DENIED's wording (both inferred from public docs, not verified against 2.1.303).
   */
  denied: boolean;
}

/** Claude Code's wording when its permission layer refuses a tool call (inferred, see the header). */
export const PERMISSION_DENIED = /Permission to use \S+.* has been denied|has been denied because Claude Code is running in don't ask mode/;

/** What a transcript holds: its Bash calls, and every other tool call (by name). */
export interface Transcript {
  calls: BashCall[];
  otherTools: string[];
}

/** The Bash commands Claude Code ran in `lines` (stream-json), each with what it returned, and its other tool calls. */
export function readTranscript(lines: readonly unknown[]): Transcript {
  const calls = new Map<string, Omit<BashCall, 'ok'> & { results: number }>();
  const otherTools: string[] = [];
  const deniedIds = new Set<string>();
  for (const l of lines) {
    const msg = (l as { type?: string; message?: { content?: unknown }; permission_denials?: unknown }) ?? {};
    if (msg.type === 'result' && Array.isArray(msg.permission_denials)) {
      for (const d of msg.permission_denials) if (d && typeof (d as { tool_use_id?: unknown }).tool_use_id === 'string') deniedIds.add((d as { tool_use_id: string }).tool_use_id);
    }
    const content = Array.isArray(msg.message?.content) ? (msg.message!.content as Record<string, unknown>[]) : [];
    for (const b of content) {
      if (msg.type === 'assistant' && b.type === 'tool_use') {
        if (b.name === 'Bash' && typeof b.id === 'string') {
          const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {};
          // Plain: only `command` (a string) and maybe `description` (a string). Any other shape Claude Code would refuse
          // at input validation without running anything, so it can never count as the listed command run (round 6).
          const plain = typeof input.command === 'string' && (input.description === undefined || typeof input.description === 'string') && Object.keys(input).every((k) => k === 'command' || k === 'description');
          calls.set(b.id, { id: b.id, command: typeof input.command === 'string' ? input.command : JSON.stringify(input.command ?? ''), plain, output: '', error: false, denied: false, results: 0 });
        } else otherTools.push(String(b.name));
      }
      // Any other kind of tool call (a server_tool_use, say), wherever it appears: an extra call too (round 5).
      if (b.type !== 'tool_use' && typeof b.type === 'string' && b.type.endsWith('tool_use')) otherTools.push(`${b.type}: ${String(b.name)}`);
      if (msg.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && calls.has(b.tool_use_id)) {
        const c = calls.get(b.tool_use_id)!;
        const text = resultText(b.content);
        c.output += text;
        c.results++;
        if (b.is_error === true) {
          c.error = true;
          if (PERMISSION_DENIED.test(text)) c.denied = true;
        }
      }
    }
  }
  return { calls: [...calls.values()].map(({ results, ...c }) => ({ ...c, denied: c.denied || deniedIds.has(c.id), ok: results > 0 && !c.error })), otherTools };
}

/** A failed sentinel read's mark of a masked or unreadable file, per form. */
const UNREADABLE: Record<'cat' | 'node', RegExp> = {
  cat: /: (Permission denied|Operation not permitted|No such file or directory)\s*$/m,
  node: new RegExp(`${MASKED}|\\bE(ACCES|PERM|NOENT)\\b`),
};

/** The signals whose default ends the process, on which the sentinels are removed first. */
export const CLEANUP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Removes `sentinels` on SIGINT, SIGTERM or SIGHUP, then lets the signal take its course; returns the undo. */
function cleanUpOnSignals(sentinels: readonly Sentinel[]): () => void {
  const signals = CLEANUP_SIGNALS;
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
    const nodeCommand = (path: string) => `node -e "${READ_JS}" '${path}'`;
    const commands = [...sockets.map((s) => socketCommand(s.target)), ...sentinels.map((s) => readCommand(s.path)), ...sentinels.map((s) => nodeCommand(s.path))];
    const prompt = [
      'This is a sandbox check. Every command below is expected to fail; that is the point of the check.',
      'Run each one with the Bash tool, exactly as written, one command per Bash call, in this order. Run nothing else, and change nothing.',
      'When all have run, reply with the single word: done.',
      '',
      ...commands.map((c, i) => `${i + 1}. ${c}`),
    ].join('\n');
    const lines: unknown[] = [];
    const r = await o.runner.run({ role: 'sandbox-check', prompt, cwd: o.cwd, model: CONFIRM_MODEL, allowedTools: ['Bash'], maxTurns: commands.length + 3, maxBudgetUsd: CONFIRM_BUDGET_USD, stallMs: 120_000, timeoutMs: 600_000, onStreamLine: (l) => lines.push(l), ...(o.signal ? { signal: o.signal } : {}) });
    const { calls, otherTools } = readTranscript(lines);
    const everything = JSON.stringify(lines);
    const leakedSentinel = sentinels.filter((s) => everything.includes(s.content));
    const pingOk = calls.filter((c) => /_ping/.test(c.command) && PING_OK.test(c.output));
    // A listed command run exactly: the same command, with no other Bash input (a timeout, a background run...).
    const listed = new Set(commands);
    const isListed = (c: BashCall) => c.plain && listed.has(c.command.trim());
    // Anything the model ran beyond the listed commands: "model declined" at best (owner, 2026-10-19).
    const extra = [...calls.filter((c) => !isListed(c)).map((c) => `Bash: ${c.command.slice(0, 200)}${c.plain ? '' : ' (with other inputs)'}`), ...otherTools];
    const attempt = (kind: ConfirmAttempt['kind'], form: ConfirmAttempt['form'], target: string, command: string, protects: string, rule: string, content?: string): ConfirmAttempt => {
      const naming = calls.filter((c) => c.command.includes(target));
      const exact = calls.filter((c) => isListed(c) && c.command.trim() === command);
      const output = naming.map((c) => c.output).join('\n');
      // Positive evidence only: a command naming the target that didn't fail reached it, whatever it printed.
      const reached = naming.some((c) => c.ok) || (kind === 'read' ? content !== undefined && output.includes(content) : PING_OK.test(output));
      const failed = exact.filter((c) => c.error);
      const refused = !reached && failed.length > 0;
      // Fail closed: the OS sandbox only on a sentinel read's own mark of a masked or unreadable file, and only when the
      // model ran nothing else: an extra command (a chmod through a glob, say) could have made that mark itself (round 5).
      const layer: ConfirmLayer = reached
        ? null
        : !exact.length
          ? 'model declined'
          : failed.some((c) => c.denied)
            ? 'permission layer'
            : form !== 'curl' && !extra.length && failed.some((c) => UNREADABLE[form].test(c.output))
              ? 'OS sandbox'
              : 'unknown';
      return { kind, form, target, protects, rule, command, ran: exact.length > 0, output: output.slice(0, 300), result: reached ? 'reached' : refused ? 'refused' : 'not run', refused, layer };
    };
    const attempts = [
      ...sockets.map((s) => attempt('connect', 'curl', s.target, socketCommand(s.target), s.target, `the sandbox's denyRead of ${s.target} (or its folder)`)),
      ...sentinels.map((s) => attempt('read', 'cat', s.path, readCommand(s.path), s.protects, s.rule, s.content)),
      ...sentinels.map((s) => attempt('read', 'node', s.path, nodeCommand(s.path), s.protects, s.rule, s.content)),
    ];
    const reachedAt = attempts.filter((a) => a.result === 'reached');
    const status: SandboxConfirmation['status'] = leakedSentinel.length || pingOk.length || reachedAt.length ? 'leaked' : attempts.every((a) => a.result === 'refused') && !extra.length ? 'all refused' : 'model declined';
    const unparsed = attempts.filter((a) => a.form === 'node');
    const osReadDeny = !extra.length && unparsed.length > 0 && unparsed.every((a) => a.layer === 'OS sandbox');
    const layers = (['permission layer', 'OS sandbox', 'unknown'] as const).map((l) => `${attempts.filter((a) => a.result === 'refused' && a.layer === l).length} by ${l === 'unknown' ? 'no layer shown' : `the ${l}`}`).join(', ');
    const readDeny = osReadDeny ? "the OS sandbox's own read-deny refused every unparsed read (node -e)" : `the OS sandbox's own read-deny was not shown: ${unparsed.map((a) => a.layer ?? 'reached').join(', ') || 'no sentinel'} for the unparsed reads`;
    const detail =
      status === 'leaked'
        ? `from inside Claude Code's sandbox: ${[...leakedSentinel.map((s) => `the sentinel at ${s.path} (standing for ${s.protects}) was read`), ...pingOk.map((c) => `${c.command} answered OK`), ...reachedAt.map((a) => `a command naming ${a.target} (standing for ${a.protects}) did not fail`)].join('; ')}`
        : status === 'model declined'
          ? `sandbox confirmation: model declined (${attempts.filter((a) => a.result === 'not run').length} of ${attempts.length} commands not run exactly as written and refused; ${extra.length} other call(s) made; run ended ${r.reason}). The run relies on the srt preflight alone: ${SRT_LABEL}`
          : `every listed command ran and was refused, and nothing else ran (${attempts.length} commands, ${CONFIRM_MODEL}): ${layers}; ${readDeny}`;
    return { status, model: CONFIRM_MODEL, usage_equivalent_usd: r.costUsd, attempts, os_sandbox_read_deny: osReadDeny, extra_calls: extra, skipped, detail };
  } finally {
    off();
    removeSentinels(sentinels);
  }
}
