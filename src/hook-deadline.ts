// The agents' tool guard answers every PreToolUse call within GUARD_BUDGET_MS, and refuses a call it hasn't decided by
// then (#887 review: one Bash call kept the guard busy for 43.5 s).
//
// WHY the deadline is held outside the code that decides: Claude Code cancels a command hook that runs past its
// timeout (30 s, src/install.ts) and, unless the hook's onFailure is "block", lets the tool call go ahead. A timer in
// the process that evaluates can't fire while that process is stuck in synchronous code (a walk of a large tree, a
// regex, a spawnSync), and a worker thread can't be stopped while it waits in native code (node joins it at exit). So
// src/hook-main.ts runs the evaluation as a child process of its own, and the process Claude Code waits on runs no guard
// code: it reads the call, holds the deadline, and answers itself when the child hasn't. A child that is still running
// at the deadline is killed; this process never waits on it.
//
// INVARIANT: an answer that lets the call through (exit 0) is passed on only when the child ended by itself with exit 0
// and wrote its verdict line (VERDICT_FD) saying so. Every other ending is a refusal: the deadline, a spawn error, a
// signal, an exit code other than 0 or 2, a missing or different verdict, output past OUTPUT_CAP, or an error here.
// A refusal is a deny decision on stdout, its reason on stderr, and exit code 2, which Claude Code blocks on.
import { spawn } from 'node:child_process';
import { BRAND } from './brand.js';

/**
 * How long the guard may take to decide one call. WHY 10 s: a third of the hook's 30 s timeout (src/install.ts), so
 * node's start and a loaded machine still leave this process 20 s to answer before Claude Code would cancel it; and
 * some 50 times what an ordinary call takes through the guard's two processes (test/hook-deadline.test.ts reports the
 * corpus's p50 and p95). A call that needs longer is refused, and the agent narrows it.
 */
export const GUARD_BUDGET_MS = 10_000;

/** The argument that makes src/hook-main.ts the evaluating child: `hook-main.js --evaluate <event>`. */
export const EVALUATE_ARG = '--evaluate';

/** The child's extra descriptor: the exit code it decided, as one line, written just before it exits. */
export const VERDICT_FD = 3;

/** The most stdout or stderr the child may write (each); more is a refusal. The guard's answers are a few hundred bytes. */
export const OUTPUT_CAP = 1024 * 1024;

export interface GuardAnswer {
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
}

/** The refusal for a call the guard couldn't decide: deny on stdout, the reason on stderr, exit code 2. */
export function refusal(reason: string): GuardAnswer {
  const why = `[${BRAND.cli}] ${reason}`;
  return {
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }),
    stderr: `${why}\n`,
    exitCode: 2,
  };
}

/** The evaluating process: a program and its arguments (src/hook-main.ts gives node and its own file). */
export interface Evaluator {
  file: string;
  args: readonly string[];
}

/**
 * Runs the evaluator with `input` on its stdin, and answers within `budgetMs`: the evaluator's own answer when it
 * decided in time (see the INVARIANT above), a refusal otherwise. Never rejects.
 */
export function underDeadline(evaluator: Evaluator, input: NodeJS.ReadableStream | string, budgetMs: number = GUARD_BUDGET_MS): Promise<GuardAnswer> {
  return new Promise<GuardAnswer>((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const settle = (a: GuardAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve(a);
    };
    const refuse = (why: string) => settle(refusal(`${why}; this tool call is refused. The guard has ${budgetMs / 1000} s to decide a call: narrow it (fewer paths or words) and try again.`));
    // First, before anything can wait: the deadline.
    const timer = setTimeout(() => refuse(`the tool guard did not decide within ${budgetMs / 1000} s`), budgetMs);
    try {
      child = spawn(evaluator.file, [...evaluator.args], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const verdict: Buffer[] = [];
      const collect = (into: Buffer[]) => {
        let size = 0;
        return (c: Buffer) => {
          size += c.length;
          if (size > OUTPUT_CAP) return refuse(`the tool guard wrote more than ${OUTPUT_CAP} bytes`);
          into.push(c);
        };
      };
      child.stdout!.on('data', collect(out));
      child.stderr!.on('data', collect(err));
      child.stdio[VERDICT_FD]!.on('data', collect(verdict));
      // WHY: a pipe that breaks (the child gone mid-write) must not throw here; the child's ending decides.
      for (const s of [child.stdin!, child.stdout!, child.stderr!, child.stdio[VERDICT_FD]!]) s.on('error', () => {});
      child.on('error', (e) => refuse(`the tool guard could not start (${e.message})`));
      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        // A refusal by exit code is passed on as the guard wrote it, verdict or not: it blocks either way.
        if (code === 2 && signal === null) return settle({ stdout, stderr, exitCode: 2 });
        const said = Buffer.concat(verdict).toString('utf8');
        if (code === 0 && signal === null && said === '0\n') return settle({ stdout, stderr, exitCode: 0 });
        const how = signal ? `was killed (${signal})` : code === 0 ? 'ended without a verdict of 0' : `ended with exit code ${code}`;
        refuse(`the tool guard ${how}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]!.slice(0, 300)}` : ''}`);
      });
      if (typeof input === 'string') child.stdin!.end(input);
      else {
        input.on('error', (e: Error) => refuse(`the tool call could not be read (${e.message})`));
        input.pipe(child.stdin!);
      }
    } catch (e) {
      refuse(`the tool guard could not run (${(e as Error).message})`);
    }
  });
}
