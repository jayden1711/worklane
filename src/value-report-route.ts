// GET /api/value (#708): the value report, for the instance's owners and writers only, by the same role check as
// /api/metrics (isWriter). A viewer gets a refusal and nothing else: no counts, no hold reasons. Read-only: it reads
// the events it is handed and answers; it never writes.
//
// Follow-up: once a viewer-safe build exists (#826's field-by-field prsForViewer pattern), a viewer could be given the
// figures that are safe for them. Until then this fails closed: no viewer gets any of it.
import { isWriter, type Role } from './dashboard-auth.js';
import { readPolicy } from './instance.js';
import { DEFAULT_VALUE_CONSTANTS, VALUE_WINDOWS, valueReport, type Estimate, type ValueEvent } from './value-report.js';

export const DEFAULT_VALUE_DAYS = 30;

/** Every file-level failure (missing, unreadable, not YAML, refused, a throw of any kind): one text, with no path. */
export const POLICY_FILE_UNREADABLE = "the instance policy (policy.yaml) can't be read as a file (missing, unreadable, not YAML, or refused), so the value report isn't made";

/**
 * The estimate's constants: the instance's policy.yaml value_report.hours_estimate, re-read on every request; without
 * it, or with no instance (a checkout, `policyFile` null), the engine's defaults. A policy that doesn't load is refused,
 * as everywhere else: never the defaults in its place, so the figure is never shown with constants nobody chose.
 *
 * INVARIANT: the error text is built only from schema issues that carry a key path (`key: problem`); anything else, a
 * throw included, is POLICY_FILE_UNREADABLE. A file-level message (a read's EACCES, a refusal) can name the instance
 * home's path, which isn't the report's to show, and a throw would reach the dashboard's catch with its message as is.
 */
export function valueEstimate(policyFile: string | null): Estimate | { error: string } {
  if (policyFile === null) return { constants: { ...DEFAULT_VALUE_CONSTANTS }, from: 'default' };
  let r: ReturnType<typeof readPolicy>;
  try {
    r = readPolicy(policyFile);
  } catch {
    return { error: POLICY_FILE_UNREADABLE };
  }
  if (!r.policy) {
    const keyed = r.errors.filter((e) => e.path !== '');
    if (!keyed.length || keyed.length !== r.errors.length) return { error: POLICY_FILE_UNREADABLE };
    return { error: `the instance policy (policy.yaml) is invalid, so the value report isn't made: ${keyed.map((e) => `${e.path}: ${e.message}`).join('; ')}` };
  }
  const set = r.policy.value_report?.hours_estimate;
  return set ? { constants: { ...set }, from: 'policy' } : { constants: { ...DEFAULT_VALUE_CONSTANTS }, from: 'default' };
}

/** `policyFile`: the instance's policy.yaml, or null for a checkout (required, so no caller can leave it out by accident). */
export function valueRoute(o: { method: string; role: Role | null | undefined; login: string; events: readonly ValueEvent[]; query: URLSearchParams; policyFile: string | null; now?: Date }): { status: number; body: unknown } {
  if (o.method !== 'GET' && o.method !== 'HEAD') return { status: 405, body: { error: 'the value report is read-only' } };
  if (!isWriter(o.role)) return { status: 403, body: { error: `the value report is for the instance's owners and writers (admin or write on its repo); @${o.login} is a ${o.role ?? 'viewer'}` } };
  const asked = o.query.get('days');
  const days = asked === null ? DEFAULT_VALUE_DAYS : Number(asked);
  if (!VALUE_WINDOWS.includes(days)) return { status: 400, body: { error: `days is one of ${VALUE_WINDOWS.join(', ')}` } };
  const estimate = valueEstimate(o.policyFile);
  if ('error' in estimate) return { status: 500, body: { error: estimate.error } };
  return { status: 200, body: valueReport(o.events, { now: o.now ?? new Date(), days, estimate }) };
}
