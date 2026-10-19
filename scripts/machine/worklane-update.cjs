#!/usr/bin/env node
// Engine updates, run as root by worklane-update.timer every 10 minutes and installed as
// /usr/local/libexec/worklane-update by scripts/setup/updates.sh. It does nothing unless
// /etc/worklane/updates.json has "enabled": true (set through the machine helper's
// `set-updates on`). Its "channel" says what it follows:
//   - "release" (new installs): the newest release tag vX.Y.Z, only when it is newer than the installed
//     version, its signature verifies (`git verify-tag`) against the owner's allowed signers file
//     (updates.json allowed_signers), and its commit is the main commit it was cut from plus dist/ only.
//     The checks below are read on that main commit (CI runs on main, not on tags).
//   - "main" (the default when the field is absent, so an existing install keeps following main): the newest
//     commit on main's first-parent line that passes the checks below, only when it descends from the installed
//     engine (never older, never a rewrite). One red tip doesn't block updates: from the tip back, newest first, it
//     reads each commit's check runs (one API call each, a second apart, an older commit's red verdict remembered
//     for an hour) and stops at the first fully green one that isn't held. It looks at most updates.json
//     "max_lookback" commits back (default 20), only at commits newer than the installed one, and never at a merge's
//     second parent. A commit whose checks are pending (or haven't started) is waited for, nothing older installed,
//     until it has been on main for updates.json "pending_wait_minutes" (default 60, from its committer date); after
//     that an older fully green commit may go in instead, and the pending one still installs later if it turns green.
//     Installing an older commit than the tip logs a "chose" line: the commit, and why each newer one was skipped.
//     On the engine repo the slow checks run in batches (.github/workflows/ci-batch.yml: main's newest commit, at
//     most every 30 minutes), so only a batched commit can have every required check: one the batch skipped reads
//     as "hasn't run" and is never installed. Such a commit isn't waited for when nothing is in flight on it (a
//     required check hasn't run, and no check on it is queued or running, 10 minutes or more after it landed): an
//     older fully green commit goes in at once. Otherwise a busy main, whose tip is rarely the batched commit, would keep every batched one waiting.
// Either way it installs only if:
//   - every check on it is complete and green, and every required check (updates.json
//     required_checks) ran and succeeded: a missing, pending, failed or skipped one refuses it;
//   - the machine is quiet: no agent slot or full-run lock is held and no emergency stop is on.
// Drain: a machine that is never quiet (one instance running long test tiers back to back) would starve updates for
// good. So once an update has waited updates.json "drain_after_minutes" (default 60) for a busy machine, the updater
// drains it: it writes /var/lib/worklane/update-drain.json (root-owned 0644: { since, until, to }), and while it
// stands no coordinator starts a new test run, takes the full-run lock or starts an agent (src/update-drain.ts, read
// by every one of those gates under the slot directory's lock). What is running finishes; nothing is ever stopped. Each
// run while draining writes it again, 30 minutes ahead, and raises the stuck alert with what is still finishing and
// when it should be done (each test run records its own cap in its slot: its setup steps', its database's and its
// tiers' timeouts); past that, the alert says it is overdue and the drain goes on: the updater never installs over a
// running test run or agent, and never kills one. Once nothing is in flight it installs as below, with the flag kept
// (3 hours ahead) through the install, and then removes it whatever the outcome: installed, current, refused, held,
// a failed build, a rollback, an error, updates turned off. A coordinator ignores a flag past its "until", so an
// updater that crashed never leaves the machine drained. An install that finds the machine quiet without a drain
// still puts the flag up for its own span (after a 5-second settle, checking quiet again), so no run starts during
// the build only to be stopped with the services; after the build it checks quiet once more.
// It builds as a throwaway unprivileged user (a systemd DynamicUser) with `npm ci
// --ignore-scripts` from the lockfile; root only copies the built tree into /opt/worklane/<sha>.
// Before switching, it stops the services and migrates every instance's config and state with the NEW engine
// (`migrate --instance <name> --json`, run as that instance's coordinator user through systemd-run, as the
// instance's own unit runs; each file is backed up first). If a migration fails, it restores every instance's
// backups, starts the services again on the old engine and holds the commit. Otherwise it switches
// /opt/worklane/current and restarts the instance and dashboard services, and if any of them isn't active and
// steady within 2 minutes, it restores the migration backups, switches back and restarts again.
// The test sandbox, after the restart: an engine can come up "active and steady" and still have lost its test runs (a
// helper change once made every coordinator's startup sandbox check fail from inside its unit, while it passed from
// a shell). So before switching, the updater asks each instance for its last startup verdict (`sandbox-status
// --instance <name> --json`, the new engine's, run as the instance's user like migrate: root never opens an
// instance's event log), and after the restart it waits, updates.json "sandbox_wait_minutes" at most (default 10),
// for a verdict newer than the restart. An instance that passed before and fails after rolls the update back as an
// unhealthy service does (backups, helpers, the old engine, restart) and holds the commit; the rollback's reason
// names the instance and the check's own words, redacted. That rollback's order: stop the services, put the
// migrations' backups back, put the old engine's root helpers back (each one the new engine replaced, byte for byte,
// owner and mode kept), switch /opt/worklane/current back, and only then restart, so the old engine never starts
// beside a helper of another protocol. A helper that can't be put back is the first thing the reason says.
// An instance with no test runs, with no verdict before, or
// already failing before, is never waited for and never rolls anything back. No verdict in time from one that
// passed before: rolled back and held too (updates.json "sandbox_on_timeout": "hold", the default: an engine whose
// test runs can't be shown to work isn't kept). "sandbox_on_timeout": "stand" keeps the install instead and raises
// an incident that says the check couldn't be confirmed.
// The canary (updates.json "canary": { "instance", "repo", "time_limit_minutes" }, docs/canary.md): a scratch-repo
// instance that gets a tiny issue each day and after every install, filed and read with the engine's `canary` command
// as that instance's user. It must go issue -> plan -> PR -> green checks -> merged within the time limit (default
// 120 minutes). While one runs, no other update starts. After an install, a canary that fails or runs out of time
// rolls back as above (backups restored, the old engine, services restarted), holds the commit and raises a watchdog
// incident. A daily canary that fails only raises the incident.
// The root-owned helpers the setup scripts installed from scripts/machine/ (the test-run sandbox helper, the machine
// helper, the console shell) follow the engine: with its services stopped, just before the switch, each one this
// machine has is replaced by the new engine's copy when the two differ (atomically: a checked temp file beside it,
// renamed over it, with the installed file's owner and mode; sudoers is never touched; a helper the machine doesn't
// have is never installed). An engine and its helpers then always speak the same protocol. If one can't be replaced,
// the update is rolled back and held, like a failed migration. Every rollback puts the old engine's helpers back.
// The updater itself (#760) follows only the release channel: never main, which has no signature to check. Once an
// install from a release tag is healthy (services steady, sandbox verdicts in), it takes that release's updater: read
// from the tag's commit in the root-owned clone after the tag's signature is checked again, never from the build, and
// only when the release is newer than the running updater's recorded version (release order, so an engine rollback
// never takes it back). The running one is kept as worklane-update.prev for a manual rollback. Root's flag file
// /etc/worklane/updater-no-self-update turns this off. A refusal leaves the running updater as it is, with the reason
// in the "installed" log line.
// Every attempt, install, refusal, rollback and canary is one JSON line in /var/lib/worklane/updates.jsonl (a wait
// or refusal once per commit and reason). Every run also prints one line to stdout, the journal: the result, and for
// a wait, refusal, hold or failed build the commit and the reason (`waiting b9634df: required check "x" hasn't run
// on this commit`), secrets redacted.
// Stuck: when the machine has stayed on one engine commit for updates.json "stuck_alert_minutes" (default 120) while
// what it follows has moved on, it raises one watchdog incident (update_stuck: the installed commit, the newest one,
// how long, and the reason it gives now), once per episode, and resolves it when an install succeeds or there is
// nothing newer. Never while updates are off; a machine that is only busy ("not quiet") must have been busy that long.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Fixed paths: the installed updater takes none from its caller.
const CONFIG = '/etc/worklane/updates.json';
const LOG = '/var/lib/worklane/updates.jsonl';
const STATE = '/var/lib/worklane/update-state.json';
const HELD = '/var/lib/worklane/update-held.json'; // the last rolled-back commit: { sha, at, failed }
const STUCK = '/var/lib/worklane/update-stuck.json'; // since when the engine has been behind: { installed, since, tip, notQuietSince, raised }
const DRAIN = '/var/lib/worklane/update-drain.json'; // the drain every coordinator honors (src/update-drain.ts): { since, until, to }
const CANARY = '/var/lib/worklane/canary.json'; // the canary running now, and when the last one was filed (root, 0600)
const OPT = '/opt/worklane';
const SLOTS = '/var/lib/worklane/agent-slots';
const VERDICTS = '/var/lib/worklane/update-verdicts.json'; // older main commits' red check verdicts, reused an hour
const VERIFY_GIT = '/var/lib/worklane/verify.git'; // a root-owned bare clone, only for checking release tags
const ALLOWED_SIGNERS = '/etc/worklane/allowed_signers';
const BUILD_STATE = 'worklane-build'; // the DynamicUser's StateDirectory, /var/lib/worklane-build
const BUILD_DIR = `/var/lib/${BUILD_STATE}`;

// The root helpers an engine ships (scripts/machine/) and where the setup scripts install them: kept in step by syncHelpers.
const HELPERS = [
  { dest: '/usr/local/libexec/worklane-testrun', src: 'scripts/machine/worklane-testrun.sh', check: 'bash' }, // test-user.sh
  { dest: '/usr/local/libexec/worklane-machine', src: 'scripts/machine/worklane-machine.cjs', check: 'node' }, // machine-helper.sh
  { dest: '/usr/local/libexec/worklane-console-shell', src: 'scripts/machine/worklane-console-shell.sh', check: 'bash' }, // console-shell.sh
  { dest: '/usr/local/libexec/worklane-gpu-devices', src: 'scripts/machine/worklane-gpu-devices.sh', check: 'bash' }, // gpu-devices.sh (run by udev)
  { dest: '/usr/local/libexec/worklane-exp', src: 'scripts/machine/worklane-exp.sh', check: 'bash' }, // experiments.sh
];
// The updater itself (syncSelf): where it runs from, the copy it replaced, its release version and sha256 (root, 0644,
// written by updates.sh and by each self-update), and root's switch to turn self-update off.
const SELF = '/usr/local/libexec/worklane-update';
const SELF_PREV = '/usr/local/libexec/worklane-update.prev';
const SELF_RECORD = '/var/lib/worklane/updater.json';
const SELF_OFF = '/etc/worklane/updater-no-self-update';
const SELF_SRC = 'scripts/machine/worklane-update.cjs';
const SELF_ROLLBACK = `sudo install -o root -g root -m 0755 ${SELF_PREV} ${SELF}`;
const SELF_SETUP = 'sudo bash /opt/worklane/current/scripts/setup/updates.sh';

const HEALTH_MS = 120_000;
const STABLE_MS = 30_000;
const POLL_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
const CANARY_LIMIT_MIN = 120;
const LOOKBACK = 20; // updates.json max_lookback: first-parent commits looked at, from main's tip back
const LOOKBACK_MAX = 100;
const PENDING_WAIT_MIN = 60; // updates.json pending_wait_minutes
const STUCK_ALERT_MIN = 120; // updates.json stuck_alert_minutes
const STUCK_INCIDENT = 'update_stuck'; // the watchdog incident's kind (src/watchdog/incidents.ts KINDS); its key is 'engine'
const DRAIN_AFTER_MIN = 60; // updates.json drain_after_minutes: how long an update waits for a busy machine before draining it
const DRAIN_TTL_MS = 30 * 60_000; // a drain's flag lapses this long after the run that wrote it (three timer ticks)
const DRAIN_INSTALL_TTL_MS = 3 * 3600_000; // through an install: the build, migrations, restart and sandbox wait (src/update-drain.ts honors at most 4 h)
const DRAIN_SETTLE_MS = 5_000; // after putting the flag up on a quiet machine, before reading the slots again
const DRAIN_MARGIN_MS = 15 * 60_000; // beyond the in-flight runs' caps: their workspace, caches and wipe
const SANDBOX_WAIT_MIN = 10; // updates.json sandbox_wait_minutes: how long a restarted instance has to say its sandbox check's result
const SANDBOX_POLL_MS = 10_000;
const SANDBOX_INCIDENT = 'update_sandbox_unconfirmed'; // the watchdog incident for a verdict that never came (key: the instance)
const CHECKS_SPACING_MS = 1_000; // between two check-run calls in one run
const CHECK_PAGES_MAX = 10; // pages of 100 check runs read for one commit
const IDLE_AFTER_MS = 10 * 60_000; // WHY: a commit's checks take a moment to appear; before this, "nothing running" isn't idle
const JOURNAL_MAX = 1000; // characters of one stdout line (journalLine)
const VERDICT_TTL_MS = 60 * 60_000; // how long an older commit's red verdict is reused before GitHub is asked again

// ---------- decisions (pure) ----------

