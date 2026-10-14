// The bisect step shared by the two culprit finders: CI's red-batch bisect on GitHub (scripts/ci/batch.mjs, which
// imports this file directly, so it stays plain, with no imports and only erasable type syntax) and the harness's
// fix-forward on a red default branch (src/fix-forward.ts, coordinator/fix-forward.ts).
//
// The candidates are the default branch's first-parent commits since the last good one, oldest first, the last one
// bad (the red commit). Each candidate is tested on its own commit; the culprit is the oldest bad commit whose first
// parent is good.

/**
 * A candidate's verdict: good, bad, pending (its test is running), skip (it ran but gave no verdict: skipped,
 * cancelled, couldn't be tested) or untested.
 */
export type BisectVerdict = 'good' | 'bad' | 'pending' | 'skip' | 'untested';

export type BisectStep =
  | { state: 'found'; culprit: string; good: string | null }
  | { state: 'wait'; sha: string }
  | { state: 'test'; sha: string }
  | { state: 'range'; from: string; to: string };

/**
 * The bisect's next step. `commits`: the candidates and the red commit, oldest first, each { sha, verdict }, at
 * least one bad; the commit before the first is the last good one. Returns
 *   { state: 'found', culprit, good }  the oldest bad commit whose first parent is good (good: null = the last good one)
 *   { state: 'wait', sha }             a candidate between the two is still running
 *   { state: 'test', sha }             test this commit next: the untested one nearest the middle (binary search)
 *   { state: 'range', from, to }       only untestable commits are left between the two: the culprit is one of from..to
 */
export function nextStep(commits: { sha: string; verdict: BisectVerdict }[]): BisectStep {
  const b = commits.findIndex((c) => c.verdict === 'bad');
  if (b < 0) throw new Error('no bad commit: the red commit is the last one, and bad');
  let g = -1;
  for (let i = 0; i < b; i++) if (commits[i]!.verdict === 'good') g = i;
  if (b === g + 1) return { state: 'found', culprit: commits[b]!.sha, good: g >= 0 ? commits[g]!.sha : null };
  const between = commits.slice(g + 1, b).map((c, j) => ({ ...c, i: g + 1 + j }));
  const running = between.find((c) => c.verdict === 'pending');
  if (running) return { state: 'wait', sha: running.sha };
  const open = between.filter((c) => c.verdict === 'untested');
  if (!open.length) return { state: 'range', from: commits[g + 1]!.sha, to: commits[b]!.sha };
  const mid = (g + b) / 2;
  open.sort((x, y) => Math.abs(x.i - mid) - Math.abs(y.i - mid) || x.i - y.i);
  return { state: 'test', sha: open[0]!.sha };
}
