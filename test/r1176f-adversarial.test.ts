// R1176f adversarial attempts on #943 (PR #1176). Payloads follow GitHub's real shapes: a workflow run carries
// `repository` (the repo the run lives in, always the base repo, even for a fork's PR), `head_repository` (the fork for
// a fork's PR) and `pull_requests` (computed when read: the OPEN pull requests matching the run's head branch, each with
// the PR's CURRENT base and head, as observed on the engine's own repo: an older run of a PR's head lists the PR with
// its newer head). From the R1176f adversarial review, adapted to the required judging context (R1176e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBacklog } from '../src/backlog/github.js';
import { PinnedChecks, type CheckPin } from '../src/check-source.js';
import { readiness } from '../src/pr-watch.js';

const HEAD = 'a'.repeat(40);
const ACTIONS = 15368;
const REPO = { id: 1, name: 'r', url: 'https://api.github.com/repos/o/r' };
const FORK = { id: 2, name: 'r', url: 'https://api.github.com/repos/attacker/r' };
const PIN = { test: { workflow: '.github/workflows/ci.yml' } };

type PrEntry = { number: number; base: string; headSha?: string; headRepo?: typeof REPO; headRef?: string };
const prEntry = (p: PrEntry) => ({ id: p.number * 7, number: p.number, url: `https://api.github.com/repos/o/r/pulls/${p.number}`, base: { ref: p.base, sha: 'c'.repeat(40), repo: REPO }, head: { ref: p.headRef ?? 'feature', sha: p.headSha ?? HEAD, repo: p.headRepo ?? REPO } });
const run = (o: { suite: number; event?: string; branch?: string; headRepo?: string; prs: PrEntry[]; attempt?: number }) => ({
  id: o.suite * 10,
  name: 'CI',
  html_url: `https://github.com/o/r/actions/runs/${o.suite * 10}`,
  check_suite_id: o.suite,
  path: '.github/workflows/ci.yml',
  head_sha: HEAD,
  head_branch: o.branch ?? 'feature',
  event: o.event ?? 'pull_request',
  run_attempt: o.attempt ?? 1,
  repository: { full_name: 'o/r' },
  head_repository: { full_name: o.headRepo ?? 'o/r' },
  pull_requests: o.prs.map(prEntry),
});
const checkRun = (id: number, suite: number) => ({ id, name: 'test', status: 'completed', conclusion: 'success', html_url: `https://github.com/o/r/actions/runs/${suite * 10}/job/${id}`, app: { id: ACTIONS, slug: 'github-actions' }, check_suite: { id: suite } });

/**
 * Stand-in GitHub for o/r: `pullsFromRef` answers pulls?head=o:feature&state=all, `pullsOfCommit` commits/HEAD/pulls (GitHub
 * lists only OPEN PRs there for a commit not on the default branch), `timeline` issues/<n>/timeline per PR.
 */
function github(o: { checks: ReturnType<typeof checkRun>[]; runs: unknown[]; pullsFromRef: { number: number; base: string }[]; pullsOfCommit: { number: number; base: string }[]; timeline?: Record<number, unknown[]> }) {
  const calls: string[] = [];
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const pr = (p: { number: number; base: string }) => ({ number: p.number, state: 'open', base: { ref: p.base, repo: REPO }, head: { ref: 'feature', sha: HEAD, repo: REPO } });
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/check-runs`)) return ok({ total_count: o.checks.length, check_runs: o.checks });
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/status`)) return ok({ statuses: [] });
    if (path.startsWith(`/repos/o/r/actions/runs?head_sha=${HEAD}`)) return ok({ total_count: o.runs.length, workflow_runs: o.runs });
    if (path === '/repos/o/r/branches/main') return ok({ name: 'main', protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } });
    if (path.startsWith('/repos/o/r/rules/branches/main')) return ok([]);
    if (path.startsWith('/repos/o/r/pulls?head=o%3Afeature&state=all')) return ok(o.pullsFromRef.map(pr));
    if (path.startsWith(`/repos/o/r/commits/${HEAD}/pulls`)) return ok(o.pullsOfCommit.map(pr));
    const tl = /^\/repos\/o\/r\/issues\/(\d+)\/(timeline|events)/.exec(path);
    if (tl) return ok(o.timeline?.[Number(tl[1])] ?? []);
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  }) as typeof fetch;
  return { backlog: new GitHubBacklog('o/r', () => 't', f), calls };
}

