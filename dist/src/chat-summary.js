// The chat's running summary: the only memory a chat turn gets of the conversation so far. Fixed headings,
// returned updated by each turn, capped and redacted, kept per instance in its private state (0600). A turn
// gets a fresh context bundle plus this summary, never the transcript; facts about the instance's current
// state come from the bundle (and are cited from it), never from the summary. There is no recall store.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactString } from './events/redact.js';
import { groupOnlyDir, writeOwnerOnly } from './os/index.js';
import { SUMMARY_HEADINGS } from './roles.js';
export { SUMMARY_HEADINGS };
/** Each section's cap, and the whole summary's. */
export const SECTION_CHARS = 600;
export const SUMMARY_CHARS = 3000;
export const CHAT_SUMMARY_FILE = join('chat', 'summary.json');
export const EMPTY_SUMMARY = Object.fromEntries(SUMMARY_HEADINGS.map(([k]) => [k, '']));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 2).trimEnd()} …` : s);
/**
 * The summary a turn returned, made safe to keep: every heading present (a missing or non-text one keeps the
 * previous turn's text), each section redacted and capped, and the whole under SUMMARY_CHARS (the longest
 * sections are cut first).
 */
export function acceptSummary(raw, previous = EMPTY_SUMMARY) {
    const r = (raw ?? {});
    const out = {};
    for (const [k] of SUMMARY_HEADINGS) {
        const v = typeof r[k] === 'string' ? r[k] : previous[k];
        out[k] = clip(redactString(v.trim().replace(/\n{3,}/g, '\n\n')), SECTION_CHARS);
    }
    // Over the whole cap: cut the longest section, then the next, never below a short floor each.
    const FLOOR = 40;
    let total = Object.values(out).reduce((n, v) => n + v.length, 0);
    while (total > SUMMARY_CHARS) {
        const [k, v] = Object.entries(out).sort((a, b) => b[1].length - a[1].length)[0];
        if (v.length <= FLOOR)
            break;
        out[k] = clip(v, Math.max(FLOOR, v.length - (total - SUMMARY_CHARS)));
        total = Object.values(out).reduce((n, x) => n + x.length, 0);
    }
    return out;
}
/** The summary as the prompt shows it: every heading, in order, "(none yet)" for an empty one. */
export function renderSummary(s) {
    return SUMMARY_HEADINGS.map(([k, h]) => `### ${h}\n${s[k] || '(none yet)'}`).join('\n\n');
}
export function readSummary(stateDir) {
    const f = join(stateDir, CHAT_SUMMARY_FILE);
    if (!existsSync(f))
        return { ...EMPTY_SUMMARY };
    try {
        return acceptSummary(JSON.parse(readFileSync(f, 'utf8')));
    }
    catch {
        return { ...EMPTY_SUMMARY };
    }
}
export function writeSummary(stateDir, s) {
    groupOnlyDir(join(stateDir, 'chat'));
    writeOwnerOnly(join(stateDir, CHAT_SUMMARY_FILE), JSON.stringify(s, null, 2));
}
//# sourceMappingURL=chat-summary.js.map