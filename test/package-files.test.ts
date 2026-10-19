import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { shimsNeedShell } from '../src/os/index.js';
import { webUiBuilt } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

/** npm, as the user runs it (a .cmd shim on Windows). Scripts off: packing must not rebuild. */
const npm = (...args: string[]) => npmIn(repoRoot, ...args);
const npmIn = (cwd: string, ...args: string[]) => {
  const r = spawnSync('npm', [...args, '--ignore-scripts'], { cwd, encoding: 'utf8', shell: shimsNeedShell });
  assert.equal(r.status, 0, `npm ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Every file under `dir`, relative to the repo root, with forward slashes (npm's form). */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [relative(repoRoot, p).split(sep).join('/')];
  });
}

test('the package ships the example project the demo seeds from (every file of examples/basic)', () => {
  const packed = (JSON.parse(npm('pack', '--dry-run', '--json')) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
  const example = filesUnder(join(repoRoot, 'examples', 'basic'));
  assert.ok(example.includes(`examples/basic/${BRAND.configDir}/config.yaml`), 'its config folder too (a dot folder)');
  assert.deepEqual(example.filter((f) => !packed.includes(f)), [], 'missing from the package');
});

test('from an installed package, the demo finds its example project', { timeout: 120_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'pack-'));
  const tarball = (JSON.parse(npm('pack', '--json', '--pack-destination', out)) as { filename: string }[])[0]!.filename;
  const r = spawnSync('tar', ['-xzf', tarball], { cwd: out, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // Real paths: the temp folder can sit behind a symlink (macOS's /var), and the module's own URL is resolved.
  const pkg = realpathSync(join(out, 'package'));
  // Its dependencies, as an install would provide them (a junction needs no privilege on Windows).
  symlinkSync(join(repoRoot, 'node_modules'), join(pkg, 'node_modules'), 'junction');
  const { EXAMPLE_DIR } = (await import(pathToFileURL(join(pkg, 'dist', 'src', 'demo.js')).href)) as { EXAMPLE_DIR: string };
  assert.ok(existsSync(join(EXAMPLE_DIR, 'package.json')) && existsSync(join(EXAMPLE_DIR, 'src', 'price.js')), `the example is there: ${EXAMPLE_DIR}`);
  assert.ok(!relative(pkg, realpathSync(EXAMPLE_DIR)).startsWith('..'), `inside the installed package: ${EXAMPLE_DIR}`);
  rmSync(out, { recursive: true, force: true });
});

/** What `npm pack` would put in the tarball made in `dir`. */
const packedIn = (dir: string) => (JSON.parse(npmIn(dir, 'pack', '--dry-run', '--json')) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);

/**
 * Every path the engine reads relative to its own module (`new URL('../..', import.meta.url)` in src/), as a path in
 * the package: what an install from the tarball (npx) must hold, since there is no checkout of the engine to fall
 * back on. A directory ends in '/'. The package root itself (the engine's own directory) is left out.
 */
function selfRelativePaths(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
  for (const file of walk(join(repoRoot, 'src'))) {
    const from = posix.dirname(`dist/${relative(repoRoot, file).split(sep).join('/')}`);
    for (const m of readFileSync(file, 'utf8').matchAll(/new URL\(\s*['`]((?:\.\.\/)+[^'`]*)['`]\s*,\s*import\.meta\.url\s*\)/g)) {
      // A template literal: the part before its first placeholder, up to the last '/' (a directory).
      const ref = m[1]!.includes('${') ? m[1]!.slice(0, m[1]!.indexOf('${')).replace(/[^/]*$/, '') : m[1]!;
      const p = posix.normalize(posix.join(from, ref));
      if (p !== './' && p !== '.') out.add(p);
    }
  }
  return [...out].sort();
}

/** Paths that never belong in the package: the engine's tests and sources, build leftovers, project state, secrets. */
const forbidden = (p: string) =>
  /^dist\/test\//.test(p) ||
  /\.(map|d\.ts)$/.test(p) ||
  p.startsWith(`${BRAND.configDir}/`) ||
  /(^|\/)\.env(\.|$)/.test(p) ||
  /\.(pem|key|p12)$/.test(p) ||
  /(^|\/)(\.npmrc|credentials\.ya?ml)$/.test(p) ||
  /^(src|test|\.github|docs|desktop)\//.test(p);

/**
 * Every path the engine reads from its own package root, as the scan above finds them in src/ (kept here by hand, so
 * a new one is a reviewed change to this list: the installed-package test below checks each is in the package).
 */
const RUNTIME_PATHS = [
  'dist/src/cli.js',
  'dist/web/',
  'examples/basic',
  'package.json',
  'scripts/setup/app-permissions.mjs',
  'templates/evals/roles/',
  'templates/evals/tasks',
  'templates/project/',
];

test('the scan finds the paths the engine reads relative to itself', () => {
  const refs = selfRelativePaths();
  // If these go missing, the pattern stopped matching how src/ refers to them, and the tests below check nothing.
  for (const p of ['dist/web/', 'templates/project/', 'templates/evals/roles/', 'examples/basic', 'scripts/setup/app-permissions.mjs', 'package.json']) assert.ok(refs.includes(p), `found ${p} in ${refs.join(', ')}`);
  assert.deepEqual(refs, RUNTIME_PATHS, "src/ reads a path from the package root that RUNTIME_PATHS doesn't list (or no longer reads one it lists): update the list");
});

/**
 * The packed size's ceiling, in bytes (npm pack --dry-run --json: `size` is the tarball, `unpackedSize` its files),
 * measured with the dashboard UI built (dist/web, as CI and the release build it), each rounded up to the next 10,000:
 * at release prep, measured + 5%; a raise between releases, measured + about 2% (release prep resets it, and a
 * smaller margin keeps an accidental jump such as a sourcemap or a stray file visible). Raising it is allowed, on
 * purpose: in the PR that grows the package, with the new `npm pack --dry-run --json` numbers and why in its body.
 * Never to get a PR green without looking at what grew.
 */
// #727 (2026-10-19, the owner's practice: the new size + 2%, rounded up to 1,000): measured 1,918,697 / 5,990,181 on
// #803 (doctor's pin block, stacked on #788) with main d4b45039; the growth over #788 is check-pin-block.js (the PR
// body breaks it down).
const PACKAGE_BUDGET = { size: 1_958_000, unpackedSize: 6_110_000 };

/** Whether a pack's sizes fit the budget; the reasons when not, each saying how to raise it on purpose. */
function overBudget(p: { size: number; unpackedSize: number }, budget = PACKAGE_BUDGET): string[] {
  const how = 'if that growth is on purpose, raise PACKAGE_BUDGET in test/package-files.test.ts in the same PR and give the new numbers and why in its body; otherwise find what grew (npm pack --dry-run --json lists every file)';
  return (['size', 'unpackedSize'] as const).filter((k) => p[k] > budget[k]).map((k) => `the package's ${k === 'size' ? 'tarball' : 'unpacked size'} is ${p[k]} bytes, over its budget of ${budget[k]}: ${how}`);
}

test('the package stays within its size budget (npm pack --dry-run --json)', () => {
  const p = (JSON.parse(npm('pack', '--dry-run', '--json')) as { size: number; unpackedSize: number; files: { path: string }[] }[])[0]!;
  // CI builds the UI before the tests (with CI_REQUIRE_WEB=1 a missing one throws here): the budget counts it.
  if (webUiBuilt()) assert.ok(p.files.some((f) => f.path === 'dist/web/index.html'), 'measured with the dashboard UI in it');
  assert.deepEqual(overBudget(p), []);
  // The check itself: a budget below the current size fails, with the way to raise it.
  const under = overBudget(p, { size: p.size - 1, unpackedSize: p.unpackedSize - 1 });
  assert.equal(under.length, 2);
  assert.match(under[0]!, /raise PACKAGE_BUDGET in test\/package-files\.test\.ts/);
});

test('the packed tarball, installed into an empty folder (no install scripts), runs: --version, and each --help without running the command', { timeout: 300_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'pack-install-'));
  try {
    const tarball = join(out, (JSON.parse(npm('pack', '--json', '--pack-destination', out)) as { filename: string }[])[0]!.filename);
    const app = join(out, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'try', version: '1.0.0', private: true }));
    npmIn(app, 'install', '--no-audit', '--no-fund', '--prefer-offline', tarball);
    const pkgDir = join(app, 'node_modules', ...BRAND.pkg.split('/'));
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string; bin: Record<string, string> };
    const bin = join(pkgDir, pkg.bin[BRAND.cli]!);
    // From a folder that is no checkout and no git repo: nothing but the installed package to go on.
    const cwd = join(out, 'elsewhere');
    mkdirSync(cwd);
    const run = (...args: string[]) => {
      // A short timeout: a --help that runs its command (a dashboard serves until stopped) fails here, never hangs.
      const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 0, `${BRAND.cli} ${args.join(' ')}: ${r.error ?? ''} ${r.stderr}`);
      return r.stdout;
    };
    assert.equal(run('--version').trim(), JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version);
    for (const cmd of ['init', 'doctor', 'dashboard']) assert.match(run(cmd, '--help'), new RegExp(`^usage: ${BRAND.cli} ${cmd}( |$)`, 'm'), `${cmd} --help prints its usage`);
    // Every path the engine reads from its package root is in the installed package (dist/web when it was built).
    for (const p of RUNTIME_PATHS) {
      if (p === 'dist/web/' && !webUiBuilt()) continue;
      assert.ok(existsSync(join(pkgDir, p)), `${p} is in the installed package`);
    }
    assert.ok(!existsSync(join(pkgDir, 'dist', 'test')), 'no tests in the installed package');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("package.json's files: the package holds what an install needs and nothing it mustn't (stand-in files, no build)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-files-'));
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { bin: Record<string, string>; scripts?: unknown };
    delete pkg.scripts;
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    const put = (p: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), p.endsWith('.json') ? '{}' : 'x');
    };
    const needed = [
      ...Object.values(pkg.bin).map((b) => posix.normalize(b)),
      'dist/src/cli.js',
      'dist/src/setup/app-manifest.js',
      'dist/web/index.html',
      'dist/web/assets/index-0.js',
      'dist/web/assets/index-0.css',
      'scripts/setup/app-permissions.mjs',
      'templates/project/config.yaml',
      'templates/evals/roles/evaluator.md',
      'examples/basic/package.json',
      `examples/basic/${BRAND.configDir}/config.yaml`,
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.md',
      // Each path src/ reads relative to itself: that file, or one inside it for a directory.
      ...selfRelativePaths().filter((p) => p !== 'package.json').map((p) => (p.endsWith('/') ? `${p}index.html` : /\.[a-z]+$/.test(p) ? p : `${p}/package.json`)),
    ];
    const decoys = [
      'dist/test/cli.test.js',
      'dist/test/fixtures/key.pem',
      'dist/src/cli.js.map',
      'dist/src/cli.d.ts',
      `${BRAND.configDir}/config.yaml`,
      '.env',
      'dist/src/.env',
      'templates/project/.env.local',
      'dist/web/key.pem',
      '.npmrc',
      'src/cli.ts',
      'test/cli.test.ts',
      'docs/design.md',
      '.github/workflows/release.yml',
      'scripts/release.mjs',
      'scripts/setup/credentials.sh',
    ];
    for (const p of [...needed, ...decoys]) put(p);
    const packed = packedIn(dir);
    assert.deepEqual([...new Set(needed)].filter((p) => !packed.includes(p)), [], 'missing from the package');
    assert.deepEqual(packed.filter((p) => decoys.includes(p) || forbidden(p)), [], 'in the package, but must not be');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the package as packed now: its bin, every built file the engine reads, and no tests, project state or secrets', () => {
  const packed = packedIn(repoRoot);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { bin: Record<string, string>; engines: { node: string } };
  for (const b of Object.values(pkg.bin)) {
    assert.ok(packed.includes(posix.normalize(b)), `bin ${b} is packed`);
    assert.match(readFileSync(join(repoRoot, b), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/, `${b} runs as a command`);
  }
  assert.match(pkg.engines.node, /^>=22\.13$/);
  // What isn't built here isn't packed either (dist/web needs `npm run build:web`; the release workflow runs it first).
  for (const p of selfRelativePaths().filter((p) => existsSync(join(repoRoot, p)))) {
    assert.ok(packed.includes(p) || packed.some((f) => f.startsWith(p.endsWith('/') ? p : `${p}/`)), `${p} is packed`);
  }
  if (webUiBuilt()) assert.ok(packed.includes('dist/web/index.html'), 'the built dashboard is packed');
  assert.deepEqual(packed.filter(forbidden), [], 'in the package, but must not be');
});
