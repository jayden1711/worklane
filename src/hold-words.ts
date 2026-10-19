// WHY (#741, #706 slice 2's table): a held PR's reasons are the merge policy's own strings ("doubt: evaluator
// confidence medium: ...", "auto-merge is off for this instance (policy.yaml auto_merge)"). A new user waiting on
// their first PR needs two plain sentences per kind instead: why it waits, and what lets it through. One table, keyed
// by the prefix every reason of that kind starts with (src/merge-policy.ts); the words never feed back into the
// decision. A reason with no known prefix is shown as its own text, so a hold is never hidden or emptied.
// Local mode (no instance) words the kill switch as #729 does: there, every PR waits for you, and no policy.yaml
// exists to name.

/** One kind of hold, said plainly. `kind` 'other' is a reason no prefix matched: `why` is then its own text. */
export interface HoldWords {
  kind: HoldKind;
  why: string;
  through: string;
}

export type HoldKind = 'never' | 'policy-off' | 'repo-off' | 'stopped' | 'high-risk' | 'design' | 'big' | 'doubt' | 'eval' | 'outside-plan' | 'other';

type Entry = { kind: Exclude<HoldKind, 'other'>; prefix: string; why: string; through: string; local?: { why: string; through: string } };

/** Every reason prefix src/merge-policy.ts emits, in the order mergeDecision adds them. test/first-task-progress.test.ts builds one hold per prefix. */
const TABLE: readonly Entry[] = [
  { kind: 'never', prefix: 'never auto-merged:', why: 'The harness never merges this kind of PR itself: one it did not open, a revert, or a check proposed from feedback.', through: 'A person reviews it and merges it.' },
  {
    kind: 'policy-off',
    prefix: 'auto-merge is off for this instance',
    why: "Auto-merge is off for this instance (its policy's auto_merge), so every PR waits for a person.",
    through: 'Review the PR and merge it yourself.',
    local: { why: 'Local mode: every PR waits for you. The engine does not merge its own PRs on a single machine.', through: 'Review the PR and merge it yourself on GitHub.' },
  },
  { kind: 'repo-off', prefix: 'auto-merge is off for this repo', why: "Auto-merge is off in this repo's review.yaml (merge.auto), so every PR waits for a person.", through: 'Review the PR and merge it yourself.' },
  { kind: 'stopped', prefix: 'auto-merge is stopped:', why: 'Auto-merge is stopped for this instance until the stop is cleared.', through: 'Review the PR and merge it yourself; auto-merge resumes once the stop is cleared.' },
  { kind: 'high-risk', prefix: 'high-risk: ', why: 'It changes an area that always waits for a person (for example auth, secrets, CI, deploys or the harness itself), or the worker marked it protected.', through: 'Review those changes and merge it yourself.' },
  { kind: 'design', prefix: 'design:', why: 'It is a design-level change: the evaluator flagged one, a dependency manifest changes, or it adds a top-level module.', through: 'Review the design and merge it yourself.' },
  { kind: 'big', prefix: 'big:', why: "The change is over this repo's size limit (review.yaml merge.max_lines or max_files).", through: 'Split it, or review it and merge it yourself.' },
  { kind: 'doubt', prefix: 'doubt:', why: 'The evaluator or the run left a doubt: no approval or confidence below high, files it did not read, CI fix runs, a push limit, or someone else pushed to the branch.', through: "Read the PR's hold comment, then merge it yourself or ask for a fix." },
  { kind: 'eval', prefix: 'eval:', why: "It changes the agents' instructions, and their eval did not clear it.", through: 'Check the eval result on the PR, and merge it yourself if the change is right.' },
  { kind: 'outside-plan', prefix: 'not in the approved plan:', why: 'It changes high-risk or design-level files that its approved plan did not list.', through: 'Review those files and merge it yourself.' },
];

/** The kinds the table words (every one but 'other'). */
export const HOLD_KINDS: readonly HoldKind[] = TABLE.map((e) => e.kind);

/** The longest a reason with no known prefix is shown: the hold comment on the PR has it in full. */
const RAW_MAX = 300;

/** One reason in plain words; `local`: a checkout's dashboard (no instance), where the kill switch reads as #729 words it. */
export function holdWords(reason: string, o: { local: boolean }): HoldWords {
  const e = TABLE.find((x) => reason.startsWith(x.prefix));
  if (!e) {
    const raw = reason.replace(/\s+/g, ' ').trim();
    return { kind: 'other', why: raw ? (raw.length > RAW_MAX ? `${raw.slice(0, RAW_MAX - 1)}…` : raw) : 'held for a reason the engine did not record', through: "Read the PR's hold comment and decide." };
  }
  const w = o.local && e.local ? e.local : e;
  return { kind: e.kind, why: w.why, through: w.through };
}

/** A hold's reasons in plain words: one line per kind (several reasons of one kind say the same), in the policy's order. */
export function holdsInWords(reasons: readonly string[], o: { local: boolean }): HoldWords[] {
  const out: HoldWords[] = [];
  for (const r of reasons) {
    const w = holdWords(r, o);
    if (!out.some((x) => x.kind === w.kind && x.why === w.why)) out.push(w);
  }
  return out;
}