async function prHead(gh: ReturnType<typeof github>, configured: Record<string, CheckPin> = PIN) {
  const pinned = new PinnedChecks({ backlog: gh.backlog, branch: () => 'main', repo: () => 'o/r', configured: () => configured });
  const r = readiness({ required: ['test'], checks: await pinned.of(HEAD, { pr: { headRef: 'feature' } }), head: HEAD, evaluated: { head: HEAD, approved: true } });
  return r.checks.map((c) => `${c.name} ${c.outcome}`);
}

// ---- Attack A: a re-pointed base. PR #5 from o:feature was opened into `evil` (its pull_request run R read evil's
// ci.yml from the merge ref evil+HEAD), then its base was edited to main. `edited` isn't in ci.yml's pull_request types,
// so nothing re-runs: R is the only run on HEAD. GitHub now lists PR #5 on R with its CURRENT base (main), and the PR
// lists (pulls?state=all, commits/{sha}/pulls) show base main too. Only the timeline shows the change.
test('A: a run from a PR opened into another base, then re-pointed to main, does not count (base_ref_changed)', async () => {
  const gh = github({
    checks: [checkRun(1, 70)],
    runs: [run({ suite: 70, prs: [{ number: 5, base: 'main' }] })],
    pullsFromRef: [{ number: 5, base: 'main' }],
    pullsOfCommit: [{ number: 5, base: 'main' }],
    timeline: { 5: [{ event: 'base_ref_changed', created_at: '2026-11-08T10:00:00Z', actor: { login: 'x' } }] },
  });
  assert.deepEqual(await prHead(gh), ['test missing'], 'R ran evil\'s ci.yml; it must not count once the PR is re-pointed');
});

// Variant: the decoy is a SECOND PR from the same ref, opened into evil, re-pointed to main, then closed. pulls?state=all
// shows its current base (main): foreignBase stays false.
test('A2: a same-ref decoy opened into evil, re-pointed to main, then closed, does not count', async () => {
  const gh = github({
    checks: [checkRun(1, 70)],
    runs: [run({ suite: 70, prs: [{ number: 6, base: 'main' }] })], // only the open genuine PR #6 is listed now
    pullsFromRef: [{ number: 5, base: 'main' }, { number: 6, base: 'main' }],
    pullsOfCommit: [{ number: 6, base: 'main' }],
    timeline: { 5: [{ event: 'base_ref_changed', created_at: '2026-11-08T10:00:00Z' }] },
  });
  assert.deepEqual(await prHead(gh), ['test missing']);
});

// ---- Attack B: a fork's decoy. attacker/r pushes the same commit HEAD on a branch also named `feature` and opens PR #9
// into an existing base `evil` of o/r. The run lives in o/r (`repository` o/r, `head_repository` attacker/r), posts on
// HEAD, head_branch `feature`. GitHub matches pull_requests by head branch/sha among o/r's own PRs, so it lists the genuine
// PR #5 (o:feature into main). The fork PR is then closed: pulls?head=o:feature never lists it, commits/{sha}/pulls lists
// only open PRs for a commit not on main.
test('B: a fork PR from a same-named branch into another base does not count for the same-repo PR', async () => {
  const gh = github({
    checks: [checkRun(1, 80)],
    runs: [run({ suite: 80, headRepo: 'attacker/r', prs: [{ number: 5, base: 'main' }] })],
    pullsFromRef: [{ number: 5, base: 'main' }],
    pullsOfCommit: [{ number: 5, base: 'main' }],
  });
  assert.deepEqual(await prHead(gh), ['test missing'], 'a run whose head_repository is a fork never decides a same-repo PR');
});

