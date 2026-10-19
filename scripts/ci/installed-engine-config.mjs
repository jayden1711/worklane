#!/usr/bin/env node
// A pull request that changes .worklane/ (#810): its config, as it would be on main, is loaded with the engine this
// repo's machines run (the release scripts/bootstrap.sh pins), not only with the PR's own engine. A key the installed
// engine refuses fails this check, naming the key and the engine version. The check blocks a merge only once the owner
// makes it required (.github/workflows/installed-engine-config.yml); until then it is advisory.
//
//   node scripts/ci/installed-engine-config.mjs --base <rev> --head <rev>      (from the repo root; CI: HEAD^1 HEAD)
//
// INVARIANT: it fails closed, naming why, and never falls back to the PR's own engine:
//   - the installed version is the pin in scripts/bootstrap.sh as committed at --base (ENGINE_TAG and ENGINE_COMMIT,
//     scripts/lib/engine-pin.mjs), so a PR can't move the pin it is judged by. Only when --base has no bootstrap.sh,
//     or its ENGINE_COMMIT isn't filled in, is it the newest vX.Y.Z tag instead; a malformed pin is refused;
//   - that tag must verify as release.yml verifies one (scripts/verify-release-tag.mjs: an SSH signature by a key in
//     .github/release-signers as committed at --base, the tag pointing at the pinned commit);
//   - the engine's own dist/ at that commit, with its own locked runtime dependencies (npm ci --omit=dev
//     --ignore-scripts), loads the config with its own loader and schema (configFrom in dist/src/config/load.js);
//   - every top-level .worklane/*.yaml the change adds or edits must be one that loader reads.
// No skip label and no exception (#810): a PR meant to land after an engine upgrade waits, as a draft, until the pin
// on main includes that upgrade, and passes then.
//
// A change that moves that pin (#814) is also judged by the engine it pins, since every new bootstrap would install
// that one: its .worklane/ as the merge commit carries it (main's own, when only the pin moves) is loaded the same way
// with the engine the --head pin names. Once bootstrap.sh changes, both pin lines must be exactly
// `ENGINE_TAG=vX.Y.Z` and `ENGINE_COMMIT=<40 hex>` in ASCII with nothing after them (strictPin), or it is refused:
// bash must not be able to read another pin than this check does. The tag must verify against the signers at --base,
// never --head's, so a PR can't bring its own signer. Every top-level .worklane/*.yaml at --head must be one that
// engine reads. A change that removes bootstrap.sh is refused. A bootstrap.sh change that leaves both pin lines as
// they were moves nothing. An engine chosen elsewhere in bootstrap.sh's code is not seen here: owner review of
// scripts/** is what covers that.
//
// A moved pin must be newer than the base's, by full semver (owner, 2026-10-19). An older version, the same version at
// another commit, or a base pin whose version can't be told is a rollback: refused unless the repository owner applied
// the engine-rollback label to the PR (read from its timeline with the workflow's read-only token, and printed, so the
// run records who and when). A label by anyone else, or a timeline it can't read, is no override.
//
// A change that touches neither .worklane/ nor the pin has nothing to load: it prints so and exits 0, before fetching
// any engine (the workflow's paths filter already skips most such PRs; this keeps the script right without it).
// Exit 1: refused, or it couldn't check.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPin } from '../lib/engine-pin.mjs';

