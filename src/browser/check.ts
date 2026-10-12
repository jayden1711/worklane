// The `browser:` done_when check (Track B): run one of the app's flows and judge it. It passes only when the
// flow ran to the end with no NEW console errors and no NEW failed requests (new against a baseline run of the
// same flow, e.g. on main or before the fix; with no baseline, any counts) and the trace held the app's
// thresholds. Slow and blocked requests are reported, never judged. A check that couldn't run (no browser on
// the machine, no app declared) is unavailable, never passed.
//
// The coordinator's DoneWhen doesn't accept `browser:` yet: its verify() would pass over a kind it doesn't run.
// The wiring adds BrowserDoneWhenItem to DoneWhen and calls runBrowserCheck from verify(), together.
import { z } from 'zod';
import { BRAND } from '../brand.js';
import type { AppConfig } from '../config/schema.js';
import { runFlow, type FlowEvidence, type FlowRun } from './run.js';

/** A done_when item: `- browser: checkout` runs the app's `checkout` flow. */
export const BrowserDoneWhenItem = z.strictObject({ browser: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a flow name from app.yaml') });
export type BrowserDoneWhenItem = z.infer<typeof BrowserDoneWhenItem>;

export interface BrowserVerdict {
  pass: boolean;
  /** Why it failed, one line each; empty when it passed. */
  reasons: string[];
  /** What was seen but not judged (slow and blocked requests, frames not measured). */
  notes: string[];
}

/** A console error, compared without its line and column, or a query string, which move between runs. */
const errorKey = (e: { kind: string; text: string }) => `${e.kind}:${e.text.replace(/:\d+(:\d+)?\b/g, '').replace(/\?[^\s)]*/g, '').trim()}`;
/** A failed request, by method, path and status (the port and query differ between runs). */
const requestKey = (r: { method: string; url: string; status: number | null; error: string | null }) => {
  let path = r.url;
  try {
    path = new URL(r.url).pathname;
  } catch {
    // not a URL: as it is
  }
  return `${r.method} ${path} ${r.status ?? r.error ?? ''}`;
};

/** Judge a flow's evidence against the app's thresholds, and against a baseline run of the same flow if there is one. */
export function judgeFlow(ev: FlowEvidence, thresholds: AppConfig['thresholds'], baseline?: FlowEvidence | null): BrowserVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];
  const failed = ev.steps.find((s) => !s.ok);
  if (failed) reasons.push(`step "${failed.step}" failed: ${failed.error ?? 'no reason given'}`);
  const knownErrors = new Set((baseline?.consoleErrors ?? []).map(errorKey));
  const newErrors = ev.consoleErrors.filter((e) => !knownErrors.has(errorKey(e)));
  for (const e of newErrors.slice(0, 5)) reasons.push(`new console ${e.kind === 'exception' ? 'exception' : 'error'}: ${e.text.split('\n')[0]!.slice(0, 200)}`);
  if (newErrors.length > 5) reasons.push(`and ${newErrors.length - 5} more new console errors`);
  const knownRequests = new Set((baseline?.failedRequests ?? []).map(requestKey));
  const newFailed = ev.failedRequests.filter((r) => !knownRequests.has(requestKey(r)));
  for (const r of newFailed.slice(0, 5)) reasons.push(`new failed request: ${r.method} ${r.url} (${r.status ?? r.error})`);
  if (newFailed.length > 5) reasons.push(`and ${newFailed.length - 5} more new failed requests`);
  if (ev.trace) {
    if (ev.trace.maxTaskMs > thresholds.max_long_task_ms) reasons.push(`a main-thread task took ${ev.trace.maxTaskMs} ms (the limit is ${thresholds.max_long_task_ms} ms)`);
    if (ev.trace.droppedFramePct === null) notes.push('dropped frames not measured (the trace had no frame events)');
    else if (ev.trace.droppedFramePct > thresholds.max_dropped_frame_pct) reasons.push(`${ev.trace.droppedFramePct}% of frames dropped (the limit is ${thresholds.max_dropped_frame_pct}%)`);
  } else notes.push('no performance trace was recorded');
  if (ev.slowRequests.length) notes.push(`${ev.slowRequests.length} slow request(s), slowest ${Math.max(...ev.slowRequests.map((r) => r.ms))} ms`);
  if (ev.blockedRequests.length) notes.push(`${ev.blockedRequests.length} request(s) to other hosts refused`);
  return { pass: reasons.length === 0, reasons, notes };
}

/** A browser check's result, in the shape of the coordinator's other checks, with its evidence. */
export interface BrowserCheckResult {
  check: string;
  status: 'pass' | 'fail' | 'unavailable';
  kind: 'browser';
  exitCode: null;
  tail: string;
  evidence: FlowEvidence | null;
  verdict: BrowserVerdict | null;
}

/**
 * Run a `browser:` check: the flow from the project's app, judged. Unavailable (never passed) without an app or
 * a browser; failed for an unknown flow, or an app that doesn't start.
 */
export async function runBrowserCheck(o: { item: BrowserDoneWhenItem; app: AppConfig | undefined; cwd: string; outDir: string; baseline?: FlowEvidence | null; chrome?: string | null; runAs?: { user: string; home: string } }): Promise<BrowserCheckResult> {
  const check = `browser ${o.item.browser}`;
  const result = (status: BrowserCheckResult['status'], tail: string, evidence: FlowEvidence | null = null, verdict: BrowserVerdict | null = null): BrowserCheckResult => ({ check, status, kind: 'browser', exitCode: null, tail, evidence, verdict });
  if (!o.app) return result('unavailable', `no app is declared (${BRAND.configDir}/app.yaml), so there is nothing to run a browser check against`);
  if (!o.app.flows[o.item.browser]) return result('fail', `no flow "${o.item.browser}" in app.yaml (it has: ${Object.keys(o.app.flows).join(', ')})`);
  let run: FlowRun;
  try {
    run = await runFlow({ app: o.app, flow: o.item.browser, cwd: o.cwd, outDir: o.outDir, ...(o.chrome !== undefined ? { chrome: o.chrome } : {}), ...(o.runAs ? { runAs: o.runAs } : {}) });
  } catch (e) {
    return result('fail', `the app couldn't be run: ${(e as Error).message.slice(0, 1500)}`);
  }
  if ('skipped' in run) return result('unavailable', run.skipped);
  const verdict = judgeFlow(run, o.app.thresholds, o.baseline);
  const tail = [...(verdict.pass ? ['passed'] : verdict.reasons), ...verdict.notes.map((n) => `note: ${n}`)].join('\n');
  return result(verdict.pass ? 'pass' : 'fail', tail, run, verdict);
}
