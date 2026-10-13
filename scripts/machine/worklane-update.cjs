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
//     as pending ("hasn't run"), is waited for until pending_wait_minutes, then passed over, and never installed.
// Either way it installs only if:
//   - every check on it is complete and green, and every required check (updates.json
//     required_checks) ran and succeeded: a missing, pending, failed or skipped one refuses it;
//   - the machine is quiet: no agent slot or full-run lock is held and no emergency stop is on.
// It builds as a throwaway unprivileged user (a systemd DynamicUser) with `npm ci
// --ignore-scripts` from the lockfile; root only copies the built tree into /opt/worklane/<sha>.
// Before switching, it stops the services and migrates every instance's config and state with the NEW engine
// (`migrate --instance <name> --json`, run as that instance's coordinator user through systemd-run, as the
// instance's own unit runs; each file is backed up first). If a migration fails, it restores every instance's
// backups, starts the services again on the old engine and holds the commit. Otherwise it switches
// /opt/worklane/current and restarts the instance and dashboard services, and if any of them isn't active and
// steady within 2 minutes, it restores the migration backups, switches back and restarts again.
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
// Every attempt, install, refusal, rollback and canary is one JSON line in /var/lib/worklane/updates.jsonl.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Fixed paths: the installed updater takes none from its caller.
const CONFIG = '/etc/worklane/updates.json';
const LOG = '/var/lib/worklane/updates.jsonl';
const STATE = '/var/lib/worklane/update-state.json';
const HELD = '/var/lib/worklane/update-held.json'; // the last rolled-back commit: { sha, at, failed }
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
];

const HEALTH_MS = 120_000;
const STABLE_MS = 30_000;
const POLL_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
const CANARY_LIMIT_MIN = 120;
const LOOKBACK = 20; // updates.json max_lookback: first-parent commits looked at, from main's tip back
const LOOKBACK_MAX = 100;
const PENDING_WAIT_MIN = 60; // updates.json pending_wait_minutes
const CHECKS_SPACING_MS = 1_000; // between two check-run calls in one run
const CHECK_PAGES_MAX = 10; // pages of 100 check runs read for one commit
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
const heldReason = (held) => `rolled back at ${held.at}${held.failed && held.failed.length ? ` (${held.failed.join('; ')})` : ''}; held until a newer commit, or until updates are turned off and on again`;

