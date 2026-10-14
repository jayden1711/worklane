#!/usr/bin/env node
// CI only (.github/workflows/ci-batch.yml: whenever the fast checks finish on a push to main, whenever a ci-slow.yml
// batch or bisect run ends, and every 30 minutes as a backstop, since GitHub drops scheduled runs): the slow checks
// on main, in batches, and the bisect of a red batch. It keeps no state of its own (what ran is read back from
// GitHub: ci-slow.yml's runs, this workflow's runs, and the check runs on main's commits).
//   1. Bisect and 2. cleanup, below, first: one short look.
//   3. Batch: when main's newest commit has had no batch (no ci-slow.yml run on main for it, but a cancelled one),
//      none is queued or running, and the last one started SPACING_MS (30 minutes) ago or more, it starts one there:
//      workflow_dispatch on main, job=all. A dispatched run's check runs land on the commit it runs on, so that
//      commit gets the slow checks the engine updater requires. A commit the batch skipped never gets them, and the
//      updater never installs it. When only the spacing is in the way, the run waits it out and looks again (no
//      later event is promised to: main may stay quiet, and the schedule may be dropped), then starts the batch on
//      whatever main's newest commit is by then. Runs of this workflow take turns by run id (olderRuns): the oldest
//      decides, a newer one lets it finish first, or leaves it to it when it is waiting out the spacing. So two
//      runs never start a batch each, and only one sits waiting.
//   1. Bisect: when the newest finished batch is red, the first-parent commits between the last green batch and it
//      are the candidates. The failing job's result on each is its check run there (a batch's, or an earlier
//      bisect step's). Binary search: the next candidate is the untested one nearest the middle of the commits
//      between the newest good one and the oldest bad one; it runs that job alone on that commit (a ci-bisect/<sha>
//      branch at the commit, then workflow_dispatch on that branch, job=<key>, sha=<commit>, so the check run lands
//      on the candidate, never on main's tip). When a bad commit's first parent is good, that commit is the culprit:
//      an issue, and a comment on its PR. Commits that couldn't be tested (a skipped or cancelled run) are passed
//      over; if only those are left, the issue names the range instead.
//   2. Cleanup: a ci-bisect/ branch whose run has finished is deleted.
// Usage: node scripts/ci/batch.mjs [--dry-run]   (GITHUB_TOKEN, GITHUB_REPOSITORY; --dry-run changes nothing)

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { nextStep } from '../../src/bisect.ts';

/** ci-slow.yml's jobs, by the key a dispatch names, with the check runs each creates (test/ci-batch.test.ts). */
export const SLOW_JOBS = {
  bootstrap: ['bootstrap (ubuntu-latest)', 'bootstrap (macos-latest)'],
  'bootstrap-windows': ['bootstrap (windows-wsl)'],
  'testrun-real-systemd': ['test-run sandbox (real systemd)'],
  'add-project-real-systemd': ['add-project (real systemd)'],
  'auth-probe-real-users': ['Claude sign-in probe (real users)'],
};
export const SLOW_WORKFLOW = 'ci-slow.yml';
export const BATCH_WORKFLOW = 'ci-batch.yml';
/** INVARIANT: two batches on main never start closer together than this (the rule was only the schedule's before). */
export const SPACING_MS = 30 * 60_000;
/** WHY: the job's timeout (ci-batch.yml) must never cut a wait short: a cancelled check on main's tip stops the updater. */
export const MAX_WAIT_MS = 35 * 60_000;
/** How long a newer run gives an older one to finish its look, and how often it asks. */
export const TURN_WAIT_MS = 60_000;
export const TURN_POLL_MS = 10_000;
export const BISECT_PREFIX = 'ci-bisect/';
/** At most this many first-parent commits between the last green batch and the red one are bisected. */
export const MAX_CANDIDATES = 50;
const MARKER = 'ci-batch-bisect red-batch=';

