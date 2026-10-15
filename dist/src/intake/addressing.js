// Whether a message is addressed to the bot, and what it says once the address is
// removed. In a group or channel, only addressed messages count; the rest are
// dropped on receipt and never stored.
/** The message's text without the prefix or mention that addressed it, or null when it isn't addressed. */
export function addressed(text, prefixes, mentions = []) {
    const t = text.trimStart();
    for (const m of mentions) {
        if (t.startsWith(m))
            return t.slice(m.length).replace(/^[\s:,-]+/, '').trim() || null;
    }
    const lower = t.toLowerCase();
    for (const p of prefixes) {
        if (lower.startsWith(p.toLowerCase()))
            return t.slice(p.length).trim() || null;
    }
    return null;
}
//# sourceMappingURL=addressing.js.map