const CONFIG_DIR = '.worklane';
const BOOTSTRAP = 'scripts/bootstrap.sh';
const LOADER = 'dist/src/config/load.js';
const VERSION_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
// The repository owner's word that a moved pin may go back (a deliberate rollback): this label on the PR, last applied
// by the owner (upgradeOrOwnerRollback).
const ROLLBACK_LABEL = 'engine-rollback';
// What ownerRollback reads, taken out of the environment at once: no engine's code loaded below, and no child process
// (git, npm), ever sees the token.
const GH = {
  api: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPOSITORY || '',
  owner: process.env.GITHUB_REPOSITORY_OWNER || '',
  pr: process.env.PR_NUMBER || '',
};
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
// The only pin lines a moved pin may have (strictPin): ASCII, nothing after the value.
const PIN_LINE = { ENGINE_TAG: /^ENGINE_TAG=v[0-9]+\.[0-9]+\.[0-9]+$/, ENGINE_COMMIT: /^ENGINE_COMMIT=[0-9a-f]{40}$/ };
const PIN_FORM = { ENGINE_TAG: 'vX.Y.Z', ENGINE_COMMIT: '<40 hex digits>' };
/** A line as printable ASCII: anything else as \uXXXX, so a CR, NBSP, BOM or lookalike shows in the message. */
const shown = (s) => s.replace(/[^\x20-\x7e]/gu, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const say = (msg) => console.log(`installed-engine-config: ${msg}`);
class Refused extends Error {}
const fail = (msg) => {
  throw new Refused(msg);
};
const git = (...a) => spawnSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const gitText = (...a) => {
  const r = git(...a);
  return r.status === 0 ? r.stdout.trim() : null;
};
const has = (rev, path) => git('cat-file', '-e', `${rev}:${path}`).status === 0;
const lastLine = (s) => String(s ?? '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';

try {
  await main();
} catch (e) {
  if (!(e instanceof Refused)) throw e;
  console.error(`installed-engine-config: refused: ${e.message}`);
  process.exitCode = 1;
}

async function main() {
  if (!opt('base') || !opt('head')) fail('usage: installed-engine-config.mjs --base <rev> --head <rev>');
  const base = gitText('rev-parse', '-q', '--verify', `${opt('base')}^{commit}`);
  const head = gitText('rev-parse', '-q', '--verify', `${opt('head')}^{commit}`);
  if (!base) fail(`no commit ${opt('base')} here to compare against`);
  if (!head) fail(`no commit ${opt('head')} here to load`);
  const root = gitText('rev-parse', '--show-toplevel');
  if (!root) fail('not inside a git checkout');

  // Whether the change touches .worklane/ at all: the same tree id at both ends (or none at either) means nothing to
  // load with the installed engine. Whether it moves the pin: decided before any engine is fetched.
  const treeAt = (rev) => gitText('rev-parse', '-q', '--verify', `${rev}:${CONFIG_DIR}`);
  const configChanged = treeAt(base) !== treeAt(head);
  const moved = movedPin(base, head);
  if (!configChanged && !moved) {
    say(`no change under ${CONFIG_DIR}/ between ${base.slice(0, 12)} and ${head.slice(0, 12)}: nothing to load (the engine pin in ${BOOTSTRAP} didn't move)`);
    return;
  }
  // A moved pin is an upgrade, or the owner's recorded rollback: decided before any engine is fetched.
  if (moved) await upgradeOrOwnerRollback(moved, base);
  const yamlAtHead =[...entriesAt(head)].filter(([name]) => /\.ya?ml$/.test(name));
  let refusals = 0;
  const refuse = (problems, why) => {
    for (const p of problems) {
      const where = `${CONFIG_DIR}/${p.file ?? ''}${p.path ? ` at ${p.path}` : ''}`;
      console.error(`installed-engine-config: ${where}: ${p.message}`);
    }
    console.error(`installed-engine-config: refused: ${why}`);
    refusals += 1;
  };

  if (configChanged) {
    // The top-level config files the change adds or edits: a *.yaml/*.yml entry at --head whose mode or blob differs
    // from --base's (a deleted one has nothing to load; the loader itself names a required one that is gone).
    const atBase = entriesAt(base);
    const changedYaml = yamlAtHead.filter(([name, id]) => atBase.get(name) !== id).map(([name]) => name);
    const engine = verified('the installed engine', installed(base), base);
    const problems = await loadWith(engine, root, head);
    for (const file of changedYaml) {
      if (!problems.asked.has(file)) problems.list.push({ file, path: '', message: `the installed engine doesn't read ${CONFIG_DIR}/${file}: what it sets would have no effect on a machine` });
    }
    if (problems.list.length) {
      refuse(
        problems.list,
        `${CONFIG_DIR}/ at ${head.slice(0, 12)} is refused by ${engine.label}. Merged now, the machines running it couldn't load ` +
          `their config. If this change needs a newer engine, keep the PR a draft until ${BOOTSTRAP} on main pins one that accepts it ` +
          '(scripts/pin-engine.mjs), then update the PR',
      );
    } else {
      say(`${CONFIG_DIR}/ at ${head.slice(0, 12)} loads with ${engine.label}${changedYaml.length ? `; changed: ${changedYaml.join(', ')}` : ''}`);
    }
  }

  if (moved) {
    // The engine every new bootstrap would install once this merges: its tag verified against the BASE's signers.
    const engine = verified('the engine this change pins,', moved, base);
    const problems = await loadWith(engine, root, head);
    // Every config file there, not only changed ones: a release that stops reading one drops what it sets.
    for (const [file] of yamlAtHead) {
      if (!problems.asked.has(file)) problems.list.push({ file, path: '', message: `the engine this change pins doesn't read ${CONFIG_DIR}/${file}: what it sets would have no effect on a new machine` });
    }
    if (problems.list.length) {
      refuse(
        problems.list,
        `${CONFIG_DIR}/ at ${head.slice(0, 12)} is refused by ${engine.label}. Merged now, every new bootstrap would install an engine that ` +
          `can't load this repo's config. Pin a release that loads it, or first change ${CONFIG_DIR}/ (in a PR of its own) to a config ` +
          'both the installed engine and that release accept',
      );
    } else {
      say(`${CONFIG_DIR}/ at ${head.slice(0, 12)} loads with ${engine.label}`);
    }
  }
  if (refusals) process.exitCode = 1;
}

/**
 * The pin --head sets in bootstrap.sh when it differs from --base's: { tag, commit, source }, or null when it doesn't
 * move (bootstrap.sh unchanged, or changed with both pin lines byte for byte as they were). Read with strictPin from
 * the raw file, so a pin line bash would read differently is refused, never taken as "the same". A base pin that
 * strictPin refuses counts as moved. A removed bootstrap.sh is refused.
 */
function movedPin(base, head) {
  const blob = (rev) => gitText('rev-parse', '-q', '--verify', `${rev}:${BOOTSTRAP}`);
  const [was, now] = [blob(base), blob(head)];
  if (was === now) return null;
  if (now === null) fail(`this change removes ${BOOTSTRAP}, the engine pin every new machine bootstraps from: can't tell which engine they would install`);
  const at = `${BOOTSTRAP} at ${head.slice(0, 12)}`;
  // Raw bytes, never trimmed: trimming would drop a trailing NBSP, BOM or newline that bash keeps.
  const raw = (rev) => {
    const r = git('show', `${rev}:${BOOTSTRAP}`);
    return r.status === 0 ? r.stdout : null;
  };
  const text = raw(head);
  if (text === null) fail(`can't read ${at}`);
  let pin;
  try {
    pin = strictPin(text);
  } catch (e) {
    fail(`${at}: ${e.message}`);
  }
  let before = null;
  if (was !== null) {
    try {
      before = strictPin(raw(base) ?? '');
    } catch {
      before = null;
    }
  }
  if (before && before.tag === pin.tag && before.commit === pin.commit) return null;
  return { tag: pin.tag, commit: pin.commit, source: `the pin in ${at}`, before };
}

/** vMAJOR.MINOR.PATCH as three BigInts (no leading zeros, any size), or null: a version this check can't compare. */
function semver(tag) {
  const m = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(tag ?? '');
  return m ? m.slice(1).map(BigInt) : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * A moved pin must be an upgrade (#825, owner 2026-10-19): newer than the base's pin by full semver. An older
 * version, the same version at another commit, or a base pin whose version can't be told is a rollback, allowed only
 * by the repository owner's engine-rollback label on the PR (ownerRollback), and then printed, so the run records who
 * and when. A head version that won't parse is refused whatever the label says.
 */
async function upgradeOrOwnerRollback(moved, base) {
  const now = semver(moved.tag);
  if (!now) fail(`the engine this change pins, ${moved.tag} isn't a version this check can compare (vMAJOR.MINOR.PATCH, no leading zeros)`);
  const at = `${BOOTSTRAP} at ${base.slice(0, 12)}`;
  const was = moved.before ? semver(moved.before.tag) : null;
  let why = null;
  if (!was) why = `can't tell which engine version ${at} pins, so this move can't be shown to be an upgrade`;
  else if (compare(now, was) < 0) why = `the engine this change pins, ${moved.tag}, is older than ${moved.before.tag}, the pin in ${at}`;
  else if (compare(now, was) === 0) why = `this change pins ${moved.tag} again, at ${moved.commit}, not ${moved.before.commit}`;
  if (!why) return;
  const owner = await ownerRollback();
  if (!owner.ok) fail(`${why}: a rollback needs the repository owner's ${ROLLBACK_LABEL} label on the PR, and ${owner.reason}`);
  say(`${why}; rollback allowed: ${owner.line}`);
}

/**
 * Whether the repository owner allowed a rollback on this PR: the PR's timeline (GitHub's API, with the workflow's
 * read-only token) shows the engine-rollback label last applied, not removed, by the login GITHUB_REPOSITORY_OWNER
 * names, and the PR carries it now. Anything else, including an API it can't read, is { ok: false, reason }.
 */
async function ownerRollback() {
  const { api, token, repo, owner, pr } = GH;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9][0-9]*$/.test(pr) || !owner || repo.split('/')[0] !== owner) {
    return { ok: false, reason: "can't read the PR's labels: this run has no token, repository, owner or PR number" };
  }
  const get = async (path) => {
    const r = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`GET ${path.split('?')[0]} answered ${r.status}`);
    return { body: await r.json(), link: r.headers.get('link') || '' };
  };
  try {
    const events = [];
    for (let page = 1; ; page += 1) {
      if (page > 50) throw new Error('the timeline runs past 50 pages');
      const { body, link } = await get(`/repos/${repo}/issues/${pr}/timeline?per_page=100&page=${page}`);
      if (!Array.isArray(body)) throw new Error('the timeline is not a list');
      events.push(...body);
      if (!/rel="next"/.test(link)) break;
    }
    const { body: issue } = await get(`/repos/${repo}/issues/${pr}`);
    const present = Array.isArray(issue?.labels) && issue.labels.some((l) => l?.name === ROLLBACK_LABEL);
    const changes = events.filter((e) => (e?.event === 'labeled' || e?.event === 'unlabeled') && e?.label?.name === ROLLBACK_LABEL);
    if (changes.some((e) => Number.isNaN(Date.parse(e.created_at)))) throw new Error('a label event has no readable time');
    const last = changes.map((e, i) => ({ e, i })).sort((x, y) => Date.parse(x.e.created_at) - Date.parse(y.e.created_at) || x.i - y.i).pop()?.e;
    if (!present || !last || last.event !== 'labeled') return { ok: false, reason: `no ${ROLLBACK_LABEL} label on PR #${pr}` };
    const who = last.actor?.login;
    if (who !== owner) return { ok: false, reason: `${ROLLBACK_LABEL} on PR #${pr} was last applied by @${who ?? '(no one named)'}, not the repository owner @${owner}` };
    return { ok: true, line: `${ROLLBACK_LABEL} on PR #${pr} was last applied by @${who} (the repository owner) at ${last.created_at}` };
  } catch (e) {
    return { ok: false, reason: `can't read the PR's labels: ${e.message}` };
  }
}

/**
 * The pin in bootstrap.sh's raw text, only when bash can't read it differently from this check: exactly one line
 * `ENGINE_TAG=vX.Y.Z` and one `ENGINE_COMMIT=<40 lowercase hex>`, ASCII, with nothing else on the line (no comment,
 * quote, `$`, CR, NBSP, BOM or U+2028) and a newline after it. Every line that starts with either name must be that
 * line (so `ENGINE_TAG+=…` is refused). No line may assign a name with a character outside ASCII, since a lookalike of
 * either name can't be told apart. Lines are split on "\n" only, as bash splits them. Throws why otherwise.
 * It sees only these lines: an engine set some other way in the script (indented, export, eval, ...) is not seen.
 */
function strictPin(text) {
  const lines = text.split('\n');
  const found = { ENGINE_TAG: [], ENGINE_COMMIT: [] };
  lines.forEach((line, i) => {
    const n = i + 1;
    const name = /^\s*([^\s=#][^\s=]*)=/u.exec(line)?.[1];
    if (name && /[^\x00-\x7f]/u.test(name)) {
      throw new Error(`line ${n} assigns "${shown(name)}", a name with a character outside ASCII: it can't be told from the pin's names`);
    }
    for (const key of Object.keys(found)) {
      if (!line.startsWith(key)) continue;
      if (!PIN_LINE[key].test(line)) {
        throw new Error(`line ${n} is "${shown(line)}", not exactly ${key}=${PIN_FORM[key]} (ASCII, nothing after it): bash could read another pin there than this check does`);
      }
      if (i === lines.length - 1) throw new Error(`line ${n}, "${shown(line)}", doesn't end in a newline`);
      found[key].push(line.slice(key.length + 1));
    }
  });
  if (found.ENGINE_TAG.length !== 1 || found.ENGINE_COMMIT.length !== 1) throw new Error('bootstrap.sh needs exactly one ENGINE_TAG= line and one ENGINE_COMMIT= line');
  return { tag: found.ENGINE_TAG[0], commit: found.ENGINE_COMMIT[0] };
}

/**
 * The engine `{ tag, commit, source }`, its tag here (fetched by name when missing) and verified as release.yml
 * verifies one: signed by a release signer `signersRef` lists, pointing at `commit`. Returns it with its label.
 */
function verified(noun, { tag, commit, source }, signersRef) {
  const label = `${noun} ${tag} (${commit.slice(0, 12)}, ${source})`;
  fetchTag(tag, label);
  const verify = spawnSync(process.execPath, [join(here, '..', 'verify-release-tag.mjs'), tag, '--commit', commit, '--signers-ref', signersRef], { encoding: 'utf8' });
  if (verify.status !== 0) fail(`${label} doesn't verify: ${lastLine(verify.stderr || verify.stdout) || verify.error?.message}`);
  say(lastLine(verify.stdout));
  return { tag, commit, source, label };
}

/** refs/tags/<tag> here: fetched by name from origin when missing (shallow when this checkout is). */
function fetchTag(tag, label) {
  if (gitText('rev-parse', '-q', '--verify', `refs/tags/${tag}`) !== null) return;
  if (git('remote', 'get-url', 'origin').status !== 0) fail(`no tag ${tag} here for ${label}, and no origin to fetch it from`);
  const shallow = gitText('rev-parse', '--is-shallow-repository') === 'true' ? ['--depth=1'] : [];
  const f = git('fetch', '-q', '--no-tags', ...shallow, 'origin', `+refs/tags/${tag}:refs/tags/${tag}`);
  if (f.status !== 0) fail(`can't fetch ${tag} for ${label}: ${lastLine(f.stderr)}`);
}

/** The files directly in .worklane/ at `rev`, as name -> "mode object id" (none when it has no .worklane/). */
function entriesAt(rev) {
  const out = new Map();
  if (!has(rev, CONFIG_DIR)) return out;
  const r = git('ls-tree', '-z', rev, `${CONFIG_DIR}/`);
  if (r.status !== 0) fail(`can't list ${CONFIG_DIR}/ at ${rev.slice(0, 12)}: ${lastLine(r.stderr)}`);
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, id] = entry.slice(0, tab).split(' ');
    if (type === 'blob') out.set(entry.slice(tab + 1).slice(CONFIG_DIR.length + 1), `${mode} ${id}`);
  }
  return out;
}

/** The engine this repo's machines run: the pin as committed at `base`, else the newest release tag. */
function installed(base) {
  const at = `${BOOTSTRAP} at ${base.slice(0, 12)}`;
  const boot = has(base, BOOTSTRAP) ? gitText('show', `${base}:${BOOTSTRAP}`) : null;
  if (boot !== null) {
    let pin;
    try {
      pin = readPin(boot);
    } catch (e) {
      fail(`${at}: ${e.message}`);
    }
    if (!VERSION_TAG.test(pin.tag)) fail(`${at} pins ENGINE_TAG=${pin.tag}, not a release tag vX.Y.Z`);
    if (pin.commit) {
      if (!FULL_COMMIT.test(pin.commit)) fail(`${at} pins ENGINE_COMMIT=${pin.commit}, not a full commit id`);
      return { tag: pin.tag, commit: pin.commit, source: `the pin in ${at}` };
    }
  }
  const names = new Set((gitText('tag', '--list', 'v*') ?? '').split('\n'));
  if (git('remote', 'get-url', 'origin').status === 0) {
    const remote = git('ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*');
    if (remote.status !== 0) fail(`no engine pinned in ${at}, and the release tags can't be listed: ${lastLine(remote.stderr)}`);
    for (const line of remote.stdout.split('\n')) names.add(line.split('refs/tags/')[1] ?? '');
  }
  const num = (t) => t.slice(1).split('.').map(Number);
  const tag = [...names]
    .filter((t) => VERSION_TAG.test(t))
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .pop();
  if (!tag) fail(`no engine pinned in ${at} and no release tag vX.Y.Z: can't tell which engine is installed`);
  const source = `the newest release tag; ${at} pins no commit`;
  // No pinned commit: the tag's own, so the tag must be here first (fetched by name when missing).
  fetchTag(tag, `the installed engine ${tag} (${source})`);
  const commit = gitText('rev-parse', `refs/tags/${tag}^{commit}`);
  if (!commit) fail(`${tag} (${source}) names no commit`);
  return { tag, commit, source };
}

/**
 * The config committed at `head`, loaded by the verified engine at `commit`: its dist/src and its locked runtime
 * dependencies in a directory outside this checkout (so nothing resolves to the PR's own modules), then its configFrom.
 * Returns what the loader refused and the files it asked for.
 */
async function loadWith({ commit, label: engine }, root, head) {
  if (!has(commit, LOADER)) fail(`${engine} carries no ${LOADER}: not a release commit`);
  const pkgText = gitText('show', `${commit}:package.json`);
  if (pkgText === null) fail(`${engine} has no package.json`);
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (e) {
    fail(`${engine} has an unreadable package.json: ${e.message}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'installed-engine-'));
  try {
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', commit, 'dist/src'], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const x = spawnSync('tar', ['-x', '-C', dir], { input: tar, stdio: ['pipe', 'ignore', 'pipe'] });
      if (x.status !== 0) throw new Error(lastLine(x.stderr) || `tar exited ${x.status}`);
    } catch (e) {
      fail(`can't unpack ${engine}: ${lastLine(e.stderr) || e.message}`);
    }
    writeFileSync(join(dir, 'package.json'), pkgText);
    if (Object.keys(pkg.dependencies ?? {}).length) {
      const lock = gitText('show', `${commit}:package-lock.json`);
      if (lock === null) fail(`${engine} has runtime dependencies but no package-lock.json to install them as released`);
      writeFileSync(join(dir, 'package-lock.json'), lock);
      const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
      if (npm.status !== 0) fail(`can't install ${engine}'s runtime dependencies: ${lastLine(npm.stderr || npm.stdout) || npm.error?.message}`);
    }
    let mod;
    try {
      mod = await import(pathToFileURL(join(dir, LOADER)).href);
    } catch (e) {
      fail(`can't load ${engine}'s config loader: ${e.message}`);
    }
    if (typeof mod.configFrom !== 'function') fail(`${engine}'s ${LOADER} exports no configFrom: can't load a config with it`);
    // Read only from git at --head, never the working tree: every file the engine asks for, as it asks.
    const asked = new Set();
    const read = (file) => {
      asked.add(file);
      const path = `${CONFIG_DIR}/${file}`;
      if (!has(head, path)) return null;
      const r = git('show', `${head}:${path}`);
      if (r.status !== 0) fail(`can't read ${path} at ${head.slice(0, 12)}: ${lastLine(r.stderr)}`);
      return r.stdout;
    };
    try {
      mod.configFrom(root, read);
      return { asked, list: [] };
    } catch (e) {
      if (e instanceof Refused) throw e;
      const list = Array.isArray(e?.errors) && e.errors.length ? e.errors : [{ file: '', path: '', message: lastLine(e?.message ?? e) || 'its loader threw' }];
      return { asked, list };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
