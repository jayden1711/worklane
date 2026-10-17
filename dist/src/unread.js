const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
export function unreadFiles(changed, record) {
    if (!record)
        return [...changed];
    if (record.diffedAll)
        return [];
    const seen = new Set((record.read ?? []).map(norm));
    return changed.filter((f) => !seen.has(norm(f)));
}
//# sourceMappingURL=unread.js.map