/** owner/repo from a GitHub clone URL. */
function repoFromUrl(url) {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** GitHub's compare of installed...candidate: only "ahead, nothing behind" is a fast-forward. */
function fastForward(cmp) {
  if (cmp && cmp.status === 'ahead' && cmp.behind_by === 0) return { ok: true };
  return { ok: false, reason: `not a fast-forward of the installed engine (GitHub compare: ${cmp ? `${cmp.status}, ${cmp.ahead_by} ahead, ${cmp.behind_by} behind` : 'no answer'})` };
}

/** updates.json max_lookback: a whole number 1..100, else 20. */
function lookbackOf(cfg) {
  const n = cfg && cfg.max_lookback;
  return Number.isInteger(n) && n >= 1 ? Math.min(n, LOOKBACK_MAX) : LOOKBACK;
}

/** updates.json stuck_alert_minutes, in ms: a number above 0, else 120 minutes. */
function stuckAlertMs(cfg) {
  const n = cfg && cfg.stuck_alert_minutes;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : STUCK_ALERT_MIN) * 60_000;
}

/** updates.json drain_after_minutes, in ms: a number above 0, else 60 minutes. */
function drainAfterMs(cfg) {
  const n = cfg && cfg.drain_after_minutes;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DRAIN_AFTER_MIN) * 60_000;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * A slot file's pid, only when it can name one other process: a whole number of 2 or more. 0 and a negative pid
 * address process groups and pid 1 is init, so `kill(pid, 0)` on any of them answers "alive" for good: a corrupt or
 * hand-edited slot file would hold every update off forever. Anything else is no holder.
 */
const slotPid = (v) => (Number.isInteger(v) && v >= 2 ? v : null);

/** What is in flight: live test-run slots and the full-run lock (test runs), and agent slots. entries: [{ name, pid, acquiredAt?, limitMs? }]. */
function inFlight(entries, alive) {
  const live = entries.filter((e) => slotPid(e.pid) && alive(e.pid));
  return { tests: live.filter((e) => /^test-\d+\.lock$/.test(e.name) || e.name === 'full-run.lock'), agents: live.filter((e) => /^agent-\d+\.lock$/.test(e.name)) };
}

/** When the test runs in flight are done at the latest: the latest start plus its cap, plus a margin; null when none runs or one has no recorded cap. */
function drainDeadline(tests) {
  let t = 0;
  for (const e of tests) {
    const at = Date.parse(e.acquiredAt);
    if (!(typeof e.limitMs === 'number' && e.limitMs > 0) || !Number.isFinite(at)) return null;
    t = Math.max(t, at + e.limitMs);
  }
  return tests.length ? t + DRAIN_MARGIN_MS : null;
}

const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Whether this run drains the machine, and what it tells (pure). `prev`: the flag as it stands (or null), `stuck`: the
 * stuck alert's state, which knows since when the machine has been busy for this engine. It drains when a flag of its
 * own still stands, or once the machine has been busy drain_after (afterMs). Returns null, or { flag, tests, agents,
 * deadline, overdue, line }: the flag to write (30 minutes ahead) and the line the wait and the stuck alert say.
 */
function drainStep(prev, stuck, current, head, entries, alive, afterMs, now) {
  const live = prev && typeof prev.since === 'string' && Date.parse(prev.until) > now ? prev : null;
  const waited = stuck && stuck.installed === current && stuck.notQuietSince ? now - Date.parse(stuck.notQuietSince) : NaN;
  if (!live && !(waited >= afterMs)) return null;
  const f = inFlight(entries, alive);
  const deadline = drainDeadline(f.tests);
  const since = live ? live.since : iso(now);
  const overdue = deadline !== null && now > deadline;
  const what = [f.tests.length ? count(f.tests.length, 'test run') : '', f.agents.length ? count(f.agents.length, 'agent') : ''].filter(Boolean).join(' and ') || 'nothing';
  const when = !f.tests.length
    ? ''
    : deadline === null
      ? '; a test run has no recorded cap'
      : overdue
        ? `; OVERDUE: the test runs were due by ${iso(deadline)} (their tiers' caps); nothing is stopped and the update keeps waiting`
        : `; the test runs are due by ${iso(deadline)} (their tiers' caps)`;
  const line = `draining for the update since ${since}: no new test run or agent starts; ${what} finishing${when}`;
  return { flag: { since, until: iso(now + DRAIN_TTL_MS), to: head }, tests: f.tests.length, agents: f.agents.length, deadline, overdue, line };
}

/**
 * Write the drain flag. Never throws: a flag that can't be written (a full disk) must not stop the update that may
 * fix it; the wait or the install goes on without it, and the log says so.
 */
function putFlag(deps, flag) {
  try {
    deps.saveDrain(flag);
    return true;
  } catch (e) {
    try {
      deps.log({ event: 'error', reason: `the drain flag couldn't be written (${String((e && e.message) || e).slice(0, 200)})` });
    } catch {
      // the journal has it
    }
    return false;
  }
}

/** Remove the drain flag (reopen the machine). Never throws: the flag lapses at its "until" by itself. */
function reopen(deps) {
  if (typeof deps.drainState !== 'function' || typeof deps.saveDrain !== 'function') return;
  try {
    if (deps.drainState()) deps.saveDrain(null);
  } catch (e) {
    try {
      deps.log({ event: 'error', reason: `the drain flag couldn't be removed (${String((e && e.message) || e).slice(0, 200)}); it lapses by itself at its "until"` });
    } catch {
      // the journal has it
    }
  }
}

/** `2 h 10 min` */
const span = (ms) => {
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/**
 * The stuck alert's next step, from what this run saw (pure). `state` is what the last run left (or null), `seen`
 * this run's: { current, head, result, reason }, or null when updates are off. Behind: the run ended any way but
 * installed or current, on an engine that isn't the newest commit (head unknown, a run that failed before asking:
 * still behind if it was). Returns { state, raise?: { detail, fix }, resolve?: true }:
 *   - not behind, or off: the state cleared, and the incident resolved if this episode raised one;
 *   - behind: the clock runs from the first run that saw this engine behind; one raise per episode, once it has
 *     been afterMs, and, when the reason is only a busy machine ("not quiet"), once that has lasted afterMs too.
 */
function stuckStep(state, seen, afterMs, now, what = 'main') {
  const mine = state && seen && state.installed === seen.current ? state : null;
  const behind = !!seen && !!seen.current && seen.result !== 'installed' && seen.result !== 'current' && (seen.head ? seen.head !== seen.current : !!mine);
  if (!behind) return { state: null, ...(state && state.raised ? { resolve: true } : {}) };
  const at = new Date(now).toISOString();
  const busy = /^not quiet\b/.test(String(seen.reason || ''));
  const next = { installed: seen.current, since: mine ? mine.since : at, tip: seen.head || (mine && mine.tip) || null, notQuietSince: busy ? (mine && mine.notQuietSince) || at : null, raised: !!(mine && mine.raised) };
  // WHY: an engine that changed under an open alert (a rollback to an older one, say) ends that episode.
  const out = { state: next, ...(state && state.raised && !mine ? { resolve: true } : {}) };
  const stuckMs = now - Date.parse(next.since);
  // Draining: raised at once and on every run (an open incident's detail is updated in place), with what is finishing.
  if (seen.drain) {
    next.raised = true;
    const detail = `the engine has been on ${short(next.installed)} for ${span(stuckMs)} while ${what} moved on${next.tip ? ` to ${short(next.tip)}` : ''}; ${seen.drain.line}`;
    const fix = seen.drain.overdue
      ? 'runs are going past their caps: nothing is stopped and the update waits. Let them finish, or end them yourself and the next updater run installs; the Updates panel on the Machine page shows what is left'
      : 'nothing to do: new test runs and agents wait until the update is installed, then start again by themselves; the Updates panel on the Machine page shows it';
    return { ...out, raise: { detail: detail.slice(0, 600), fix } };
  }
  if (next.raised || !(stuckMs >= afterMs) || (busy && !(now - Date.parse(next.notQuietSince) >= afterMs))) return out;
  next.raised = true;
  const why = redact(String(seen.reason || '')).replace(/\s+/g, ' ').trim();
  const detail = `the engine has been on ${short(next.installed)} for ${span(stuckMs)} while ${what} moved on${next.tip ? ` to ${short(next.tip)}` : ''}; the updater says: ${seen.result}${why ? `: ${why}` : ''}`;
  return { ...out, raise: { detail: detail.slice(0, 600), fix: 'read the reason; the Updates panel on the Machine page and /var/lib/worklane/updates.jsonl have the history' } };
}

/** Apply stuckStep: save the state, raise or resolve the incident. Never throws: an alert must not stop an update. */
function stuckCheck(deps, cfg, seen) {
  if (typeof deps.stuckState !== 'function' || typeof deps.saveStuck !== 'function') return;
  try {
    const before = deps.stuckState();
    const step = stuckStep(before, seen, stuckAlertMs(cfg), deps.now(), cfg && channelOf(cfg) === 'release' ? 'the newest release' : (cfg && cfg.branch) || 'main');
    if (JSON.stringify(step.state) !== JSON.stringify(before || null)) deps.saveStuck(step.state);
    if (step.resolve && typeof deps.resolveIncident === 'function') deps.resolveIncident(STUCK_INCIDENT, 'engine');
    if (step.raise && typeof deps.raiseIncident === 'function') deps.raiseIncident(STUCK_INCIDENT, 'engine', step.raise.detail, step.raise.fix);
  } catch {
    // the update log has the reason either way
  }
}

/** updates.json pending_wait_minutes, in ms: a number >= 0, else 60 minutes. */
function pendingWaitMs(cfg) {
  const n = cfg && cfg.pending_wait_minutes;
  return (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : PENDING_WAIT_MIN) * 60_000;
}

/**
 * The commits that may be installed, newest first: main's first-parent line from `head` back to the installed
 * commit (not included), at most `max`, read from GitHub's compare of installed...head (its commits and their
 * parents). Only when that line reaches the installed commit inside the compare's list, so every one descends from
 * it; otherwise (no installed commit, a truncated list, an installed commit off the first-parent line) the tip alone.
 * Each is { sha, date } (its committer date: when it landed on main).
 */
function firstParentLine(cmp, current, head, max) {
  const commits = cmp && Array.isArray(cmp.commits) ? cmp.commits.filter((c) => c && typeof c.sha === 'string') : null;
  const by = new Map((commits || []).map((c) => [c.sha, c]));
  const dateOf = (c) => (c && c.commit && c.commit.committer && typeof c.commit.committer.date === 'string' ? c.commit.committer.date : null);
  const tipOnly = [{ sha: head, date: dateOf(by.get(head)) }];
  if (!current || !commits || (typeof cmp.total_commits === 'number' && cmp.total_commits > commits.length)) return tipOnly;
  const line = [];
  for (let sha = head; sha !== current; ) {
    const c = by.get(sha);
    if (!c || line.length >= commits.length) return tipOnly;
    line.push({ sha, date: dateOf(c) });
    sha = Array.isArray(c.parents) && c.parents[0] ? c.parents[0].sha : null;
  }
  return line.length ? line.slice(0, max) : tipOnly;
}

const short = (sha) => String(sha).slice(0, 7);
/**
 * Every check run on a commit, page by page: 100 a page, the next page (CHECKS_SPACING_MS later) while GitHub's
 * total_count says there are more, at most CHECK_PAGES_MAX pages. A commit can carry well over 100: the CI batch's
 * scheduled run adds one to main's tip every half hour, newest first, so the checks that matter can be on a later
 * page. Returns { check_runs } (past CHECK_PAGES_MAX pages, the newest only: a required check among the older ones
 * reads as not run, so that commit isn't installed), or null when GitHub gives no answer for any page.
 */
async function checkRunsOf(deps, api, sha) {
  const all = [];
  for (let page = 1; page <= CHECK_PAGES_MAX; page++) {
    if (page > 1) await deps.sleep(CHECKS_SPACING_MS);
    const data = await deps.fetchJson(`${api}/commits/${sha}/check-runs?per_page=100${page > 1 ? `&page=${page}` : ''}`);
    if (!data || !Array.isArray(data.check_runs)) return null; // a page missing could hide a red check
    all.push(...data.check_runs);
    if (data.check_runs.length < 100 || !(data.total_count > all.length)) break;
  }
  return { check_runs: all };
}

/** `a0685ce: required check "push-gate" ended failure; …` */
const skippedText = (skipped) => skipped.map((s) => `${short(s.sha)}: ${s.reason}`).join('; ');
// A hold is released only at a root shell (updates.sh --release-hold) or by a newer commit: never by updates.json
// changing, which any coordinator can make happen through the machine helper (the on/off switch, the channel).
const RELEASE_HOLD = 'sudo bash /opt/worklane/current/scripts/setup/updates.sh --release-hold';
const heldReason = (held) => `rolled back at ${held.at}${held.failed && held.failed.length ? ` (${held.failed.join('; ')})` : ''}; held until a newer commit, or until an admin releases it at a root shell: ${RELEASE_HOLD}`;

/**
 * Which candidate (firstParentLine, newest first) to install: the newest one that isn't held and whose checks are
 * all green (evaluateChecks). One check-run call per commit, CHECKS_SPACING_MS apart, stopping at the first green
 * one; an older commit's final red verdict is reused for VERDICT_TTL_MS (deps.verdicts/saveVerdicts, optional), so a
 * long red streak doesn't spend the API's hourly limit (the tip is always asked). A pending commit, or one GitHub
 * gave no answer for, stops the scan to wait for it, until it has been on main pendingWaitMs; after that it is
 * passed over for an older one. An idle commit (evaluateChecks: a required check hasn't run and nothing on it is
 * queued or running, IDLE_AFTER_MS or more after it landed) is passed over at once: nothing in flight will make it green, and waiting on it would only
 * keep an older green commit out. Below the tip its verdict is remembered like a red one (only main's newest commit
 * gets a batch). What may be installed is unchanged: only a commit whose checks are all green. Returns { chosen, skipped } | { wait, reason, skipped } | { none: true, skipped },
 * skipped being the newer commits passed over: [{ sha, reason, held?, pending? }].
 */
async function chooseCommit(deps, cfg, api, cands, held) {
  const now = deps.now();
  const waitMs = pendingWaitMs(cfg);
  const memo = (typeof deps.verdicts === 'function' && deps.verdicts()) || {};
  const kept = {};
  for (const [sha, v] of Object.entries(memo)) if (v && typeof v.reason === 'string' && now - Date.parse(v.at) < VERDICT_TTL_MS) kept[sha] = v;
  let changed = Object.keys(kept).length !== Object.keys(memo).length;
  const skipped = [];
  let calls = 0;
  let out = null;
  for (let i = 0; i < cands.length && !out; i++) {
    const c = cands[i];
    let v;
    if (held && held.sha === c.sha) v = { ok: false, final: true, held: true, reason: heldReason(held) };
    else if (i > 0 && kept[c.sha]) v = { ok: false, final: true, reason: kept[c.sha].reason };
    else {
      if (calls++) await deps.sleep(CHECKS_SPACING_MS);
      const data = await checkRunsOf(deps, api, c.sha);
      v = data ? evaluateChecks(data.check_runs, cfg.required_checks) : { ok: false, final: false, noAnswer: true, reason: 'GitHub gave no answer for its check runs' };
      // WHY: idle only once the commit has been on main a while: just landed, its checks may not have appeared yet.
      if (v.idle && !(now - Date.parse(c.date || '') >= IDLE_AFTER_MS)) v = { ...v, idle: false };
      if (!v.ok && (v.final || v.idle) && i > 0) {
        kept[c.sha] = { reason: v.reason, at: new Date(now).toISOString() };
        changed = true;
      }
    }
    if (v.ok) {
      out = { chosen: c, skipped };
      break;
    }
    let pending = false;
    if (!v.final) {
      const landed = Date.parse(c.date || '');
      if (v.noAnswer || !(v.idle || now - landed >= waitMs)) {
        out = { wait: c, reason: v.reason, skipped };
        break;
      }
      pending = true;
      v = { ...v, reason: now - landed >= waitMs ? `${v.reason}, still ${Math.round(waitMs / 60_000)}+ minutes after it landed (pending_wait_minutes)` : `${v.reason}, and none of its checks is queued or running` };
    }
    skipped.push({ sha: c.sha, reason: v.reason, ...(v.held ? { held: true } : {}), ...(pending ? { pending: true } : {}) });
  }
  if (changed && typeof deps.saveVerdicts === 'function') {
    try {
      deps.saveVerdicts(kept);
    } catch {
      // the memo only saves API calls
    }
  }
  return out || { none: true, skipped };
}

const GREEN = new Set(['success', 'neutral', 'skipped']);
/**
 * Every check on the commit complete and green, and every required check present and successful.
 * final: true when waiting can't fix it (failed, skipped required); false when it may (pending, missing).
 * idle: true when a required check hasn't run and every check that is on the commit is complete: nothing in flight
 * will bring it (a slow check that only runs in batches, on a commit with no batch).
 */
function evaluateChecks(runs, required) {
  if (!Array.isArray(required) || required.length === 0) return { ok: false, final: true, reason: 'no required checks configured in updates.json' };
  const latest = new Map();
  for (const r of runs || []) {
    const prev = latest.get(r.name);
    if (!prev || (r.started_at || '') > (prev.started_at || '') || ((r.started_at || '') === (prev.started_at || '') && r.id > prev.id)) latest.set(r.name, r);
  }
  for (const name of required) {
    const r = latest.get(name);
    if (!r) return { ok: false, final: false, idle: [...latest.values()].every((x) => x.status === 'completed'), reason: `required check "${name}" hasn't run on this commit` };
    if (r.status !== 'completed') return { ok: false, final: false, reason: `required check "${name}" is ${r.status}` };
    if (r.conclusion === 'skipped') return { ok: false, final: true, reason: `required check "${name}" was skipped` };
    if (r.conclusion !== 'success') return { ok: false, final: true, reason: `required check "${name}" ended ${r.conclusion}` };
  }
  for (const [name, r] of latest) {
    if (r.status !== 'completed') return { ok: false, final: false, reason: `check "${name}" is ${r.status}` };
    if (!GREEN.has(r.conclusion)) return { ok: false, final: true, reason: `check "${name}" ended ${r.conclusion}` };
  }
  return { ok: true };
}

/** Quiet: no live agent slot, test-run slot or full-run lock, and no emergency stop. entries: [{ name, pid|null }]. */
function quiet(entries, alive) {
  for (const e of entries) {
    if (e.name === 'STOP') return { quiet: false, stop: true, why: 'an emergency stop is in force' };
    if (/^test-\d+\.lock$/.test(e.name) && slotPid(e.pid) && alive(e.pid)) return { quiet: false, why: 'a test run is going' };
    if ((/^agent-\d+\.lock$/.test(e.name) || e.name === 'full-run.lock') && slotPid(e.pid) && alive(e.pid)) return { quiet: false, why: e.name === 'full-run.lock' ? 'a full test run is going' : 'an agent is running' };
  }
  return { quiet: true };
}

/** The services an update restarts: every worklane-*.service but the updater and the build. */
function parseUnits(listing) {
  return String(listing)
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => /^worklane-[a-z0-9-]+\.service$/.test(u) && u !== 'worklane-update.service' && !u.startsWith('worklane-build'));
}

