// Redact secret-shaped strings before anything is stored. Fast, pattern
// based; gitleaks still scans transcripts. False positives cost a few
// characters of a log line; a false negative leaks a key into the log.
// This is the one shared redactor: a feature that needs more redaction adds a pattern here, never its own redactor.
//
// Every pattern added here must run in linear time on hostile input (an intake report, a CI log, chat text): a
// match may start only where a run of its characters starts (a prefix group, never `\b` inside a run of `-`), and a
// decision a regex would make by backtracking is made in a function instead. test/redact.test.ts times each one on
// 100 KB adversarial strings. No lookbehind: the web bundle imports this module (web/src/voice/talk.ts).
type Replacement = string | ((match: string, ...groups: string[]) => string);

/** Credential-shaped: mixed case with a digit (a random key), or a long hex run (a classic token). */
const credentialShaped = (v: string) => (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) || /^[0-9a-fA-F]{32,}$/.test(v);

// Each pattern with what kind of secret it finds (secretKinds names the kind, never the value).
const PATTERNS: [RegExp, Replacement, string][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, 'gh*_[REDACTED]', 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]', 'GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]', 'API key (sk-)'],
  // Stripe secret and restricted keys, live and test: random, so with a digit (a long camelCase name after the
  // prefix, with no digit, is a code identifier).
  [/(^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g, (m, pre, k, v) => (/\d/.test(v!) ? `${pre}${k}_[REDACTED]` : m), 'Stripe key'],
  // Google API keys: AIza and 35 more characters.
  [/(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, '$1AIza[REDACTED]', 'Google API key'],
  // JSON Web Tokens: a base64url JSON header (so `eyJ`), a payload and a signature (empty when unsigned).
  [/(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '$1[REDACTED JWT]', 'JWT'],
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
  // A JSON string value under a credential key ("jwt", "key", "token", "secret", "password", "api_key",
  // "access_token", "client_secret", ...), also inside an escaped JSON string (\"token\":\"...\"). Only those names
  // (not "cacheKey" or "sortKey"), and only a credential-shaped value (16 or more characters; mixed case with a
  // digit, or long hex), so {"key": "issue-644"}, {"token": "intake.triaged.v2"} and a UUID stay.
  [
    /(\\?")(jwt|key|token|secret|password|passwd|(?:access|refresh|id|auth|session|bearer|api|oauth|csrf|npm|github|slack)[_-]?token|(?:client|api|app|webhook|signing)[_-]?secret|(?:api|access|secret|private|signing|encryption|master|secret[_-]?access)[_-]?key)\1(\s*:\s*)\1([A-Za-z0-9_\-.+/=~]{16,})\1/gi,
    (m, q, k, sep, v) => (credentialShaped(v!) ? `${q}${k}${q}${sep}${q}[REDACTED]${q}` : m),
    'secret under a JSON key',
  ],
];

/** The first word of a dotted name that is code, not a host: `this.internal`, `opts.corp`, `config.lan.x`. */
const CODE_HEADS = new Set(['this', 'self', 'super', 'opts', 'options', 'o', 'ctx', 'context', 'config', 'cfg', 'conf', 'settings', 'props', 'state', 'env', 'process', 'module', 'exports', 'window', 'document', 'globalThis', 'args', 'params', 'req', 'res', 'request', 'response', 'app', 'data', 'obj', 'result', 'item', 'node', 'e', 'err', 'x']);

/**
 * A dotted name under a private-use suffix is code when no label has a hyphen (an identifier can't) and either it
 * is one plain word (`this.internal`), it starts with a usual receiver (`this.config.internal`), or a label is
 * camelCase. Otherwise it is a host: `db-1.prod.internal`, `api.shop.svc.cluster.local`, `build-box.local`.
 */
function internalHost(m: string, pre: string, name: string): string {
  const labels = name.split('.').slice(0, name.toLowerCase().endsWith('.home.arpa') || name.toLowerCase().endsWith('.ts.net') ? -2 : -1);
  const code =
    !labels.some((l) => l.includes('-')) &&
    ((labels.length === 1 && /^[A-Za-z]+$/.test(labels[0]!)) || CODE_HEADS.has(labels[0]!) || labels.some((l) => /[a-z][A-Z]/.test(l)));
  return code ? m : `${pre}[internal-host]`;
}

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
 * the user name in a home directory's path. Redacted only when asked for (`identifiers: true`, TRACKER below),
 * because the event log, run records and the secret checks (`redactString(s) !== s`) keep them; the backlog asks for
 * it on everything it writes to an issue, a comment or a pull request.
 * A path keeps everything but the home and user (`/home/<user>/proj/a.ts:42:7` becomes `~/proj/a.ts:42:7`), so a
 * stack trace still says which file and line. A hosted CI runner's home (`/home/runner`) names no one and stays, as
 * do system paths (/etc, /opt, /var, /tmp): they name no person.
 */
const IDENTIFIERS: [RegExp, Replacement, string][] = [
  // Emails, except git@host (an SSH remote names no one).
  [/(^|[^A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g, '$1[email]', 'email'],
  // A home directory's user: /home/<user>, /Users/<user>, WSL's /mnt/<drive>/Users/<user>, also in a file:// URL.
  [
    /(^|[^\w.~/:-]|file:\/\/)\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/([^\s/"'`<>()[\]{},;|\\]+)/g,
    (m, pre, user) => (user === 'runner' ? m : `${pre}~`),
    'home path',
  ],
  [/(^|[^\w])[A-Za-z]:[\\/][Uu]sers[\\/]([^\\/\s"'`<>|]+)/g, '$1~', 'home path'],
  // Hostnames under the private-use suffixes; code that looks like one stays (internalHost).
  [/(^|[^A-Za-z0-9.-])([A-Za-z0-9][A-Za-z0-9.-]*\.(?:internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi, internalHost, 'internal host'],
  [new RegExp(`(^|[^\\w.])(?:${PRIVATE_V4})\\.${OCTET}\\.${OCTET}(?![\\w-]|\\.\\d)`, 'g'), '$1[private-ip]', 'private IP'],
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) addresses.
  [/(^|[^\w:])f(?:[cd][0-9a-f]{2}|e[89ab][0-9a-f]):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![\w:])/gi, '$1[private-ip]', 'private IP'],
];

/** Every pattern with its kind, for the linear-time test (test/redact.test.ts). */
export const REDACTION_PATTERNS: readonly { kind: string; re: RegExp; rep: Replacement }[] = [...PATTERNS, ...IDENTIFIERS].map(([re, rep, kind]) => ({ kind, re, rep }));

export interface RedactTextOptions {
  /** Also redact emails, internal hostnames, private IPs and home paths' user names (text for an issue, comment or PR). */
  identifiers?: boolean;
}

/** The options for text bound for an issue, a comment or a pull request (src/backlog): secrets and identifiers. */
export const TRACKER: Readonly<RedactTextOptions> = Object.freeze({ identifiers: true });

const apply = (s: string, re: RegExp, rep: Replacement) => (typeof rep === 'string' ? s.replace(re, rep) : s.replace(re, rep));

/**
 * Fenced blocks the harness parses back out of an issue (```done_when, src/backlog/types.ts parseContract and
 * contractKey; ```research, src/research.ts): the identifier pass leaves them byte for byte, or a contract's command
 * would change or stop parsing. Secrets are still redacted inside them. Found with indexOf, not a regex: linear.
 */
const MACHINE_BLOCKS = ['```done_when', '```research'];
function outsideMachineBlocks(s: string, f: (part: string) => string): string {
  const spans: [number, number][] = [];
  for (const open of MACHINE_BLOCKS) {
    for (let at = s.indexOf(open); at !== -1; ) {
      const close = s.indexOf('\n```', at + open.length);
      if (close === -1) break;
      spans.push([at, close + 4]);
      at = s.indexOf(open, close + 4);
    }
  }
  if (!spans.length) return f(s);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  for (const [a, b] of spans) {
    if (a < from) continue;
    out += f(s.slice(from, a)) + s.slice(a, b);
    from = b;
  }
  return out + f(s.slice(from));
}

/** The kinds of secret `s` looks like it holds (sorted, each once): names only, never a matched value. */
export function secretKinds(s: string): string[] {
  const kinds = new Set<string>();
  for (const [re, rep, kind] of PATTERNS) {
    re.lastIndex = 0;
    if (apply(s, re, rep) !== s) kinds.add(kind);
  }
  return [...kinds].sort();
}

export function redactString(s: string, o: RedactTextOptions = {}): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = apply(out, re, rep);
  if (o.identifiers) out = outsideMachineBlocks(out, (part) => IDENTIFIERS.reduce((t, [re, rep]) => apply(t, re, rep), part));
  return out;
}

export function redact<T>(value: T, o: RedactTextOptions = {}): T {
  if (typeof value === 'string') return redactString(value, o) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, o)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, o)])) as T;
  return value;
}
