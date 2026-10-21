// An issue's check runs (GET /api/checks?issue=N) as each role may have them (issue #837). The owners and writers
// get every run whole: each check's exit code, the end of a failing check's output and the commit it ran on. A
// viewer (read on the instance's repo), and any role this code doesn't know, gets each run's time and stage and
// each check's name and result, and nothing else: an output tail can carry paths and error text from the project's
// commands, and check.result is not on the viewer-events allowlist (src/viewer-events.ts), so /api/events already
// hides it from them. Each viewer's run is built field by field, so a field added to CheckRunView later stays the
// writers' until someone adds it here.
import { isWriter, type Role } from './dashboard-auth.js';
import type { CheckRunView } from './projection.js';

/** The stages a viewer may see; any other (a stage added later included) is shown as "check". */
const VIEWER_STAGES = ['verify', 'land', 'no change'] as const;
type ViewerStage = (typeof VIEWER_STAGES)[number] | 'check';

/** The results a viewer may see (the event schema's own); any other is shown as "unknown". */
const VIEWER_STATUSES = ['pass', 'fail', 'unavailable', 'skipped'] as const;
type ViewerStatus = (typeof VIEWER_STATUSES)[number] | 'unknown';

/** One run of the coordinator's checks as a viewer sees it: no head, no exit codes, no output. */
export interface ViewerCheckRun {
  id: number;
  at: string;
  stage: ViewerStage;
  checks: { check: string; status: ViewerStatus }[];
  forViewer: true;
}

export const viewerStage = (stage: string): ViewerStage => ((VIEWER_STAGES as readonly string[]).includes(stage) ? (stage as ViewerStage) : 'check');

export const viewerStatus = (status: string): ViewerStatus => ((VIEWER_STATUSES as readonly string[]).includes(status) ? (status as ViewerStatus) : 'unknown');

/**
 * A check's name as a viewer sees it. A verify run's and a no-change finding's names are the project's commands and
 * the issue's done_when items, which a viewer reads on the repo and the issue. A land gate's is "<tier>: <its
 * verdict note>" (src/coordinator/landing.ts), and the note (failure counts, main's baseline commit) is a run's
 * detail: a viewer gets the tier only. A name of any other stage, or a land name not in that form, gives no part.
 */
export function viewerCheckName(stage: string, check: string): string {
  const s = viewerStage(stage);
  if (s === 'verify' || s === 'no change') return check;
  if (s === 'land') {
    const at = check.indexOf(': ');
    return at > 0 ? check.slice(0, at) : 'land gate';
  }
  return 'check';
}

/** One run as a viewer sees it (see the top of this file). */
export function checkRunForViewer(r: CheckRunView): ViewerCheckRun {
  return {
    id: r.id,
    at: r.at,
    stage: viewerStage(r.stage),
    checks: r.checks.map((c) => ({ check: viewerCheckName(r.stage, c.check), status: viewerStatus(c.status) })),
    forViewer: true,
  };
}

/** What GET /api/checks answers this role: the runs whole for the owners and writers, a viewer's shape for anyone else. */
export function checksFor(role: Role | null | undefined, runs: CheckRunView[]): CheckRunView[] | ViewerCheckRun[] {
  return isWriter(role) ? runs : runs.map(checkRunForViewer);
}