/** `systemctl show -p ActiveState,SubState,NRestarts,Result <unit>` as { state, sub, restarts, result }. */
function parseShow(text) {
  const kv = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { state: kv.ActiveState || 'unknown', sub: kv.SubState || '', restarts: Number(kv.NRestarts || 0) || 0, result: kv.Result || 'success' };
}

const asUnit = (v) => (typeof v === 'string' ? { state: v, sub: '', restarts: 0, result: 'success' } : v);

/**
 * After a restart: 'healthy' once every unit has been active for STABLE_MS without a break; 'failed'
 * at once when a unit is failed or crash-looping (restarted since the first sample, waiting in
 * auto-restart, or not active with a Result other than success), or when HEALTH_MS passes without that;
 * else 'wait'. samples: [{ at, states: { unit: ActiveState | { state, sub, restarts, result } } }].
 */
function health(samples, startedAt, now) {
  const first = samples[0] ? Object.fromEntries(Object.entries(samples[0].states).map(([u, v]) => [u, asUnit(v)])) : {};
  for (const s of samples) {
    for (const [u, raw] of Object.entries(s.states)) {
      const v = asUnit(raw);
      if (v.state === 'failed' || v.sub === 'auto-restart' || (v.result !== 'success' && v.state !== 'active') || v.restarts > (first[u] ? first[u].restarts : 0)) return 'failed';
    }
  }
  let since = null;
  for (const s of samples) {
    const all = Object.values(s.states).every((v) => asUnit(v).state === 'active');
    since = all ? (since ?? s.at) : null;
  }
  if (since !== null && now - since >= STABLE_MS) return 'healthy';
  return now - startedAt >= HEALTH_MS ? 'failed' : 'wait';
}

/** Secrets that could appear in a service's journal, replaced before anything is logged. */
function redact(text) {
  return String(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, '[redacted]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@') // WHY: a clone URL can carry user:token@
    .replace(/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
}

/**
 * One journal line for a run's result: the event, the commit's short sha and the reason, on one line, secrets
 * redacted (a reason can quote updates.json's repo_url or a build's output), capped.
 * `waiting b9634df: required check "x" hasn't run on this commit`
 */
function journalLine(event, sha, reason) {
  const why = redact(String(reason == null ? '' : reason)).replace(/\s+/g, ' ').trim();
  const line = `${event}${sha ? ` ${short(sha)}` : ''}${why ? `: ${why}` : ''}`;
  return line.length > JOURNAL_MAX ? `${line.slice(0, JOURNAL_MAX)}…` : line;
}

/**
 * deps.note: a refusal or wait goes to updates.jsonl once per commit and reason (state remembers the last one), not
 * every 10 minutes, and to the journal (print) on every run, so `journalctl -u` always says why it isn't updating.
 */
function makeNote({ readState, writeState, log, print }) {
  return (event, sha, reason) => {
    // INVARIANT: the state file holds the redacted reason, so the dedupe compares redacted with redacted: a reason
    // with a secret in it is still logged once, not every run.
    const why = redactDeep(reason);
    const last = readState() || {};
    if (last.event !== event || last.sha !== sha || last.reason !== why) {
      log({ event, to: sha, reason: why });
      writeState({ event, sha, reason: why });
    }
    print(journalLine(event, sha, reason));
    return event;
  };
}

/** A value with redact() applied to every string in it, however deep (keys are the updater's own, never data). */
function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/**
 * INVARIANT: every write to the update log, the state file and the hold file goes through these two, redacted: all
 * three are world-readable (0644), and their fields carry reasons, URLs, build output and journal lines.
 */
function appendLog(file, entry) {
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...redactDeep(entry) })}\n`, { mode: 0o644 });
}
function writeRedacted(file, value) {
  saveJson(file, redactDeep(value), 0o644);
}

/** The last lines of a text, capped. */
const tail = (text, max) => (text.length > max ? `…${text.slice(-max)}` : text);

// The build, as a throwaway user: clone, check out exactly the commit, install from the lockfile
// with no dependency scripts, and build the CLI and the web UI.
const BUILD_SCRIPT = [
  'rm -rf src',
  'git clone -q "$1" src',
  'cd src',
  'git checkout -q --detach "$2"',
  'test "$(git rev-parse HEAD)" = "$2"',
  'npm ci --ignore-scripts --no-audit --no-fund',
  'npm run -s build',
  'npm run -s build:web',
  'test -f dist/src/cli.js',
  'test -f dist/web/index.html',
].join(' && ');

/** The build as a transient DynamicUser unit. `state` is the StateDirectory name (a test passes its own). */
function buildCommand(repoUrl, sha, state = BUILD_STATE) {
  const dir = `/var/lib/${state}`;
  return [
    'systemd-run', '--wait', '--collect', '--pipe', '--quiet',
    '-p', 'DynamicUser=yes', '-p', `StateDirectory=${state}`, '-p', 'PrivateTmp=yes', '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes', '-p', 'NoNewPrivileges=yes',
    `--working-directory=${dir}`, `--setenv=HOME=${dir}`, '--setenv=PATH=/usr/local/bin:/usr/bin:/bin',
    '/bin/bash', '-euo', 'pipefail', '-c', BUILD_SCRIPT, '_', repoUrl, sha,
  ];
}

/** The files a package's "bin" names (a string, or an object of name -> path), relative to the package. */
function binTargets(pkg) {
  const bin = pkg && pkg.bin;
  if (typeof bin === 'string') return [bin];
  if (bin && typeof bin === 'object') return Object.values(bin).filter((v) => typeof v === 'string');
  return [];
}

/** Every bin target exists and is executable by everyone; else the reason it isn't. */
function binProblems(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (e) {
    return [`package.json unreadable: ${String((e && e.message) || e).split('\n')[0]}`];
  }
  const targets = binTargets(pkg);
  if (!targets.length) return ['package.json names no bin'];
  const out = [];
  for (const t of targets) {
    const f = path.join(dir, t);
    if (!fs.existsSync(f)) out.push(`bin ${t} is missing`);
    else if ((fs.statSync(f).mode & 0o111) !== 0o111) out.push(`bin ${t} is not executable (mode ${(fs.statSync(f).mode & 0o777).toString(8)})`);
  }
  return out;
}

/**
 * Copy the built tree into <opt>/<sha> as root, readable by every user and writable by none but root.
 * Every file the built package.json names in "bin" is made 0755: the services exec the CLI through
 * /usr/local/bin/<cli> (a symlink to current/<bin>), and tsc writes it 0644, which `a+rX` alone leaves
 * unexecutable (203/EXEC). Throws, before anything is switched, if a bin target is missing or still not
 * executable. opt, buildDir and owner are parameters for tests only; production uses the defaults.
 */
function installTree(sha, opt = OPT, buildDir = BUILD_DIR, owner = 'root:root') {
  const dest = path.join(opt, sha);
  if (fs.existsSync(path.join(dest, 'dist', 'web', 'index.html')) && binProblems(dest).length === 0) return;
  const tmp = path.join(opt, `.${sha}.new`);
  fs.rmSync(tmp, { recursive: true, force: true });
  execFileSync('cp', ['-a', path.join(buildDir, 'src'), tmp]);
  execFileSync('chown', ['-R', owner, tmp]);
  execFileSync('chmod', ['-R', 'a+rX,go-w', tmp]);
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
  } catch {
    // reported by binProblems below
  }
  for (const t of binTargets(pkg)) {
    const f = path.join(tmp, t);
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
  const problems = binProblems(tmp);
  if (problems.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`the built tree can't be started: ${problems.join('; ')}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}

