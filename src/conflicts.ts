// Conflict fix runs: when a harness PR can no longer merge because its base
// moved under it, merge the PR's actual base into its branch, let a worker
// resolve only the conflicted hunks (knowing what both sides meant), and send
// the result through the normal pipeline. These are the pure decisions; the
// coordinator does the git work and the runs.

/** What to do about a PR's merge state. Only a real conflict starts a fix; "still computing" is polled again soon. */
export type ConflictTrigger = { act: 'fix' } | { act: 'recheck'; why: string } | { act: 'none'; why: string };

/**
 * GitHub reports conflicts as mergeable=false with mergeable_state "dirty" (GraphQL: CONFLICTING). Behind,
 * blocked, unstable, clean, draft and unknown are never conflicts; mergeable=null means GitHub hasn't
 * computed it yet (it starts when asked), so the caller polls again shortly instead of acting.
 */
export function conflictTrigger(pr: { state: string; mergeable: boolean | null; mergeableState: string }): ConflictTrigger {
  if (pr.state !== 'open') return { act: 'none', why: `the PR is ${pr.state}` };
  if (pr.mergeable === null || pr.mergeableState === 'unknown') return { act: 'recheck', why: 'GitHub is still computing whether it can merge' };
  if (pr.mergeable === false && pr.mergeableState === 'dirty') return { act: 'fix' };
  return { act: 'none', why: `merge state ${pr.mergeableState}${pr.mergeable === false ? ' (not mergeable, but not a conflict)' : ''}` };
}

/** Fix runs already used on a PR: every one started counts, including runs a restart cut short. */
export function conflictFixesUsed(events: { type: string; payload: unknown }[], pr: number): number {
  return events.filter((e) => e.type === 'conflict_fix.started' && (e.payload as { number?: number }).number === pr).length;
}

export interface ConflictHunk {
  file: string;
  /** 1-based line of the "<<<<<<<" marker in the conflicted file. */
  line: number;
  ours: string;
  theirs: string;
  /** The common ancestor's text, when the merge used diff3 / zdiff3 markers. */
  base?: string;
}

/** The conflicted hunks in one file's merged text (merge or diff3 markers). */
export function parseConflicts(file: string, text: string): ConflictHunk[] {
  const lines = text.split('\n');
  const out: ConflictHunk[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith('<<<<<<<')) continue;
    const start = i;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let part: string[] = ours;
    let hasBase = false;
    let closed = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (l.startsWith('|||||||')) {
        part = base;
        hasBase = true;
      } else if (l === '=======' || l.startsWith('======= ')) part = theirs;
      else if (l.startsWith('>>>>>>>')) {
        closed = true;
        break;
      } else part.push(l);
    }
    if (!closed) break;
    out.push({ file, line: start + 1, ours: ours.join('\n'), theirs: theirs.join('\n'), ...(hasBase ? { base: base.join('\n') } : {}) });
  }
  return out;
}

export interface Side {
  /** e.g. "this PR (#12, issue #40)" or "main: #15 Add the orders table" */
  label: string;
  /** What the side was for: its issue and PR description. */
  intent: string;
}

/**
 * The worker's brief for a conflict fix: every conflicted hunk with both sides' text, and what each side was
 * for, so a resolution keeps both behaviors. The worker may change only the conflicted hunks.
 */
export function conflictBrief(o: { baseRef: string; baseSha: string; strategy: 'merge' | 'rebase'; hunks: ConflictHunk[]; ours: Side; theirs: Side[] }): string {
  const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
  const hunk = (h: ConflictHunk, i: number) =>
    [`### ${i + 1}. ${h.file}, line ${h.line}`, '', 'This PR:', '```', clip(h.ours), '```', ...(h.base !== undefined ? ['Before either change:', '```', clip(h.base), '```'] : []), `${o.baseRef}:`, '```', clip(h.theirs), '```'].join('\n');
  return [
    `Your change conflicts with ${o.baseRef} (${o.baseSha.slice(0, 8)}). ${o.strategy === 'merge' ? `${o.baseRef} has been merged into your branch` : `Your branch is being rebased onto ${o.baseRef}`}; ${o.hunks.length} hunk(s) in ${new Set(o.hunks.map((h) => h.file)).size} file(s) conflict.`,
    '',
    'Resolve each conflicted hunk so that BOTH sides keep their behavior, remove every conflict marker, and commit. Change nothing outside the conflicted hunks: anything else you touch sends the PR to a human.',
    '',
    `## What this PR is for: ${o.ours.label}`,
    clip(o.ours.intent, 2000),
    '',
    ...o.theirs.flatMap((t) => [`## What changed on ${o.baseRef}: ${t.label}`, clip(t.intent, 2000), '']),
    '## The conflicted hunks',
    '',
    ...o.hunks.map(hunk),
  ].join('\n');
}