// ---- Controls the PR defends (expected to pass at 667df8bd).
test('defended: same-ref decoy into evil, closed; another ref; workflow_run; repository_dispatch; pull_request_target; a re-attempt', async () => {
  const base = { checks: [checkRun(1, 70)], pullsOfCommit: [{ number: 5, base: 'main' }] };
  // Same ref, decoy #4 into evil (closed): pulls?state=all lists it.
  assert.deepEqual(await prHead(github({ ...base, runs: [run({ suite: 70, prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 4, base: 'evil' }, { number: 5, base: 'main' }] })), ['test missing']);
  // Another ref holding HEAD.
  assert.deepEqual(await prHead(github({ ...base, runs: [run({ suite: 70, branch: 'decoy', prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 5, base: 'main' }] })), ['test missing']);
  for (const event of ['workflow_run', 'repository_dispatch', 'pull_request_target', 'push']) {
    assert.deepEqual(await prHead(github({ ...base, runs: [run({ suite: 70, event, prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 5, base: 'main' }] })), ['test missing'], event);
  }
  // A re-attempt of the decoy's run after the decoy (same ref, into evil) closed: still the decoy's run.
  assert.deepEqual(await prHead(github({ ...base, runs: [run({ suite: 70, attempt: 2, prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 4, base: 'evil' }, { number: 5, base: 'main' }] })), ['test missing']);
  // Genuine: passes.
  assert.deepEqual(await prHead(github({ ...base, runs: [run({ suite: 70, prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 5, base: 'main' }] })), ['test pass']);
});

// ---- R1176e / R1176f D3: a PR head judged with the names its caller judges (headChecksOf: merge-flow.ts people's
// batch queue, rulesetHold, mayMerge) is judged as a PR head: the genuine pull_request run counts. Judging needs a
// context: none (a cast, a missing argument) throws instead of judging the head as a main commit.
test('regression: a pinned check on a PR head judged with the names its caller judges counts the genuine run; no context throws', async () => {
  const gh = github({ checks: [checkRun(1, 70)], runs: [run({ suite: 70, prs: [{ number: 5, base: 'main' }] })], pullsFromRef: [{ number: 5, base: 'main' }], pullsOfCommit: [{ number: 5, base: 'main' }] });
  const pinned = new PinnedChecks({ backlog: gh.backlog, branch: () => 'main', repo: () => 'o/r', configured: () => PIN });
  const checks = await pinned.of(HEAD, { pr: { headRef: 'feature' } }, { judging: ['test'] });
  const r = readiness({ required: ['test'], checks, head: HEAD, evaluated: { head: HEAD, approved: true } });
  assert.deepEqual(r.checks.map((c) => `${c.name} ${c.outcome}`), ['test pass'], 'genuine pull_request run into main on a PR head');
  await assert.rejects(pinned.of(HEAD, {} as never), /say whether this is a main commit or a PR head/);
  await assert.rejects(pinned.of(HEAD, undefined as never), /say whether this is a main commit or a PR head/);
});

// R1176e: people's PRs are judged as PR heads, so the open-PR listing carries each PR's head ref.
test("the open-PR listing gives each PR's head ref (people's PRs are judged as PR heads); a PR without one has none", async () => {
  const { listOpenPrs } = await import('../src/coordinator/test-runs.js');
  const f = (async () => new Response(JSON.stringify([{ number: 3, head: { sha: HEAD, ref: 'feature/x' }, base: { ref: 'main' }, user: { login: 'someone', type: 'User' } }, { number: 4, head: { sha: HEAD }, base: { ref: 'main' }, user: null }]), { status: 200 })) as unknown as typeof fetch;
  const prs = await listOpenPrs('o/r', async () => 't', f);
  assert.deepEqual(prs.map((p) => [p.number, p.headRef]), [[3, 'feature/x'], [4, undefined]]);
});
