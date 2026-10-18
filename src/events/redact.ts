// Redact secret-shaped strings before anything is stored. Fast, pattern
// based; gitleaks still scans transcripts. False positives cost a few
// characters of a log line; a false negative leaks a key into the log.
// This is the one shared redactor: a feature that needs more redaction adds a pattern here, never its own redactor.
// Each pattern with what kind of secret it finds (secretKinds names the kind, never the value).
const PATTERNS: [RegExp, string, string][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, 'gh*_[REDACTED]', 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]', 'GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]', 'API key (sk-)'],
  // Stripe secret and restricted keys, live and test.
  [/\b([sr]k)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '$1_[REDACTED]', 'Stripe key'],
  // Google API keys: AIza and 35 more characters.
  [/\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, 'AIza[REDACTED]', 'Google API key'],
  // JSON Web Tokens: a base64url JSON header (so `eyJ`), a payload and a signature (empty when unsigned).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]', 'JWT'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AKIA[REDACTED]', 'AWS access key'],
  // Slack's token-rotation and refresh tokens (xoxe-..., xoxe.xoxb-...), before the
  // other Slack tokens (one is inside it); then its app-level token (xapp-, Socket Mode).
  [/\bxoxe[.-][A-Za-z0-9.-]{10,}\b/g, 'xoxe-[REDACTED]', 'Slack token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, 'xox-[REDACTED]', 'Slack token'],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, 'xapp-[REDACTED]', 'Slack app-level token'],
  // Linear personal API keys and OAuth tokens.
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g, 'lin_[REDACTED]', 'Linear key'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]', 'Slack webhook'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]', 'private key'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]', 'bearer token'],
  // Credentials inside connection strings: keep scheme, user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@', 'password in a URL'],
  // 0x-prefixed 32-byte hex (EVM private keys and the like).
  [/\b0x[0-9a-fA-F]{64}\b/g, '0x[REDACTED-32-BYTES]', '32-byte hex key'],
  // A JSON string value under a credential-named key ("jwt", "key", "token", "api_key", "client_secret", "password",
  // ...), also inside an escaped JSON string (\"token\":\"...\"). The value must look like a credential (16 or more
  // token characters with a letter and a digit), so {"key": "ready"} and {"key": "ctrl+shift+1"} stay.
  [
    /(\\?")([A-Za-z0-9_-]*(?:jwt|token|secret|password|passwd|key|auth|authorization|credentials?))\1(\s*:\s*)\1(?=[A-Za-z0-9_\-.+/=~]*\d)(?=[A-Za-z0-9_\-.+/=~]*[A-Za-z])[A-Za-z0-9_\-.+/=~]{16,}\1/gi,
    '$1$2$1$3$1[REDACTED]$1',
    'secret under a JSON key',
  ],
];

type Replacement = string | ((match: string, ...groups: string[]) => string);

/** A path's trailing full stop, colon or the like belongs to the sentence, not the path. */
const path = (_m: string, pre: string, p: string) => `${pre}[path]${/[.:,;!?]*$/.exec(p)![0]}`;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const PRIVATE_V4 = [
  `10\\.${OCTET}`,
  '172\\.(?:1[6-9]|2\\d|3[01])',
  '192\\.168',
  // The shared range (RFC 6598): carrier NAT and tailnets.
  '100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])',
  // Link-local, cloud metadata among it.
  '169\\.254',
].join('|');

/**
 * What names a person or the inside of a network rather than a secret: emails, internal hostnames, private IPs and
 * absolute paths under the roots that hold a user name or a machine's layout. Redacted only when asked for
 * (`identifiers: true`, TRACKER below), because the event log, run records and the secret checks
 * (`redactString(s) !== s`) keep them; the backlog asks for it on everything it writes to an issue, a comment or a
 * pull request. No lookbehind: the web bundle imports this module (web/src/voice/talk.ts), so a prefix group stands in.
 */
const IDENTIFIERS: [RegExp, Replacement][] = [
  // Emails, except git@host (an SSH remote names no one).
  [/\b(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[email]'],
  // Absolute paths under a home, temp or system root, up to the next space, quote or bracket.
  [/(^|[^\w.~/:-])(\/(?:home|Users|root|tmp|var|etc|opt|srv|mnt|media|private|Volumes|workspaces|run)\/[^\s"'`<>()[\]{},;|]+)/gm, path],
  [/(^|[^\w])([A-Za-z]:\\[^\\\s"'`<>|]+(?:\\[^\\\s"'`<>|]*)+)/gm, path],
  // Hostnames under the private-use suffixes. A lone plain word before .local (this.local) is code, not a host.
  [
    /\b((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+)(internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local)\b(?![.-]?[A-Za-z0-9])/gi,
    (m, labels, suffix) => (suffix!.toLowerCase() === 'local' && /^[A-Za-z]+\.$/.test(labels!) ? m : '[internal-host]'),
  ],
  [new RegExp(`(^|[^\\w.])(?:${PRIVATE_V4})\\.${OCTET}\\.${OCTET}(?![\\w-]|\\.\\d)`, 'gm'), '$1[private-ip]'],
  // IPv6 unique-local addresses (fc00::/7).
  [/(^|[^\w:])f[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![\w:])/gim, '$1[private-ip]'],
];

export interface RedactTextOptions {
  /** Also redact emails, internal hostnames, private IPs and absolute paths (text bound for an issue, comment or PR). */
  identifiers?: boolean;
}

/** The options for text bound for an issue, a comment or a pull request (src/backlog): secrets and identifiers. */
export const TRACKER: Readonly<RedactTextOptions> = Object.freeze({ identifiers: true });

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

export function redactString(s: string, o: RedactTextOptions = {}): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (o.identifiers) for (const [re, rep] of IDENTIFIERS) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, o: RedactTextOptions = {}): T {
  if (typeof value === 'string') return redactString(value, o) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, o)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, o)])) as T;
  return value;
}