const keyOf = (name) => Object.keys(SLOW_JOBS).find((k) => SLOW_JOBS[k].includes(name)) ?? null;
const byCreated = (a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id;
const isBatch = (r, branch) => r.event === 'workflow_dispatch' && r.head_branch === branch;

/**
 * Whether to start a batch on `head`, from ci-slow.yml's runs: not while one is queued or running on `branch`
 * (concurrency would only queue it behind), not when `head` has had one already (a cancelled one doesn't count), and
 * not within SPACING_MS of the last batch's start (its run's created_at; a cancelled one doesn't count). When only
 * the spacing is in the way, waitMs says how long until it isn't.
 */
export function batchToStart(runs, head, branch = 'main', now = Date.now()) {
  const batches = runs.filter((r) => isBatch(r, branch));
  const busy = batches.find((r) => r.status !== 'completed');
  if (busy) return { start: false, why: `batch ${busy.html_url ?? busy.id} on ${short(busy.head_sha)} is ${busy.status}` };
  const done = batches.find((r) => r.head_sha === head && r.conclusion !== 'cancelled');
  if (done) return { start: false, why: `${short(head)} has had its batch (${done.conclusion}, ${done.html_url ?? done.id})` };
  const last = batches.filter((r) => r.conclusion !== 'cancelled').sort(byCreated)[0];
  const waitMs = last ? Date.parse(last.created_at) + SPACING_MS - now : 0;
  if (waitMs > 0) return { start: false, waitMs, why: `${short(head)} has had no batch, but the last one (${short(last.head_sha)}) started ${Math.max(0, Math.floor((now - Date.parse(last.created_at)) / 60_000))} minutes ago: at most one every ${SPACING_MS / 60_000}` };
  return { start: true, why: `${short(head)} has had no batch` };
}

/** The runs of this workflow still queued or running that are older than run `runId` (run ids only grow). */
export async function olderRuns(gh, R, runId) {
  const ids = [];
  for (const status of ['in_progress', 'queued']) {
    const runs = (await gh.get(`${R}/actions/workflows/${BATCH_WORKFLOW}/runs?status=${status}&per_page=100`)).workflow_runs ?? [];
    for (const r of runs) if (r.status !== 'completed' && Number(r.id) < runId) ids.push(Number(r.id));
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Step 3, the batch: decide (batchToStart), and start it, or wait out the spacing and decide again. `first` is what
 * main() read already ({ head, runs }). Before starting or waiting, a run with a run id gives way to older runs of
 * this workflow: it lets them finish (TURN_WAIT_MS at most) and reads again; one still going after that is waiting
 * out the spacing itself, and the batch is left to it. Returns what it did: started, nothing, yielded or gave-up.
 */
export async function batchStep({ gh, R, branch, runId = 0, first = null, dry = false, say, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const began = now();
  for (let state = first; ; state = null) {
    const head = state ? state.head : (await gh.get(`${R}/commits/${encodeURIComponent(branch)}`)).sha;
    const runs = state ? state.runs : (await gh.get(`${R}/actions/workflows/${SLOW_WORKFLOW}/runs?event=workflow_dispatch&per_page=100`)).workflow_runs ?? [];
    const b = batchToStart(runs, head, branch, now());
    say(`batch: ${b.why}`);
    if (!b.start && !(b.waitMs > 0)) return 'nothing';
    if (runId) {
      let older = await olderRuns(gh, R, runId);
      if (older.length) {
        for (let waited = 0; older.length && waited < TURN_WAIT_MS; waited += TURN_POLL_MS) {
          await sleep(TURN_POLL_MS);
          older = await olderRuns(gh, R, runId);
        }
        if (older.length) {
          say(`batch: left to the older run ${older[0]} of ${BATCH_WORKFLOW}, which is waiting to start it`);
          return 'yielded';
        }
        continue; // WHY: the older run may have started the batch: read again before deciding.
      }
    }
    if (b.start) {
      await gh.write('POST', `${R}/actions/workflows/${SLOW_WORKFLOW}/dispatches`, { ref: branch, inputs: { job: 'all', sha: '' } });
      say(`batch: started on ${branch} (${short(head)})`);
      return 'started';
    }
    const mins = Math.ceil(b.waitMs / 60_000);
    if (dry) {
      say(`batch: would wait ${mins} minute(s) and look again`);
      return 'nothing';
    }
    if (now() + b.waitMs - began > MAX_WAIT_MS) {
      say(`batch: not waiting ${mins} more minute(s): past this run's ${MAX_WAIT_MS / 60_000}; a later run starts it`);
      return 'gave-up';
    }
    say(`batch: waiting ${mins} minute(s), then looking again`);
    await sleep(b.waitMs);
  }
}

/** The newest finished batch (cancelled ones aside), and the newest green batch older than it on another commit. */
export function lastBatches(runs, branch = 'main') {
  const done = runs.filter((r) => isBatch(r, branch) && r.status === 'completed' && r.conclusion !== 'cancelled').sort(byCreated);
  const last = done[0] ?? null;
  const green = last ? done.find((r) => r.conclusion === 'success' && r.head_sha !== last.head_sha && String(r.created_at) < String(last.created_at)) ?? null : null;
  return { last, green };
}

/**
 * main's first-parent line from `bad` back to `good`, oldest first, without `good`: from GitHub's compare of
 * good...bad (its commits and their parents). null when that line doesn't reach `good` inside the list.
 */
export function firstParentLine(cmp, good, bad) {
  const commits = cmp && Array.isArray(cmp.commits) ? cmp.commits : [];
  const by = new Map(commits.map((c) => [c.sha, c]));
  const line = [];
  for (let sha = bad; sha !== good; ) {
    const c = by.get(sha);
    if (!c || line.length > commits.length) return null;
    line.push({ sha, subject: String(c.commit?.message ?? '').split('\n')[0] });
    sha = c.parents?.[0]?.sha ?? null;
  }
  return line.reverse();
}

/**
 * One commit's verdict for the job, from its check runs by that name (the newest started counts): good, bad,
 * pending (queued or running, or `dispatched`: a bisect run asked for and not started yet), skip (ran, but neither
 * passed nor failed: skipped, cancelled, ...) or untested.
 */
export function verdictOf(checkRuns, dispatched = false) {
  let r = null;
  for (const x of checkRuns ?? []) if (!r || String(x.started_at ?? '') > String(r.started_at ?? '') || (x.started_at === r.started_at && x.id > r.id)) r = x;
  if (!r) return dispatched ? 'pending' : 'untested';
  if (r.status !== 'completed') return 'pending';
  if (r.conclusion === 'success') return 'good';
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return 'bad';
  return dispatched ? 'pending' : 'skip';
}

// The bisect's next step (src/bisect.ts): shared with the harness's fix-forward, which bisects a red default branch.
export { nextStep };

const short = (sha) => String(sha ?? '').slice(0, 7);

/** The issue for a finished bisect, with the marker that keeps a red batch from being reported twice. */
export function issueFor({ red, job, others, line, step, verdicts, pr, repoUrl }) {
  const link = (sha) => `[${short(sha)}](${repoUrl}/commit/${sha})`;
  const subject = (sha) => line.find((c) => c.sha === sha)?.subject ?? '';
  const found = step.state === 'found';
  const title = found
    ? `CI batch red: "${job}" broke at ${short(step.culprit)}${pr ? ` (#${pr})` : ''}`
    : `CI batch red: "${job}" broke between ${short(step.from)} and ${short(step.to)}`;
  const body = [
    `The slow-checks batch on ${link(red.head_sha)} went red: ${red.html_url}`,
    '',
    found
      ? `**Culprit:** ${link(step.culprit)} ${subject(step.culprit)}${pr ? ` (#${pr})` : ''}. "${job}" passes on its first parent${step.good ? ` ${link(step.good)}` : ' (the last green batch)'} and fails on it.`
      : `**Culprit:** one of the commits ${link(step.from)}..${link(step.to)}; those between couldn't be tested (their runs were skipped or cancelled${step.why ? `; ${step.why}` : ''}).`,
    '',
    `Bisected job: "${job}"${others.length ? `. Also red in that batch, not bisected: ${others.map((o) => `"${o}"`).join(', ')}` : ''}.`,
    '',
    'First-parent commits since the last green batch, oldest first:',
    ...line.map((c) => `- ${link(c.sha)} ${verdicts.get(c.sha) ?? 'untested'}: ${c.subject}`),
    '',
    'A bad verdict can be a flaky test: rerun the job on the culprit before reverting it.',
    `<!-- ${MARKER}${red.head_sha} -->`,
  ].join('\n');
  return { title, body };
}

/** A tiny GitHub REST client on fetch. */
function client(token, apiUrl, dry) {
  const call = async (method, path, body) => {
    const r = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'worklane-ci-batch' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`), { status: r.status });
    return r.status === 204 ? null : r.json();
  };
  return {
    get: (path) => call('GET', path),
    write: async (method, path, body) => {
      console.log(`${dry ? 'would ' : ''}${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
      return dry ? null : call(method, path, body);
    },
  };
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed');
  const gh = client(token, process.env.GITHUB_API_URL || 'https://api.github.com', dry);
  const repoUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}`;
  const R = `/repos/${repo}`;
  const info = await gh.get(R);
  const branch = info.default_branch;
  const head = (await gh.get(`${R}/commits/${encodeURIComponent(branch)}`)).sha;
  const runs = (await gh.get(`${R}/actions/workflows/${SLOW_WORKFLOW}/runs?event=workflow_dispatch&per_page=100`)).workflow_runs ?? [];
  // WHY: each line goes out as it is known: the batch step may wait out the spacing, and the bisect's lines shouldn't wait with it.
  const say = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  };

  // 1. Bisect, and 2. cleanup: a bisect branch whose run has finished.
  // WHY: an error here must not cost main its batch (the updater installs only batched commits): say it and go on.
  try {
    const refs = ((await gh.get(`${R}/git/matching-refs/heads/${BISECT_PREFIX}`)) ?? []).map((r) => ({ name: r.ref.replace(/^refs\/heads\//, ''), sha: r.object.sha }));
    for (const line of await bisect({ gh, R, repoUrl, runs, refs, branch })) say(line);
    for (const ref of refs) {
      const its = runs.filter((r) => r.head_branch === ref.name);
      if (its.length && its.every((r) => r.status === 'completed')) await gh.write('DELETE', `${R}/git/refs/heads/${ref.name}`);
    }
  } catch (e) {
    annotate(e);
  }

  // 3. Batch: last, since it may wait.
  await batchStep({ gh, R, branch, runId: Number(process.env.GITHUB_RUN_ID) || 0, first: { head, runs }, dry, say });
}

async function bisect({ gh, R, repoUrl, runs, refs, branch }) {
  const { last, green } = lastBatches(runs, branch);
  if (!last) return ['bisect: no finished batch yet'];
  if (last.conclusion === 'success') return [`bisect: the last batch (${short(last.head_sha)}) is green`];
  const issues = (await gh.get(`${R}/issues?state=all&creator=${encodeURIComponent('github-actions[bot]')}&per_page=50`)) ?? [];
  if (issues.some((i) => String(i.body ?? '').includes(`${MARKER}${last.head_sha}`))) return [`bisect: the red batch on ${short(last.head_sha)} is reported already`];
  const jobs = (await gh.get(`${R}/actions/runs/${last.id}/jobs?per_page=100`)).jobs ?? [];
  const red = jobs.filter((j) => ['failure', 'timed_out'].includes(j.conclusion) && keyOf(j.name)).map((j) => j.name);
  const order = Object.values(SLOW_JOBS).flat();
  red.sort((x, y) => order.indexOf(x) - order.indexOf(y));
  if (!red.length) return [`bisect: the red batch on ${short(last.head_sha)} failed outside the slow jobs (${jobs.filter((j) => j.conclusion !== 'success').map((j) => j.name).join(', ')}); nothing to bisect`];
  const job = red[0];
  if (!green) return [`bisect: no green batch before the red one on ${short(last.head_sha)}; nothing to bisect from`];
  const cmp = await gh.get(`${R}/compare/${green.head_sha}...${last.head_sha}`);
  const line = firstParentLine(cmp, green.head_sha, last.head_sha);
  if (!line) return [`bisect: the green batch ${short(green.head_sha)} isn't on the first-parent line of ${short(last.head_sha)}`];
  if (line.length > MAX_CANDIDATES + 1) return [`bisect: ${line.length - 1} commits since the last green batch, over ${MAX_CANDIDATES}; not bisected`];

  // Each candidate's verdict for the job: its check runs by that name; the red batch's commit is bad.
  const verdicts = new Map();
  for (const c of line.slice(0, -1)) {
    const cr = (await gh.get(`${R}/commits/${c.sha}/check-runs?check_name=${encodeURIComponent(job)}&filter=all&per_page=100`)).check_runs ?? [];
    const name = `${BISECT_PREFIX}${c.sha}`;
    const tried = runs.some((r) => r.head_branch === name && r.status === 'completed');
    const v = verdictOf(cr, refs.some((r) => r.name === name) && !tried);
    // A step that ended without running the job (its workflow refused, say): untestable, never asked again.
    verdicts.set(c.sha, v === 'untested' && tried ? 'skip' : v);
  }
  verdicts.set(last.head_sha, 'bad');
  let step = nextStep(line.map((c) => ({ sha: c.sha, verdict: verdicts.get(c.sha) })));
  const say = [`bisect: "${job}" red on ${short(last.head_sha)}; ${line.length - 1} commit(s) since the green batch ${short(green.head_sha)}: ${line.map((c) => `${short(c.sha)}=${verdicts.get(c.sha)}`).join(' ')}`];

  if (step.state === 'wait') return [...say, `bisect: waiting for "${job}" on ${short(step.sha)}`];
  if (step.state === 'test') {
    const name = `${BISECT_PREFIX}${step.sha}`;
    try {
      // 422: another run of this made it a moment ago (no concurrency group here: a cancelled run's check would be red).
      if (!refs.some((r) => r.name === name)) await gh.write('POST', `${R}/git/refs`, { ref: `refs/heads/${name}`, sha: step.sha }).catch((e) => { if (e.status !== 422) throw e; });
      await gh.write('POST', `${R}/actions/workflows/${SLOW_WORKFLOW}/dispatches`, { ref: name, inputs: { job: keyOf(job), sha: step.sha } });
      return [...say, `bisect: running "${job}" on ${short(step.sha)} (${name})`];
    } catch (e) {
      // A commit from before ci-slow.yml took a sha, say: report what is known rather than try it every run.
      await gh.write('DELETE', `${R}/git/refs/heads/${name}`).catch(() => {});
      const i = line.findIndex((c) => c.sha === step.sha);
      let lo = i;
      while (lo > 0 && verdicts.get(line[lo - 1].sha) !== 'good') lo--;
      let hi = i;
      while (verdicts.get(line[hi].sha) !== 'bad') hi++;
      step = { state: 'range', from: line[lo].sha, to: line[hi].sha, why: `couldn't start a run on ${short(step.sha)}: ${String(e.message).slice(0, 200)}` };
      say.push(`bisect: ${step.why}`);
    }
  }

  // found or range: the issue, and on a culprit, a comment on its PR.
  let pr = null;
  if (step.state === 'found') {
    const pulls = (await gh.get(`${R}/commits/${step.culprit}/pulls`).catch(() => [])) ?? [];
    const merged = /^Merge #(\d+)/.exec(line.find((c) => c.sha === step.culprit)?.subject ?? '');
    pr = (pulls.find((p) => p.merge_commit_sha === step.culprit) ?? pulls[0])?.number ?? (merged ? Number(merged[1]) : null);
  }
  const { title, body } = issueFor({ red: last, job, others: red.slice(1), line, step, verdicts, pr, repoUrl });
  const issue = await gh.write('POST', `${R}/issues`, { title, body });
  say.push(`bisect: ${title}${issue ? ` (${issue.html_url})` : ''}`);
  if (pr) {
    const text = `The slow-checks batch went red on main, and the bisect names this PR's merge (${short(step.culprit)}) as the commit that broke "${job}": ${issue ? issue.html_url : last.html_url}`;
    await gh.write('POST', `${R}/issues/${pr}/comments`, { body: text });
    say.push(`bisect: commented on #${pr}`);
  }
  return say;
}

// WHY: never a red check on main's tip: this run's check lands there, and the engine updater refuses a commit with
// any red check. An error shows as an annotation; the next run looks again.
function annotate(e) {
  console.log(`::error title=ci batch::${String(e && e.message ? e.message : e).replace(/\r?\n/g, ' ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(annotate);
}