/**
 * Which candidate (firstParentLine, newest first) to install: the newest one that isn't held and whose checks are
 * all green (evaluateChecks). One check-run call per commit, CHECKS_SPACING_MS apart, stopping at the first green
 * one; an older commit's final red verdict is reused for VERDICT_TTL_MS (deps.verdicts/saveVerdicts, optional), so a
 * long red streak doesn't spend the API's hourly limit (the tip is always asked). A pending commit, or one GitHub
 * gave no answer for, stops the scan to wait for it, until it has been on main pendingWaitMs; after that it is
 * passed over for an older one. Returns { chosen, skipped } | { wait, reason, skipped } | { none: true, skipped },
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
    if (held && held.sha === c.sha && !(deps.configChangedAt() > Date.parse(held.at))) v = { ok: false, final: true, held: true, reason: heldReason(held) };
    else if (i > 0 && kept[c.sha]) v = { ok: false, final: true, reason: kept[c.sha].reason };
    else {
      if (calls++) await deps.sleep(CHECKS_SPACING_MS);
      const data = await checkRunsOf(deps, api, c.sha);
      v = data ? evaluateChecks(data.check_runs, cfg.required_checks) : { ok: false, final: false, noAnswer: true, reason: 'GitHub gave no answer for its check runs' };
      if (!v.ok && v.final && i > 0) {
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
      if (v.noAnswer || !(now - landed >= waitMs)) {
        out = { wait: c, reason: v.reason, skipped };
        break;
      }
      pending = true;
      v = { ...v, reason: `${v.reason}, still ${Math.round(waitMs / 60_000)}+ minutes after it landed (pending_wait_minutes)` };
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
    if (!r) return { ok: false, final: false, reason: `required check "${name}" hasn't run on this commit` };
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
    if (e.name === 'STOP') return { quiet: false, why: 'an emergency stop is in force' };
    if (/^test-\d+\.lock$/.test(e.name) && e.pid && alive(e.pid)) return { quiet: false, why: 'a test run is going' };
    if ((/^agent-\d+\.lock$/.test(e.name) || e.name === 'full-run.lock') && e.pid && alive(e.pid)) return { quiet: false, why: e.name === 'full-run.lock' ? 'a full test run is going' : 'an agent is running' };
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
    .replace(/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]');
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
  const cfg = deps.config();
  if (!cfg || cfg.enabled !== true) return 'disabled';
  // A canary running now goes first: no other update starts until it has passed, failed or run out of time.
  if (cfg.canary) {
    const st = deps.canaryState() || {};
    if (st.pending) return checkCanaryNow(deps, cfg, st);
  }
  const r = await update(deps, cfg);
  // Once a day, when no install just filed one: a canary on the engine as it is.
  if (cfg.canary && r !== 'installed' && r !== 'rolled_back' && dailyDue(deps.canaryState(), deps.now())) {
    const filed = startCanary(deps, cfg, 'daily', null);
    return filed.ok ? 'canary_filed' : 'canary_failed';
  }
  return r;
}

async function update(deps, cfg) {
  const gh = repoFromUrl(cfg.repo_url);
  if (!gh) return deps.note('refused', null, `updates.json repo_url isn't a GitHub repository: ${cfg.repo_url}`, true);
  const current = deps.installed();
  const release = channelOf(cfg) === 'release';
  let head;
  let tag = null;
  if (release) {
    tag = newestRelease(parseTags(deps.exec('git', ['ls-remote', '--tags', cfg.repo_url, 'refs/tags/v*'])));
    if (!tag) return deps.note('waiting', null, `no release tag vX.Y.Z on ${cfg.repo_url} yet`, false);
    head = tag.commit;
    if (head === current) return 'current';
    // Never back: a tag no newer than the installed engine's version is not an update.
    const installedVersion = deps.installedVersion();
    if (installedVersion && !newer(tag.version, installedVersion)) return 'current';
  } else {
    head = deps.exec('git', ['ls-remote', cfg.repo_url, `refs/heads/${cfg.branch || 'main'}`]).split(/\s/)[0];
    if (!/^[0-9a-f]{40}$/.test(head)) return deps.note('refused', null, `no ${cfg.branch || 'main'} on ${cfg.repo_url}`, true);
    if (head === current) return 'current';
  }
  // A commit that was rolled back is never retried by itself: only a newer commit, or the owner turning
  // updates off and on again after the rollback (updates.json written later), releases it.
  // (On main, a held commit is passed over for an older one; see chooseCommit.)
  const held = deps.held();
  const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  // On main: the newer commits passed over for the one installed, and why.
  let skipped = [];
  if (release) {
    if (held && held.sha === head && !(deps.configChangedAt() > Date.parse(held.at))) return deps.note('held', head, heldReason(held), true);
    // The commit whose checks count: the main commit the release was cut from.
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
  const q = quiet(deps.slots(), deps.alive);
  if (!q.quiet) return deps.note('waiting', head, `not quiet: ${q.why}`, false);

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
  deps.switchTo(head);
  const after = await settle();
  if (after.h === 'healthy') {
    deps.log({ event: 'installed', from: current, to: head, units, ...(helpers.length ? { helpers } : {}), ...(instances.length ? { migrated: migrated.map((m) => ({ instance: m.inst.name, applied: m.applied.length })) } : {}), ...(cfg.canary ? { canary: 'pending' } : {}) });
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
  const fix = pending.update ? 'look at the canary issue and its PR; turning updates off and on again retries the held commit' : 'look at the canary issue and its PR';
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

function realDeps() {
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const log = (entry) => fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o644 });
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
      return names.map((name) => ({ name, pid: (readJson(path.join(SLOTS, name)) || {}).pid || null }));
    },
    alive: (pid) => {
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
    held: () => readJson(HELD),
    verdicts: () => readJson(VERDICTS),
    saveVerdicts: (map) => saveJson(VERDICTS, map, 0o644),
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
    hold: (entry) => {
      const tmp = `${HELD}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o644 });
      fs.chmodSync(tmp, 0o644);
      fs.renameSync(tmp, HELD);
    },
    configChangedAt: () => {
      try {
        return fs.statSync(CONFIG).mtimeMs;
      } catch {
        return 0;
      }
    },
    switchTo: (sha) => {
      const link = path.join(OPT, '.current.new');
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.join(OPT, sha), link);
      fs.renameSync(link, path.join(OPT, 'current'));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    /** A refusal or wait is logged once per commit and reason, not every 10 minutes. */
    note: (event, sha, reason) => {
      const last = readJson(STATE) || {};
      if (last.event !== event || last.sha !== sha || last.reason !== reason) {
        log({ event, to: sha, reason });
        fs.writeFileSync(STATE, JSON.stringify({ event, sha, reason }), { mode: 0o644 });
      }
      return event;
    },
  };
}

if (require.main === module) {
  run(realDeps()).then(
    (r) => process.stdout.write(`${r}\n`),
    (e) => {
      try {
        fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), event: 'error', reason: String(e && e.message ? e.message : e).slice(0, 500) })}\n`);
      } catch {
        // nowhere to write: the journal has stderr
      }
      process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
      process.exitCode = 1;
    },
  );
}
module.exports = { chooseCommit, checkRunsOf, firstParentLine, lookbackOf, pendingWaitMs, saveJson, CHECKS_SPACING_MS, VERDICT_TTL_MS, syncHelpers, HELPERS, canaryConfig, canaryCommand, dailyDue, DAY_MS, channelOf, newer, parseTags, newestRelease, verifyRelease, parseInstance, migrateCommand, restoreCommand, parseMigrate, repoFromUrl, fastForward, evaluateChecks, quiet, parseUnits, parseShow, health, redact, buildCommand, binTargets, binProblems, installTree, run, BUILD_SCRIPT, HEALTH_MS, STABLE_MS };
