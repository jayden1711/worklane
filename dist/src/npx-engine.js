// `npx <pkg> init <repo>`: npx runs the engine from its cache (~/.npm/_npx/<hash>/...), which npm may clear at any
// time. Local mode writes that engine's path into the repo's hooks and, later, into the coordinator's service, so
// a cached copy won't do: like scripts/bootstrap.sh, init installs the engine under the prefix (~/.local; no root,
// no build, no install scripts) from the very package npx is running, then hands the walk over to that install.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { npmGlobalPackageDir, shimsNeedShell } from './os/index.js';
/** This engine's package directory (dist/src/ is two levels down). */
export const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url));
/** Is this package directory npx's cache (npm exec's own install), not an install of its own? */
export const fromNpxCache = (dir) => dir.split(/[\\/]/).includes('_npx');
export const systemRunner = {
    run: (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, shell: shimsNeedShell });
        return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
    },
    relaunch: (cli, args) => new Promise((done) => {
        const p = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
        p.on('exit', (code) => done(code ?? 1));
        p.on('error', () => done(1));
    }),
};
const firstLine = (s) => s.trim().split('\n')[0] ?? '';
export async function handOffFromNpx(a, engineDir = ENGINE_DIR, r = systemRunner) {
    if (!fromNpxCache(engineDir))
        return null;
    const { name, version } = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8'));
    const dest = npmGlobalPackageDir(a.prefix, name);
    const cli = join(dest, 'dist', 'src', 'cli.js');
    let have = null;
    try {
        have = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version;
    }
    catch {
        // not installed
    }
    if (have === version && existsSync(cli)) {
        a.say(`${BRAND.cli} ${version} is installed at ${dest}: handing over to it`);
    }
    else {
        a.say(`running from npx's cache, which npm may clear: installing ${name} ${version} at ${dest} (what the hooks and the service call), then handing over to it`);
        const work = mkdtempSync(join(tmpdir(), `${BRAND.cli}-engine-`));
        try {
            // This very package, packed (no scripts: dist/ is built), then installed from that tarball.
            const p = r.run('npm', ['pack', engineDir.endsWith(sep) ? engineDir.slice(0, -1) : engineDir, '--ignore-scripts', '--json', '--pack-destination', work]);
            let tarball = '';
            try {
                tarball = join(work, JSON.parse(p.stdout)[0].filename);
            }
            catch {
                // reported below
            }
            if (p.status !== 0 || !existsSync(tarball)) {
                a.say(`init: couldn't pack ${engineDir}: ${firstLine(p.stderr) || 'npm pack gave no tarball'}`);
                return 1;
            }
            const i = r.run('npm', ['install', '-g', '--prefix', a.prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
            if (i.status !== 0 || !existsSync(cli)) {
                a.say(`init: couldn't install ${name} ${version} under ${a.prefix}: ${firstLine(i.stderr) || `no ${cli} after npm install`}`);
                return 1;
            }
        }
        finally {
            rmSync(work, { recursive: true, force: true });
        }
        a.say(`   installed ${name} ${version} at ${dest}`);
    }
    const bin = join(a.prefix, 'bin');
    if (!(process.env.PATH ?? '').split(delimiter).includes(bin))
        a.say(`   note: ${bin} isn't on your PATH: add it in your shell profile (export PATH="${bin}:$PATH") to run \`${BRAND.cli}\` from now on`);
    return r.relaunch(cli, ['init', '--mode', 'local', ...(a.yes ? ['--yes'] : []), ...(a.reset ? ['--reset'] : []), ...Object.entries(a.answers ?? {}).flatMap(([id, choice]) => ['--answer', `${id}=${choice}`]), a.root]);
}
//# sourceMappingURL=npx-engine.js.map