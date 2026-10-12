import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { shimsNeedShell } from '../src/os/index.js';
import { repoRoot } from './helpers.js';

/** npm, as the user runs it (a .cmd shim on Windows). Scripts off: packing must not rebuild. */
const npm = (...args: string[]) => {
  const r = spawnSync('npm', [...args, '--ignore-scripts'], { cwd: repoRoot, encoding: 'utf8', shell: shimsNeedShell });
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
});
