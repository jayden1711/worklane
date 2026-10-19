// WHY: a sandbox check that failed once at coordinator start used to switch test runs off for the life of the
// process, silently: nothing in the journal, no check on any PR. The check can fail for a reason that passes by
// itself (an engine update starts every unit of the machine at the same moment). So the result is held here and the
// check is run again while it fails, 30 s, 1 min and 2 min after a failure and then every 5 min; when it passes, the
// test runs go on in the running coordinator. Every failure and the recovery are said on stderr (the journal), and
// recorded (`testrun.sandbox`: health, the dashboard and the watchdog's test_sandbox incident read the newest).
//
// INVARIANT: `ok` is true only after the host's own check passed, in full, in this process. Nothing here passes a
// check, shortens it or skips it: while it fails, a test run is refused before anything starts (./run.ts).
import type { EventLog } from '../events/log.js';

/** How long after each failed check the next one runs: the first three, then SANDBOX_RETRY_MAX_MS every time. */
export const SANDBOX_RETRY_MS = [30_000, 60_000, 120_000] as const;
export const SANDBOX_RETRY_MAX_MS = 300_000;
export const sandboxRetryMs = (failures: number): number => SANDBOX_RETRY_MS[failures - 1] ?? SANDBOX_RETRY_MAX_MS;

/** What a run reads before it starts (./run.ts): the newest check's result. */
export interface SandboxState {
  readonly ok: boolean;
  /** The check's FAIL lines, or why it couldn't run; "all checks passed" when ok. */
  readonly detail: string;
}

export interface SandboxWatchDeps {
  /** The host's own check (RunHost.check). A check that throws didn't run, and so failed. */
  check: () => Promise<{ ok: boolean; detail: string; unsupported?: string }>;
  log: EventLog;
  actor: string;
  /** A line for the journal (default: stderr). */
  say?: (line: string) => void;
  /** After a check passed, each time it passes after failing or for the first time: the test runs go on from here. */
  passed?: () => void | Promise<void>;
  /** A one-shot timer (tests inject one); the default doesn't keep the process alive. */
  timer?: (fn: () => void, ms: number) => { cancel(): void };
  now?: () => number;
}

const every = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const indent = (detail: string) => detail.split('\n').map((l) => `  ${l}`).join('\n');

export class SandboxWatch implements SandboxState {
  private state = { ok: false, detail: 'the sandbox check has not run yet' };
  private failures = 0;
  private failingSince: number | null = null;
  private inFlight: Promise<boolean> | null = null;
  private next: { cancel(): void } | null = null;
  private recorded: string | null = null;
  private stopped = false;

  constructor(private d: SandboxWatchDeps) {}

  get ok(): boolean {
    return this.state.ok;
  }

  get detail(): string {
    return this.state.detail;
  }

  /** Checks failed in a row since the last pass. */
  get failed(): number {
    return this.failures;
  }

  /**
   * Run the check once; while it fails, the next one is scheduled from here. INVARIANT: never two at once: a call
   * while one runs gets that one's result (the check makes a probe run in the sandbox, and wipes it).
   */
  check(): Promise<boolean> {
    this.inFlight ??= this.once().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async once(): Promise<boolean> {
    this.next?.cancel();
    this.next = null;
    const now = this.d.now ?? Date.now;
    const say = this.d.say ?? ((line: string) => console.error(line));
    const r: { ok: boolean; detail: string; unsupported?: string } = await this.d.check().catch((e: Error) => ({ ok: false, detail: `the check didn't run: ${e.message}` }));
    const detail = r.detail.slice(0, 2000);
    // Shown only (doctor, the Machine page): never part of ok, and the state a run reads has no such field.
    const unsupported = r.unsupported?.slice(0, 500);
    // WHY: one event per change, not one per check: the watchdog and the dashboard read the newest, and a sandbox
    // that stays broken for a day would otherwise write 288 identical events.
    const key = `${r.ok} ${unsupported ?? ''} ${detail}`;
    if (key !== this.recorded) {
      this.d.log.append('testrun.sandbox', { ok: r.ok, detail, ...(unsupported ? { unsupported } : {}) }, this.d.actor);
      this.recorded = key;
    }
    if (r.ok) {
      const was = this.failures;
      const since = this.failingSince;
      this.failures = 0;
      this.failingSince = null;
      this.state = { ok: true, detail };
      if (was) say(`test runs are on again: the test sandbox check passed, after ${was} failed check${was === 1 ? '' : 's'} over ${every(Math.max(0, now() - (since ?? now())))}; no restart needed`);
      if (!this.stopped) {
        try {
          await this.d.passed?.();
        } catch (e) {
          say(`test runs: after the sandbox check passed: ${(e as Error).message.slice(0, 500)}`);
        }
      }
      return true;
    }
    this.failures += 1;
    this.failingSince ??= now();
    const changed = detail !== this.state.detail;
    this.state = { ok: false, detail };
    const wait = sandboxRetryMs(this.failures);
    const head = `test runs are OFF: the test sandbox check failed (${this.failures} in a row); no test run starts until it passes. Checked again in ${every(wait)}; test runs go on by themselves when it passes.`;
    // WHY: the FAIL lines the first time and whenever they change; the same lines again every 5 minutes say nothing new.
    say(changed || this.failures === 1 ? `${head}\n${indent(detail)}` : `${head} The same failure as before.`);
    if (!this.stopped) this.next = (this.d.timer ?? defaultTimer)(() => void this.check(), wait);
    return false;
  }

  /** The coordinator is stopping: no further check is scheduled, and one in flight changes nothing more. */
  stop(): void {
    this.stopped = true;
    this.next?.cancel();
    this.next = null;
  }
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const t = setTimeout(fn, ms);
  // WHY: a pending re-check must not hold a stopping coordinator open (the run loop holds it while it runs).
  t.unref();
  return { cancel: () => clearTimeout(t) };
}