/**
 * Put each root helper this machine has in step with the engine in `engineDir` (its scripts/machine/ copy): left as
 * it is when the content is the same; else replaced atomically by a temp file in the same directory with the
 * installed file's owner and mode, syntax-checked (bash -n, node --check), then renamed over it, so a helper that is
 * running keeps its old file and the next call gets the whole new one. A helper the machine doesn't have is never
 * installed (its sudoers rule is the setup script's), and sudoers is never touched. Throws, having removed its temp
 * file, when one can't be replaced; the ones before it stay replaced (the caller puts the old engine's back).
 * Returns each helper's state: same, updated, absent (not installed here) or missing (not in this engine).
 */
function syncHelpers(engineDir, helpers = HELPERS, exec = execFileSync) {
  const out = [];
  for (const h of helpers) {
    let st;
    try {
      st = fs.lstatSync(h.dest);
    } catch {
      out.push({ path: h.dest, state: 'absent' });
      continue;
    }
    if (!st.isFile()) throw new Error(`${h.dest} isn't a regular file; not replacing it`);
    const src = path.join(engineDir, h.src);
    let next;
    try {
      next = fs.readFileSync(src);
    } catch {
      out.push({ path: h.dest, state: 'missing' });
      continue;
    }
    if (fs.readFileSync(h.dest).equals(next)) {
      out.push({ path: h.dest, state: 'same' });
      continue;
    }
    // node --check refuses an unknown extension, so the machine helper's temp name ends in .cjs.
    const tmp = path.join(path.dirname(h.dest), `.${path.basename(h.dest)}.update${h.check === 'node' ? '.cjs' : ''}`);
    fs.rmSync(tmp, { force: true });
    try {
      fs.writeFileSync(tmp, next, { mode: 0o600, flag: 'wx' });
      fs.chownSync(tmp, st.uid, st.gid);
      fs.chmodSync(tmp, st.mode & 0o7777);
      if (h.check === 'node') exec(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      else exec('bash', ['-n', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      fs.renameSync(tmp, h.dest);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      const said = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
      throw new Error(`couldn't replace ${h.dest} with ${src}: ${said}`);
    }
    out.push({ path: h.dest, state: 'updated' });
  }
  return out;
}

/** After a rollback: the old engine's helpers back. Never throws; what it couldn't do is returned for the log. */
function helpersBack(deps, sha) {
  try {
    return { helpers: deps.syncHelpers(sha).filter((h) => h.state === 'updated') };
  } catch (e) {
    return { helpers_error: String((e && e.message) || e).slice(0, 500) };
  }
}

// ---------- the updater itself (#760) ----------

const sha256 = (buf) => require('node:crypto').createHash('sha256').update(buf).digest('hex');
const firstLine = (e) => String((e && e.stderr && String(e.stderr).trim()) || (e && e.message) || e).split('\n')[0].slice(0, 300);

/**
 * A file read as src/os readRegularFile reads one: through one descriptor opened without following a symlink, so what
 * is checked is what is read. { kind: 'file', uid, mode, bytes }, or { kind }: missing, symlink, not-file, too-big,
 * unreadable.
 */
function readRootFile(file, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    const code = e && e.code;
    return { kind: code === 'ELOOP' || code === 'EMLINK' ? 'symlink' : code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile()) return { kind: 'not-file' };
    if (s.size > maxBytes) return { kind: 'too-big' };
    const buf = Buffer.alloc(maxBytes + 1);
    const n = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    return n > maxBytes ? { kind: 'too-big' } : { kind: 'file', uid: s.uid, mode: s.mode & 0o7777, bytes: buf.subarray(0, n) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Why a readRootFile result isn't root's own file (owned by `owner`, no group or other write), or null. */
function rootFileProblem(f, owner, what) {
  const kinds = { missing: 'missing', symlink: 'a symlink', 'not-file': 'not a regular file', 'too-big': 'too big', unreadable: 'unreadable' };
  if (f.kind !== 'file') return `${what} is ${kinds[f.kind] || f.kind}`;
  if (f.uid !== owner) return `${what} is owned by uid ${f.uid}, not ${owner}`;
  if (f.mode & 0o022) return `${what} is writable by group or others (mode ${f.mode.toString(8)})`;
  return null;
}

/** Root's off switch: anything at all at SELF_OFF turns self-update off (a flag that isn't root's own too). Null when on. */
function selfUpdateOff(flag = SELF_OFF, owner = 0) {
  try {
    fs.lstatSync(flag);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    return `${flag} can't be read (${(e && e.code) || e}), so self-update stays off`;
  }
  const why = rootFileProblem(readRootFile(flag, 4096), owner, flag);
  return why ? `${why}; self-update stays off until root removes it` : `self-update is off (${flag}, root's switch)`;
}

/** The record of the running updater ({ version, sha256, ... }), only from root's own file, or null. */
function readSelfRecord(record, owner) {
  const f = readRootFile(record, 64 * 1024);
  if (rootFileProblem(f, owner, record)) return null;
  try {
    const r = JSON.parse(f.bytes.toString('utf8'));
    return r && semver(r.version) && /^[0-9a-f]{64}$/.test(String(r.sha256)) ? r : null;
  } catch {
    return null;
  }
}

/**
 * Write `bytes` beside `dest` and rename them over it, root's and 0755: a temp file (exclusive, 0600), chown, chmod,
 * `check` on it, then read back through one O_NOFOLLOW descriptor (a regular file, root's, mode 0755, the same bytes)
 * before the rename; `before()` runs between those checks and the rename. Throws, its temp file removed, with what
 * failed; `dest` is then as it was.
 */
function placeFile(bytes, dest, tmpName, o, check = null, before = null) {
  const tmp = path.join(path.dirname(dest), tmpName);
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
    o.chown(tmp, o.owner, 0);
    o.chmod(tmp, 0o755);
    if (check) check(tmp);
    const got = o.inspect(tmp);
    const why = rootFileProblem(got, o.owner, tmp) || (got.mode !== 0o755 ? `${tmp} has mode ${got.mode.toString(8)}, not 755` : null) || (got.bytes.equals(bytes) ? null : `${tmp} isn't the bytes written`);
    if (why) throw new Error(why);
    if (before) before();
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // a directory put there: left for root to look at; dest is untouched either way
    }
    throw e;
  }
}

/**
 * A release's updater, only as this machine verifies it: the tag's signature checked again (git verify-tag against the
 * allowed signers, as verifyRelease), the signed tag object naming itself `tag` and pointing at `commit` (the engine
 * just installed), and the file read from that commit's tree in the root-owned clone, never from the build.
 * `exec` returns a Buffer. { ok: true, version, tag, commit, bytes } or { ok: false, reason }.
 */
function verifiedUpdater(signers, tag, commit, exec, gitDir = VERIFY_GIT, exists = fs.existsSync) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(tag));
  if (!m) return { ok: false, reason: `${tag} isn't a release tag vX.Y.Z` };
  if (!exists(signers)) return { ok: false, reason: `no allowed signers file at ${signers}` };
  const g = (...a) => exec('git', ['--git-dir', gitDir, ...a]);
  try {
    g('-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-tag', tag);
  } catch (e) {
    return { ok: false, reason: `${tag}'s signature doesn't verify against ${signers}: ${String((e && e.stderr) || (e && e.message) || e).split('\n').filter(Boolean).slice(-1)[0] || 'no signature'}` };
  }
  let at;
  let named;
  try {
    at = String(g('rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`)).trim();
    named = (/^tag (\S+)$/m.exec(String(g('cat-file', 'tag', `refs/tags/${tag}`))) || [])[1] || null;
  } catch (e) {
    return { ok: false, reason: `couldn't read ${tag}: ${firstLine(e)}` };
  }
  if (at !== commit) return { ok: false, reason: `${tag} points at ${short(at)}, not at the engine just installed (${short(commit)})` };
  if (named !== tag) return { ok: false, reason: `${tag}'s signed tag object names itself ${named || 'nothing'}` };
  try {
    return { ok: true, version: m[1], tag, commit, bytes: Buffer.from(g('cat-file', 'blob', `${commit}:${SELF_SRC}`)) };
  } catch {
    return { ok: false, reason: `${tag} has no ${SELF_SRC}` };
  }
}

/**
 * Replace the running updater with a verified release's (verifiedUpdater's `src`), or say why not. Never throws.
 * Refused, the running updater left as it is: root's switch is off; the running updater isn't root's regular file; its
 * version isn't known (SELF_RECORD must name its sha256); the release isn't newer than it (release order, never hashes);
 * the new file fails `node --check` or isn't root's regular 0755 file with the release's bytes (placeFile). The running
 * one is copied to SELF_PREV first, for a manual rollback (SELF_ROLLBACK). The running process keeps its old file.
 * Returns { state: 'updated' | 'same' | 'off' | 'refused', from, to, reason?, prev? }, from/to: { version, sha256 }.
 */
function syncSelf(src, opts = {}) {
  const o = { dest: SELF, prev: SELF_PREV, record: SELF_RECORD, off: SELF_OFF, owner: 0, exec: execFileSync, chown: fs.chownSync, chmod: fs.chmodSync, inspect: readRootFile, now: Date.now, ...opts };
  const to = { version: src.version, sha256: sha256(src.bytes), tag: src.tag };
  const from = { version: null, sha256: null };
  const no = (reason, state = 'refused') => ({ state, from, to, reason });
  try {
    const off = selfUpdateOff(o.off, o.owner);
    if (off) return no(off, 'off');
    const cur = o.inspect(o.dest);
    const bad = rootFileProblem(cur, o.owner, o.dest);
    if (bad) return no(`${bad}; not replacing it`);
    from.sha256 = sha256(cur.bytes);
    const rec = readSelfRecord(o.record, o.owner);
    if (rec && rec.sha256 === from.sha256) from.version = rec.version;
    if (from.sha256 === to.sha256) return { state: 'same', from, to };
    if (!from.version) return no(`the running updater's version isn't known (${o.record} doesn't name its sha256): rerun ${SELF_SETUP} once`);
    if (!newer(to.version, from.version)) return no(`${to.tag}'s updater (${to.version}) isn't newer than the running one (${from.version}): an updater is never replaced by an older or equal release's`);
    const check = (tmp) => {
      try {
        o.exec(process.execPath, ['--check', tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        throw new Error(`node --check failed: ${firstLine(e)}`);
      }
    };
    // INVARIANT: the copy for a manual rollback is in place before the rename, the first change to the running updater.
    const keep = () => placeFile(cur.bytes, o.prev, `.${path.basename(o.prev)}.tmp`, o);
    try {
      // node --check refuses an unknown extension, so the temp name ends in .cjs.
      placeFile(src.bytes, o.dest, `.${path.basename(o.dest)}.new.cjs`, o, check, keep);
    } catch (e) {
      return no(`the new updater wasn't installed, the running one is as it was: ${firstLine(e)}`);
    }
    try {
      saveJson(o.record, { version: to.version, sha256: to.sha256, tag: to.tag, commit: src.commit, source: 'release', at: iso(o.now()), previous: from }, 0o644);
    } catch (e) {
      return { state: 'updated', from, to, prev: o.prev, reason: `${o.record} couldn't be written (${firstLine(e)}): the next self-update is refused until ${SELF_SETUP} is rerun` };
    }
    return { state: 'updated', from, to, prev: o.prev };
  } catch (e) {
    return no(`couldn't replace the updater: ${firstLine(e)}`);
  }
}

/** The version in package.json two levels above this checkout's updater (scripts/machine/), or null. */
function checkoutVersion(src) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(src), '..', '..', 'package.json'), 'utf8')).version;
    return semver(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * updates.sh, as root, before it installs this checkout's updater (this file): 3 to keep the installed one, when it is
 * a release's updater newer than this checkout (its record names its sha256): never a downgrade, as for a self-update.
 * Else 0, the installed one first copied to SELF_PREV (root's, 0755) when it is root's and differs from this one.
 */
function setupBefore(opts = {}) {
  const o = { dest: SELF, prev: SELF_PREV, record: SELF_RECORD, owner: 0, chown: fs.chownSync, chmod: fs.chmodSync, inspect: readRootFile, src: __filename, print: (l) => process.stdout.write(`${l}\n`), ...opts };
  const version = o.version === undefined ? checkoutVersion(o.src) : o.version;
  const cur = o.inspect(o.dest);
  if (rootFileProblem(cur, o.owner, o.dest) || cur.bytes.equals(fs.readFileSync(o.src))) return 0;
  const rec = readSelfRecord(o.record, o.owner);
  if (rec && rec.sha256 === sha256(cur.bytes) && newer(rec.version, version)) {
    o.print(`kept the installed updater: ${rec.tag || rec.version}'s (${rec.version}), newer than this checkout's (${version || 'no version'}). To go back by hand: ${SELF_ROLLBACK}`);
    return 3;
  }
  placeFile(cur.bytes, o.prev, `.${path.basename(o.prev)}.tmp`, o);
  o.print(`kept the updater it replaces as ${o.prev} (sha256 ${sha256(cur.bytes).slice(0, 12)})`);
  return 0;
}

/** updates.sh, as root, after it installed this checkout's updater: its version and sha256 recorded (kept when the record already names it). */
function setupRecord(opts = {}) {
  const o = { dest: SELF, record: SELF_RECORD, owner: 0, inspect: readRootFile, src: __filename, now: Date.now, ...opts };
  const version = o.version === undefined ? checkoutVersion(o.src) : o.version;
  const cur = o.inspect(o.dest);
  const bad = rootFileProblem(cur, o.owner, o.dest);
  if (bad) throw new Error(bad);
  const hash = sha256(cur.bytes);
  const rec = readSelfRecord(o.record, o.owner);
  if (rec && rec.sha256 === hash) return;
  // No version (a checkout without one): no record, so the updater never replaces itself until there is one.
  if (!version) return void fs.rmSync(o.record, { force: true });
  saveJson(o.record, { version, sha256: hash, source: 'updates.sh', at: iso(o.now()) }, 0o644);
}

/**
 * The coordinator units among the restarted ones, with the instance each runs and its user: from
 * `systemctl show -p User,Environment,ExecStart` (ExecStart names `coordinator run --instance <name>`).
 */
function parseInstance(unit, text) {
  const kv = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const m = /\bcoordinator run --instance ([a-z][a-z0-9-]{0,40})\b/.exec(kv.ExecStart || '');
  if (!m || !/^[a-z_][a-z0-9_-]{0,31}$/.test(kv.User || '')) return null;
  const env = String(kv.Environment || '').split(/\s+/).filter((e) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(e));
  return { unit, name: m[1], user: kv.User, env };
}

/** As the instance's own unit runs: its user, its slice, its home as the working directory, its environment. */
function asInstance(inst, argv) {
  const env = inst.env.some((e) => e.startsWith('PATH=')) ? inst.env : ['PATH=/usr/local/bin:/usr/bin:/bin', ...inst.env];
  return ['systemd-run', '--wait', '--collect', '--pipe', '--quiet', '-p', `User=${inst.user}`, '-p', 'Slice=worklane.slice', '-p', 'WorkingDirectory=~', ...env.map((e) => `--setenv=${e}`), ...argv];
}

/** The new engine's `migrate` for one instance, run as its coordinator user. */
function migrateCommand(inst, sha, opt = OPT) {
  // node through env: found on the unit's own PATH, as the instance's service finds it.
  return asInstance(inst, ['/usr/bin/env', 'node', path.posix.join(opt, sha, 'dist', 'src', 'cli.js'), 'migrate', '--instance', inst.name, '--json']);
}

/** The new engine's `sandbox-status` for one instance, run as its coordinator user (read-only: its own event log). */
function sandboxCommand(inst, sha, opt = OPT) {
  return asInstance(inst, ['/usr/bin/env', 'node', path.posix.join(opt, sha, 'dist', 'src', 'cli.js'), 'sandbox-status', '--instance', inst.name, '--json']);
}

/**
 * `sandbox-status --json`'s answer as { configured, last: { ok, detail, at } | null }, or null when it gave none
 * (an unknown state is never a verdict).
 */
function parseSandbox(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).pop() || '';
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (!j || j.ok !== true) return null;
  const l = j.last;
  const last = l && typeof l.ok === 'boolean' && typeof l.at === 'string' && Number.isFinite(Date.parse(l.at)) ? { ok: l.ok, detail: String(l.detail || ''), at: l.at } : null;
  return { configured: j.configured === true, last };
}

/** updates.json sandbox_on_timeout: "stand" only when it says so; anything else, and unset, is "hold". */
const sandboxOnTimeout = (cfg) => (cfg && cfg.sandbox_on_timeout === 'stand' ? 'stand' : 'hold');

/** updates.json sandbox_wait_minutes, in ms: a number above 0, else 10 minutes. */
function sandboxWaitMs(cfg) {
  const n = cfg && cfg.sandbox_wait_minutes;
  return (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : SANDBOX_WAIT_MIN) * 60_000;
}

/**
 * One instance's sandbox verdict across an update, from its status before the switch and now (parseSandbox's, or
 * null), and when the restart began:
 *   skip  nothing to compare: no test runs configured, no verdict before, or it was already failing before;
 *   wait  it passed before, and the restarted process hasn't said yet (the last verdict is from before the restart);
 *   pass / fail  it passed before, and the restarted process's own check passed / failed.
 */
function sandboxVerdict(before, after, restartedAt) {
  if (!before || !before.configured || !before.last || before.last.ok !== true) return 'skip';
  if (!after || !after.last || !(Date.parse(after.last.at) >= restartedAt)) return 'wait';
  return after.last.ok ? 'pass' : 'fail';
}

/**
 * After the restart: each instance that passed before, asked until its restarted process has said (sandboxVerdict),
 * every SANDBOX_POLL_MS, sandboxWaitMs at most; it stops at the first failure (the update rolls back either way).
 * Returns { passed, failed: [{ instance, detail }], unconfirmed } (instance names; detail redacted, one line).
 */
async function verifySandbox(deps, cfg, instances, before, sha, restartedAt) {
  const out = { passed: [], failed: [], unconfirmed: [] };
  if (typeof deps.sandboxStatus !== 'function') return out;
  let left = instances.filter((i) => sandboxVerdict(before[i.name], null, restartedAt) === 'wait');
  const deadline = deps.now() + sandboxWaitMs(cfg);
  while (left.length) {
    const still = [];
    for (const inst of left) {
      const after = deps.sandboxStatus(inst, sha);
      const v = sandboxVerdict(before[inst.name], after, restartedAt);
      if (v === 'fail') out.failed.push({ instance: inst.name, detail: redact(after.last.detail).replace(/\s+/g, ' ').trim().slice(0, 500) });
      else if (v === 'pass') out.passed.push(inst.name);
      else still.push(inst);
    }
    left = still;
    if (!left.length || out.failed.length || deps.now() >= deadline) break;
    await deps.sleep(SANDBOX_POLL_MS);
  }
  out.unconfirmed = left.map((i) => i.name);
  return out;
}

/** Put one backup back, as the instance's user (the files are its own): a log loses the migrated one's WAL files. */
function restoreCommand(inst, b) {
  return asInstance(inst, ['/bin/sh', '-c', 'cp -p -- "$1" "$2" && rm -f -- "$2-wal" "$2-shm"', '_', b.backup, b.path]);
}

/** `migrate --json`'s answer, or a failure when it printed none. */
function parseMigrate(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).at(-1) || '';
  try {
    const j = JSON.parse(line);
    return { ok: j.ok === true, error: j.error || null, made: Array.isArray(j.made) ? j.made.filter((b) => b && typeof b.path === 'string' && typeof b.backup === 'string') : [], applied: Array.isArray(j.applied) ? j.applied : [] };
  } catch {
    return { ok: false, error: `no answer from migrate: ${line.slice(0, 300)}`, made: [], applied: [] };
  }
}

/** What updates.json follows: "release" or "main"; absent or anything else is main (an existing install keeps it). */
const channelOf = (cfg) => (cfg && cfg.channel === 'release' ? 'release' : 'main');

const semver = (v) => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null);
/** a > b, as X.Y.Z versions. */
function newer(a, b) {
  const [x, y] = [semver(a), semver(b)];
  if (!x || !y) return !!x && !y;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * `git ls-remote --tags <repo> 'refs/tags/v*'` as release tags: { tag, version, object, commit, annotated }. An
 * annotated tag's line names the tag object and its `^{}` line the commit; a lightweight tag (no `^{}`) can't be signed.
 */
function parseTags(listing) {
  const tags = new Map();
  for (const line of String(listing).split('\n')) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const t = tags.get(m[2]) || { tag: `v${m[2]}`, version: m[2], object: null, commit: null };
    if (m[3]) t.commit = m[1];
    else t.object = m[1];
    tags.set(m[2], t);
  }
  return [...tags.values()].map((t) => ({ ...t, commit: t.commit || t.object, annotated: !!t.commit }));
}

/** The newest release tag. */
function newestRelease(tags) {
  return tags.reduce((best, t) => (!best || newer(t.version, best.version) ? t : best), null);
}

/**
 * Check a release tag before anything is built: fetched into a root-owned bare clone, its signature verified by
 * `git verify-tag` against the allowed signers file (SSH signatures), its commit one commit on top of a commit on
 * main that adds only dist/. Returns { ok, base } (base: the main commit whose checks count) or { ok: false, reason }.
 */
function verifyRelease(repoUrl, tag, signers, exec, gitDir = VERIFY_GIT, exists = fs.existsSync) {
  if (!exists(signers)) return { ok: false, reason: `no allowed signers file at ${signers}: the release channel installs only tags signed by a key listed there` };
  const g = (...a) => exec('git', ['--git-dir', gitDir, ...a]).trim();
  try {
    if (!exists(gitDir)) exec('git', ['init', '-q', '--bare', gitDir]);
    g('fetch', '-q', '--force', '--no-tags', repoUrl, `+refs/tags/${tag}:refs/tags/${tag}`, '+refs/heads/main:refs/heads/main');
  } catch (e) {
    return { ok: false, reason: `couldn't fetch ${tag}: ${String((e && e.message) || e).split('\n')[0]}` };
  }
  if (g('cat-file', '-t', `refs/tags/${tag}`) !== 'tag') return { ok: false, reason: `${tag} is a lightweight tag: it can't carry a signature` };
  try {
    g('-c', 'gpg.format=ssh', '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-tag', tag);
  } catch (e) {
    const said = String((e && e.stderr) || (e && e.message) || e).split('\n').filter(Boolean).slice(-1)[0];
    return { ok: false, reason: `${tag}'s signature doesn't verify against ${signers}: ${said || 'no signature'}` };
  }
  const commit = g('rev-parse', `${tag}^{commit}`);
  const parents = g('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
  if (parents.length !== 1) return { ok: false, reason: `${tag}'s commit has ${parents.length} parents; a release commit has one, the main commit it was cut from` };
  try {
    g('merge-base', '--is-ancestor', parents[0], 'refs/heads/main');
  } catch {
    return { ok: false, reason: `${tag} wasn't cut from main: ${parents[0].slice(0, 12)} isn't on main` };
  }
  const outside = g('diff', '--name-only', parents[0], commit).split('\n').filter((f) => f && !f.startsWith('dist/'));
  if (outside.length) return { ok: false, reason: `${tag}'s release commit changes more than dist/: ${outside.slice(0, 5).join(', ')}` };
  return { ok: true, base: parents[0] };
}

// ---------- the run ----------

async function run(deps) {
  // What this run saw, for the stuck alert: the installed engine, the newest commit, the reason it noted, any drain.
  const seen = { current: null, head: null, reason: '' };
  try {
    return await runOnce(deps, seen);
  } finally {
    // INVARIANT: the machine is reopened on every way a run ends but "still draining": installed, current, refused,
    // held, a failed build, rolled back, an error, updates off, a canary.
    if (!seen.keepDrain) reopen(deps);
  }
}

async function runOnce(deps, seen) {
  const cfg = deps.config();
  watchSigners(deps, cfg);
  if (!cfg || cfg.enabled !== true) {
    stuckCheck(deps, cfg, null); // off: never an alert, and an open one is closed
    return 'disabled';
  }
  // A canary running now goes first: no other update starts until it has passed, failed or run out of time.
  if (cfg.canary) {
    const st = deps.canaryState() || {};
    if (st.pending) return checkCanaryNow(deps, cfg, st);
  }
  const noting = { ...deps, note: (event, sha, reason, ...rest) => ((seen.reason = reason), deps.note(event, sha, reason, ...rest)) };
  let r;
  try {
    r = await update(noting, cfg, seen);
  } catch (e) {
    stuckCheck(deps, cfg, { ...seen, result: 'error', reason: String(e && e.message ? e.message : e).slice(0, 300) });
    throw e;
  }
  stuckCheck(deps, cfg, { ...seen, result: r });
  // Once a day, when no install just filed one: a canary on the engine as it is.
  if (cfg.canary && r !== 'installed' && r !== 'rolled_back' && dailyDue(deps.canaryState(), deps.now())) {
    const filed = startCanary(deps, cfg, 'daily', null);
    return filed.ok ? 'canary_filed' : 'canary_failed';
  }
  return r;
}

async function update(deps, cfg, seen = {}) {
  const gh = repoFromUrl(cfg.repo_url);
  if (!gh) return deps.note('refused', null, `updates.json repo_url isn't a GitHub repository: ${cfg.repo_url}`, true);
  const current = deps.installed();
  seen.current = current;
  const release = channelOf(cfg) === 'release';
  // WHY: a pass with nothing newer logged nothing, so the dashboard couldn't say when this channel last checked (#465).
  // The state file gets a dated entry; updates.jsonl stays a log of changes.
  const upToDate = (newest) => {
    if (deps.checked) deps.checked({ event: 'current', at: new Date(deps.now()).toISOString(), channel: release ? 'release' : 'main', sha: current, version: deps.installedVersion ? deps.installedVersion() : null, newest });
    return 'current';
  };
  let head;
  let tag = null;
  if (release) {
    tag = newestRelease(parseTags(deps.exec('git', ['ls-remote', '--tags', cfg.repo_url, 'refs/tags/v*'])));
    if (!tag) return deps.note('waiting', null, `no release tag vX.Y.Z on ${cfg.repo_url} yet`, false);
    head = tag.commit;
    seen.head = head;
    if (head === current) return upToDate(tag.tag);
    // Never back: a tag no newer than the installed engine's version is not an update.
    const installedVersion = deps.installedVersion();
    if (installedVersion && !newer(tag.version, installedVersion)) return upToDate(tag.tag);
  } else {
    head = deps.exec('git', ['ls-remote', cfg.repo_url, `refs/heads/${cfg.branch || 'main'}`]).split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(head)) return deps.note('refused', null, `no ${cfg.branch || 'main'} on ${cfg.repo_url}`, true);
    seen.head = head;
    if (head === current) return upToDate(head);
  }
  // A commit that was rolled back is never retried by itself: only a newer commit, or an admin at a root shell
  // (updates.sh --release-hold, which moves the hold file aside), releases it. Nothing a coordinator can do through
  // the machine helper does: updates.json changing (on/off, the channel) is not read here.
  // (On main, a held commit is passed over for an older one; see chooseCommit.)
  const held = deps.held();
  const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  // On main: the newer commits passed over for the one installed, and why.
  let skipped = [];
  if (release) {
    if (held && held.sha === head) return deps.note('held', head, heldReason(held), true);
    // The commit whose checks count: the main commit the release was cut from.
    // The signers file changed outside updates.sh and nobody has acknowledged it: no release is installed on its say-so.
    const signersHeld = typeof deps.signersHold === 'function' ? deps.signersHold() : null;
    if (signersHeld) return deps.note('held', head, `the signers file changed outside updates.sh at ${signersHeld.at} and hasn't been acknowledged (${signersChangeText(signersHeld)}); no release is installed until an admin runs: ${SIGNERS_ACK}`, true);
    const v = deps.verifyRelease(cfg.repo_url, tag.tag, cfg.allowed_signers || ALLOWED_SIGNERS);
    if (!v.ok) return deps.note('refused', head, v.reason, true);
    const checks = evaluateChecks(((await checkRunsOf(deps, api, v.base)) || {}).check_runs, cfg.required_checks);
    if (!checks.ok) return deps.note(checks.final ? 'refused' : 'waiting', head, checks.reason, checks.final);
  } else {
    if (!Array.isArray(cfg.required_checks) || cfg.required_checks.length === 0) return deps.note('refused', head, 'no required checks configured in updates.json', true);
    const cmp = current ? await deps.fetchJson(`${api}/compare/${current}...${head}`) : { status: 'ahead', behind_by: 0, ahead_by: 0 };
    const ff = fastForward(cmp);
    if (!ff.ok) return deps.note('refused', head, ff.reason, true);
    // The newest commit on main's first-parent line, back to the installed one, whose checks are all green.
    const pick = await chooseCommit(deps, cfg, api, firstParentLine(cmp, current, head, lookbackOf(cfg)), held);
    skipped = pick.skipped;
    if (pick.wait) return deps.note('waiting', pick.wait.sha, skipped.length ? `${pick.reason}; newer commits skipped: ${skippedText(skipped)}` : pick.reason, false);
    if (pick.none) {
      const tip = skipped[0];
      const event = tip.held ? 'held' : tip.pending ? 'waiting' : 'refused';
      return deps.note(event, head, skipped.length === 1 ? tip.reason : `nothing to install: ${skippedText(skipped)}`, event !== 'waiting');
    }
    head = pick.chosen.sha;
  }
  const drains = typeof deps.drainState === 'function' && typeof deps.saveDrain === 'function';
  const entries = deps.slots();
  const q = quiet(entries, deps.alive);
  if (!q.quiet) {
    // WHY: an emergency stop is the owner's, not a busy machine: it never starts or keeps a drain.
    const d = drains && !q.stop ? drainStep(deps.drainState(), typeof deps.stuckState === 'function' ? deps.stuckState() : null, current, head, entries, deps.alive, drainAfterMs(cfg), deps.now()) : null;
    if (d) {
      putFlag(deps, d.flag);
      seen.drain = d;
      seen.keepDrain = true;
    }
    return deps.note('waiting', head, `not quiet: ${q.why}${d ? `; ${d.line}` : ''}`, false);
  }
  // The install holds the machine for its span: a run that started during the build would be stopped with the services.
  let drained = false;
  let flag = null;
  if (drains) {
    const prev = deps.drainState();
    drained = !!(prev && typeof prev.since === 'string' && Date.parse(prev.until) > deps.now());
    flag = { since: drained ? prev.since : iso(deps.now()), until: iso(deps.now() + DRAIN_INSTALL_TTL_MS), to: head };
    putFlag(deps, flag);
    if (!drained) {
      // WHY: a gate that read no flag a moment ago may be taking a slot now; read the slots again after that moment.
      await deps.sleep(DRAIN_SETTLE_MS);
      const again = quiet(deps.slots(), deps.alive);
      if (!again.quiet) return deps.note('waiting', head, `not quiet: ${again.why}`, false);
    }
  }

  if (skipped.length) {
    deps.log({ event: 'chose', from: current, to: head, tip: skipped[0].sha, skipped, reason: `${short(head)} is the newest commit on main's first-parent line with every check green; skipped ${skippedText(skipped)}` });
  }
  deps.log({ event: 'attempt', from: current, to: head, ...(tag ? { tag: tag.tag } : {}) });
  const [file, ...args] = buildCommand(cfg.repo_url, head);
  try {
    deps.exec(file, args, { timeout: 40 * 60_000 });
  } catch (e) {
    return deps.note('build_failed', head, String(e.message || e).slice(-500), true);
  }
  try {
    deps.installTree(head);
  } catch (e) {
    return deps.note('build_failed', head, String((e && e.message) || e).slice(-500), true);
  }
  if (drains) {
    // Something that doesn't read the flag (an older engine's coordinator, another harness) may have started meanwhile.
    const after = quiet(deps.slots(), deps.alive);
    if (!after.quiet) {
      if (drained) {
        putFlag(deps, { ...flag, until: iso(deps.now() + DRAIN_TTL_MS) });
        seen.keepDrain = true;
      }
      return deps.note('waiting', head, `not quiet after the build: ${after.why}`, false);
    }
  }
  const { units, instances } = machineUnits(deps);
  // Every backup the migrations made, per instance: what a rollback puts back.
  const migrated = [];
  const restoreAll = () => restoreBackups(deps, migrated);
  const settle = () => settleUnits(deps, units);
  if (instances.length) {
    // Migrate with the new engine while nothing runs: stop, migrate each instance, and only then switch.
    deps.exec('systemctl', ['stop', ...units]);
    for (const inst of instances) {
      let r;
      try {
        r = parseMigrate(deps.exec(...splitCmd(migrateCommand(inst, head)), { timeout: 10 * 60_000 }));
      } catch (e) {
        r = parseMigrate(e && e.stdout);
        if (!r.error || /^no answer/.test(r.error)) r.error = `${r.error ? `${r.error}; ` : ''}${String((e && e.message) || e).split('\n')[0]}`;
      }
      if (!r.ok) {
        // The failing migrate restored its own files; the instances migrated before it are restored here.
        const unrestored = restoreAll();
        const back = await settle();
        const at = new Date(deps.now()).toISOString();
        const reason = `rollback: migration failed: ${inst.name}: ${String(r.error).slice(0, 500)}`;
        deps.hold({ sha: head, at, failed: [reason] });
        deps.log({ event: 'rolled_back', from: head, to: current, units, reason, migration: { instance: inst.name, error: String(r.error).slice(0, 2000), restored: migrated.map((m) => m.inst.name), unrestored }, back: back.h, held: true });
        return 'rolled_back';
      }
      migrated.push({ inst, made: r.made, applied: r.applied });
    }
  }
  // Each instance's sandbox verdict as the old engine left it, read while nothing runs (verifySandbox compares).
  const sandboxBefore = {};
  if (typeof deps.sandboxStatus === 'function') for (const inst of instances) sandboxBefore[inst.name] = deps.sandboxStatus(inst, head);
  // The root helpers from the new engine, before it starts: it never runs with a helper of another protocol.
  let helpers;
  try {
    helpers = deps.syncHelpers(head).filter((h) => h.state === 'updated');
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 500);
    const back = current ? helpersBack(deps, current) : {};
    const unrestored = restoreAll();
    const settled = await settle();
    const reason = `rollback: the root helpers couldn't be put in step with the new engine: ${why}`;
    deps.hold({ sha: head, at: new Date(deps.now()).toISOString(), failed: [reason] });
    deps.log({ event: 'rolled_back', from: head, to: current, units, reason, ...back, back: settled.h, held: true, ...(migrated.length ? { restored: migrated.map((m) => m.inst.name), unrestored } : {}) });
    return 'rolled_back';
  }
  const restartedAt = deps.now();
  deps.switchTo(head);
  const after = await settle();
  if (after.h === 'healthy') {
    // Up and steady isn't working: an instance whose test sandbox check passed before must pass it again.
    const sandbox = await verifySandbox(deps, cfg, instances, sandboxBefore, head, restartedAt);
    const onTimeout = sandboxOnTimeout(cfg);
    if (sandbox.failed.length || (sandbox.unconfirmed.length && onTimeout === 'hold')) {
      const failed = [
        ...sandbox.failed.map((f) => `rollback: the test sandbox check passed before the update and fails after it: ${f.instance}: ${f.detail}`),
        ...(sandbox.failed.length ? [] : sandbox.unconfirmed.map((i) => `rollback: no test sandbox result from ${i} within ${Math.round(sandboxWaitMs(cfg) / 60_000)} minutes of the restart (sandbox_on_timeout: hold)`)),
      ];
      // As for a service that didn't come up: the migrations' backups, the old engine's helpers, the old engine.
      if (instances.length) deps.exec('systemctl', ['stop', ...units]);
      const unrestored = restoreAll();
      const hb = current ? helpersBack(deps, current) : {};
      if (current) deps.switchTo(current);
      const back = current ? await settle() : { h: 'failed' };
      // WHY: an old engine left with the new one's helpers has no test runs either (another protocol): that is not a
      // clean rollback, and it goes first in the reason so the incident says it before anything else.
      if (hb.helpers_error) failed.unshift(`rollback: the old engine's root helpers could NOT be put back (${hb.helpers_error}); its test runs are off until they are: sudo bash /opt/worklane/current/scripts/setup/test-user.sh update-helper`);
      deps.hold({ sha: head, at: new Date(deps.now()).toISOString(), failed });
      // INVARIANT: the reason names the instance and what its check said: the watchdog's update_rollback incident quotes it.
      deps.log({ event: 'rolled_back', from: head, to: current, units, reason: failed.join('; '), sandbox, back: back.h, held: true, ...hb, ...(migrated.length ? { restored: migrated.map((m) => m.inst.name), unrestored } : {}) });
      return 'rolled_back';
    }
    // The updater itself, now that the release is healthy: only from a release tag, verified again (#760).
    const updater = release ? selfStep(deps, cfg, tag.tag, head) : null;
    try {
      for (const i of sandbox.passed) if (typeof deps.resolveIncident === 'function') deps.resolveIncident(SANDBOX_INCIDENT, i);
      for (const i of sandbox.unconfirmed) {
        if (typeof deps.raiseIncident === 'function') deps.raiseIncident(SANDBOX_INCIDENT, i, `after the update to ${short(head)}, ${i} gave no test sandbox result within ${Math.round(sandboxWaitMs(cfg) / 60_000)} minutes of its restart; its test runs passed that check before the update`, `look at ${i}'s log for testrun.sandbox and its coordinator's journal; the update was kept (sandbox_on_timeout in updates.json)`);
      }
    } catch {
      // the installed line below is the record
    }
    deps.log({ event: 'installed', from: current, to: head, units, ...(sandbox.passed.length || sandbox.unconfirmed.length ? { sandbox: { passed: sandbox.passed, unconfirmed: sandbox.unconfirmed } } : {}), ...(helpers.length ? { helpers } : {}), ...(updater ? { updater } : {}), ...(instances.length ? { migrated: migrated.map((m) => ({ instance: m.inst.name, applied: m.applied.length })) } : {}), ...(cfg.canary ? { canary: 'pending' } : {}) });
    if (!cfg.canary) return 'installed';
    // The install stands only once the canary passes: until then the backups and the old engine are kept to go back to.
    const filed = startCanary(deps, cfg, 'update', { from: current, to: head, migrated: migrated.map((m) => ({ inst: m.inst, made: m.made })) });
    if (filed.ok) return 'installed';
    return rollbackAfterCanary(deps, filed.pending, filed.verdict);
  }
  const bad = Object.entries(after.states).filter(([, s]) => s.state !== 'active' || s.sub === 'auto-restart' || s.restarts > 0);
  const down = bad.map(([u, s]) => `${u}: ${s.state}${s.sub ? ` (${s.sub})` : ''}${s.result !== 'success' ? `, ${s.result}` : ''}${s.restarts ? `, ${s.restarts} restarts` : ''}`);
  // Why, from the failing units themselves, before switching back: their journal and exit status.
  const diagnosis = bad.map(([u]) => {
    const get = (file, args) => {
      try {
        return deps.exec(file, args);
      } catch (e) {
        return `(${file} failed: ${String((e && e.message) || e).split('\n')[0]})`;
      }
    };
    const show = parseShow(get('systemctl', ['show', '-p', 'ActiveState,SubState,NRestarts,Result', u]));
    const status = get('systemctl', ['show', '-p', 'ExecMainStatus', '--value', u]).trim();
    return { unit: u, result: show.result, status, restarts: show.restarts, journal: tail(redact(get('journalctl', ['-u', u, '-n', '30', '--no-pager', '-o', 'short-iso'])).trim(), 4000) };
  });
  // The old engine refuses config and state newer than it knows: put the migrations' backups back first.
  if (instances.length) deps.exec('systemctl', ['stop', ...units]);
  const unrestored = restoreAll();
  const hb = current ? helpersBack(deps, current) : {};
  if (current) deps.switchTo(current);
  const back = current ? await settle() : { h: 'failed' };
  const at = new Date(deps.now()).toISOString();
  deps.hold({ sha: head, at, failed: down });
  deps.log({ event: 'rolled_back', from: head, to: current, units, failed: down, back: back.h, diagnosis, held: true, ...hb, ...(migrated.length ? { restored: migrated.map((m) => m.inst.name), unrestored } : {}) });
  return 'rolled_back';
}

