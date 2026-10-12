// The coordinator's browser checks (Track B), for verify(): which flows run (src/browser/gate.ts), each run and
// judged (src/browser/check.ts), recorded as checks with kind 'browser', and the PR's BROWSER CHECKS section.
//
// A flow the issue asks for is a check like any other: unavailable (no app, no browser) fails the attempt, as
// verify() fails anything that isn't a pass. A flow run only because the change touched ui_paths is held to its
// result too, except that with no browser on the machine it is listed and skipped: a project's UI changes don't
// all stop because one machine lacks Chrome, and the PR says so.
import { join } from 'node:path';
import type { DoneWhenList } from '../backlog/types.js';
import type { AppConfig } from '../config/schema.js';
import { runBrowserCheck, type BrowserCheckResult } from '../browser/check.js';
import { browserEvidenceLines } from '../browser/evidence.js';
import { askedFlows, browserGate, type BrowserGate } from '../browser/gate.js';
import type { RunAs } from '../runner.js';

export interface BrowserCheckRecord {
  check: string;
  status: 'pass' | 'fail' | 'unavailable';
  kind: 'browser';
  exitCode: null;
  tail: string;
  duration_ms?: number;
}

export interface BrowserChecks {
  gate: BrowserGate;
  /** What verify() adds to its checks: every asked flow, and every gated flow that ran. */
  checks: BrowserCheckRecord[];
  /** The PR description's section; empty when the project has no app and the issue asked for nothing. */
  lines: string[];
}

/** The files of the change proposed at `head` (none for a head no change was proposed at, such as the base). */
export function changedAt(events: readonly { type: string; payload: unknown }[], head: string): string[] {
  const p = events.filter((e) => e.type === 'change.proposed').map((e) => e.payload as { head: string; files: string[] }).filter((c) => c.head === head).at(-1);
  return p?.files ?? [];
}

export async function browserChecks(o: {
  app: AppConfig | undefined;
  doneWhen: DoneWhenList;
  /** The change's files (repo-relative); none when verifying an unchanged base. */
  changed: readonly string[];
  cwd: string;
  /** Where each flow's evidence (its screenshot) goes. */
  outDir: string;
  runAs?: RunAs;
  /** Tests: null means no browser on this machine. */
  chrome?: string | null;
  run?: typeof runBrowserCheck;
}): Promise<BrowserChecks> {
  const asked = askedFlows(o.doneWhen);
  const gate = browserGate({ app: o.app, changed: o.changed, asked });
  const run = o.run ?? runBrowserCheck;
  const results: { flow: string; result: BrowserCheckResult }[] = [];
  for (const flow of gate.flows) {
    results.push({
      flow,
      result: await run({
        item: { browser: flow },
        app: o.app,
        cwd: o.cwd,
        outDir: join(o.outDir, flow),
        ...(o.chrome !== undefined ? { chrome: o.chrome } : {}),
        ...(o.runAs ? { runAs: { user: o.runAs.user, home: o.runAs.home } } : {}),
      }),
    });
  }
  const checks = results
    .filter(({ flow, result }) => asked.includes(flow) || result.status !== 'unavailable')
    .map(({ result: r }): BrowserCheckRecord => ({ check: r.check, status: r.status, kind: 'browser', exitCode: null, tail: r.tail, ...(r.evidence ? { duration_ms: r.evidence.durationMs } : {}) }));
  const lines = o.app || asked.length ? browserEvidenceLines({ gate, runs: results.map(({ result }) => ({ result })) }) : [];
  return { gate, checks, lines };
}
