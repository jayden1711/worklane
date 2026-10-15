// #458: a rebuild of the signed v0.5.0 gave another dist/web/licenses.txt (a CRLF license, tslib's, written as is,
// while git stores the committed file with LF), and that rebuild was published. Here: scripts/web-licenses.mjs is
// byte-deterministic for a lockfile, a release commit of a build is reproduced by a rebuild, and
// scripts/verify-release-tree.mjs refuses a tarball that isn't the signed tree byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnv } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

const tree = (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'release-tree.mjs')).href)) as {
  treeDifferences(o: { dir: string; commit: string; prefixes: string[]; exact?: boolean; cwd?: string }): string[];
};
const skip = process.platform === 'win32' && 'release builds and packs run on macOS or Linux';

interface Pkg {
  path: string; // under node_modules, e.g. 'react' or 'lucide-react/node_modules/scheduler'
  name: string;
  version: string;
  deps?: Record<string, string>;
  peers?: Record<string, string>;
  optionalPeers?: string[];
  files?: Record<string, string>;
}
// The dashboard's roots, with what tripped #458 and the issue's other suspects: a CRLF license with a BOM (react),
// several license files (cmdk), a nested dependency of another version (lucide-react's scheduler), an optional peer
// that's installed but never bundled (@types/react).
const PKGS: Pkg[] = [
  { path: 'react', name: 'react', version: '19.0.0', files: { LICENSE: '﻿MIT License\r\n\r\nCopyright (c) Meta\r\n' } },
  { path: 'react-dom', name: 'react-dom', version: '19.0.0', deps: { scheduler: '^1' }, peers: { react: '^19' }, files: { LICENSE: 'MIT react-dom\n' } },
  { path: 'scheduler', name: 'scheduler', version: '1.0.0', files: { LICENSE: 'MIT scheduler one\n' } },
  { path: 'cmdk', name: 'cmdk', version: '1.0.0', peers: { react: '^19', '@types/react': '*' }, optionalPeers: ['@types/react'], files: { COPYING: 'not this one\n', 'LICENSE.md': 'nor this one\n', LICENSE: 'MIT cmdk\n' } },
  { path: '@types/react', name: '@types/react', version: '19.0.0', files: { LICENSE: 'MIT types\n' } },
  { path: '@radix-ui/react-dialog', name: '@radix-ui/react-dialog', version: '1.0.0', deps: { tslib: '^2' }, files: { 'LICENSE.txt': 'Copyright (c) Microsoft Corporation.\r\n\r\nPermission to use...\r\n' } },
  { path: 'tslib', name: 'tslib', version: '2.0.0', files: { 'LICENSE.txt': '0BSD\r\nline two\r\n' } },
  { path: 'lucide-react', name: 'lucide-react', version: '1.0.0', deps: { scheduler: '^2' }, files: { LICENSE: 'ISC lucide\n' } },
  { path: 'lucide-react/node_modules/scheduler', name: 'scheduler', version: '2.0.0', files: { LICENSE: 'MIT scheduler two\n' } },
];
const nm = (p: string) => `node_modules/${p}`;

/** A checkout's stand-in: package-lock.json, node_modules written in `order`, and the real script under scripts/. */
function checkout(order: 'forward' | 'reverse') {
  const root = mkdtempSync(join(tmpdir(), 'web-licenses-'));
  const lock: Record<string, unknown> = { '': { name: 'fixture' } };
  for (const p of order === 'forward' ? PKGS : [...PKGS].reverse()) {
    const dir = join(root, nm(p.path));
    mkdirSync(dir, { recursive: true });
    const peerMeta = Object.fromEntries((p.optionalPeers ?? []).map((n) => [n, { optional: true }]));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: p.name, version: p.version, license: 'MIT', dependencies: p.deps, peerDependencies: p.peers, peerDependenciesMeta: peerMeta }));
    const files = Object.entries(p.files ?? {});
    for (const [f, text] of order === 'forward' ? files : files.reverse()) writeFileSync(join(dir, f), text);
    lock[nm(p.path)] = { version: p.version };
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: lock }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist', 'web'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'web-licenses.mjs'), join(root, 'scripts', 'web-licenses.mjs'));
  return root;
}
const build = (root: string) => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'web-licenses.mjs')], { cwd: root, encoding: 'utf8', env: childEnv() });
  return { ...r, out: r.status === 0 ? readFileSync(join(root, 'dist', 'web', 'licenses.txt')) : null };
};

