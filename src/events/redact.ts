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

/** A word that makes any key holding it a credential's: `db_password`, `slack_bot_token`, `aws_secret_access_key`. */
const CREDENTIAL_WORDS = new Set(['token', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'jwt', 'bearer', 'credential', 'credentials', 'authorization']);
/** The word before `key` that makes it a credential (`x-api-key`, `apiKey`, `signing_key`); `cacheKey`, `sort_key` are not. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'secret', 'private', 'signing', 'encryption', 'master', 'client', 'app', 'auth', 'account', 'service', 'license', 'deploy', 'admin', 'webhook', 'session', 'ssh', 'hmac', 'consumer']);

/**
 * A JSON key that names a credential, by rule rather than a list: split into words (`_`, `-`, camelCase), it holds a
 * credential word, ends in `auth`, or is `key` on its own or after a qualifier (`apikey` written as one word too).
 */
function credentialKey(k: string): boolean {
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[ _-]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  if (words.some((w) => CREDENTIAL_WORDS.has(w)) || last === 'auth') return true;
  if (last === 'key') return words.length === 1 || KEY_QUALIFIERS.has(words.at(-2)!);
  return last.endsWith('key') && KEY_QUALIFIERS.has(last.slice(0, -3));
}

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
  // A JSON string value under a credential key (credentialKey: "aws_secret_access_key", "db_password", "x-api-key",
  // "slack_bot_token", "authorization", ...), also inside an escaped JSON string (\"token\":\"...\"). Not "cacheKey"
  // or "sort_key", and only a credential-shaped value (16 or more characters; mixed case with a digit, or long hex),
  // so {"key": "issue-644"}, {"token": "intake.triaged.v2"} and a UUID stay. The key is judged in a function, so the
  // regex only reads one run of key characters from each quote.
  [
    /(\\?")([A-Za-z0-9_-]+)\1(\s*:\s*)\1([A-Za-z0-9_\-.+/=~]{16,})\1/g,
    (m, q, k, sep, v) => (credentialKey(k!) && credentialShaped(v!) ? `${q}${k}${q}${sep}${q}[REDACTED]${q}` : m),
    'secret under a JSON key',
  ],
];

/**
 * The first word of a dotted name that is code, not a host: `this.internal`, `opts.corp`, `config.lan.x`. Only
 * receivers no one names a machine after: `app`, `data` and `node` are left out, since `app.internal` (one app on a
 * private network), `data.corp` and `node.cluster.local` are hosts.
 */
const CODE_HEADS = new Set(['this', 'self', 'super', 'opts', 'options', 'o', 'ctx', 'context', 'config', 'cfg', 'conf', 'settings', 'props', 'state', 'env', 'process', 'module', 'exports', 'window', 'document', 'globalThis', 'args', 'params', 'req', 'res', 'request', 'response', 'obj', 'result', 'item', 'e', 'err', 'x']);

/**
 * A dotted name under a private-use suffix is a host, one plain word included (`nas.lan`, `vault.internal`): a false
 * positive costs a few characters, a false negative names a machine. It is code only when no label has a hyphen (an
 * identifier can't) and it starts with a usual receiver (`this.internal`, `this.config.internal`) or a label is
 * camelCase (`someObj.lan`). And it is prose when the suffix is in mixed case (`passed.Internal`, a missing space):
 * a host name is written in one case.
 */
function internalHost(m: string, pre: string, name: string): string {
  const lower = name.toLowerCase();
  const labels = name.split('.').slice(0, lower.endsWith('.home.arpa') || lower.endsWith('.ts.net') ? -2 : -1);
  const suffix = name.slice(labels.join('.').length + 1);
  const prose = suffix !== suffix.toLowerCase() && suffix !== suffix.toUpperCase();
  const code = !labels.some((l) => l.includes('-')) && (CODE_HEADS.has(labels[0]!) || labels.some((l) => /[a-z][A-Z]/.test(l)));
  return prose || code ? m : `${pre}[internal-host]`;
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
  // Hostnames under the private-use suffixes; code that looks like one stays (internalHost). After a slash only as a
  // URL's `//`: `./util.internal` is a module path, `http://nas.lan/` a host.
  [/(^|[^A-Za-z0-9./-]|\/\/)([A-Za-z0-9][A-Za-z0-9.-]*\.(?:internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi, internalHost, 'internal host'],
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
 * would change or stop parsing. Secrets are still redacted inside them. Only an opener its parser would take counts:
 * the fence word then a line break, with nothing but blanks between (parseContract's `\s*\n`, research's
 * `[ \t]*\r?\n`), so a mention in prose (`add a ```done_when block.`) leaves the text after it redacted. Found with
 * indexOf and a sticky check at each opener, not a scan: linear.
 */
const MACHINE_BLOCKS: [string, RegExp][] = [
  ['```done_when', /[^\S\n]*\n/y],
  ['```research', /[ \t]*\r?\n/y],
];
function outsideMachineBlocks(s: string, f: (part: string) => string): string {
  const spans: [number, number][] = [];
  for (const [open, lineBreak] of MACHINE_BLOCKS) {
    for (let at = s.indexOf(open); at !== -1; ) {
      lineBreak.lastIndex = at + open.length;
      if (!lineBreak.test(s)) {
        at = s.indexOf(open, at + open.length);
        continue;
      }
      // The block's body starts after the opener's line break; the first line that starts with ``` closes it.
      const close = s.indexOf('\n```', lineBreak.lastIndex);
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
