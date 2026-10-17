// WHY: tool poisoning and rug pulls (Invariant Labs, 2025-04-01; MCP spec, server/tools). What the model sees of an
// MCP server is its instructions and its tools' names, descriptions and schemas. Those are approved as one snapshot,
// and the broker serves the approved bytes, never the live list. It compares the live list with the approved snapshot
// whenever it connects to the server, and again on every list_changed. Any difference blocks the server.
import { createHash } from 'node:crypto';
import { canonicalJson } from '../plugins/approval.js';
const pick = (t) => ({
    name: String(t.name),
    ...(typeof t.title === 'string' ? { title: t.title } : {}),
    ...(typeof t.description === 'string' ? { description: t.description } : {}),
    inputSchema: t.inputSchema ?? null,
    ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    ...(t.annotations !== undefined ? { annotations: t.annotations } : {}),
});
/** A snapshot from an initialize result and the tools of every tools/list page. */
export function snapshotOf(init, tools) {
    const list = tools.filter((t) => !!t && typeof t === 'object' && typeof t.name === 'string').map(pick);
    return {
        serverName: typeof init?.serverInfo?.name === 'string' ? init.serverInfo.name : null,
        instructions: typeof init?.instructions === 'string' ? init.instructions : null,
        tools: list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
}
export const snapshotHash = (s) => `sha256:${createHash('sha256').update(canonicalJson(s), 'utf8').digest('hex')}`;
/** What changed between an approved snapshot and a live one, for the incident and the review page. */
export function diffSnapshots(approved, live) {
    const a = new Map(approved.tools.map((t) => [t.name, t]));
    const b = new Map(live.tools.map((t) => [t.name, t]));
    const changed = [];
    for (const [name, t] of a) {
        const u = b.get(name);
        if (!u)
            continue;
        const fields = ['title', 'description', 'inputSchema', 'outputSchema', 'annotations'].filter((k) => canonicalJson(t[k] ?? null) !== canonicalJson(u[k] ?? null));
        if (fields.length)
            changed.push({ name, fields });
    }
    return {
        added: [...b.keys()].filter((n) => !a.has(n)).sort(),
        removed: [...a.keys()].filter((n) => !b.has(n)).sort(),
        changed,
        instructions: approved.instructions !== live.instructions,
        serverName: approved.serverName !== live.serverName,
    };
}
// Text the model will read, checked for what the owner should look at twice. Flags, never edits (Q11).
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f­​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{e0000}-\u{e007f}]/u;
const TO_THE_MODEL = /\b(ignore (all |any )?(previous|prior|above)|before (using|calling) (this|any) tool|do not (tell|mention|inform|reveal)|don't (tell|mention)|<\s*important\s*>|system\s*:|you must (always|first)|secretly|without (telling|informing))\b/i;
const SENSITIVE_PATHS = /(~\/|\$HOME|\/home\/|\/root\/)|\.ssh|id_rsa|id_ed25519|\.env\b|credentials|\.aws|\.npmrc|\.netrc|mcp\.json|\.claude/i;
/** Why each part of a snapshot deserves a second look: one line per finding. */
export function snapshotFlags(s, otherTools = []) {
    const out = [];
    const check = (where, text) => {
        if (INVISIBLE.test(text))
            out.push(`${where}: has invisible or control characters`);
        if (TO_THE_MODEL.test(text))
            out.push(`${where}: addresses the model ("${TO_THE_MODEL.exec(text)[0]}")`);
        if (SENSITIVE_PATHS.test(text))
            out.push(`${where}: names a sensitive path ("${SENSITIVE_PATHS.exec(text)[0]}")`);
        if (/https?:\/\//i.test(text))
            out.push(`${where}: contains a URL`);
        if (/[A-Za-z0-9+/]{80,}={0,2}/.test(text))
            out.push(`${where}: contains a long encoded blob`);
        if (text.length > 2000)
            out.push(`${where}: is ${text.length} characters long`);
        for (const o of otherTools)
            if (o && new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text))
                out.push(`${where}: names another server's tool "${o}"`);
    };
    if (s.instructions)
        check('instructions', s.instructions);
    for (const t of s.tools) {
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(t.name))
            out.push(`tool ${JSON.stringify(t.name)}: name outside letters, digits, _ . -`);
        check(`tool ${t.name} description`, `${t.title ?? ''}\n${t.description ?? ''}`);
        check(`tool ${t.name} schema`, canonicalJson(t.inputSchema));
    }
    return out;
}
/** Make invisible characters visible as ⟨U+XXXX⟩, for showing a description exactly as approved, never hiding any. */
export function revealInvisible(text) {
    return text.replace(new RegExp(INVISIBLE.source, 'gu'), (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
}
//# sourceMappingURL=snapshot.js.map