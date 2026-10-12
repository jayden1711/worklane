// Claims receipts: what a PR's change was actually checked against, from the record alone (no agent run).
// VERIFIED is each check the coordinator ran, with its result. NOT VERIFIED is anything the worker claimed that
// no recorded command or check backs ("tested on mobile"): listed, never counted as evidence, and it lowers the
// evaluator's confidence. NOT CHECKED is the manual done_when items and the checks that were skipped.
import type { DoneWhenList } from './backlog/types.js';

export interface CheckRecord {
  check: string;
  status: 'pass' | 'fail' | 'unavailable' | 'skipped';
  exitCode?: number | null | undefined;
  duration_ms?: number | undefined;
}

/** A sentence that says something was verified: tested, checked, confirmed, ran, passes, works. */
const VERIFYING = /\b(test(?:ed|s)?|verif(?:y|ied|ies)|check(?:ed|s)?|confirm(?:ed|s)?|ran|runs?|pass(?:es|ed|ing)?|works?|working|reproduc(?:e|ed|es))\b/i;
/** Places and ways the coordinator never checks: a claim about them is only as good as a recorded command. */
const UNCHECKED_SCOPE = /\b(mobile|phone|tablet|ios|android|safari|chrome|firefox|edge|browser|device|emulator|simulator|staging|production|prod|live site|manual(?:ly)?|by hand|visual(?:ly)?|screenshots?|in the ui|on (?:my|a) machine|locally on)\b/i;

/** The sentences of a worker's summary that claim verification (at most 10, each at most 300 characters). */
export function claimsOf(summary: string): string[] {
  return summary
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+(?=[A-Z`(])/)
    .map((s) => s.trim())
    .filter((s) => s && VERIFYING.test(s))
    .slice(0, 10)
    .map((s) => (s.length > 300 ? `${s.slice(0, 300)}…` : s));
}

/** Concrete references in a claim: `backticked` spans and path-like tokens (a slash, or a file extension). */
function refsOf(claim: string): string[] {
  const ticked = [...claim.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  const paths = claim
    .replace(/`[^`]*`/g, ' ')
    .split(/[\s,;()]+/)
    .map((t) => t.replace(/[.:]+$/, ''))
    .filter((t) => /[\w-]\/[\w.-]|[\w-]\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|json|ya?ml|md)$/.test(t));
  return [...ticked, ...paths].filter((r) => r.length >= 3);
}

/**
 * The claims no record backs. A claim naming a command or file is backed only if a passing check or a successful
 * worker command contains it. Otherwise, one about a place or way the coordinator never checks (a phone, a browser,
 * by hand) is not backed; and any other is backed only if at least one of the coordinator's checks passed.
 */
export function unbackedClaims(claims: string[], record: { checks: CheckRecord[]; commands: string[] }): string[] {
  const passed = record.checks.filter((c) => c.status === 'pass').map((c) => c.check.toLowerCase());
  const ran = record.commands.map((c) => c.toLowerCase());
  const evidence = [...passed, ...ran];
  return claims.filter((claim) => {
    const refs = refsOf(claim).map((r) => r.toLowerCase());
    if (refs.length) return !refs.some((r) => evidence.some((e) => e.includes(r)));
    if (UNCHECKED_SCOPE.test(claim)) return true;
    return passed.length === 0;
  });
}

/** One step less sure for each reason given (high → medium → low), never below low. */
export function lowerConfidence(c: 'high' | 'medium' | 'low', unbacked: number): 'high' | 'medium' | 'low' {
  if (!unbacked) return c;
  return c === 'high' ? 'medium' : 'low';
}

/** The three receipt sections for a PR description. */
export function receiptLines(o: { checks: CheckRecord[]; doneWhen: DoneWhenList; unverified: string[] }): string[] {
  const ran = o.checks.filter((c) => c.status === 'pass' || c.status === 'fail');
  const notRun = o.checks.filter((c) => c.status === 'skipped' || c.status === 'unavailable');
  const manual = o.doneWhen.filter((d) => 'manual' in d).map((d) => (d as { manual: string }).manual);
  const secs = (ms?: number) => (ms === undefined ? '' : `, ${Math.round(ms / 1000)}s`);
  const code = (c: CheckRecord) => (c.status === 'fail' && c.exitCode !== undefined && c.exitCode !== null ? `, exit ${c.exitCode}` : '');
  const md = (s: string) => s.replace(/`/g, "'");
  return [
    '### VERIFIED',
    ...(ran.length ? ran.map((c) => `- \`${md(c.check)}\`: ${c.status}${code(c)}${secs(c.duration_ms)}`) : ['- nothing: the coordinator ran no checks']),
    '',
    '### NOT VERIFIED',
    ...(o.unverified.length ? o.unverified.map((c) => `- "${c}" (claimed by the worker; no recorded command or check backs it, so it is not evidence)`) : ['- nothing: every claim in the worker\'s summary is backed by a recorded command or check']),
    '',
    '### NOT CHECKED',
    ...(manual.length || notRun.length ? [...manual.map((m) => `- manual: ${m}`), ...notRun.map((c) => `- \`${md(c.check)}\`: ${c.status === 'skipped' ? 'skipped (an earlier check failed)' : 'unavailable'}`)] : ['- nothing']),
  ];
}
