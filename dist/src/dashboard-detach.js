// WHY: the one-command install (scripts/bootstrap.sh) ends with one wizard URL, the same on every run, and a rerun
// changes nothing: the dashboard starts in the background only when it isn't answering already.
// INVARIANT: the URL never carries the dashboard's key; it stays in its 0600 file and the page asks for it once.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BRAND } from './brand.js';
import { readRegularFile } from './os/index.js';
/** WHY: one fixed URL per port, so a rerun prints exactly the same one. */
export const wizardUrl = (port) => `http://127.0.0.1:${port}/first-run`;
/** INVARIANT: the key goes in a header, never the URL; only a 200 with this checkout's key is 'ours'. */
export async function probeDashboard(port, tokenFile, timeoutMs = 2_000) {
    const key = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/role`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(timeoutMs) });
        await r.body?.cancel();
        return r.ok && key ? 'ours' : 'other';
    }
    catch {
        return 'none';
    }
}
export class DetachError extends Error {
}
/** WHY: its own session, so the dashboard outlives the install command that started it. */
export function startDetached(command, logFile) {
    const fd = openSync(logFile, 'a', 0o600);
    try {
        const child = spawn(command[0], command.slice(1), { detached: true, stdio: ['ignore', fd, fd] });
        let code = null;
        child.on('exit', (c) => (code = c ?? 1));
        child.on('error', () => (code = 127));
        child.unref();
        return { pid: child.pid ?? null, exited: () => code };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * The port a dashboard started with `--port 0` listens on, as it wrote it: a regular file of this user's, written by
 * nobody else (the probe sends the key to that port), holding one port number; else null.
 */
export function readDashboardPort(file) {
    const r = readRegularFile(file, 16);
    let text;
    if (r.kind === 'file') {
        if (typeof process.getuid === 'function' && r.uid !== process.getuid())
            return null;
        if ((parseInt(r.mode, 8) & 0o022) !== 0)
            return null;
        text = r.text;
    }
    else if (r.kind === 'unsupported') {
        try {
            text = readFileSync(file, 'utf8');
        }
        catch {
            return null;
        }
    }
    else
        return null;
    const t = text.trim();
    return /^[1-9][0-9]{0,4}$/.test(t) && Number(t) <= 65_535 ? Number(t) : null;
}
/** Where a dashboard started with `--port-file` says which port it got: 0600, replaced in one rename. */
export function writeDashboardPort(file, port) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${port}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}
/**
 * `--port 0`: any port, the dashboard's own choice. WHY: a port picked free here and handed to the dashboard can be
 * taken by another program before the dashboard listens on it (#312, #436's follow-up); the dashboard listens on
 * port 0 instead and writes the port it got to `portFile`. A rerun finds it there and, when it answers with this
 * checkout's key, prints the same URL and starts nothing.
 */
async function detachAnyPort(o, probe, sleep, waitMs) {
    const known = readDashboardPort(o.portFile);
    if (known !== null && (await probe(known, o.tokenFile)) === 'ours')
        return { url: wizardUrl(known), started: false };
    // Whatever it named is gone or someone else's now: never probed again.
    rmSync(o.portFile, { force: true });
    mkdirSync(dirname(o.logFile), { recursive: true });
    const child = (o.start ?? startDetached)(o.command, o.logFile);
    for (let waited = 0; waited < waitMs; waited += 250) {
        await sleep(250);
        const port = readDashboardPort(o.portFile);
        if (port !== null && (await probe(port, o.tokenFile)) === 'ours')
            return { url: wizardUrl(port), started: true, pid: child.pid };
        const code = child.exited();
        if (code !== null)
            throw new DetachError(`the dashboard stopped (exit ${code}) before it answered: see ${o.logFile}`);
    }
    throw new DetachError(`the dashboard didn't answer within ${Math.round(waitMs / 1000)} s: see ${o.logFile}`);
}
export async function detachDashboard(o) {
    const probe = o.probe ?? probeDashboard;
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const waitMs = o.waitMs ?? 30_000;
    if (o.port === 0) {
        if (!o.portFile)
            throw new DetachError('--port 0 needs a file for the dashboard to name its port in');
        return detachAnyPort({ ...o, portFile: o.portFile }, probe, sleep, waitMs);
    }
    const url = wizardUrl(o.port);
    const now = await probe(o.port, o.tokenFile);
    if (now === 'ours')
        return { url, started: false };
    if (now === 'other')
        throw new DetachError(`port ${o.port} answers, but not as this checkout's dashboard (another project's, or another program): stop it, or give --port`);
    mkdirSync(dirname(o.logFile), { recursive: true });
    const child = (o.start ?? startDetached)(o.command, o.logFile);
    for (let waited = 0; waited < waitMs; waited += 250) {
        await sleep(250);
        if ((await probe(o.port, o.tokenFile)) === 'ours')
            return { url, started: true, pid: child.pid };
        const code = child.exited();
        if (code !== null)
            throw new DetachError(`the dashboard stopped (exit ${code}) before it answered: see ${o.logFile}`);
    }
    throw new DetachError(`the dashboard didn't answer on port ${o.port} within ${Math.round(waitMs / 1000)} s: see ${o.logFile}`);
}
/** INVARIANT: the URL is the last line and the only one; the key's path is printed, never the key. */
export function detachedLines(d, o) {
    return [
        `${BRAND.name} dashboard for ${o.root}: ${d.started ? `started in the background (pid ${d.pid ?? '?'}; its log: ${o.logFile})` : 'already running; nothing changed'}`,
        `  the page asks once for the dashboard key: it is in ${o.tokenFile} (only you can read it)`,
        d.url,
    ];
}
//# sourceMappingURL=dashboard-detach.js.map