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
// A change outside .worklane/ has nothing to load: it prints so and exits 0, before fetching any engine (the
// workflow's paths filter already skips such PRs; this keeps the script right without it). Exit 1: refused, or it
// couldn't check.
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
  // load, and no engine is fetched.
  const treeAt = (rev) => gitText('rev-parse', '-q', '--verify', `${rev}:${CONFIG_DIR}`);
  if (treeAt(base) === treeAt(head)) {
    say(`no change under ${CONFIG_DIR}/ between ${base.slice(0, 12)} and ${head.slice(0, 12)}: nothing to load`);
    return;
  }
  // The top-level config files the change adds or edits: a *.yaml/*.yml entry at --head whose mode or blob differs
  // from --base's (a deleted one has nothing to load; the loader itself names a required one that is gone).
  const atBase = entriesAt(base);
  const changedYaml = [...entriesAt(head)].filter(([name, id]) => /\.ya?ml$/.test(name) && atBase.get(name) !== id).map(([name]) => name);

  const { tag, commit, source } = installed(base);
  // Signed by a release signer the base lists, and pointing at the pinned commit: the release workflow's own check.
  const verify = spawnSync(process.execPath, [join(here, '..', 'verify-release-tag.mjs'), tag, '--commit', commit, '--signers-ref', base], { encoding: 'utf8' });
  if (verify.status !== 0) fail(`the installed engine ${tag} (${source}) doesn't verify: ${lastLine(verify.stderr || verify.stdout) || verify.error?.message}`);
  say(lastLine(verify.stdout));
  const engine = `${tag} (${commit.slice(0, 12)}, ${source})`;

  const problems = await loadWith(engine, commit, root, head);
  for (const file of changedYaml) {
    if (!problems.asked.has(file)) problems.list.push({ file, path: '', message: `the installed engine doesn't read ${CONFIG_DIR}/${file}: what it sets would have no effect on a machine` });
  }
  if (problems.list.length) {
    for (const p of problems.list) {
      const where = `${CONFIG_DIR}/${p.file ?? ''}${p.path ? ` at ${p.path}` : ''}`;
      console.error(`installed-engine-config: ${where}: ${p.message}`);
    }
    fail(
      `${CONFIG_DIR}/ at ${head.slice(0, 12)} is refused by the installed engine ${engine}. Merged now, the machines running it couldn't load ` +
        `their config. If this change needs a newer engine, keep the PR a draft until ${BOOTSTRAP} on main pins one that accepts it ` +
        '(scripts/pin-engine.mjs), then update the PR',
    );
  }
  say(`${CONFIG_DIR}/ at ${head.slice(0, 12)} loads with the installed engine ${engine}${changedYaml.length ? `; changed: ${changedYaml.join(', ')}` : ''}`);
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
  let tag;
  let commit;
  let source;
  if (boot !== null) {
    let pin;
    try {
      pin = readPin(boot);
    } catch (e) {
      fail(`${at}: ${e.message}`);
    }
    if (!VERSION_TAG.test(pin.tag)) fail(`${at} pins ENGINE_TAG=${pin.tag}, not a release tag vX.Y.Z`);
    if (pin.commit) {
      if (!/^[0-9a-f]{40}$/.test(pin.commit)) fail(`${at} pins ENGINE_COMMIT=${pin.commit}, not a full commit id`);
      [tag, commit, source] = [pin.tag, pin.commit, `the pin in ${at}`];
    }
  }
  const hasOrigin = git('remote', 'get-url', 'origin').status === 0;
  if (!tag) {
    const names = new Set((gitText('tag', '--list', 'v*') ?? '').split('\n'));
    if (hasOrigin) {
      const remote = git('ls-remote', '--tags', '--refs', 'origin', 'refs/tags/v*');
      if (remote.status !== 0) fail(`no engine pinned in ${at}, and the release tags can't be listed: ${lastLine(remote.stderr)}`);
      for (const line of remote.stdout.split('\n')) names.add(line.split('refs/tags/')[1] ?? '');
    }
    const num = (t) => t.slice(1).split('.').map(Number);
    const newest = [...names]
      .filter((t) => VERSION_TAG.test(t))
      .sort((a, b) => {
        const [x, y] = [num(a), num(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      })
      .pop();
    if (!newest) fail(`no engine pinned in ${at} and no release tag vX.Y.Z: can't tell which engine is installed`);
    [tag, source] = [newest, `the newest release tag; ${at} pins no commit`];
  }
  // The tag here, fetched by name when missing (shallow when this checkout is).
  if (gitText('rev-parse', '-q', '--verify', `refs/tags/${tag}`) === null) {
    if (!hasOrigin) fail(`no tag ${tag} (${source}) here, and no origin to fetch it from`);
    const shallow = gitText('rev-parse', '--is-shallow-repository') === 'true' ? ['--depth=1'] : [];
    const f = git('fetch', '-q', '--no-tags', ...shallow, 'origin', `+refs/tags/${tag}:refs/tags/${tag}`);
    if (f.status !== 0) fail(`can't fetch ${tag} (${source}): ${lastLine(f.stderr)}`);
  }
  commit ??= gitText('rev-parse', `refs/tags/${tag}^{commit}`);
  if (!commit) fail(`${tag} (${source}) names no commit`);
  return { tag, commit, source };
}

/**
 * The config committed at `head`, loaded by the engine at `commit`: its dist/src and its locked runtime dependencies
 * in a directory outside this checkout (so nothing resolves to the PR's own modules), then its configFrom.
 * Returns what the loader refused and the files it asked for.
 */
async function loadWith(engine, commit, root, head) {
  if (!has(commit, LOADER)) fail(`the installed engine ${engine} carries no ${LOADER}: not a release commit`);
  const pkgText = gitText('show', `${commit}:package.json`);
  if (pkgText === null) fail(`the installed engine ${engine} has no package.json`);
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (e) {
    fail(`the installed engine ${engine} has an unreadable package.json: ${e.message}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'installed-engine-'));
  try {
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', commit, 'dist/src'], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const x = spawnSync('tar', ['-x', '-C', dir], { input: tar, stdio: ['pipe', 'ignore', 'pipe'] });
      if (x.status !== 0) throw new Error(lastLine(x.stderr) || `tar exited ${x.status}`);
    } catch (e) {
      fail(`can't unpack the installed engine ${engine}: ${lastLine(e.stderr) || e.message}`);
    }
    writeFileSync(join(dir, 'package.json'), pkgText);
    if (Object.keys(pkg.dependencies ?? {}).length) {
      const lock = gitText('show', `${commit}:package-lock.json`);
      if (lock === null) fail(`the installed engine ${engine} has runtime dependencies but no package-lock.json to install them as released`);
      writeFileSync(join(dir, 'package-lock.json'), lock);
      const npm = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
      if (npm.status !== 0) fail(`can't install the installed engine ${engine}'s runtime dependencies: ${lastLine(npm.stderr || npm.stdout) || npm.error?.message}`);
    }
    let mod;
    try {
      mod = await import(pathToFileURL(join(dir, LOADER)).href);
    } catch (e) {
      fail(`can't load the installed engine ${engine}'s config loader: ${e.message}`);
    }
    if (typeof mod.configFrom !== 'function') fail(`the installed engine ${engine}'s ${LOADER} exports no configFrom: can't load a config with it`);
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
