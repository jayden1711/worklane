// GET /api/value (#708): the value report, for the instance's owners and writers only, by the same role check as
// /api/metrics (isWriter). A viewer gets a refusal and nothing else: no counts, no hold reasons. Read-only: it reads
// the events it is handed and answers; it never writes.
//
// Follow-up: once a viewer-safe build exists (#826's field-by-field prsForViewer pattern), a viewer could be given the
// figures that are safe for them. Until then this fails closed: no viewer gets any of it.
import { isWriter, type Role } from './dashboard-auth.js';
import { VALUE_WINDOWS, valueReport, type ValueEvent } from './value-report.js';

export const DEFAULT_VALUE_DAYS = 30;

export function valueRoute(o: { method: string; role: Role | null | undefined; login: string; events: readonly ValueEvent[]; query: URLSearchParams; now?: Date }): { status: number; body: unknown } {
  if (o.method !== 'GET' && o.method !== 'HEAD') return { status: 405, body: { error: 'the value report is read-only' } };
  if (!isWriter(o.role)) return { status: 403, body: { error: `the value report is for the instance's owners and writers (admin or write on its repo); @${o.login} is a ${o.role ?? 'viewer'}` } };
  const asked = o.query.get('days');
  const days = asked === null ? DEFAULT_VALUE_DAYS : Number(asked);
  if (!VALUE_WINDOWS.includes(days)) return { status: 400, body: { error: `days is one of ${VALUE_WINDOWS.join(', ')}` } };
  return { status: 200, body: valueReport(o.events, { now: o.now ?? new Date(), days }) };
}
