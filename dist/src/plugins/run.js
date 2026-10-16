// WHY: what one agent run loads. The approved plugins for the run's role (root's allowlist), minus any the instance's
// owner switched off, each passed with --plugin-dir from root's store only after its files hash to the approved value.
// The plugins root is moved to an empty directory root owns, so nothing in the agent user's own ~/.claude/plugins is
// ever read and `claude plugin install` has nowhere to write (probe P2, Claude Code 2.1.296 on Ubuntu). The session's
// init event is then checked against what was passed: anything else loaded ends the run.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { emptyPluginRoot, readAllowlist, storeDir } from './approval.js';
import { treeHash } from './tree.js';
/** The instance's own switch-off list (the dashboard's Disable; it can only remove what root approved). */
export const PLUGINS_OFF_FILE = 'plugins-off.yaml';
export class PluginRunError extends Error {
}
/** The ids the owner switched off. A file that can't be read or parsed switches every plugin off (it only tightens). */
export function pluginsOff(instanceHome) {
    const f = join(instanceHome, PLUGINS_OFF_FILE);
    if (!existsSync(f))
        return { off: new Set(), all: false, problem: null };
    try {
        const v = parseYaml(readFileSync(f, 'utf8'));
        const list = v && typeof v === 'object' && Array.isArray(v.off) ? v.off : null;
        if (!list || !list.every((x) => typeof x === 'string'))
            return { off: new Set(), all: true, problem: `${f}: expected "off: [<id>, ...]"; every plugin is off until it is fixed` };
        return { off: new Set(list), all: false, problem: null };
    }
    catch (e) {
        return { off: new Set(), all: true, problem: `${f}: ${e.message}; every plugin is off until it is fixed` };
    }
}
/**
 * The plugins one run of `role` loads. Throws PluginRunError (the run doesn't start) when the allowlist can't be
 * trusted (src/plugins/approval.ts readAllowlist) or an approved copy doesn't hash to its approved value.
 */
export function pluginsForRun(o) {
    let entries;
    try {
        entries = o.entries ?? readAllowlist(o.instance, o.allowlistOwnerUid === undefined ? {} : { ownerUid: o.allowlistOwnerUid }).entries;
    }
    catch (e) {
        throw new PluginRunError(`plugins: ${e.message}`);
    }
    const off = pluginsOff(o.instanceHome);
    const root = emptyPluginRoot(o.instance);
    const pluginRoot = existsSync(root) && statSync(root).isDirectory() ? root : null;
    const mine = off.all ? [] : entries.filter((e) => e.record.kind === 'plugin' && e.record.roles.includes(o.role) && !off.off.has(e.record.id));
    const dirs = [];
    for (const e of mine) {
        const dir = storeDir(o.instance, e.record.id, e.record.tree);
        let got;
        try {
            got = treeHash(dir);
        }
        catch (err) {
            throw new PluginRunError(`approved plugin ${e.record.id} can't be checked at ${dir}: ${err.message}`);
        }
        if (got !== e.record.tree)
            throw new PluginRunError(`approved plugin ${e.record.id} changed on disk at ${dir} (${got}, approved ${e.record.tree})`);
        dirs.push(dir);
    }
    return { dirs, ids: mine.map((e) => e.record.id), pluginRoot };
}
/**
 * Why a session's init event shows something loaded that the run didn't pass, or null. Claude Code's own built-in
 * plugins (path "builtin") are part of the CLI the machine already runs, and are allowed.
 */
export function loadedSetProblem(init, expected) {
    const want = new Set(expected.pluginDirs);
    const extra = (init.plugins ?? []).filter((p) => p.path !== 'builtin' && !want.has(p.path ?? ''));
    const loadedDirs = new Set((init.plugins ?? []).map((p) => p.path));
    const missing = expected.pluginDirs.filter((d) => !loadedDirs.has(d));
    const mcpWant = new Set(expected.mcpServers);
    const mcpExtra = (init.mcp_servers ?? []).filter((s) => !mcpWant.has(s.name ?? ''));
    const why = [
        ...extra.map((p) => `plugin ${p.source ?? p.name ?? '?'} from ${p.path ?? '?'}`),
        ...missing.map((d) => `approved plugin at ${d} did not load`),
        ...mcpExtra.map((s) => `MCP server ${s.name ?? '?'} (${s.source ?? '?'})`),
    ];
    return why.length ? `the session loaded what the run didn't pass: ${why.join('; ')}` : null;
}
//# sourceMappingURL=run.js.map