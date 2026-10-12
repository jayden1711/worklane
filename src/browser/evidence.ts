// Browser-check evidence for a PR description (Track B): why checks ran (or didn't), then per flow its result,
// what was seen, and, for a UI fix, the reproduction run before the change beside the run after it. Built from
// the recorded evidence alone; bounded, so a noisy app can't flood the description.
import { basename } from 'node:path';
import type { BrowserGate } from './gate.js';
import type { BrowserCheckResult } from './check.js';
import type { FlowEvidence } from './run.js';

/** Text in a markdown list: one line, no backticks, bounded. */
const plain = (s: string, max = 200) => {
  const one = s.split('\n')[0]!.replace(/`/g, "'").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};
/** Text from the app (console messages, URLs) as a code span, so its markup, HTML or @mentions never render. */
const quoted = (s: string, max = 200) => `\`${plain(s, max) || ' '}\``;

/** What a run saw, in one line: the counts a reviewer compares before and after. */
export function evidenceSummary(ev: FlowEvidence): string {
  const t = ev.trace;
  const trace = t ? `longest task ${t.maxTaskMs} ms, ${t.droppedFramePct === null ? 'frames not measured' : `${t.droppedFramePct}% frames dropped`}` : 'no trace';
  const stepsOk = ev.steps.filter((s) => s.ok).length;
  return `${stepsOk}/${ev.steps.length} steps held, ${ev.consoleErrors.length} console error(s), ${ev.failedRequests.length} failed request(s), ${ev.slowRequests.length} slow, ${trace}`;
}

const LIST_MAX = 5;
function listed<T>(label: string, items: T[], line: (x: T) => string): string[] {
  if (!items.length) return [];
  return [`  - ${label}:`, ...items.slice(0, LIST_MAX).map((x) => `    - ${line(x)}`), ...(items.length > LIST_MAX ? [`    - and ${items.length - LIST_MAX} more`] : [])];
}

/** The PR description's browser section. `before` is the same flow's reproduction run, for a UI fix. */
export function browserEvidenceLines(o: { gate: BrowserGate; runs: { result: BrowserCheckResult; before?: FlowEvidence | null }[] }): string[] {
  const out = ['### BROWSER CHECKS', `- Why: ${plain(o.gate.reason, 300)}`];
  if (o.gate.uiFiles.length) out.push(`- UI files touched: ${o.gate.uiFiles.map((f) => `\`${plain(f, 120)}\``).join(', ')}`);
  if (!o.gate.flows.length) return out;
  for (const { result: r, before } of o.runs) {
    out.push(`- \`${plain(r.check, 80)}\`: ${r.status}`);
    const ev = r.evidence;
    if (!ev) {
      out.push(`  - ${quoted(r.tail, 300)}`);
      continue;
    }
    if (before) out.push(`  - before the change: ${evidenceSummary(before)}`, `  - after the change: ${evidenceSummary(ev)}`);
    else out.push(`  - ${evidenceSummary(ev)}`);
    for (const reason of r.verdict?.reasons ?? []) out.push(`  - failed: ${quoted(reason, 300)}`);
    out.push(
      ...listed('console errors', ev.consoleErrors, (e) => `${e.kind}: ${quoted(e.text)}`),
      ...listed('failed requests', ev.failedRequests, (q) => `${q.method} ${quoted(q.url, 150)} (${q.status ?? plain(q.error ?? '', 60)})`),
      ...listed('slow requests', ev.slowRequests, (q) => `${q.method} ${quoted(q.url, 150)}: ${q.ms} ms`),
      ...listed('refused (not the app on localhost)', ev.blockedRequests, (q) => quoted(q, 150)),
    );
    for (const n of r.verdict?.notes ?? []) out.push(`  - note: ${plain(n, 300)}`);
    // The file's name only: the path is the run's machine, which the PR's readers don't share.
    if (ev.screenshot) out.push(`  - screenshot: ${quoted(basename(ev.screenshot), 120)} (kept with the run)`);
  }
  return out;
}
