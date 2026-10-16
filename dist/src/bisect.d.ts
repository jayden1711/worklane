/**
 * A candidate's verdict: good, bad, pending (its test is running), skip (it ran but gave no verdict: skipped,
 * cancelled, couldn't be tested) or untested.
 */
export type BisectVerdict = 'good' | 'bad' | 'pending' | 'skip' | 'untested';
export type BisectStep = {
    state: 'found';
    culprit: string;
    good: string | null;
} | {
    state: 'wait';
    sha: string;
} | {
    state: 'test';
    sha: string;
} | {
    state: 'range';
    from: string;
    to: string;
};
/**
 * The bisect's next step. `commits`: the candidates and the red commit, oldest first, each { sha, verdict }, at
 * least one bad; the commit before the first is the last good one. Returns
 *   { state: 'found', culprit, good }  the oldest bad commit whose first parent is good (good: null = the last good one)
 *   { state: 'wait', sha }             a candidate between the two is still running
 *   { state: 'test', sha }             test this commit next: the untested one nearest the middle (binary search)
 *   { state: 'range', from, to }       only untestable commits are left between the two: the culprit is one of from..to
 */
export declare function nextStep(commits: {
    sha: string;
    verdict: BisectVerdict;
}[]): BisectStep;