test('regression (#458): licenses.txt is the same bytes from differently-ordered installs, LF only, with the nested dependency and a fixed license file', { skip }, () => {
  const a = build(checkout('forward'));
  const b = build(checkout('reverse'));
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(a.out!.equals(b.out!), 'byte-identical');
  const text = a.out!.toString('utf8');
  assert.ok(!text.includes('\r'), 'no CR: git stores this file with LF (tslib\'s CRLF license made v0.5.0 differ)');
  assert.ok(!text.includes('﻿'), 'no BOM');
  assert.match(text, /^-{72}\nMIT License\n\nCopyright \(c\) Meta\n$/m);
  // LICENSE wins over LICENSE.md and COPYING, whatever the directory order.
  assert.match(text, /^cmdk@1\.0\.0 \(MIT\)\n-{72}\nMIT cmdk\n/m);
  // Both schedulers: the nested one lucide-react bundles, and react-dom's top-level one.
  assert.match(text, /^scheduler@1\.0\.0 \(MIT\)\n-{72}\nMIT scheduler one\n/m);
  assert.match(text, /^scheduler@2\.0\.0 \(MIT\)\n-{72}\nMIT scheduler two\n/m);
  // An optional peer is types only, never bundled: not listed, so a production-only install gives the same file.
  assert.doesNotMatch(text, /@types\/react/);
  const names = [...text.matchAll(/^(\S+@\d\S*) \(/gm)].map((m) => m[1]);
  assert.deepEqual(names, ['@radix-ui/react-dialog@1.0.0', 'cmdk@1.0.0', 'lucide-react@1.0.0', 'react@19.0.0', 'react-dom@19.0.0', 'scheduler@1.0.0', 'scheduler@2.0.0', 'tslib@2.0.0']);
  assert.match(text, /^Third-party software bundled in this dashboard \(8 packages\)\.\n/);
});

test('licenses.txt: an install that isn\'t the lockfile, or a missing dependency, fails the build instead of writing another file', { skip }, () => {
  const off = checkout('forward');
  const lock = JSON.parse(readFileSync(join(off, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/tslib'].version = '2.0.1';
  writeFileSync(join(off, 'package-lock.json'), JSON.stringify(lock));
  const r = build(off);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /node_modules\/tslib is 2\.0\.0, package-lock\.json says 2\.0\.1: run npm ci/);
  const gone = checkout('forward');
  execFileSync('rm', ['-rf', join(gone, 'node_modules', 'tslib')]);
  const g = build(gone);
  assert.notEqual(g.status, 0);
  assert.match(g.stderr, /tslib \(needed by node_modules\/@radix-ui\/react-dialog\) isn't installed: run npm ci/);
});

/** A git repo with the engine's own .gitattributes, as release.mjs makes a release commit. */
function gitRepo(dir: string) {
  const env = { ...childEnv(), GIT_CONFIG_GLOBAL: join(dir, '.no-global'), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  copyFileSync(join(repoRoot, '.gitattributes'), join(dir, '.gitattributes'));
  writeFileSync(join(dir, '.gitignore'), 'dist/\nnode_modules/\n.no-global\n');
  return git;
}

test('regression (#458): the engine\'s .gitattributes stores build output byte for byte (no line-ending conversion in a release commit)', () => {
  for (const p of ['dist/web/licenses.txt', 'dist/src/cli.js']) {
    assert.equal(execFileSync('git', ['check-attr', 'text', '--', p], { cwd: repoRoot, encoding: 'utf8' }).trim(), `${p}: text: unset`);
  }
});

test('regression (#458): a release commit of the build is the built bytes, and a fresh checkout of it plus a rebuild reproduces it', { skip }, () => {
  const root = checkout('forward');
  const git = gitRepo(root);
  assert.equal(build(root).status, 0);
  git('add', '.gitattributes', '.gitignore', 'package-lock.json', 'scripts/web-licenses.mjs');
  git('add', '-f', 'dist/web');
  git('commit', '-q', '-m', 'Release (with built dist/)');
  assert.deepEqual(tree.treeDifferences({ dir: root, commit: 'HEAD', prefixes: ['dist/web'], cwd: root }), [], 'committed = built');
  // The owner's path: a clean checkout of the tag, the same install, a rebuild.
  const clone = mkdtempSync(join(tmpdir(), 'web-licenses-clone-'));
  execFileSync('git', ['clone', '-q', root, join(clone, 'r')], { env: { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(clone, '.no-global') } });
  const again = join(clone, 'r');
  execFileSync('cp', ['-R', join(root, 'node_modules'), join(again, 'node_modules')]);
  assert.equal(build(again).status, 0);
  assert.deepEqual(tree.treeDifferences({ dir: again, commit: 'HEAD', prefixes: ['dist/web'], cwd: again }), [], 'rebuilt = signed');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'dist'], { cwd: again, encoding: 'utf8' }), '');
});

/** A committed tree, and a tarball packed npm's way (package/...) from files given here. */
function tarball(files: Record<string, string>) {
  const stage = mkdtempSync(join(tmpdir(), 'release-tree-pack-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, 'package', p)), { recursive: true });
    writeFileSync(join(stage, 'package', p), body);
  }
  const tgz = join(stage, 'x-1.0.0.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'package']);
  return tgz;
}

test('verify-release-tree: the tarball must be the signed commit byte for byte: same passes; changed, extra or line-ending-converted files are refused, listed', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-tree-'));
  const git = gitRepo(dir);
  const signed = { 'package.json': '{"name":"x","version":"1.0.0"}\n', 'dist/web/licenses.txt': 'MIT\nline two\n', 'dist/src/cli.js': 'console.log(1);\n', 'dist/src/cli.d.ts': 'export {};\n' };
  for (const [p, body] of Object.entries(signed)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  git('add', '.gitattributes', '.gitignore', 'package.json');
  git('add', '-f', 'dist');
  git('commit', '-q', '-m', 'release');
  const sha = git('rev-parse', 'HEAD');
  const verify = (tgz: string) => spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-tree.mjs'), tgz, '--commit', sha], { cwd: dir, encoding: 'utf8', env: childEnv() });
  // The same files, less the .d.ts the package leaves out: passes.
  const shipped = Object.fromEntries(Object.entries(signed).filter(([p]) => !p.endsWith('.d.ts')));
  const ok = verify(tarball(shipped));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`^same as the signed tree: 3 files at ${sha}$`, 'm'));
  // v0.5.0's case: licenses.txt rebuilt with CRLF. Raw bytes are compared: no line-ending normalisation.
  const crlf = verify(tarball({ ...shipped, 'dist/web/licenses.txt': 'MIT\r\nline two\r\n' }));
  assert.equal(crlf.status, 1);
  assert.match(crlf.stderr, /^verify-release-tree: refused: the tarball is not the signed tree at [0-9a-f]{40} \(1 file\(s\)\); nothing may be staged:\n {2}differs from the signed tree: dist\/web\/licenses\.txt\n$/);
  const extra = verify(tarball({ ...shipped, 'dist/src/cli.js': 'console.log(2);\n', 'dist/web/new.js': 'x\n' }));
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /differs from the signed tree: dist\/src\/cli\.js\n {2}not in the signed tree: dist\/web\/new\.js\n$/);
  const nothing = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'verify-release-tree.mjs'), join(dir, 'missing.tgz'), '--commit', sha], { cwd: dir, encoding: 'utf8', env: childEnv() });
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /usage: verify-release-tree\.mjs <package\.tgz> --commit <sha>/);
});
