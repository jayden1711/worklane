// A pinned npm MCP server, fetched by the throwaway user (plugins.sh mcp-fetch, systemd DynamicUser): exactly one
// version, its tarball's integrity the registry's own, its whole dependency tree locked and installed with no install
// script run, and no bin links (the tree hash refuses links). A package any of whose dependencies needs an install
// script is refused (Q7). Nothing here runs the package.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { lockResolvedProblem } from '../plugins/hosts.js';
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function npm(cwd, home, args, registry) {
    // Only root's registry: on the command line and in the environment, with no user, global or project config that
    // could name another (or a scoped registry for one of the package's scopes).
    return execFileSync('npm', [...args, '--registry', `https://${registry}/`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(home, 'cache'), NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_BIN_LINKS: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false', NPM_CONFIG_REGISTRY: `https://${registry}/` },
    });
}
/** The one command the package's bin names: its only bin, or the one named like the package. */
export function binOf(pkg, bin) {
    const base = pkg.split('/').pop();
    const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? (bin[base] ?? (Object.keys(bin).length === 1 ? Object.values(bin)[0] : undefined)) : undefined;
    if (typeof rel !== 'string')
        return null;
    const n = posix.normalize(rel.replace(/^\.\//, ''));
    return n.startsWith('..') || posix.isAbsolute(n) ? null : n;
}
export function fetchNpmServer(pkg, version, dest, registry = 'registry.npmjs.org') {
    if (!NPM_NAME.test(pkg))
        throw new Error(`${JSON.stringify(pkg)} is not an npm package name`);
    if (!NPM_VERSION.test(version))
        throw new Error('the version must be exact (1.2.3), never a range or a tag');
    if (existsSync(dest))
        throw new Error(`${dest} already exists`);
    const home = mkdtempSync(join(tmpdir(), 'npm-fetch-'));
    const refusals = [];
    try {
        const view = JSON.parse(npm(home, home, ['view', `${pkg}@${version}`, 'dist.integrity', 'bin', 'version', '--json'], registry));
        if (view.version !== version)
            throw new Error(`the registry has no ${pkg}@${version}`);
        const integrity = view['dist.integrity'];
        if (typeof integrity !== 'string' || !integrity.startsWith('sha512-'))
            throw new Error(`${pkg}@${version} has no sha512 integrity in the registry`);
        const bin = binOf(pkg, view.bin);
        if (!bin)
            refusals.push(`${pkg}@${version} names no single command to start (its package.json "bin")`);
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'pinned-mcp-server', private: true, dependencies: { [pkg]: version } }, null, 2) + '\n');
        npm(dest, home, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], registry);
        // Every package the lock names must come from that registry: no tarball URL, git dependency or link elsewhere.
        const resolvedBad = lockResolvedProblem(readFileSync(join(dest, 'package-lock.json'), 'utf8'), registry);
        if (resolvedBad)
            throw new Error(resolvedBad);
        npm(dest, home, ['ci', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'], registry);
        const lockText = readFileSync(join(dest, 'package-lock.json'), 'utf8');
        const lock = JSON.parse(lockText);
        const me = lock.packages?.[`node_modules/${pkg}`];
        if (!me || me.version !== version || me.integrity !== integrity)
            throw new Error(`the installed ${pkg} isn't ${version} with the registry's integrity`);
        for (const [p, e] of Object.entries(lock.packages ?? {}))
            if (e.hasInstallScript)
                refusals.push(`${p.replace(/^node_modules\//, '')} needs an install script (refused: Q7)`);
        rmSync(join(dest, 'node_modules', '.package-lock.json'), { force: true });
        return { package: pkg, version, integrity, lockfile: `sha256:${createHash('sha256').update(lockText).digest('hex')}`, argv: bin ? ['node', `node_modules/${pkg}/${bin}`] : ['node'], refusals };
    }
    finally {
        rmSync(home, { recursive: true, force: true });
    }
}
//# sourceMappingURL=npm.js.map