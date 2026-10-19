// scripts/ci/installed-engine-config.mjs (#810): a .worklane/ change is loaded with the engine release the base pins in
// scripts/bootstrap.sh, verified as release.yml verifies a tag, and fails when that engine refuses it. A change that
// moves that pin (#814) also has its .worklane/ loaded with the engine it pins, that tag verified against the base's
// signers. Real git, real SSH keys, a throwaway repo, and a pinned-engine stand-in: a release commit whose
// dist/src/config/load.js takes only the keys it knows, as the real schema's strict objects do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { which } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const skip = (process.platform === 'win32' || !which('ssh-keygen')) && 'needs ssh-keygen and a POSIX shell';
const SCRIPT = join(repoRoot, 'scripts', 'ci', 'installed-engine-config.mjs');
const BOOT = '#!/usr/bin/env bash\nENGINE_TAG=v0.0.0\nENGINE_COMMIT= # NOT FILLED IN\n';
/** bootstrap.sh pinned to `tag` at `commit`, as scripts/pin-engine.mjs writes it. */
const bootFor = (tag: string, commit: string) => BOOT.replace('v0.0.0', tag).replace('ENGINE_COMMIT= # NOT FILLED IN', `ENGINE_COMMIT=${commit}`);

/**
 * The stand-in engine's config loader: config.yaml (required) and, by default, review.yaml, each with only the keys
 * `known` lists. `files`: the config files this engine reads.
 */
