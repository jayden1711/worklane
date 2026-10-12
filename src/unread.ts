// What a reviewer didn't read, from what its run actually did (the run record), never from the reviewer's own
// list of files it says it reviewed. A changed file counts as read when the session opened it with Read or a
// `git diff`/`git show` named it, or when it showed a whole range's diff. A run with no record proves nothing,
// so every changed file is unread then.
import type { RunRecord } from './run-record.js';

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function unreadFiles(changed: string[], record: Pick<RunRecord, 'read' | 'diffedAll'> | null): string[] {
  if (!record) return [...changed];
  if (record.diffedAll) return [];
  const seen = new Set((record.read ?? []).map(norm));
  return changed.filter((f) => !seen.has(norm(f)));
}
