// GET /api/health/incidents: what the Health page shows of one instance's dashboard. The incidents about this
// instance and about the machine (never another instance's: the hub asks each instance the person has a role on),
// open ones oldest first and the resolved history newest first, with the instance's status (its sidebar dot).
// Owners and writers get each incident whole; a viewer gets the allowlisted fields only (viewer-events.ts).
import { incidentsForViewer } from '../viewer-events.js';
import { healthStatus, readIncidents, type HealthStatus, type Incident } from './incidents.js';

export interface IncidentsView {
  instance: string | null;
  status: HealthStatus;
  open: Partial<Incident>[];
  resolved: Partial<Incident>[];
  /** Whether each incident's detail, what was tried and its fix are included (owners and writers). */
  detail: boolean;
}

export function incidentsView(o: { dir?: string; instance: string | null; full: boolean }): IncidentsView {
  const mine = readIncidents(o.dir).incidents.filter((x) => x.instance === null || x.instance === o.instance);
  const open = mine.filter((x) => !x.resolvedAt).sort((a, b) => a.since.localeCompare(b.since));
  const resolved = mine.filter((x) => x.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!)).slice(0, 50);
  const shown = (xs: Incident[]): Partial<Incident>[] => (o.full ? xs.map(({ posted: _posted, ...x }) => x) : (incidentsForViewer(xs) as Partial<Incident>[]));
  return { instance: o.instance, status: healthStatus(mine, o.instance), open: shown(open), resolved: shown(resolved), detail: o.full };
}
