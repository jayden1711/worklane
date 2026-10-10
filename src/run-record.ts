// What an agent did in one run, as the dashboard shows it: each shell
// command with whether it failed and the first lines of its output, every
// file it wrote, and its final message. Recorded by the runner from the
// stream-json it already reads, into the coordinator's own state dir (the
// dashboard can't read the agent user's session files). Bounded in size and
// redacted; a recording problem never affects the run.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { redact } from './events/redact.js';

export const RUNS_DIR = 'runs';
/** Run records kept per state dir; the oldest go first. */
export const KEEP_RUNS = 500;
const MAX_STEPS = 400;
const MAX_COMMAND = 400;
const MAX_OUTPUT_LINES = 6;
const MAX_OUTPUT = 800;
const MAX_FINAL = 4000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface RunStep {
  /** A shell command, or a file the agent wrote. */
  kind: 'command' | 'write';
  tool: string;
  what: string;
  status: 'ok' | 'error' | 'no result';
  /** The exit code, when the tool's output names one. */
  exitCode: number | null;
  output: string;
}

export interface RunRecord {
  v: 1;
  id: string;
  issue: number | null;
  role: string;
  model: string;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
  costUsd: number | null;
  turns: number | null;
  steps: RunStep[];
  /** Repo-relative where possible; each once, in the order first written. */
  files: string[];
  /** Tool calls that were neither commands nor writes (reads, searches): counted, not listed. */
  otherTools: number;
  final: string;
  /** Some steps were dropped to keep the record bounded. */
  truncated: boolean;
}

export type RunSummary = Pick<RunRecord, 'id' | 'issue' | 'role' | 'model' | 'startedAt' | 'endedAt' | 'reason' | 'costUsd' | 'turns' | 'files' | 'truncated'> & { commands: number; failedCommands: number };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);
const firstLines = (s: string) => clip(s.trim().split('\n').slice(0, MAX_OUTPUT_LINES).join('\n'), MAX_OUTPUT);
const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text ?? '') : '')).join('') : '');

/** The issue a run belongs to, from its worktree or task file (issue-<n>). */
export function runIssue(cwd: string, taskFile?: string): number | null {
  for (const p of [cwd, taskFile ?? '']) {
    // Either separator, whatever platform this runs on.
    const m = (p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').match(/^issue-(\d+)(\.json)?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

export class RunRecorder {
  private rec: RunRecord;
  private pending = new Map<string, RunStep>();
  private cwd: string;

  constructor(
    private stateDir: string,
    o: { role: string; model: string; cwd: string; taskFile?: string; issue?: number },
    now = new Date(),
  ) {
    const id = `${now.toISOString().replace(/[:.]/g, '-')}-${o.role.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomBytes(3).toString('hex')}`;
    this.rec = { v: 1, id, issue: o.issue ?? runIssue(o.cwd, o.taskFile), role: o.role, model: o.model, startedAt: now.toISOString(), endedAt: null, reason: null, costUsd: null, turns: null, steps: [], files: [], otherTools: 0, final: '', truncated: false };
    this.cwd = o.cwd;
  }

  get id() {
    return this.rec.id;
  }

  /** One stream-json line from the agent's session. */
  line(j: unknown): void {
    try {
      const m = j as { type?: string; message?: { content?: unknown } };
      const content = Array.isArray(m.message?.content) ? (m.message!.content as Record<string, unknown>[]) : [];
      if (m.type === 'assistant') {
        for (const c of content) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) this.rec.final = clip(c.text, MAX_FINAL);
          if (c.type !== 'tool_use') continue;
          const input = (c.input ?? {}) as Record<string, unknown>;
          const tool = String(c.name);
          let step: RunStep | null = null;
          if (tool === 'Bash') step = { kind: 'command', tool, what: clip(String(input.command ?? ''), MAX_COMMAND), status: 'no result', exitCode: null, output: '' };
          else if (WRITE_TOOLS.has(tool)) {
            const file = this.relative(String(input.file_path ?? input.notebook_path ?? ''));
            if (file && !this.rec.files.includes(file)) this.rec.files.push(file);
            step = { kind: 'write', tool, what: file, status: 'no result', exitCode: null, output: '' };
          } else this.rec.otherTools++;
          if (!step) continue;
          if (this.rec.steps.length >= MAX_STEPS) {
            this.rec.truncated = true;
            continue;
          }
          this.rec.steps.push(step);
          if (typeof c.id === 'string') this.pending.set(c.id, step);
        }
      } else if (m.type === 'user') {
        for (const c of content) {
          if (c.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
          const step = this.pending.get(c.tool_use_id);
          if (!step) continue;
          this.pending.delete(c.tool_use_id);
          const out = text(c.content);
          step.status = c.is_error ? 'error' : 'ok';
          const code = out.match(/\bexit(?:ed with)? code:? (\d+)/i);
          step.exitCode = code ? Number(code[1]) : step.status === 'ok' && step.kind === 'command' ? 0 : null;
          step.output = firstLines(out);
        }
      }
    } catch {
      // a line we can't read is left out
    }
  }

  /** Write the record when the run ends; keeps only the newest KEEP_RUNS. Never throws. */
  finish(end: { reason: string; costUsd: number; turns: number; model: string; final?: string }, now = new Date()): string | null {
    try {
      Object.assign(this.rec, { endedAt: now.toISOString(), reason: end.reason, costUsd: end.costUsd, turns: end.turns, model: end.model });
      // The session's own result text is its final message; else the last thing it said.
      if (end.final?.trim()) this.rec.final = clip(end.final, MAX_FINAL);
      const dir = join(this.stateDir, RUNS_DIR);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${this.rec.id}.json`);
      const tmp = join(dir, `.${this.rec.id}.tmp`);
      writeFileSync(tmp, JSON.stringify(redact(this.rec)), { mode: 0o600 });
      renameSync(tmp, file);
      const all = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_RUNS))) rmSync(join(dir, old), { force: true });
      return file;
    } catch {
      return null;
    }
  }

  private relative(p: string): string {
    const root = this.cwd.replace(/[\\/]+$/, '');
    return p.startsWith(root + '/') || p.startsWith(root + '\\') ? p.slice(root.length + 1) : p;
  }
}

const VALID_ID = /^[A-Za-z0-9_-]+$/;

/** One run's record, or null (unknown, or not a valid id: never a path outside the runs dir). */
export function readRun(stateDir: string, id: string): RunRecord | null {
  if (!VALID_ID.test(id)) return null;
  const f = join(stateDir, RUNS_DIR, `${id}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

/** An issue's runs, oldest first, without their steps. */
export function runsForIssue(stateDir: string, issue: number): RunSummary[] {
  const dir = join(stateDir, RUNS_DIR);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const f of files) {
    const r = readRun(stateDir, f.slice(0, -'.json'.length));
    if (!r || r.issue !== issue) continue;
    const { steps, otherTools: _o, final: _f, v: _v, ...rest } = r;
    const commands = steps.filter((s) => s.kind === 'command');
    out.push({ ...rest, commands: commands.length, failedCommands: commands.filter((s) => s.status === 'error').length });
  }
  return out;
}
