#!/usr/bin/env node
// Engine updates, run as root by worklane-update.timer every 10 minutes and installed as
// /usr/local/libexec/worklane-update by scripts/setup/updates.sh. It does nothing unless
// /etc/worklane/updates.json has "enabled": true (set through the machine helper's
// `set-updates on`). When it is on, it installs main's newest commit only if:
//   - the commit is a fast-forward of the installed engine (never older, never a rewrite);
//   - every check on it is complete and green, and every required check (updates.json
//     required_checks) ran and succeeded: a missing, pending, failed or skipped one refuses it;
//   - the machine is quiet: no agent slot or full-run lock is held and no emergency stop is on.
// It builds as a throwaway unprivileged user (a systemd DynamicUser) with `npm ci
// --ignore-scripts` from the lockfile; root only copies the built tree into /opt/worklane/<sha>.
// Then it switches /opt/worklane/current, restarts the instance and dashboard services, and if
// any of them isn't active and steady within 2 minutes, switches back and restarts again.
// Every attempt, install, refusal and rollback is one JSON line in /var/lib/worklane/updates.jsonl.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Fixed paths: the installed updater takes none from its caller.
const CONFIG = '/etc/worklane/updates.json';
const LOG = '/var/lib/worklane/updates.jsonl';
const STATE = '/var/lib/worklane/update-state.json';
const HELD = '/var/lib/worklane/update-held.json'; // the last rolled-back commit: { sha, at, failed }
const OPT = '/opt/worklane';
const SLOTS = '/var/lib/worklane/agent-slots';
const BUILD_STATE = 'worklane-build'; // the DynamicUser's StateDirectory, /var/lib/worklane-build
const BUILD_DIR = `/var/lib/${BUILD_STATE}`;

const HEALTH_MS = 120_000;
const STABLE_MS = 30_000;
const POLL_MS = 5_000;

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

/** Quiet: no live agent slot or full-run lock, and no emergency stop. entries: [{ name, pid|null }]. */
function quiet(entries, alive) {
  for (const e of entries) {
    if (e.name === 'STOP') return { quiet: false, why: 'an emergency stop is in force' };
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

// ---------- the run ----------

async function run(deps) {
  const cfg = deps.config();
  if (!cfg || cfg.enabled !== true) return 'disabled';
  const gh = repoFromUrl(cfg.repo_url);
  if (!gh) return deps.note('refused', null, `updates.json repo_url isn't a GitHub repository: ${cfg.repo_url}`, true);
  const current = deps.installed();
  const head = deps.exec('git', ['ls-remote', cfg.repo_url, `refs/heads/${cfg.branch || 'main'}`]).split(/\s/)[0];
  if (!/^[0-9a-f]{40}$/.test(head)) return deps.note('refused', null, `no ${cfg.branch || 'main'} on ${cfg.repo_url}`, true);
  if (head === current) return 'current';
  // A commit that was rolled back is never retried by itself: only a newer commit, or the owner turning
  // updates off and on again after the rollback (updates.json written later), releases it.
  const held = deps.held();
  if (held && held.sha === head && !(deps.configChangedAt() > Date.parse(held.at))) {
    return deps.note('held', head, `rolled back at ${held.at}${held.failed && held.failed.length ? ` (${held.failed.join('; ')})` : ''}; held until a newer commit, or until updates are turned off and on again`, true);
  }
  const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  const ff = fastForward(current ? await deps.fetchJson(`${api}/compare/${current}...${head}`) : { status: 'ahead', behind_by: 0, ahead_by: 0 });
  if (!ff.ok) return deps.note('refused', head, ff.reason, true);
  const checks = evaluateChecks(((await deps.fetchJson(`${api}/commits/${head}/check-runs?per_page=100`)) || {}).check_runs, cfg.required_checks);
  if (!checks.ok) return deps.note(checks.final ? 'refused' : 'waiting', head, checks.reason, checks.final);
  const q = quiet(deps.slots(), deps.alive);
  if (!q.quiet) return deps.note('waiting', head, `not quiet: ${q.why}`, false);

  deps.log({ event: 'attempt', from: current, to: head });
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
  const units = parseUnits(deps.exec('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--full', 'worklane-*.service']));
  const settle = async () => {
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
  };
  deps.switchTo(head);
  const after = await settle();
  if (after.h === 'healthy') {
    deps.log({ event: 'installed', from: current, to: head, units });
    return 'installed';
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
  if (current) deps.switchTo(current);
  const back = current ? await settle() : { h: 'failed' };
  const at = new Date(deps.now()).toISOString();
  deps.hold({ sha: head, at, failed: down });
  deps.log({ event: 'rolled_back', from: head, to: current, units, failed: down, back: back.h, diagnosis, held: true });
  return 'rolled_back';
}

// ---------- the machine (real effects) ----------

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
    held: () => readJson(HELD),
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
module.exports = { repoFromUrl, fastForward, evaluateChecks, quiet, parseUnits, parseShow, health, redact, buildCommand, binTargets, binProblems, installTree, run, BUILD_SCRIPT, HEALTH_MS, STABLE_MS };
