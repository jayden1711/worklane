// Redact secret-shaped strings before anything is stored. Fast, pattern
// based; gitleaks still scans transcripts. False positives cost a few
// characters of a log line; a false negative leaks a key into the log.
// Each pattern with what kind of secret it finds (secretKinds names the kind, never the value).
const PATTERNS: [RegExp, string, string][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, 'gh*_[REDACTED]', 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]', 'GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]', 'API key (sk-)'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA[REDACTED]', 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'xox-[REDACTED]', 'Slack token'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]', 'Slack webhook'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]', 'private key'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]', 'bearer token'],
  // Credentials inside connection strings: keep scheme, user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@', 'password in a URL'],
  // 0x-prefixed 32-byte hex (EVM private keys and the like).
  [/\b0x[0-9a-fA-F]{64}\b/g, '0x[REDACTED-32-BYTES]', '32-byte hex key'],
];

/** The kinds of secret `s` looks like it holds (sorted, each once): names only, never a matched value. */
export function secretKinds(s: string): string[] {
  const kinds = new Set<string>();
  for (const [re, , kind] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(s)) kinds.add(kind);
    re.lastIndex = 0;
  }
  return [...kinds].sort();
}

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)])) as T;
  return value;
}