const standIn = (known: string[], files = ['config.yaml', 'review.yaml']) => `export function configFrom(root, read) {
  const known = ${JSON.stringify(known)};
  const errors = [];
  for (const file of ${JSON.stringify(files)}) {
    const text = read(file);
    if (text === null) {
      if (file === 'config.yaml') errors.push({ file, path: '', message: 'missing' });
      continue;
    }
    for (const line of text.split('\\n')) {
      const key = /^([A-Za-z_]+):/.exec(line)?.[1];
      if (key && !known.includes(key)) errors.push({ file, path: '', message: 'Unrecognized key: "' + key + '"' });
    }
  }
  if (errors.length) throw Object.assign(new Error('invalid'), { errors });
  return {};
}
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'installed-engine-config-'));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const repo = join(dir, 'repo');
  const sh = (cmd: string, args: string[], cwd = repo) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const key = (name: string) => {
    sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)], dir);
    return join(dir, name);
  };
  const owner = key('owner');
  const stranger = key('stranger');
  const signersFor = (k: string) => `release-signer namespaces="git" ${readFileSync(`${k}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')}\n`;
  const write = (files: Record<string, string>) => {
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), body);
      sh('git', ['add', '-f', f]);
    }
  };
  const commitOn = (from: string, files: Record<string, string>, msg: string) => {
    sh('git', ['checkout', '-q', '--detach', from]);
    write(files);
    sh('git', ['commit', '-q', '-m', msg]);
    return sh('git', ['rev-parse', 'HEAD']);
  };
  sh('git', ['init', '-q', '-b', 'main', repo], dir);
  write({ '.github/release-signers': signersFor(owner), 'scripts/bootstrap.sh': BOOT, '.worklane/config.yaml': 'name: demo\n', 'README': 'x\n' });
  sh('git', ['commit', '-q', '-m', 'main']);
  /** A release commit on main carrying the stand-in engine, tagged (signed by `signWith`, else unsigned annotated). */
  const release = (tag: string, known: string[], signWith?: string, files?: string[]) => {
    const c = commitOn('main', { 'package.json': JSON.stringify({ version: tag.slice(1) }), 'dist/src/config/load.js': standIn(known, files) }, `Release ${tag}`);
    if (signWith) sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signWith}`, 'tag', '-s', tag, '-m', tag]);
    else sh('git', ['tag', '-a', tag, '-m', tag]);
    return c;
  };
  /** Main moves on: `files` committed on its tip. */
  const onMain = (files: Record<string, string>) => {
    const c = commitOn('main', files, 'on main');
    sh('git', ['branch', '-f', 'main', c]);
    return c;
  };
  const pin = (tag: string, commit: string) => onMain({ 'scripts/bootstrap.sh': bootFor(tag, commit) });
  /** A PR: `files` committed on main's tip, as its merge commit would carry them. */
  const pr = (files: Record<string, string>) => commitOn('main', files, 'pr');
  const run = (head: string, base = 'main') => {
    const r = spawnSync(process.execPath, [SCRIPT, '--base', base, '--head', head], { cwd: repo, env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  /** The workflow's own step, as Actions runs it, on the merge commit `head` (HEAD^1 its base) in the fixture. */
  const runStep = (head: string, step: string) => {
    sh('git', ['checkout', '-q', '--detach', head]);
    const runnerTemp = mkdtempSync(join(dir, 'runner-'));
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], { cwd: repo, env: { ...env, RUNNER_TEMP: runnerTemp, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { repo, owner, stranger, signersFor, sh, release, onMain, pin, pr, run, runStep, done };
}

const workflow = () => readFileSync(join(repoRoot, '.github', 'workflows', 'installed-engine-config.yml'), 'utf8');
/** The check's scripts as this checkout has them, to commit into a fixture's main. */
const checkScripts = () =>
  Object.fromEntries(['scripts/ci/installed-engine-config.mjs', 'scripts/lib/engine-pin.mjs', 'scripts/verify-release-tag.mjs'].map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));

const refused = (r: { code: number | null; out: string }, why: RegExp) => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /installed-engine-config: refused: /);
  assert.match(r.out, why);
};

test('installed-engine-config: a key the pinned engine refuses fails, naming the key and the version; a valid config passes', { skip }, () => {
  const f = fixture();
  const v1 = f.release('v1.0.0', ['name', 'required_checks'], f.owner);
  f.pin('v1.0.0', v1);
  const bad = f.pr({ '.worklane/config.yaml': 'name: demo\nrequired_check_sources: {}\n' });
  const r = f.run(bad);
  refused(r, /refused by the installed engine v1\.0\.0 \(/);
  assert.match(r.out, /\.worklane\/config\.yaml: Unrecognized key: "required_check_sources"/);
  assert.match(r.out, /the pin in scripts\/bootstrap\.sh at /);
  assert.match(r.out, /keep the PR a draft until scripts\/bootstrap\.sh on main pins one that accepts it/);
  const good = f.pr({ '.worklane/config.yaml': 'name: demo\nrequired_checks: [test]\n' });
  const ok = f.run(good);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /verified v1\.0\.0 /);
  assert.match(ok.out, /\.worklane\/ at \w+ loads with the installed engine v1\.0\.0 .*; changed: config\.yaml/);
  f.done();
});

test("installed-engine-config judges by the base's pin: a PR can't move it, and once main's pin accepts the key the same change passes", { skip }, () => {
  const f = fixture();
  const v1 = f.release('v1.0.0', ['name'], f.owner);
  const v2 = f.release('v1.1.0', ['name', 'required_check_sources'], f.owner);
  f.pin('v1.0.0', v1);
  const change = { '.worklane/config.yaml': 'name: demo\nrequired_check_sources: {}\n' };
  refused(f.run(f.pr(change)), /Unrecognized key: "required_check_sources"[\s\S]*v1\.0\.0/);
  // The PR moves the pin to v1.1.0 itself: still judged by main's v1.0.0.
  const boot = BOOT.replace('v0.0.0', 'v1.1.0').replace('ENGINE_COMMIT= # NOT FILLED IN', `ENGINE_COMMIT=${v2}`);
  refused(f.run(f.pr({ ...change, 'scripts/bootstrap.sh': boot })), /refused by the installed engine v1\.0\.0/);
  // The upgrade order: main pins v1.1.0 first, then the same change passes.
  f.pin('v1.1.0', v2);
  const r = f.run(f.pr(change));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /loads with the installed engine v1\.1\.0/);
  f.done();
});

test("installed-engine-config fails closed: unsigned, another key, a PR's own signer, a moved pin, a malformed pin, no or broken engine", { skip }, () => {
  const f = fixture();
  const change = { '.worklane/config.yaml': 'name: other\n' };
  // Unsigned, and signed by a key main doesn't list.
  f.pin('v1.0.0', f.release('v1.0.0', ['name']));
  refused(f.run(f.pr(change)), /the installed engine v1\.0\.0 \(.*\) doesn't verify: .*v1\.0\.0 is not signed/);
  f.pin('v1.0.1', f.release('v1.0.1', ['name'], f.stranger));
  refused(f.run(f.pr(change)), /v1\.0\.1 is signed by a key .* doesn't list for release-signer/);
  // The PR adds the stranger to the signers in its own change: the base's file is the one read.
  refused(f.run(f.pr({ ...change, '.github/release-signers': f.signersFor(f.stranger) })), /doesn't list for release-signer/);
  // The pin names a commit the tag doesn't point at.
  const v2 = f.release('v1.0.2', ['name'], f.owner);
  const other = f.release('v1.0.3', ['name'], f.owner);
  f.pin('v1.0.2', other);
  refused(f.run(f.pr(change)), new RegExp(`v1\\.0\\.2 points at ${v2}, but this run builds ${other}`));
  // A malformed pin: refused, never a fallback to a tag.
  f.onMain({ 'scripts/bootstrap.sh': `${BOOT}ENGINE_TAG=v1.0.2\n` });
  refused(f.run(f.pr(change)), /scripts\/bootstrap\.sh at \w+: bootstrap\.sh needs exactly one ENGINE_TAG= line/);
  // A signed tag whose commit carries no engine.
  f.sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${f.owner}`, 'tag', '-s', 'v1.0.4', '-m', 'v1.0.4', 'main']);
  f.pin('v1.0.4', f.sh('git', ['rev-parse', 'v1.0.4^{commit}']));
  refused(f.run(f.pr(change)), /the installed engine v1\.0\.4 .* carries no dist\/src\/config\/load\.js/);
  // A release whose loader exports no configFrom, one whose loader throws on import, and one with runtime
  // dependencies but no lockfile to install them as released.
  const signedRelease = (tag: string, files: Record<string, string>) => {
    const c = f.release(tag, ['name'], f.owner);
    f.sh('git', ['tag', '-d', tag]);
    f.sh('git', ['checkout', '-q', '--detach', c]);
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(f.repo, p, '..'), { recursive: true });
      writeFileSync(join(f.repo, p), body);
      f.sh('git', ['add', '-f', p]);
    }
    f.sh('git', ['commit', '-q', '--amend', '-m', `Release ${tag}`]);
    f.sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${f.owner}`, 'tag', '-s', tag, '-m', tag]);
    f.pin(tag, f.sh('git', ['rev-parse', 'HEAD']));
  };
  signedRelease('v1.0.5', { 'dist/src/config/load.js': 'export const loadConfig = () => ({});\n' });
  refused(f.run(f.pr(change)), /v1\.0\.5 \(.*\)'s dist\/src\/config\/load\.js exports no configFrom/);
  signedRelease('v1.0.6', { 'dist/src/config/load.js': "throw new Error('broken engine');\n" });
  refused(f.run(f.pr(change)), /can't load the installed engine v1\.0\.6 .*'s config loader: broken engine/);
  signedRelease('v1.0.7', { 'package.json': JSON.stringify({ version: '1.0.7', dependencies: { yaml: '2.0.0' } }) });
  refused(f.run(f.pr(change)), /v1\.0\.7 .* has runtime dependencies but no package-lock\.json/);
  f.done();
});

test('installed-engine-config: no pin falls back to the newest signed release tag; no pin and no tag is refused', { skip }, () => {
  const f = fixture();
  const change = { '.worklane/config.yaml': 'name: demo\nrequired_check_sources: {}\n' };
  refused(f.run(f.pr(change)), /no engine pinned in scripts\/bootstrap\.sh at \w+ and no release tag vX\.Y\.Z: can't tell which engine is installed/);
  f.release('v1.9.0', ['name', 'required_check_sources'], f.owner);
  f.release('v1.10.0', ['name'], f.owner);
  // ENGINE_COMMIT not filled in: the newest tag by version (v1.10.0, not v1.9.0), and it refuses the key.
  refused(f.run(f.pr(change)), /refused by the installed engine v1\.10\.0 \(\w+, the newest release tag; scripts\/bootstrap\.sh at \w+ pins no commit\)/);
  // The newest tag unsigned: refused, never an older one instead.
  f.release('v2.0.0', ['name', 'required_check_sources']);
  refused(f.run(f.pr(change)), /v2\.0\.0 .* doesn't verify: .*v2\.0\.0 is not signed/);
  f.done();
});

test('installed-engine-config: a config file the installed engine never reads is refused; no .worklane/ change loads nothing', { skip }, () => {
  const f = fixture();
  f.pin('v1.0.0', f.release('v1.0.0', ['name'], f.owner));
  refused(f.run(f.pr({ '.worklane/benchmarks.yaml': 'suites: []\n' })), /\.worklane\/benchmarks\.yaml: the installed engine doesn't read \.worklane\/benchmarks\.yaml/);
  // review.yaml is one it reads, and a role prompt is no yaml: both load.
  const r = f.run(f.pr({ '.worklane/review.yaml': 'name: r\n', '.worklane/roles/worker.md': 'x\n' }));
  assert.equal(r.code, 0, r.out);
  // Outside .worklane/: nothing to load, not even with a pin that wouldn't verify.
  f.onMain({ 'scripts/bootstrap.sh': `${BOOT}ENGINE_TAG=v1.0.2\n` });
  const none = f.run(f.pr({ README: 'y\n' }));
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /no change under \.worklane\/ between \w+ and \w+: nothing to load/);
  f.done();
});

test("a PR that moves the pin loads main's .worklane/ with the engine it pins: one that refuses the config or drops a file fails, one that loads it passes", { skip }, () => {
  const f = fixture();
  f.onMain({ '.worklane/config.yaml': 'name: demo\nrequired_checks: [test]\n', '.worklane/review.yaml': 'name: r\n' });
  f.pin('v1.0.0', f.release('v1.0.0', ['name', 'required_checks'], f.owner));
  // Only the pin moves, to a release that no longer takes a key main's config sets.
  const v2 = f.release('v1.1.0', ['name'], f.owner);
  const r = f.run(f.pr({ 'scripts/bootstrap.sh': bootFor('v1.1.0', v2) }));
  refused(r, /refused by the engine this change pins, v1\.1\.0 \(\w+, the pin in scripts\/bootstrap\.sh at \w+\)/);
  assert.match(r.out, /verified v1\.1\.0 /);
  assert.match(r.out, /\.worklane\/config\.yaml: Unrecognized key: "required_checks"/);
  assert.match(r.out, /every new bootstrap would install an engine that can't load this repo's config/);
  // A release that no longer reads a config file main has: what that file sets would be dropped on a new machine.
  const v3 = f.release('v1.2.0', ['name', 'required_checks'], f.owner, ['config.yaml']);
  refused(f.run(f.pr({ 'scripts/bootstrap.sh': bootFor('v1.2.0', v3) })), /\.worklane\/review\.yaml: the engine this change pins doesn't read \.worklane\/review\.yaml/);
  // A release that loads main's config as it is: passes.
  const v4 = f.release('v1.3.0', ['name', 'required_checks'], f.owner);
  const ok = f.run(f.pr({ 'scripts/bootstrap.sh': bootFor('v1.3.0', v4) }));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /verified v1\.3\.0 /);
  assert.match(ok.out, /\.worklane\/ at \w+ loads with the engine this change pins, v1\.3\.0 \(/);
  // A bootstrap.sh change that leaves the pin where it is: nothing to load.
  const same = f.run(f.pr({ 'scripts/bootstrap.sh': `${f.sh('git', ['show', 'main:scripts/bootstrap.sh'])}\n# another line\n` }));
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /no change under \.worklane\/ between \w+ and \w+: nothing to load/);
  f.done();
});

