// `npx <pkg> init <repo>` (src/npx-engine.ts): run from npx's cache, local init installs the engine under the prefix
// from the package npx is running, then hands over to that install; anywhere else it carries on as it is. Against a
// stand-in npm here; the release workflow runs the real thing from the packed tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { initCommand, localInitFile } from '../src/init.js';
import { fromNpxCache, handOffFromNpx, type NpxRunner } from '../src/npx-engine.js';
import { npmGlobalPackageDir } from '../src/os/index.js';
import { exampleProject, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'npx-state-'));

/** A package as npx installs it: in its cache, under _npx/<hash>/node_modules. */
function npxPackage(version = '9.8.7'): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'npm-cache-')), '_npx', '0123abcd', 'node_modules', ...BRAND.pkg.split('/'));
  mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: BRAND.pkg, version }));
  return dir;
}

/** A stand-in npm: pack writes a tarball, install puts the package under the prefix (unless told to fail). */
function npm(o: { installFails?: boolean } = {}) {
  const calls: string[][] = [];
  const relaunched: { cli: string; args: string[] }[] = [];
  const r: NpxRunner = {
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'pack') {
        const dest = args[args.indexOf('--pack-destination') + 1]!;
        writeFileSync(join(dest, 'engine-9.8.7.tgz'), 'tgz');
        return { status: 0, stdout: JSON.stringify([{ filename: 'engine-9.8.7.tgz' }]), stderr: '' };
      }
      if (args[0] === 'install') {
        if (o.installFails) return { status: 1, stdout: '', stderr: 'npm error network unreachable\nmore' };
        const dest = npmGlobalPackageDir(args[args.indexOf('--prefix') + 1]!, BRAND.pkg);
        mkdirSync(join(dest, 'dist', 'src'), { recursive: true });
        writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: BRAND.pkg, version: '9.8.7' }));
        writeFileSync(join(dest, 'dist', 'src', 'cli.js'), '');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
    relaunch: async (cli, args) => {
      relaunched.push({ cli, args });
      return 0;
    },
  };
  return { r, calls, relaunched };
}

const args = (prefix: string, said: string[], over: { yes?: boolean; reset?: boolean; answers?: Record<string, string> } = {}) => ({ root: '/work/shop', prefix, yes: over.yes ?? true, reset: over.reset ?? false, ...(over.answers ? { answers: over.answers } : {}), say: (l: string) => said.push(l) });

test("npx's cache is told from an install of its own", () => {
  assert.equal(fromNpxCache('/home/you/.npm/_npx/0123abcd/node_modules/@scope/cli/'), true);
  assert.equal(fromNpxCache('C:\\Users\\you\\AppData\\Local\\npm-cache\\_npx\\0123abcd\\node_modules\\@scope\\cli'), true);
  assert.equal(fromNpxCache('/home/you/.local/lib/node_modules/@scope/cli/'), false);
  assert.equal(fromNpxCache('/home/you/src/engine/'), false);
});

test('not run from npx: no hand-off, nothing installed', async () => {
  const n = npm();
  const said: string[] = [];
  assert.equal(await handOffFromNpx(args(mkdtempSync(join(tmpdir(), 'prefix-')), said), '/home/you/.local/lib/node_modules/x/', n.r), null);
  assert.deepEqual(n.calls, []);
  assert.deepEqual(said, []);
});

