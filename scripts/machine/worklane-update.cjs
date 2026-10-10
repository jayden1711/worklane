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

/**
 * After a restart: 'healthy' once every unit has been active for STABLE_MS without a break,
 * 'failed' as soon as one is failed or when HEALTH_MS passes without that, else 'wait'.
 * samples: [{ at, states: { unit: ActiveState } }], oldest first.
 */
function health(samples, startedAt, now) {
  if (samples.some((s) => Object.values(s.states).includes('failed'))) return 'failed';
  let since = null;
  for (const s of samples) {
    const all = Object.values(s.states).every((v) => v === 'active');
    since = all ? (since ?? s.at) : null;
  }
  if (since !== null && now - since >= STABLE_MS) return 'healthy';
  return now - startedAt >= HEALTH_MS ? 'failed' : 'wait';
}

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

function buildCommand(repoUrl, sha) {
  return [
    'systemd-run', '--wait', '--collect', '--pipe', '--quiet',
    '-p', 'DynamicUser=yes', '-p', `StateDirectory=${BUILD_STATE}`, '-p', 'PrivateTmp=yes', '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes', '-p', 'NoNewPrivileges=yes',
    `--working-directory=${BUILD_DIR}`, `--setenv=HOME=${BUILD_DIR}`, '--setenv=PATH=/usr/local/bin:/usr/bin:/bin',
    '/bin/bash', '-euo', 'pipefail', '-c', BUILD_SCRIPT, '_', repoUrl, sha,
  ];
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
  deps.installTree(head);
  const units = parseUnits(deps.exec('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--full', 'worklane-*.service']));
  const settle = async () => {
    deps.exec('systemctl', ['restart', ...units]);
    const start = deps.now();
    const samples = [];
    for (;;) {
      const states = {};
      for (const u of units) states[u] = deps.exec('systemctl', ['show', '-p', 'ActiveState', '--value', u]).trim();
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
  const down = Object.entries(after.states).filter(([, s]) => s !== 'active').map(([u, s]) => `${u}: ${s}`);
  if (current) deps.switchTo(current);
  const back = current ? await settle() : { h: 'failed' };
  deps.log({ event: 'rolled_back', from: head, to: current, units, failed: down, back: back.h });
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
    installTree: (sha) => {
      const dest = path.join(OPT, sha);
      if (fs.existsSync(path.join(dest, 'dist', 'src', 'cli.js')) && fs.existsSync(path.join(dest, 'dist', 'web', 'index.html'))) return;
      const tmp = path.join(OPT, `.${sha}.new`);
      fs.rmSync(tmp, { recursive: true, force: true });
      execFileSync('cp', ['-a', path.join(BUILD_DIR, 'src'), tmp]);
      execFileSync('chown', ['-R', 'root:root', tmp]);
      execFileSync('chmod', ['-R', 'a+rX,go-w', tmp]);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
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
module.exports = { repoFromUrl, fastForward, evaluateChecks, quiet, parseUnits, health, buildCommand, run, BUILD_SCRIPT, HEALTH_MS, STABLE_MS };
