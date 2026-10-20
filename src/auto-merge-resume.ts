// WHY (#776, owner decision on #698 decision 1, amended in #775): resuming auto-merge after a stop is not turning it on.
// It stays an owner's action on the dashboard, audited. But a stop the default branch caused (a red main after an
// auto-merge, `red_main`; or the main watch's unaccounted commit, `main_watch`) resumes only when main's required
// checks are green on its current tip, measured at that moment, or with an owner's explicit acknowledgement, a typed
// reason recorded in the event log with who and when. Any other stop resumes as before.
//
// INVARIANT: one judge. The coordinator alone measures main and resumes such a stop (#776 on #727, the owner's
// decision): the dashboard records a resume request (merge.resume_requested) and never reads a check; the coordinator
// answers it with mayResume (coordinator/merge-flow.ts resumeRequested), recording each measurement
// (merge.main_measured), and writes back a stop file deleted by hand (stopGoneByHand) while main isn't measured green.
// Main's checks are JudgedChecks, so a pinned required check is green only from its pinned source.
// Fail closed: a stop with no `by`, an unknown one, or an unreadable stop file waits for green main; main with no
// required checks configured, a tip that can't be read, or checks that can't be read is not green.
import { spawn } from 'node:child_process';
import type { JudgedChecks } from './check-source.js';
import { killTree, spawnDetached } from './os/index.js';
import { requiredOutcomes } from './pr-watch.js';

/** Who stopped auto-merge, as the stop file and `merge.stopped` record it. */
export const STOP_BY = ['red_main', 'main_watch', 'owner'] as const;
export type StopBy = (typeof STOP_BY)[number];

/** The only stops that resume as before (no green main needed). Anything else, or nothing, waits for green main. */
const RESUMES_AS_BEFORE: ReadonlySet<string> = new Set<StopBy>(['owner']);

/** Whether a stop by `by` waits for green main (or an acknowledgement) before it may resume. */
export function stopWaitsForGreen(by: unknown): boolean {
  return !(typeof by === 'string' && RESUMES_AS_BEFORE.has(by));
}

/** Main's state at the moment of a resume: green on `tip`, or not, and why. */
export type MainState = { green: true; tip: string } | { green: false; tip: string | null; why: string };

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Every one of `required` passes on the default branch's current tip; anything else, or anything unreadable, is not
 * green. `checks` gives the tip's checks as the engine judges them (#727: JudgedChecks, made only by PinnedChecks), so a
 * pinned required check passes here only from its pinned source, by the verdict readiness and the main watch use.
 */
export async function measureMain(o: { branch: string; required: string[]; tip: () => string | null | Promise<string | null>; checks: (sha: string) => Promise<JudgedChecks> }): Promise<MainState> {
  if (!o.required.length) return { green: false, tip: null, why: `no required checks are configured (required_checks in config.yaml), so ${o.branch} can't be measured green` };
  let tip: string | null = null;
  try {
    tip = await o.tip();
  } catch {
    tip = null;
  }
  if (!tip || !SHA.test(tip)) return { green: false, tip: null, why: `${o.branch}'s tip can't be read from the remote` };
  let checks: JudgedChecks;
  try {
    checks = await o.checks(tip);
  } catch (e) {
    return { green: false, tip, why: `the checks on ${o.branch}'s tip ${tip.slice(0, 8)} can't be read (${String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 200)})` };
  }
  const notGreen = requiredOutcomes(o.required, checks).filter((c) => c.outcome !== 'pass');
  if (notGreen.length) return { green: false, tip, why: `${o.branch}'s required checks on its tip ${tip.slice(0, 8)} are not all green (${notGreen.map((c) => `${c.name}: ${c.outcome}`).join(', ')})` };
  return { green: true, tip };
}

/** How long reading main's tip may take before it counts as unreadable (not green). */
export const MAIN_TIP_TIMEOUT_MS = 10_000;

/**
 * The default branch's tip on the remote now (`git ls-remote`), or null when it can't be read: never a clone's
 * last-fetched ref, which a failed fetch leaves behind and which may be an older, green commit. Only the line whose ref
 * is exactly `refs/heads/<branch>` counts (git's pattern also lists `refs/heads/a/refs/heads/main` and
 * `refs/tags/refs/heads/main`, which anyone who can push may plant); none, or more than one, is unreadable. Run
 * asynchronously with a timeout, so neither the dashboard's event loop nor the coordinator's waits on a hung remote.
 */
export function remoteTip(repo: string, remote: string, branch: string, o: { timeoutMs?: number } = {}): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  return new Promise((done) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (sha: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      done(sha);
    };
    // In its own process group, so a timeout kills git and everything it started (the transport: git-remote-https,
    // ssh, upload-pack), never leaving one holding a connection.
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['ls-remote', remote, ref], { cwd: repo, detached: spawnDetached, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    timer = setTimeout(() => {
      killTree(child.pid, () => child.kill('SIGKILL'));
      finish(null);
    }, o.timeoutMs ?? MAIN_TIP_TIMEOUT_MS);
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      out += d;
      if (out.length > 4 * 1024 * 1024) {
        killTree(child.pid, () => child.kill('SIGKILL'));
        finish(null);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const exact = out
        .split('\n')
        .map((l) => l.split('\t'))
        .filter((p) => p.length === 2 && p[1] === ref);
      const sha = exact.length === 1 ? exact[0]![0]! : '';
      finish(SHA.test(sha) ? sha : null);
    });
  });
}

/** Main now, the one way every surface measures it: the remote's tip (remoteTip) and the required checks on it. */
export function mainNow(o: { repo: string; remote: string; branch: string; required: string[]; checks: (sha: string) => Promise<JudgedChecks>; timeoutMs?: number }): Promise<MainState> {
  return measureMain({ branch: o.branch, required: o.required, tip: () => remoteTip(o.repo, o.remote, o.branch, o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}), checks: o.checks });
}

// The typed reason's one validator (src/ack-reason.ts), shared with the event schema and the coordinator.
export { ACK_MAX, ACK_MIN, acknowledgement } from './ack-reason.js';

export type ResumeVerdict =
  | { ok: true; how: 'as_before' | 'green' | 'acknowledged'; main: MainState | null }
  | { ok: false; error: string; needsAck: true; main: MainState };

/**
 * Whether a stop may resume now. `gated`: the stop waits for green main (stopWaitsForGreen of the stop file's `by`
 * and of the last `merge.stopped`). Main is measured for every gated stop, an acknowledged one too, so what it was
 * is recorded with the resume.
 */
export async function mayResume(o: { gated: boolean; ack: string | null; measure: () => Promise<MainState> }): Promise<ResumeVerdict> {
  if (!o.gated) return { ok: true, how: 'as_before', main: null };
  const main = await o.measure();
  if (main.green) return { ok: true, how: 'green', main };
  if (o.ack) return { ok: true, how: 'acknowledged', main };
  return { ok: false, needsAck: true, main, error: `auto-merge stopped because of the default branch, and it resumes only once it is green: ${main.why}. Resume anyway only with an explicit acknowledgement (a typed reason, recorded)` };
}
