// The learning loop: agents propose a lesson after each task (what worked,
// what failed, the fix). Once a day the coordinator writes the new ones to
// the project's lessons folder on a branch and opens a PR for the owner to
// approve. Lessons that keep recurring are listed as skill candidates;
// promoting one into a skill (with evals) is a human decision.
import type { StoredEvent } from './events/types.js';

export interface Lesson {
  issue: number;
  title: string;
  worked: string;
  failed: string;
  fix: string;
  at: string;
}

export function pendingLessons(events: StoredEvent[]): Lesson[] {
  const lastPr = events.filter((e) => e.type === 'lessons.pr').at(-1);
  const after = lastPr?.id ?? 0;
  const titles = new Map(events.filter((e) => e.type === 'issue.seen').map((e) => [(e.payload as { issue: number }).issue, (e.payload as { title: string }).title]));
  return events
    .filter((e) => e.id > after && e.type === 'lesson.proposed')
    .map((e) => ({ ...(e.payload as Omit<Lesson, 'title' | 'at'>), title: titles.get((e.payload as { issue: number }).issue) ?? '', at: e.ts }))
    .filter((l) => [l.worked, l.failed, l.fix].some((x) => x && x.trim().length > 3));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Fix or worked texts that recur across lessons (all time): candidates to become skills. */
export function skillCandidates(events: StoredEvent[], minRepeats = 3): { text: string; count: number; issues: number[] }[] {
  const all = events.filter((e) => e.type === 'lesson.proposed').map((e) => e.payload as { issue: number; worked: string; fix: string });
  const counts = new Map<string, { text: string; issues: Set<number> }>();
  for (const l of all) {
    for (const t of [l.worked, l.fix]) {
      const k = norm(t);
      if (k.split(' ').length < 3) continue;
      const c = counts.get(k) ?? { text: t.trim(), issues: new Set<number>() };
      c.issues.add(l.issue);
      counts.set(k, c);
    }
  }
  return [...counts.values()].filter((c) => c.issues.size >= minRepeats).map((c) => ({ text: c.text, count: c.issues.size, issues: [...c.issues] })).sort((a, b) => b.count - a.count);
}

export function lessonsMarkdown(day: string, lessons: Lesson[], candidates: ReturnType<typeof skillCandidates>): string {
  const out = [`# Lessons, ${day}`, '', 'Proposed by agents after their tasks. Approving this PR keeps them; edit or delete any that are wrong.', ''];
  for (const l of lessons) {
    out.push(`## #${l.issue} ${l.title}`.trimEnd(), '');
    if (l.worked) out.push(`- **Worked:** ${l.worked}`);
    if (l.failed) out.push(`- **Failed:** ${l.failed}`);
    if (l.fix) out.push(`- **Fix:** ${l.fix}`);
    out.push('');
  }
  if (candidates.length) {
    out.push('## Skill candidates', '', 'These keep coming up. Consider turning one into a skill (with evals):', '');
    for (const c of candidates.slice(0, 5)) out.push(`- "${c.text}" (${c.count} tasks: ${c.issues.map((n) => `#${n}`).join(', ')})`);
    out.push('');
  }
  return out.join('\n');
}
