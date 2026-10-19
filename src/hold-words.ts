// WHY (#741; #706 slice 2's table): each kind of reason merge.decided carries, by its prefix, in two fixed sentences:
// why it waits, what lets it through. Never fed back into a decision; never a reason's own text (it can hold run
// output, paths or evaluator text). test/first-task-progress.test.ts scans every source of merge.decided reasons.

export type HoldKind = 'never' | 'policy-off' | 'repo-off' | 'stopped' | 'high-risk' | 'design' | 'big' | 'doubt' | 'eval' | 'outside-plan' | 'conflict-fix' | 'cant-merge' | 'merge-failed' | 'mergeable-unknown' | 'combined' | 'ruleset' | 'other';
export interface HoldWords {
  kind: HoldKind;
  why: string;
  through: string;
}

const YOURS = 'Review it and merge it yourself.';
/** [kind, prefixes, why, what lets it through]. */
const TABLE: [Exclude<HoldKind, 'other'>, string[], string, string][] = [
  ['never', ['never auto-merged:'], 'The harness never merges this kind of PR itself (one it did not open, a revert, a check from feedback).', YOURS],
  ['policy-off', ['auto-merge is off for this instance'], "Auto-merge is off for this instance (its policy's auto_merge): every PR waits for a person.", YOURS],
  ['repo-off', ['auto-merge is off for this repo'], "Auto-merge is off in this repo's review.yaml (merge.auto): every PR waits for a person.", YOURS],
  ['stopped', ['auto-merge is stopped:'], 'Auto-merge is stopped for this instance until the stop is cleared.', YOURS],
  ['high-risk', ['high-risk: '], 'It changes an area that always waits for a person (such as auth, secrets, CI or the harness itself), or the worker marked it protected.', YOURS],
  ['design', ['design:'], 'It is a design-level change: for example the evaluator flagged one, a dependency manifest or a top-level module is added, or it may weaken a check.', YOURS],
  ['big', ['big:'], "The change is over this repo's size limit (review.yaml merge.max_lines or max_files).", `Split it, or ${YOURS.toLowerCase()}`],
  ['doubt', ['doubt:'], 'The evaluator or the run left a doubt (no approval, confidence below high, unread files, CI fixes, a push limit or a foreign push).', "Read the PR's hold comment; merge it yourself or ask for a fix."],
  ['eval', ['eval:'], "It changes the agents' instructions and their eval did not clear it.", YOURS],
  ['outside-plan', ['not in the approved plan:'], 'It changes high-risk or design-level files its approved plan did not list.', YOURS],
  ['conflict-fix', ['conflict fix:'], 'An agent resolved a merge conflict, and the resolution needs a person.', YOURS],
  ['cant-merge', ["GitHub can't merge it cleanly"], "GitHub says it can't merge cleanly.", 'Fix it on GitHub, then merge it yourself.'],
  ['merge-failed', ['merging failed '], 'Merging it failed 3 times.', 'Look at the PR on GitHub and merge it yourself.'],
  ['mergeable-unknown', ['GitHub was still computing'], 'GitHub never said whether it can merge.', 'Look at the PR on GitHub and merge it yourself.'],
  ['combined', ['merging the default branch into it conflicts', "can't find where this PR branched", 'combined with '], 'Checked with the latest default branch, it conflicts or fails the fast tests, or that check could not run.', 'Update it from the default branch or ask for a fix; then merge it yourself.'],
  ['ruleset', ['docs-only fast path:'], "A check this repo's ruleset requires did not pass on GitHub.", 'Merge it yourself once that check passes.'],
];
const LOCAL_OFF: HoldWords = { kind: 'policy-off', why: 'Local mode: every PR waits for you.', through: 'Review the PR and merge it yourself on GitHub.' };

export const HOLD_KINDS: readonly HoldKind[] = TABLE.map((e) => e[0]);

/** One reason in plain words; `local`: no instance (#729's words). An unknown prefix: fixed words, never its text. */
export function holdWords(reason: string, o: { local: boolean }): HoldWords {
  const e = TABLE.find((x) => x[1].some((p) => reason.startsWith(p)));
  if (!e) return { kind: 'other', why: 'Another reason (see the Board).', through: "Read the PR's hold comment and decide." };
  return o.local && e[0] === 'policy-off' ? LOCAL_OFF : { kind: e[0], why: e[2], through: e[3] };
}

/** One line per kind, in the reasons' order. */
export function holdsInWords(reasons: readonly string[], o: { local: boolean }): HoldWords[] {
  const out: HoldWords[] = [];
  for (const r of reasons) {
    const w = holdWords(r, o);
    if (!out.some((x) => x.kind === w.kind)) out.push(w);
  }
  return out;
}
