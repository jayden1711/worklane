// Redact secret-shaped strings before anything is stored. Fast, pattern
// based; gitleaks still scans transcripts. False positives cost a few
// characters of a log line; a false negative leaks a key into the log.
const PATTERNS = [
    [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, 'gh*_[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]'],
    [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]'],
    [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA[REDACTED]'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'xox-[REDACTED]'],
    [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
    [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]'],
    // Credentials inside connection strings: keep scheme, user and host.
    [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@'],
    // 0x-prefixed 32-byte hex (EVM private keys and the like).
    [/\b0x[0-9a-fA-F]{64}\b/g, '0x[REDACTED-32-BYTES]'],
];
export function redactString(s) {
    let out = s;
    for (const [re, rep] of PATTERNS)
        out = out.replace(re, rep);
    return out;
}
export function redact(value) {
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value))
        return value.map((v) => redact(v));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
}
//# sourceMappingURL=redact.js.map