/** deps.selfUpdate after a healthy release install, its result for the log (or null without one). Never throws. */
function selfStep(deps, cfg, tag, sha) {
  if (typeof deps.selfUpdate !== 'function') return null;
  let r;
  try {
    r = deps.selfUpdate(cfg.allowed_signers || ALLOWED_SIGNERS, tag, sha);
  } catch (e) {
    r = { state: 'refused', reason: `couldn't replace the updater: ${firstLine(e)}` };
  }
  if (r && r.state === 'refused' && typeof deps.warn === 'function') deps.warn(`the updater wasn't replaced: ${r.reason}`);
  return r;
}

/** The worklane-*.service units an update restarts, and the instances among them (each one's user and environment). */
function machineUnits(deps) {
  const units = parseUnits(deps.exec('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--full', 'worklane-*.service']));
  const instances = units.map((u) => parseInstance(u, deps.exec('systemctl', ['show', '-p', 'User,Environment,ExecStart', u]))).filter(Boolean);
  return { units, instances };
}

/** Put the migrations' backups back, newest first, each as its instance's user. Returns what couldn't be restored. */
function restoreBackups(deps, migrated) {
  const failed = [];
  for (const { inst, made } of migrated) {
    for (const b of [...made].reverse()) {
      try {
        deps.exec(...splitCmd(restoreCommand(inst, b)));
      } catch (e) {
        failed.push(`${inst.name}: ${b.path}: ${String((e && e.message) || e).split('\n')[0]}`);
      }
    }
  }
  return failed;
}