test('a PR that moves the pin and changes .worklane/ is judged by both engines: the installed one and the one it pins', { skip }, () => {
  const f = fixture();
  f.pin('v1.0.0', f.release('v1.0.0', ['name', 'required_checks'], f.owner));
  const change = { '.worklane/config.yaml': 'name: demo\nrequired_checks: [test]\n' };
  const v2 = f.release('v1.1.0', ['name'], f.owner);
  const r = f.run(f.pr({ ...change, 'scripts/bootstrap.sh': bootFor('v1.1.0', v2) }));
  refused(r, /refused by the engine this change pins, v1\.1\.0/);
  assert.match(r.out, /loads with the installed engine v1\.0\.0 .*; changed: config\.yaml/);
  const v3 = f.release('v1.2.0', ['name', 'required_checks'], f.owner);
  const ok = f.run(f.pr({ ...change, 'scripts/bootstrap.sh': bootFor('v1.2.0', v3) }));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /loads with the installed engine v1\.0\.0/);
  assert.match(ok.out, /loads with the engine this change pins, v1\.2\.0/);
  f.done();
});

test("a moved pin fails closed: unsigned, another key, the PR's own signer, a moved tag, malformed, unfilled, removed, no engine", { skip }, () => {
  const f = fixture();
  f.pin('v1.0.0', f.release('v1.0.0', ['name'], f.owner));
  const move = (tag: string, commit: string, more: Record<string, string> = {}) => f.run(f.pr({ 'scripts/bootstrap.sh': bootFor(tag, commit), ...more }));
  refused(move('v1.1.0', f.release('v1.1.0', ['name'])), /the engine this change pins, v1\.1\.0 \(.*\) doesn't verify: .*v1\.1\.0 is not signed/);
  refused(move('v1.1.1', f.release('v1.1.1', ['name'], f.stranger)), /v1\.1\.1 is signed by a key .* doesn't list for release-signer/);
  // The PR adds the stranger to the signers in its own change: the base's file is the one read.
  const v112 = f.release('v1.1.2', ['name'], f.stranger);
  refused(move('v1.1.2', v112, { '.github/release-signers': f.signersFor(f.stranger) }), /doesn't list for release-signer/);
  // The pin names a commit its tag doesn't point at.
  const v113 = f.release('v1.1.3', ['name'], f.owner);
  const other = f.release('v1.1.4', ['name'], f.owner);
  refused(move('v1.1.3', other), new RegExp(`v1\\.1\\.3 points at ${v113}, but this run builds ${other}`));
  // Malformed, not a release tag, or no commit filled in: bootstrap.sh itself would refuse it, so no new machine could install.
  refused(f.run(f.pr({ 'scripts/bootstrap.sh': `${bootFor('v1.1.3', v113)}ENGINE_TAG=v1.1.4\n` })), /scripts\/bootstrap\.sh at \w+: bootstrap\.sh needs exactly one ENGINE_TAG= line/);
  refused(move('latest', v113), /scripts\/bootstrap\.sh at \w+: line 2 is "ENGINE_TAG=latest", not exactly ENGINE_TAG=vX\.Y\.Z/);
  refused(move('"v1.1.3"', v113), /line 2 is "ENGINE_TAG="v1\.1\.3"", not exactly ENGINE_TAG=vX\.Y\.Z/);
  refused(f.run(f.pr({ 'scripts/bootstrap.sh': BOOT.replace('v0.0.0', 'v1.1.3') })), /scripts\/bootstrap\.sh at \w+: line 3 is "ENGINE_COMMIT= # NOT FILLED IN", not exactly ENGINE_COMMIT=<40 hex digits>/);
  // The PR removes bootstrap.sh.
  f.sh('git', ['checkout', '-q', '--detach', 'main']);
  f.sh('git', ['rm', '-q', 'scripts/bootstrap.sh']);
  f.sh('git', ['commit', '-q', '-m', 'pr']);
  refused(f.run(f.sh('git', ['rev-parse', 'HEAD'])), /this change removes scripts\/bootstrap\.sh/);
  // A signed tag whose commit carries no engine.
  f.sh('git', ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${f.owner}`, 'tag', '-s', 'v1.1.5', '-m', 'v1.1.5', 'main']);
  refused(move('v1.1.5', f.sh('git', ['rev-parse', 'v1.1.5^{commit}'])), /the engine this change pins, v1\.1\.5 .* carries no dist\/src\/config\/load\.js/);
  // A main whose own pin is malformed: a PR that moves it to a good release is still loaded with that release.
  f.onMain({ 'scripts/bootstrap.sh': `${BOOT}ENGINE_TAG=v1.0.0\n` });
  const v2 = f.release('v2.0.0', ['name'], f.owner);
  const ok = move('v2.0.0', v2);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /loads with the engine this change pins, v2\.0\.0/);
  f.done();
});

test('a pin line bash could read differently from the check fails closed; a base pin like that counts as moved', { skip }, () => {
  const f = fixture();
  const v1 = f.release('v1.0.0', ['name'], f.owner);
  f.pin('v1.0.0', v1);
  const boot = bootFor('v1.0.0', v1);
  const tagLine = 'ENGINE_TAG=v1.0.0\n';
  const commitLine = `ENGINE_COMMIT=${v1}\n`;
  // Each keeps the pin a lenient reader (readPin: trims, strips "#...", stops at \r or U+2028) sees as v1.0.0 at v1,
  // while bash reads another value, runs a command, or doesn't run at all.
  const cases: [string, string, RegExp][] = [
    ['a "#" mid-word (bash keeps it in the tag)', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0#evil\n'), /line 2 is "ENGINE_TAG=v1\.0\.0#evil", not exactly ENGINE_TAG=vX\.Y\.Z/],
    ['"#$(cmd)" (bash runs cmd)', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0#$(touch ran)\n'), /line 2 is "ENGINE_TAG=v1\.0\.0#\$\(touch ran\)", not exactly/],
    ['CRLF on the tag line', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0\r\n'), /line 2 is "ENGINE_TAG=v1\.0\.0\\u000d", not exactly/],
    ['CRLF on the commit line', boot.replace(commitLine, `ENGINE_COMMIT=${v1}\r\n`), /line 3 is "ENGINE_COMMIT=\w+\\u000d", not exactly ENGINE_COMMIT=<40 hex digits>/],
    ['a trailing NBSP', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0 \n'), /line 2 is "ENGINE_TAG=v1\.0\.0\\u00a0", not exactly/],
    ['a trailing NBSP on the commit', boot.replace(commitLine, `ENGINE_COMMIT=${v1} \n`), /line 3 is "ENGINE_COMMIT=\w+\\u00a0", not exactly/],
    ['a trailing BOM', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0﻿\n'), /line 2 is "ENGINE_TAG=v1\.0\.0\\ufeff", not exactly/],
    ['U+2028 and text', boot.replace(tagLine, 'ENGINE_TAG=v1.0.0 evil\n'), /line 2 is "ENGINE_TAG=v1\.0\.0\\u2028evil", not exactly/],
    ['a fullwidth digit', boot.replace(tagLine, 'ENGINE_TAG=v1.0.０\n'), /line 2 is "ENGINE_TAG=v1\.0\.\\uff10", not exactly/],
    ['"+=" at line start', `${boot}ENGINE_TAG+=-evil\n`, /line 4 is "ENGINE_TAG\+=-evil", not exactly/],
    ['no newline after the pin line', boot.replace(`${commitLine}`, `ENGINE_COMMIT=${v1}`), /line 3, "ENGINE_COMMIT=\w+", doesn't end in a newline/],
    // A Cyrillic "Е" for "E": an added line (bash: command not found), and one replacing the pin line's name.
    ['a lookalike name added', `${boot}ЕNGINE_TAG=v9.9.9\n`, /line 4 assigns "\\u0415NGINE_TAG", a name with a character outside ASCII/],
    ['a lookalike name in place of the pin', boot.replace(tagLine, 'ЕNGINE_TAG=v1.0.0\n'), /line 2 assigns "\\u0415NGINE_TAG", a name with a character outside ASCII/],
  ];
  // Every case is run before asserting, so a failure lists each one that wasn't refused.
  const missed = cases
    .map(([what, text, why]) => ({ what, why, r: f.run(f.pr({ 'scripts/bootstrap.sh': text })) }))
    .filter(({ why, r }) => r.code !== 1 || !/installed-engine-config: refused: scripts\/bootstrap\.sh at \w+: /.test(r.out) || !why.test(r.out))
    .map(({ what, r }) => `${what} (exit ${r.code}): ${r.out.trim().split('\n').pop()}`);
  assert.deepEqual(missed, [], `not refused as expected:\n${missed.join('\n')}`);
  assert.ok(!existsSync(join(f.repo, 'ran')), 'nothing in bootstrap.sh is run');
  // main's own pin line carries a trailing NBSP: a PR that writes it cleanly is a move, so it is loaded.
  f.onMain({ 'scripts/bootstrap.sh': boot.replace(tagLine, 'ENGINE_TAG=v1.0.0 \n') });
  const ok = f.run(f.pr({ 'scripts/bootstrap.sh': boot }));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /loads with the engine this change pins, v1\.0\.0/);
  f.done();
});

test("the workflow's step judges a moved pin with the base's copy of the check's script", { skip }, () => {
  const f = fixture();
  const steps = (parse(workflow()) as { jobs: Record<string, { steps: { run?: string }[] }> }).jobs['installed-engine-config']!.steps;
  const step = steps.find((s) => s.run?.includes('installed-engine-config.mjs'))!.run!;
  f.onMain({ ...checkScripts(), '.worklane/config.yaml': 'name: demo\nrequired_checks: [test]\n' });
  f.pin('v1.0.0', f.release('v1.0.0', ['name', 'required_checks'], f.owner));
  const v2 = f.release('v1.1.0', ['name'], f.owner);
  const r = f.runStep(f.pr({ 'scripts/bootstrap.sh': bootFor('v1.1.0', v2), 'scripts/ci/installed-engine-config.mjs': 'process.exit(0);\n' }), step);
  refused(r, /Unrecognized key: "required_checks"[\s\S]*refused by the engine this change pins, v1\.1\.0/);
  // Nor can it change how the pin is read.
  const lib = 'export const readPin = () => ({ tag: "v1.0.0", commit: "" });\nexport const writePin = () => "";\nexport const releaseProblem = () => null;\n';
  refused(f.runStep(f.pr({ 'scripts/bootstrap.sh': bootFor('v1.1.0', v2), 'scripts/lib/engine-pin.mjs': lib }), step), /refused by the engine this change pins, v1\.1\.0/);
  f.done();
});

test("the workflow's step runs the base's copy of the check's script: a PR that rewrites the script to pass is still refused", { skip }, () => {
  const f = fixture();
  const steps = (parse(workflow()) as { jobs: Record<string, { steps: { run?: string }[] }> }).jobs['installed-engine-config']!.steps;
  const step = steps.find((s) => s.run?.includes('installed-engine-config.mjs'))!.run!;
  f.onMain(checkScripts());
  f.pin('v1.0.0', f.release('v1.0.0', ['name'], f.owner));
  const bad = { '.worklane/config.yaml': 'name: demo\nrequired_check_sources: {}\n' };
  const r = f.runStep(f.pr({ ...bad, 'scripts/ci/installed-engine-config.mjs': 'process.exit(0);\n' }), step);
  refused(r, /Unrecognized key: "required_check_sources"[\s\S]*refused by the installed engine v1\.0\.0/);
  // A valid change passes through the same step.
  const ok = f.runStep(f.pr({ '.worklane/config.yaml': 'name: other\n' }), step);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /loads with the installed engine v1\.0\.0/);
  f.done();
});

test("the workflow runs the check on every pull request that changes .worklane/ or the engine pin, with the base's script and no skip", () => {
  const text = workflow();
  const wf = parse(text) as { on: Record<string, Record<string, unknown>>; permissions: Record<string, string>; jobs: Record<string, { if?: unknown; steps: { run?: string; if?: unknown }[] }> };
  assert.deepEqual(Object.keys(wf.on), ['pull_request']);
  assert.deepEqual(wf.on.pull_request!.paths, ['.worklane/**', 'scripts/bootstrap.sh'], 'every PR that changes .worklane/ or the file holding the engine pin, and only those');
  assert.deepEqual(wf.on.pull_request!.types, ['opened', 'synchronize', 'reopened'], 'each push to such a PR');
  assert.equal(wf.on.pull_request!['paths-ignore'], undefined);
  assert.deepEqual(wf.permissions, { contents: 'read' });
  const job = wf.jobs['installed-engine-config']!;
  assert.equal(job.if, undefined, 'no condition on the job');
  const steps = job.steps.filter((s) => s.run?.includes('installed-engine-config.mjs'));
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.if, undefined, 'no condition on the step');
  assert.match(steps[0]!.run!, /git archive HEAD\^1 scripts/, "the base's copy of the check");
  assert.match(steps[0]!.run!, /--base HEAD\^1 --head HEAD/);
  assert.doesNotMatch(text, /labels/, 'no label can skip it');
});
