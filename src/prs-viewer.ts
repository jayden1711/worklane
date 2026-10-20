// The pull requests page (GET /api/prs) as a viewer (read on the instance's repo) may have it: each PR's state
// and nothing of the merge decision (issue #821). Hold reasons can name review levels, guard categories, paths
// and policy states, and a viewer sees none of that on /api/state or /api/events either (src/viewer-events.ts).
// So a viewer gets, per PR, only what the viewer-events allowlist already shows (its number, issue, title, link,
// draft, open or merged or closed) and a coarse phase: waiting for a person, checks, ready, merged or closed. No
// checks, fix runs, conflict or light-check detail, no refused pushes, stops, holds or stale-PR pass, and no
// auto-merge state. Each PR is built field by field, so a field added to PrView later stays the writers' until
// someone adds it here.
import type { PrsView, PrView } from './projection.js';

/** The phases a viewer may see. Anything else (a phase added later included) is shown by draft state only. */
type ViewerPhase = Extract<PrView['phase'], 'waiting' | 'checks' | 'ready' | 'merged' | 'closed'>;

/** A PR's phase as a viewer sees it: waiting for a person (the merge rules' wait, or a CI fix that gave up), merged, closed, else by draft. */
export function viewerPhase(pr: Pick<PrView, 'phase' | 'state' | 'draft'>): ViewerPhase {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.state !== 'open') return 'closed';
  // The same two that /api/state's prCounts.needYou already counts for viewers.
  if (pr.phase === 'waiting' || pr.phase === 'gave_up') return 'waiting';
  return pr.draft ? 'checks' : 'ready';
}

/** One PR as a viewer sees it: the same shape as the writers' (so the page renders it), with nothing of why. */
export function prForViewer(pr: PrView): PrView {
  return {
    number: pr.number,
    issue: pr.issue,
    title: pr.title,
    url: pr.url,
    openedAt: pr.openedAt,
    head: '',
    state: pr.state,
    draft: pr.draft,
    status: null,
    unready: null,
    fixes: [],
    gaveUp: null,
    decision: null,
    waitReasons: [],
    // When it merged, never the merge commit, its link or whether the harness merged it itself.
    merged: pr.merged ? { at: pr.merged.at, sha: '', url: '', auto: false } : null,
    mergeFailed: null,
    mainResult: null,
    conflict: null,
    lightCheck: null,
    phase: viewerPhase(pr),
  };
}

/** What a viewer's GET /api/prs answers: each PR's state, and that the rest is the owners' and writers'. */
export interface PrsForViewer extends Omit<PrsView, 'hygiene'> {
  hygiene: null;
  autoMerge: null;
  forViewer: true;
}

/** The PR view as a viewer may have it (see the top of this file). */
export function prsForViewer(v: PrsView): PrsForViewer {
  return { prs: v.prs.map(prForViewer), refused: [], stops: [], holds: [], hygiene: null, autoMerge: null, forViewer: true };
}