/** Restart the units and wait until they're healthy or not (see health()). */
async function settleUnits(deps, units) {
  deps.exec('systemctl', ['restart', ...units]);
  const start = deps.now();
  const samples = [];
  for (;;) {
    const states = {};
    for (const u of units) states[u] = parseShow(deps.exec('systemctl', ['show', '-p', 'ActiveState,SubState,NRestarts,Result', u]));
    samples.push({ at: deps.now(), states });
    const h = health(samples, start, deps.now());
    if (h !== 'wait') return { h, states };
    await deps.sleep(POLL_MS);
  }
}

/** updates.json's canary as { instance, repo, limitMs }, or null when it doesn't name a usable one. */
function canaryConfig(cfg) {
  const c = cfg && cfg.canary;
  if (!c || !/^[a-z][a-z0-9-]{0,40}$/.test(String(c.instance || '')) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(c.repo || ''))) return null;
  const min = Number(c.time_limit_minutes);
  return { instance: c.instance, repo: c.repo, limitMs: (Number.isFinite(min) && min > 0 ? min : CANARY_LIMIT_MIN) * 60_000 };
}

/** A daily canary is due when none was filed in the last 24 hours. */
function dailyDue(state, now) {
  const last = state && state.lastFiledAt ? Date.parse(state.lastFiledAt) : NaN;
  return !(now - last < DAY_MS);
}