/**
 * Whether the resolution changed anything outside the conflicted hunks. `conflicted`: each conflicted file's
 * text with markers, as the merge left it. `resolved`: the same files after the fix. `otherChanged`: files
 * the fix changed that the merge had already merged cleanly (any is outside). Returns what was touched outside.
 */
export function outsideHunks(conflicted: Record<string, string>, resolved: Record<string, string | null>, otherChanged: string[]): string[] {
  const out = otherChanged.map((f) => `${f} (merged cleanly, then changed)`);
  for (const [file, text] of Object.entries(conflicted)) {
    const after = resolved[file];
    if (after === null || after === undefined) {
      out.push(`${file} (deleted)`);
      continue;
    }
    if (/^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|)/m.test(after) || /^=======$/m.test(after)) {
      out.push(`${file} (conflict markers left)`);
      continue;
    }
    // The merged lines outside the hunks, in order: the first run must open the resolution, the last close it,
    // and each one between appear in order, all unchanged line for line.
    const pieces: string[][] = [];
    let cur: string[] = [];
    let inHunk = false;
    for (const l of text.split('\n')) {
      if (!inHunk && l.startsWith('<<<<<<<')) {
        pieces.push(cur);
        cur = [];
        inHunk = true;
      } else if (inHunk && l.startsWith('>>>>>>>')) inHunk = false;
      else if (!inHunk) cur.push(l);
    }
    pieces.push(cur);
    const lines = after.split('\n');
    const same = (at: number, p: string[]) => p.every((l, k) => lines[at + k] === l);
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    let ok = same(0, first);
    let at = first.length;
    for (let i = 1; ok && i < pieces.length - 1; i++) {
      const p = pieces[i]!;
      let j = at;
      while (j + p.length <= lines.length && !same(j, p)) j++;
      if (j + p.length > lines.length) ok = false;
      else at = j + p.length;
    }
    if (pieces.length === 1) ok = after === text;
    else if (ok) ok = lines.length - last.length >= at && same(lines.length - last.length, last);
    if (!ok) out.push(`${file} (lines outside the conflicted hunks changed)`);
  }
  return out;
}

/** Why a resolved PR waits for the owner instead of auto-merging (empty: the merge policy decides as usual). */
export function conflictWaitReasons(o: { outside: string[]; riskCategories: string[]; evaluator: { approved: boolean; confidence: string; bothSidesKept: boolean | null } }): string[] {
  const r: string[] = [];
  if (o.outside.length) r.push(`conflict fix: changed outside the conflicted hunks: ${o.outside.slice(0, 5).join('; ')}`);
  if (o.riskCategories.length) r.push(`conflict fix: touches ${o.riskCategories.join(', ')}`);
  if (!o.evaluator.approved) r.push('conflict fix: the evaluator rejected the resolution');
  else if (o.evaluator.confidence !== 'high') r.push(`conflict fix: the evaluator's confidence is ${o.evaluator.confidence}, not high`);
  if (o.evaluator.bothSidesKept !== true) r.push(`conflict fix: the evaluator ${o.evaluator.bothSidesKept === false ? 'found a side whose behavior was lost' : "didn't confirm both sides' behavior is kept"}`);
  return r;
}

/**
 * The evaluator's verdict for a conflict fix: the usual verdict plus an explicit answer on whether the
 * resolution keeps both sides' behavior (required, so silence is never a yes).
 */
export function conflictVerdictSchema<T extends { required: readonly string[]; properties: object }>(base: T) {
  return {
    ...base,
    required: [...base.required, 'both_sides_kept'],
    properties: {
      ...base.properties,
      both_sides_kept: {
        type: 'boolean',
        description: "true only if the resolution keeps the behavior of BOTH sides: this pull request's change and what the base branch changed. false if either side's behavior was dropped or altered.",
      },
    },
  };
}