test('from npx: this very package is packed and installed under the prefix, with no scripts, then init goes on from that install', async () => {
  const pkg = npxPackage();
  const prefix = mkdtempSync(join(tmpdir(), 'prefix-'));
  const n = npm();
  const said: string[] = [];
  assert.equal(await handOffFromNpx(args(prefix, said, { reset: true, answers: { test: 'npm test', 'land-mode': 'pr' } }), `${pkg}/`, n.r), 0);
  assert.equal(n.calls.length, 2);
  const [pack, install] = n.calls as [string[], string[]];
  assert.deepEqual(pack.slice(0, 3), ['npm', 'pack', pkg]);
  assert.ok(pack.includes('--ignore-scripts'));
  assert.deepEqual(install.slice(0, 6), ['npm', 'install', '-g', '--prefix', prefix, '--ignore-scripts']);
  assert.match(install.at(-1)!, /engine-9\.8\.7\.tgz$/);
  // The tarball's temp folder is gone.
  assert.equal(existsSync(install.at(-1)!), false);
  const cli = join(npmGlobalPackageDir(prefix, BRAND.pkg), 'dist', 'src', 'cli.js');
  assert.deepEqual(n.relaunched, [{ cli, args: ['init', '--mode', 'local', '--yes', '--reset', '--answer', 'test=npm test', '--answer', 'land-mode=pr', '/work/shop'] }]);
  assert.match(said.join('\n'), /running from npx's cache, which npm may clear: installing .* 9\.8\.7/);
  assert.match(said.join('\n'), /isn't on your PATH/);
});

test('from npx, with that version installed already: straight to it, nothing reinstalled', async () => {
  const pkg = npxPackage();
  const prefix = mkdtempSync(join(tmpdir(), 'prefix-'));
  const first = npm();
  await handOffFromNpx(args(prefix, []), pkg, first.r);
  const again = npm();
  const said: string[] = [];
  assert.equal(await handOffFromNpx(args(prefix, said, { yes: false }), pkg, again.r), 0);
  assert.deepEqual(again.calls, []);
  assert.deepEqual(again.relaunched[0]!.args, ['init', '--mode', 'local', '/work/shop']);
  assert.match(said[0]!, /9\.8\.7 is installed at .*: handing over to it/);
  // A newer npx version replaces it.
  const newer = npm();
  await handOffFromNpx(args(prefix, []), npxPackage('9.9.0'), newer.r);
  assert.equal(newer.calls.length, 2);
});

test("from npx, an install that fails stops init there, saying npm's reason; nothing is handed over", async () => {
  const n = npm({ installFails: true });
  const said: string[] = [];
  assert.equal(await handOffFromNpx(args(mkdtempSync(join(tmpdir(), 'prefix-')), said), npxPackage(), n.r), 1);
  assert.deepEqual(n.relaunched, []);
  assert.match(said.at(-1)!, /^init: couldn't install .* 9\.8\.7 under .*: npm error network unreachable$/);
});

test('init: local mode hands over before any step; server mode never does', async () => {
  const { dir } = exampleProject();
  const said: string[] = [];
  const io = { say: (l: string) => said.push(l) } as unknown as Parameters<typeof initCommand>[1];
  // Only git is asked before the hand-off.
  (io as { run: unknown }).run = (cmd: string, a: string[], o: { cwd?: string } = {}) => ({ status: cmd === 'git' ? (execFileSync('git', a, { cwd: o.cwd ?? dir }), 0) : 1, stdout: '', stderr: '' });
  let handed = 0;
  const handOff = async () => (handed++, 7);
  const base = { target: dir, instance: undefined, yes: true, reset: false, cwd: dir, prefix: '/nowhere', interactive: false };
  assert.equal(await initCommand({ ...base, mode: 'local' }, io, () => false, handOff), 7);
  assert.equal(handed, 1);
  assert.equal(existsSync(localInitFile(dir)), false, 'no step ran, nothing recorded');
  assert.deepEqual(said, []);
  assert.equal(await initCommand({ ...base, target: 'example-org/example-shop', mode: 'server' }, io, () => false, handOff), 2);
  assert.equal(handed, 1);
});

test('--help tells people they can run init through npx, now the package is on npm', () => {
  const r = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'cli.js'), '--help'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage:/);
  assert.ok(r.stdout.includes(`Run through npx (npx ${BRAND.pkg} init)`), "help doesn't name the npx way in");
  assert.equal(r.stdout.includes('bash scripts/bootstrap.sh <repo>'), false, 'help points a local install at a checkout instead of npm');
});