/** The installed engine's `canary` command, run as the canary instance's user through systemd-run, as its unit runs. */
function canaryCommand(inst, sub, repo, extra, opt = OPT) {
  return asInstance(inst, ['/usr/bin/env', 'node', path.posix.join(opt, 'current', 'dist', 'src', 'cli.js'), 'canary', sub, '--instance', inst.name, '--repo', repo, ...extra, '--json']);
}

/** The canary command's one JSON line, or a failure. */
function parseCanary(out) {
  const line = String(out || '').trim().split('\n').filter(Boolean).at(-1) || '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: `no answer from the canary command: ${line.slice(0, 300)}` };
  }
}

/** One canary command, as the canary instance's user. */
function canaryRun(deps, c, sub, extra) {
  const inst = machineUnits(deps).instances.find((i) => i.name === c.instance);
  if (!inst) return { ok: false, error: `no instance "${c.instance}" on this machine (updates.json canary.instance)` };
  try {
    return parseCanary(deps.exec(...splitCmd(canaryCommand(inst, sub, c.repo, extra)), { timeout: 5 * 60_000 }));
  } catch (e) {
    const r = parseCanary(e && e.stdout);
    return r.ok === false && r.error && !/^no answer/.test(r.error) ? r : { ok: false, error: String((e && e.message) || e).split('\n')[0] };
  }
}

/**
 * File a canary issue. update: { from, to, migrated } after an install (what its rollback needs), else null.
 * { ok: true } once it's filed and recorded; { ok: false, pending, verdict } when it couldn't be.
 */
function startCanary(deps, cfg, reason, update) {
  const c = canaryConfig(cfg);
  const at = new Date(deps.now()).toISOString();
  const pending = { reason, issue: null, url: null, filedAt: at, deadline: new Date(deps.now() + (c ? c.limitMs : CANARY_LIMIT_MIN * 60_000)).toISOString(), update };
  if (!c) return failCanary(deps, pending, { stage: 'filed', reason: 'updates.json canary needs an instance name and its repo (owner/repo)', pr: null });
  const r = canaryRun(deps, c, 'file', ['--reason', reason]);
  if (!r.ok || !Number.isInteger(r.issue)) return failCanary(deps, pending, { stage: 'filed', reason: `couldn't file the canary issue: ${String(r.error || 'no issue number').slice(0, 500)}`, pr: null });
  const filed = { ...pending, issue: r.issue, url: typeof r.url === 'string' ? r.url : null };
  deps.saveCanary({ pending: filed, lastFiledAt: at });
  deps.log({ event: 'canary_filed', trigger: reason, reason: `the ${reason === 'update' ? 'post-update' : 'daily'} canary: issue #${r.issue}`, issue: r.issue, url: filed.url, deadline: filed.deadline, ...(update ? { to: update.to } : {}) });
  return { ok: true, pending: filed };
}

/** A canary that couldn't be filed fails now: logged here; an install's is rolled back by the caller. */
function failCanary(deps, pending, verdict) {
  const v = { ...verdict, state: 'failed' };
  deps.saveCanary({ pending: null, lastFiledAt: pending.filedAt });
  logCanary(deps, pending, v);
  if (!pending.update) raise(deps, pending, v);
  return { ok: false, pending, verdict: v };
}

/** One canary result in the log: passed or failed, at which stage and why, how long it took, its PR. */
function logCanary(deps, pending, v, extra = {}) {
  deps.log({ event: v.state === 'passed' ? 'canary_passed' : 'canary_failed', trigger: pending.reason, issue: pending.issue, url: pending.url, stage: v.stage, reason: v.reason, pr: v.pr || null, duration_ms: deps.now() - Date.parse(pending.filedAt), ...(pending.update ? { to: pending.update.to } : {}), ...extra });
}

/** The watchdog's incident, when the engine has the watchdog (an optional dependency until it does). */
function raise(deps, pending, v) {
  if (typeof deps.raiseIncident !== 'function') return;
  const what = pending.update ? `the canary after installing ${String(pending.update.to).slice(0, 12)} failed: ${v.reason}; rolled back and held` : `the daily canary failed: ${v.reason}`;
  const fix = pending.update ? `look at the canary issue and its PR; an admin retries the held commit with: ${RELEASE_HOLD}` : 'look at the canary issue and its PR';
  try {
    deps.raiseIncident('canary_failed', 'canary', what, fix);
  } catch {
    // the log line is the record
  }
}

/** Ask the running canary how far it got: passed, failed, out of time, or still going. */
async function checkCanaryNow(deps, cfg, st) {
  const p = st.pending;
  const c = canaryConfig(cfg);
  let v = c ? canaryRun(deps, c, 'check', ['--issue', String(p.issue)]) : { ok: false, error: 'updates.json canary needs an instance name and its repo' };
  if (!v.ok) v = { state: 'pending', stage: 'filed', reason: `the check failed: ${String(v.error).slice(0, 300)}`, pr: null };
  if (v.state === 'pending' && deps.now() >= Date.parse(p.deadline)) {
    v = { ...v, state: 'failed', reason: `timed out after ${Math.round((deps.now() - Date.parse(p.filedAt)) / 60_000)} minutes at "${v.stage}": ${v.reason}`, timedOut: true };
  }
  if (v.state === 'pending') return 'canary_pending';
  deps.saveCanary({ pending: null, lastFiledAt: st.lastFiledAt || p.filedAt });
  logCanary(deps, p, v, v.timedOut ? { timed_out: true } : {});
  if (v.state === 'passed') {
    if (typeof deps.resolveIncident === 'function') {
      try {
        deps.resolveIncident('canary_failed', 'canary');
      } catch {
        // nothing to resolve
      }
    }
    return 'canary_passed';
  }
  if (!p.update) {
    raise(deps, p, v);
    return 'canary_failed';
  }
  return rollbackAfterCanary(deps, p, v);
}

/**
 * The canary after an install failed: the same rollback as an install whose services don't come up (stop, every
 * migration's backups put back, the old engine, restart), the commit held, and the watchdog told. Only while that
 * install is still the engine.
 */
async function rollbackAfterCanary(deps, pending, v) {
  const { from, to, migrated } = pending.update;
  const reason = `rollback: canary failed: ${v.reason}`;
  if (deps.installed() !== to) {
    deps.log({ event: 'error', reason: `${reason}; not rolled back: the engine is ${deps.installed()} now, not ${to}` });
    return 'canary_failed';
  }
  const { units } = machineUnits(deps);
  if (migrated.length) deps.exec('systemctl', ['stop', ...units]);
  const unrestored = restoreBackups(deps, migrated);
  const hb = from ? helpersBack(deps, from) : {};
  if (from) deps.switchTo(from);
  const back = from ? await settleUnits(deps, units) : { h: 'failed' };
  const at = new Date(deps.now()).toISOString();
  deps.hold({ sha: to, at, failed: [reason] });
  deps.log({ event: 'rolled_back', from: to, to: from, units, reason, canary: { issue: pending.issue, url: pending.url, stage: v.stage, pr: v.pr || null }, back: back.h, held: true, ...hb, ...(migrated.length ? { restored: migrated.map((m) => m.inst.name), unrestored } : {}) });
  raise(deps, pending, v);
  return 'rolled_back';
}

/** [file, args] of an argv. */
const splitCmd = (argv) => [argv[0], argv.slice(1)];

// ---------- the signers file, watched ----------
//
// /etc/worklane/allowed_signers is the root of trust for the release channel, and the only expected way it changes is
// scripts/setup/updates.sh --signer or --confirm-signer (scripts/setup/updates-root.cjs), at a root shell. So every
// run, on or off, the updater hashes the file it verifies releases against and compares it with the hash recorded in
// SIGNERS_STATE (root-owned, 0644, written atomically). updates-root.cjs records the new hash in the same step it
// appends, so its own change is expected. Any other change (a hand edit, another tool, a tampered or missing file)
// is reported once: a `signers_changed` line in the update log, a line on stderr (the journal), and a red incident,
// each with the old and new hash, the line counts and the key fingerprints added and removed (public data). The new
// hash is then adopted, so the next change is caught too. It needs no coordinator: the incident store is written here.
//
// An unexplained change also HOLDS the release channel: nothing is installed from a release tag until an admin has
// looked and acknowledged it at a root shell (updates.sh --acknowledge-signers). The signature check itself is as
// strict as ever; the hold is one more refusal in front of it, never a way around it.
const SIGNERS_STATE = '/var/lib/worklane/signers-state.json';
const SIGNERS_INCIDENT = 'update_signers_changed';

/** A signers file as it is now: its sha256 ("absent" when there is none), its signer lines, and each key's fingerprint. */
function signersDigest(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { file, hash: 'absent', lines: 0, fingerprints: [] };
  }
  const crypto = require('node:crypto');
  const fingerprints = new Set();
  let lines = 0;
  for (const raw of bytes.toString('utf8').split('\n')) {
    const w = raw.trim().split(/\s+/);
    if (!w[0] || w[0].startsWith('#')) continue;
    lines++;
    const t = w.findIndex((x, i) => i > 0 && /^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+$/.test(x));
    if (t > 0 && /^[A-Za-z0-9+/]+=*$/.test(w[t + 1] || '')) fingerprints.add(`SHA256:${crypto.createHash('sha256').update(Buffer.from(w[t + 1], 'base64')).digest('base64').replace(/=+$/, '')}`);
  }
  return { file, hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, lines, fingerprints: [...fingerprints].sort() };
}

