// GET /api/health/incidents: what the Health page shows of one instance's dashboard. The incidents about this
// instance and about the machine (never another instance's: the hub asks each instance the person has a role on),
// open ones oldest first and the resolved history newest first, with the instance's status (its sidebar dot).
// Three audiences (#680):
//   owner   (an owner or writer here who is one of the machine's owners: the same check as the Machine page's Claude
//           account card, mayViewClaudeAccount, #567): each incident whole, its detail the owners' one
//           (Incident.ownerDetail, which may name a Claude account) where it has one
//   writer  (an instance's owners and writers who aren't machine owners): each incident whole but for ownerDetail,
//           so its detail is the one the ops channel is posted, naming no account
//   viewer  the allowlisted fields only (viewer-events.ts)
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

/** Who is asking: see the top of this file. */
export type IncidentsAudience = 'owner' | 'writer' | 'viewer';

/** One incident as an owner or a writer sees it: never the post marks; the owners' detail only for an owner. */
function whole(x: Incident, audience: 'owner' | 'writer'): Partial<Incident> {
  const { posted: _posted, ownerDetail, ...rest } = x;
  return audience === 'owner' && ownerDetail ? { ...rest, detail: ownerDetail } : rest;
}

export function incidentsView(o: { dir?: string; instance: string | null; audience: IncidentsAudience }): IncidentsView {
  const mine = readIncidents(o.dir).incidents.filter((x) => x.instance === null || x.instance === o.instance);
  const open = mine.filter((x) => !x.resolvedAt).sort((a, b) => a.since.localeCompare(b.since));
  const resolved = mine.filter((x) => x.resolvedAt).sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!)).slice(0, 50);
  const a = o.audience;
  const shown = (xs: Incident[]): Partial<Incident>[] => (a === 'viewer' ? (incidentsForViewer(xs) as Partial<Incident>[]) : xs.map((x) => whole(x, a)));
  return { instance: o.instance, status: healthStatus(mine, o.instance), open: shown(open), resolved: shown(resolved), detail: a !== 'viewer' };
}
