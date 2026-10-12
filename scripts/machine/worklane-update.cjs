#!/usr/bin/env node
// Engine updates, run as root by worklane-update.timer every 10 minutes and installed as
// /usr/local/libexec/worklane-update by scripts/setup/updates.sh. It does nothing unless
// /etc/worklane/updates.json has "enabled": true (set through the machine helper's
// `set-updates on`). Its "channel" says what it follows:
//   - "release" (new installs): the newest release tag vX.Y.Z, only when it is newer than the installed
//     version, its signature verifies (`git verify-tag`) against the owner's allowed signers file
//     (updates.json allowed_signers), and its commit is the main commit it was cut from plus dist/ only.
//     The checks below are read on that main commit (CI runs on main, not on tags).
//   - "main" (the default when the field is absent, so an existing install keeps following main): main's
//     newest commit, only when it is a fast-forward of the installed engine (never older, never a rewrite).
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
const VERIFY_GIT = '/var/lib/worklane/verify.git'; // a root-owned bare clone, only for checking release tags
const ALLOWED_SIGNERS = '/etc/worklane/allowed_signers';
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
  const held = deps.held();
  if (held && held.sha === head && !(deps.configChangedAt() > Date.parse(held.at))) {
    return deps.note('held', head, `rolled back at ${held.at}${held.failed && held.failed.length ? ` (${held.failed.join('; ')})` : ''}; held until a newer commit, or until updates are turned off and on again`, true);
  }
  const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  // The commit whose checks count: the release's main commit, or main's newest commit itself.
  let checked = head;
  if (release) {
    const v = deps.verifyRelease(cfg.repo_url, tag.tag, cfg.allowed_signers || ALLOWED_SIGNERS);
    if (!v.ok) return deps.note('refused', head, v.reason, true);
    checked = v.base;
  } else {
    const ff = fastForward(current ? await deps.fetchJson(`${api}/compare/${current}...${head}`) : { status: 'ahead', behind_by: 0, ahead_by: 0 });
    if (!ff.ok) return deps.note('refused', head, ff.reason, true);
  }
  const checks = evaluateChecks(((await deps.fetchJson(`${api}/commits/${checked}/check-runs?per_page=100`)) || {}).check_runs, cfg.required_checks);
  if (!checks.ok) return deps.note(checks.final ? 'refused' : 'waiting', head, checks.reason, checks.final);
  const q = quiet(deps.slots(), deps.alive);
  if (!q.quiet) return deps.note('waiting', head, `not quiet: ${q.why}`, false);

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
  const units = parseUnits(deps.exec('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--full', 'worklane-*.service']));
  const instances = units.map((u) => parseInstance(u, deps.exec('systemctl', ['show', '-p', 'User,Environment,ExecStart', u]))).filter(Boolean);
  // Every backup the migrations made, per instance: what a rollback puts back.
  const migrated = [];
  const restoreAll = () => {
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
  };
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
  deps.switchTo(head);
  const after = await settle();
  if (after.h === 'healthy') {
    deps.log({ event: 'installed', from: current, to: head, units, ...(instances.length ? { migrated: migrated.map((m) => ({ instance: m.inst.name, applied: m.applied.length })) } : {}) });
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
  // The old engine refuses config and state newer than it knows: put the migrations' backups back first.
  if (instances.length) deps.exec('systemctl', ['stop', ...units]);
  const unrestored = restoreAll();
  if (current) deps.switchTo(current);
  const back = current ? await settle() : { h: 'failed' };
  const at = new Date(deps.now()).toISOString();
  deps.hold({ sha: head, at, failed: down });
  deps.log({ event: 'rolled_back', from: head, to: current, units, failed: down, back: back.h, diagnosis, held: true, ...(migrated.length ? { restored: migrated.map((m) => m.inst.name), unrestored } : {}) });
  return 'rolled_back';
}

/** [file, args] of an argv. */
const splitCmd = (argv) => [argv[0], argv.slice(1)];

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
    installedVersion: () => (readJson(path.join(OPT, 'current', 'package.json')) || {}).version || null,
    verifyRelease: (repoUrl, tag, signers) => verifyRelease(repoUrl, tag, signers, (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })),
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
module.exports = { channelOf, newer, parseTags, newestRelease, verifyRelease, parseInstance, migrateCommand, restoreCommand, parseMigrate, repoFromUrl, fastForward, evaluateChecks, quiet, parseUnits, parseShow, health, redact, buildCommand, binTargets, binProblems, installTree, run, BUILD_SCRIPT, HEALTH_MS, STABLE_MS };