/** The recorded state, or null when nothing is recorded yet (or it can't be read). */
function readSignersState(stateFile = SIGNERS_STATE) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return j && typeof j.hash === 'string' && typeof j.file === 'string' ? j : null;
  } catch {
    return null;
  }
}

const saveSignersState = (stateFile, cur, at, hold, extra = {}) => saveJson(stateFile, { file: cur.file, hash: cur.hash, lines: cur.lines, fingerprints: cur.fingerprints, at, hold: hold || null, ...extra }, 0o644);

/**
 * Compare the signers file with what is recorded. Returns null when it is as recorded, when nothing was recorded
 * yet (recorded now, silently), or when it is the change updates-root.cjs said it was about to make. Otherwise the
 * change { from, to, linesBefore, linesAfter, added, removed, at }: recorded as adopted, and held until acknowledged.
 */
function checkSigners(file, stateFile = SIGNERS_STATE, now = Date.now()) {
  const cur = signersDigest(file);
  const st = readSignersState(stateFile);
  const at = new Date(now).toISOString();
  if (!st) {
    saveSignersState(stateFile, cur, at, null);
    return null;
  }
  if (st.file === cur.file && st.hash === cur.hash) return null;
  if (st.file === cur.file && st.expected && st.expected === cur.hash) {
    saveSignersState(stateFile, cur, at, st.hold);
    return null;
  }
  const before = Array.isArray(st.fingerprints) ? st.fingerprints : [];
  const change = {
    at,
    file: cur.file,
    ...(st.file !== cur.file ? { fileBefore: st.file } : {}),
    from: st.hash,
    to: cur.hash,
    linesBefore: Number(st.lines) || 0,
    linesAfter: cur.lines,
    added: cur.fingerprints.filter((f) => !before.includes(f)),
    removed: before.filter((f) => !cur.fingerprints.includes(f)),
  };
  // An earlier change nobody acknowledged stays the hold's start: the newest one is what it now describes.
  saveSignersState(stateFile, cur, at, { ...change, since: st.hold && st.hold.since ? st.hold.since : at });
  return change;
}

/**
 * For updates-root.cjs, around its own append. Before: `expectSigners(file, hashItWillHave)` when the file is as
 * recorded (or nothing is recorded), so the append is expected; false when the file already differs from the record,
 * in which case nothing is recorded and the updater's next run reports the whole change. After: recordSigners(file).
 */
function expectSigners(file, nextHash, stateFile = SIGNERS_STATE, now = Date.now()) {
  const cur = signersDigest(file);
  const st = readSignersState(stateFile);
  if (st && !(st.file === cur.file && st.hash === cur.hash)) return false;
  saveSignersState(stateFile, cur, st ? st.at : new Date(now).toISOString(), st ? st.hold : null, { expected: nextHash });
  return true;
}
function recordSigners(file, stateFile = SIGNERS_STATE, now = Date.now()) {
  const st = readSignersState(stateFile);
  saveSignersState(stateFile, signersDigest(file), new Date(now).toISOString(), st ? st.hold : null);
}

/** The unexplained change the release channel is held for, or null. */
const signersHold = (stateFile = SIGNERS_STATE) => (readSignersState(stateFile) || {}).hold || null;

/** An admin has looked at the file as it is now: it is the record, and nothing is held. Returns what was held (or null). */
function acknowledgeSigners(file, stateFile = SIGNERS_STATE, now = Date.now()) {
  const held = signersHold(stateFile);
  // acknowledged: for the updater's next run to close the incident, once.
  saveSignersState(stateFile, signersDigest(file), new Date(now).toISOString(), null, held ? { acknowledged: new Date(now).toISOString() } : {});
  return held;
}

/** Whether an acknowledgement is waiting to be told to the incident store; true once, then forgotten. */
function takeAcknowledged(stateFile = SIGNERS_STATE) {
  const st = readSignersState(stateFile);
  if (!st || !st.acknowledged || st.hold) return false;
  saveSignersState(stateFile, st, st.at, null);
  return true;
}

const shortHash = (h) => (String(h).startsWith('sha256:') ? `sha256:${String(h).slice(7, 19)}` : String(h));
/** One line saying what changed, for the log, the journal and the incident. */
function signersChangeText(c) {
  const what = c.to === 'absent' ? `${c.file} is gone` : c.from === 'absent' ? `${c.file} appeared` : `${c.file} changed`;
  const keys = [c.added.length ? `added ${c.added.join(', ')}` : '', c.removed.length ? `removed ${c.removed.join(', ')}` : ''].filter(Boolean).join('; ') || 'no key added or removed';
  return `${what} outside updates.sh --signer or --confirm-signer${c.fileBefore ? ` (the updater read ${c.fileBefore} before)` : ''}: ${shortHash(c.from)} -> ${shortHash(c.to)}, ${c.linesBefore} signer line${c.linesBefore === 1 ? '' : 's'} before, ${c.linesAfter} after; key fingerprints: ${keys}`;
}
const SIGNERS_ACK = 'sudo bash /opt/worklane/current/scripts/setup/updates.sh --acknowledge-signers';

/** Every run, before anything else: the signers file against its record. A change is logged, said on stderr, and raised. */
function watchSigners(deps, cfg) {
  if (typeof deps.signersCheck !== 'function') return;
  let change;
  try {
    change = deps.signersCheck((cfg && typeof cfg.allowed_signers === 'string' && cfg.allowed_signers) || ALLOWED_SIGNERS);
  } catch (e) {
    deps.log({ event: 'error', reason: `couldn't check the signers file: ${String((e && e.message) || e).slice(0, 300)}` });
    return;
  }
  if (!change) {
    // Acknowledged at a root shell since the last run: the incident is closed, once.
    if (typeof deps.signersAcknowledged === 'function' && deps.signersAcknowledged() && typeof deps.resolveIncident === 'function') {
      try {
        deps.resolveIncident(SIGNERS_INCIDENT, 'allowed_signers');
      } catch {
        // nothing to resolve
      }
    }
    return;
  }
  const reason = signersChangeText(change);
  deps.log({ event: 'signers_changed', reason, signers: change, held: true });
  if (typeof deps.warn === 'function') deps.warn(`signers_changed: ${reason}; release installs are held until: ${SIGNERS_ACK}`);
  if (typeof deps.raiseIncident === 'function') {
    try {
      deps.raiseIncident(SIGNERS_INCIDENT, 'allowed_signers', `${reason}. Release-channel installs are held`, `Look at the file. If the change is yours, acknowledge it at a root shell: ${SIGNERS_ACK}. If not, put the file right first, then acknowledge`);
    } catch {
      // the log line and the journal are the record
    }
  }
}

// ---------- the machine (real effects) ----------

/** The installed engine's watchdog module, or null while it has none. */
function watchdog() {
  const f = path.join(OPT, 'current', 'dist', 'src', 'watchdog', 'index.js');
  if (!fs.existsSync(f)) return Promise.resolve(null);
  return import(require('node:url').pathToFileURL(f).href).catch(() => null);
}

/** Write JSON atomically: a temp file beside it, with the mode, renamed over it. */
function saveJson(file, value, mode) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

function realDeps(print = (line) => process.stdout.write(`${line}\n`), files = { log: LOG, state: STATE, held: HELD, drain: DRAIN }) {
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const log = (entry) => appendLog(files.log, entry);
  return {
    config: () => readJson(CONFIG),
    installed: () => {
      try {
        return path.basename(fs.readlinkSync(path.join(OPT, 'current')));
      } catch {
        return null;
      }
    },
    exec: (file, args, opts = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 120_000 }),
    fetchJson: async (url) => {
      const r = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'worklane-update' } });
      return r.ok ? r.json() : null;
    },
    slots: () => {
      let names = [];
      try {
        names = fs.readdirSync(SLOTS);
      } catch {
        return [];
      }
      return names.map((name) => {
        const j = readJson(path.join(SLOTS, name)) || {};
        return { name, pid: slotPid(j.pid), acquiredAt: typeof j.acquiredAt === 'string' ? j.acquiredAt : null, limitMs: typeof j.limit_ms === 'number' ? j.limit_ms : null };
      });
    },
    alive: (pid) => {
      if (!slotPid(pid)) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    },
    installTree: (sha) => installTree(sha),
    syncHelpers: (sha) => syncHelpers(path.join(OPT, sha)),
    installedVersion: () => (readJson(path.join(OPT, 'current', 'package.json')) || {}).version || null,
    verifyRelease: (repoUrl, tag, signers) => verifyRelease(repoUrl, tag, signers, (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })),
    selfUpdate: (signers, tag, sha) => {
      const src = verifiedUpdater(signers, tag, sha, (file, args) => execFileSync(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }));
      return src.ok ? syncSelf(src) : { state: 'refused', reason: src.reason };
    },
    sandboxStatus: (inst, sha) => {
      try {
        return parseSandbox(execFileSync(...splitCmd(sandboxCommand(inst, sha)), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
      } catch (e) {
        return parseSandbox(e && e.stdout); // WHY: a failing command still prints its answer; none is "unknown", never a verdict
      }
    },
    held: () => readJson(files.held),
    verdicts: () => readJson(VERDICTS),
    saveVerdicts: (map) => saveJson(VERDICTS, map, 0o644),
    stuckState: () => readJson(STUCK),
    saveStuck: (state) => (state ? saveJson(STUCK, state, 0o644) : fs.rmSync(STUCK, { force: true })),
    // Root-owned 0644 in root's /var/lib/worklane: every coordinator reads it, none can write or remove it. Only with a
    // drain file named (the default files have it): a caller that names its own files without one never drains.
    ...(files.drain
      ? {
          drainState: () => readJson(files.drain),
          saveDrain: (flag) => (flag ? saveJson(files.drain, flag, 0o644) : fs.rmSync(files.drain, { force: true })),
        }
      : {}),
    canaryState: () => readJson(CANARY),
    saveCanary: (state) => {
      const tmp = `${CANARY}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, CANARY);
    },
    // The watchdog's incidents (src/watchdog) once the installed engine has them; until then the log line is the record.
    raiseIncident: (kind, key, detail, fix) => void watchdog().then((w) => w && typeof w.raiseIncident === 'function' && w.raiseIncident(kind, key, detail, fix)).catch(() => {}),
    resolveIncident: (kind, key) => void watchdog().then((w) => w && typeof w.resolveIncident === 'function' && w.resolveIncident(kind, key)).catch(() => {}),
    // The hold is read back by sha and time only; its reasons are for people, so redacting them changes no decision.
    hold: (entry) => writeRedacted(files.held, entry),
    signersCheck: (file) => checkSigners(file),
    signersHold: () => signersHold(),
    signersAcknowledged: () => takeAcknowledged(),
    // stderr is the unit's journal: a line there needs neither the dashboard nor a coordinator.
    warn: (line) => process.stderr.write(`${line}\n`),
    switchTo: (sha) => {
      const link = path.join(OPT, '.current.new');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(OPT, sha), link);
      fs.renameSync(link, path.join(OPT, 'current'));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    note: makeNote({ readState: () => readJson(files.state), writeState: (st) => writeRedacted(files.state, st), log, print }),
    checked: (st) => writeRedacted(files.state, st),
  };
}

if (require.main === module) {
  // WHY: one line per run in the journal. A noted result (waiting, refused, held, ...) printed its own, with the reason.
  let said = false;
  const print = (line) => {
    said = true;
    process.stdout.write(`${line}\n`);
  };
  run(realDeps(print)).then(
    (r) => said || print(r),
    (e) => {
      try {
        appendLog(LOG, { event: 'error', reason: String(e && e.message ? e.message : e).slice(0, 500) });
      } catch {
        // nowhere to write: the journal has stderr
      }
      process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    },
  );
}
module.exports = { slotPid, drainStep, drainDeadline, drainAfterMs, inFlight, reopen, DRAIN, DRAIN_TTL_MS, DRAIN_INSTALL_TTL_MS, DRAIN_MARGIN_MS, redactDeep, appendLog, sandboxOnTimeout, sandboxCommand, parseSandbox, sandboxVerdict, sandboxWaitMs, verifySandbox, SANDBOX_INCIDENT, SANDBOX_POLL_MS, stuckStep, stuckAlertMs, STUCK_INCIDENT, IDLE_AFTER_MS, journalLine, makeNote, realDeps, chooseCommit, checkRunsOf, firstParentLine, lookbackOf, pendingWaitMs, saveJson, CHECKS_SPACING_MS, VERDICT_TTL_MS, syncHelpers, HELPERS, canaryConfig, canaryCommand, dailyDue, DAY_MS, channelOf, newer, parseTags, newestRelease, verifyRelease, parseInstance, migrateCommand, restoreCommand, parseMigrate, repoFromUrl, fastForward, evaluateChecks, quiet, parseUnits, parseShow, health, redact, buildCommand, binTargets, binProblems, installTree, run, BUILD_SCRIPT, HEALTH_MS, STABLE_MS };
Object.assign(module.exports, { SIGNERS_STATE, SIGNERS_INCIDENT, signersDigest, readSignersState, checkSigners, expectSigners, recordSigners, signersHold, acknowledgeSigners, takeAcknowledged, signersChangeText });
Object.assign(module.exports, { SELF, SELF_PREV, SELF_RECORD, SELF_OFF, SELF_ROLLBACK, readRootFile, selfUpdateOff, verifiedUpdater, syncSelf, setupBefore, setupRecord });
