// The daily "waiting on you" digest (#121), posted: once a local day, after the first report time, as a comment
// on one issue (labelled `digest`, created on first use), mentioning who reports go to. Its `since` is the last
// post, so the merged-on-their-own list covers exactly the time since the owner last saw one. GitHub only: the
// backlog's comment is the delivery. What is waiting is computed by src/digest.ts from the event log alone.
import type { Backlog } from '../backlog/types.js';
import { BRAND } from '../brand.js';
import type { ProjectConfig } from '../config/schema.js';
import { digestMarkdown, waitingOnYou } from '../digest.js';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { dueSlot } from '../reports.js';

export const DIGEST_LABEL = 'digest';

/** The time of day the digest goes out: the first report time (08:00 by default). */
export function digestTime(times: string[]): string {
  return [...times].sort()[0] ?? '08:00';
}

/** Post today's digest if it is due and not yet posted. Returns the issue it went to, or null. */
export async function maybePostDigest(o: {
  log: EventLog;
  backlog: Backlog;
  project: ProjectConfig;
  emit: (payload: EventPayload<'digest.posted'>) => void;
  now?: Date;
}): Promise<number | null> {
  const now = o.now ?? new Date();
  if (!dueSlot([digestTime(o.project.reports.times)], now)) return null;
  const day = now.toLocaleDateString('en-CA');
  const posted = o.log.read(0, ['digest.posted']);
  if (posted.some((e) => (e.payload as { day: string }).day === day)) return null;
  const last = posted.at(-1);
  const d = waitingOnYou(o.log.read(), now, last ? { since: new Date(last.ts) } : {});
  const to = o.project.reports.to.length ? o.project.reports.to : [o.project.owners.default];
  let issue = (await o.backlog.list(DIGEST_LABEL))[0]?.number ?? null;
  if (issue === null) issue = await o.backlog.createIssue(`${BRAND.name}: waiting on you`, `The daily "waiting on you" digest is posted here as a comment: every state that holds work until the owner acts, and the PRs merged on their own since the last one.`, [DIGEST_LABEL]);
  await o.backlog.comment(issue, `${digestMarkdown(d, { project: o.project.project.name })}\n${to.map((u) => `@${u}`).join(' ')}`.trim());
  o.emit({ day, issue, items: d.items.length, merged: d.merged.length });
  return issue;
}
