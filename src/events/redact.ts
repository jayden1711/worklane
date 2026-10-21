// Redact secret-shaped strings before anything is stored. Fast, pattern
// based; gitleaks still scans transcripts. False positives cost a few
// characters of a log line; a false negative leaks a key into the log.
// This is the one shared redactor: a feature that needs more redaction adds a pattern here, never its own redactor.
// PATTERNS is the one list of credential shapes (#889); test/redaction-one-module.test.ts fails on a module that
// redacts a token shape with its own regex, and test/redact-shapes.test.ts drives every shape through every output path.
//
// Every pattern added here must run in linear time on hostile input (an intake report, a CI log, chat text): a
// match may start only where a run of its characters starts (a prefix group, never `\b` inside a run of `-`), and a
// decision a regex would make by backtracking is made in a function instead. test/redact.test.ts times each one on
// 100 KB adversarial strings. No lookbehind, so a browser bundle may import this module too.
type Replacement = string | ((match: string, ...groups: string[]) => string);

/** Credential-shaped: mixed case with a digit (a random key), or a long hex run (a classic token). */
const credentialShaped = (v: string) => (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) || /^[0-9a-fA-F]{32,}$/.test(v);

/** A word that makes any key holding it a credential's: `db_password`, `slack_bot_token`, `aws_secret_access_key`. */
const CREDENTIAL_WORDS = new Set(['token', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'jwt', 'bearer', 'credential', 'credentials', 'authorization']);
/**
 * A word that ends in one of these is a credential word too: a name written as one word, with nothing to split on
 * (`csrftoken`, `clientsecret`, `adminpassword`, `secretaccesskey`). Only the end counts, so `tokenizer` and
 * `secretary` are not; `pass` and `pwd` count only whole (`compass`, `bypass`).
 */
const CREDENTIAL_ENDINGS = ['token', 'secret', 'password', 'passwd', 'accesskey'];
const credentialWord = (w: string) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_ENDINGS.some((e) => w.endsWith(e));
/** The word before `key` that makes it a credential (`x-api-key`, `apiKey`, `signing_key`); `cacheKey`, `sort_key` are not. */
const KEY_QUALIFIERS = new Set(['api', 'access', 'secret', 'private', 'signing', 'encryption', 'master', 'client', 'app', 'auth', 'account', 'service', 'license', 'deploy', 'admin', 'webhook', 'session', 'ssh', 'hmac', 'consumer']);

/**
 * A JSON key that names a credential, by rule rather than a list: split into words (`_`, `-`, camelCase), it holds a
 * credential word (or a word ending in one), ends in `auth`, or is `key` on its own or after a qualifier (`apikey`
 * written as one word too).
 */
function credentialKey(k: string): boolean {
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[ _-]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? '';
  if (words.some(credentialWord) || last === 'auth') return true;
  if (last === 'key') return words.length === 1 || KEY_QUALIFIERS.has(words.at(-2)!);
  return last.endsWith('key') && KEY_QUALIFIERS.has(last.slice(0, -3));
}

/**
 * What every dashboard key starts with (#889, owner's decision): src/dashboard.ts dashboardToken writes `wld_` and 32
 * base64url characters, a shape no commit hash, digest or engine id has, so a key is redacted wherever it appears.
 * Fixed, not taken from BRAND: renaming the product must not change the shape of keys already issued. A key from
 * before (32 characters, no prefix) still opens the dashboard; doctor asks for it to be rotated.
 */
export const DASHBOARD_KEY_PREFIX = 'wld_';
const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';
/** Whether `key` is a dashboard key of the current shape (prefixed). */
export const isDashboardKey = (key: string): boolean => new RegExp(`^${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}$`).test(key);

// Each pattern with what kind of secret it finds (secretKinds names the kind, never the value).
const PATTERNS: [RegExp, Replacement, string][] = [
  // A dashboard key: starts only where a run of key characters starts (`wld_wld_...` is one run), so linear.
  [new RegExp(`(^|[^A-Za-z0-9_-])${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}(?![A-Za-z0-9_-])`, 'g'), `$1${DASHBOARD_KEY_PREFIX}[REDACTED]`, 'dashboard key'],
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
  // Tailscale auth keys, API tokens and OAuth client secrets (tskey-auth-..., tskey-api-..., tskey-client-...): the
  // prefix and the rest of its run, however short (src/tailscale-setup.ts redacted them this way on its own).
  [/tskey-[A-Za-z0-9_-]+/g, 'tskey-[REDACTED]', 'Tailscale key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]', 'private key'],
  // The scheme is case-insensitive (RFC 9110): `bearer` and `BEARER` too (#889).
  [/\b(Bearer|bearer|BEARER)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]', 'bearer token'],
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
  // A Discord bot token: three base64url parts (the bot's id, a timestamp, an HMAC). Last, as src/watchdog/incidents.ts
  // applied it after the rest (#889: it was redacted only there; there it started at `\b`, here after any character
  // but a letter or digit, so `x_<token>` is found too). It may start inside a run of `-` or `_`, but the first part
  // is bounded (23 to 28 characters, then a dot), so each start reads a bounded stretch: linear (redact-shapes.test.ts).
  [/(^|[^A-Za-z0-9])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, '$1[REDACTED]', 'Discord bot token'],
];
// Not covered: a bare 32-character string with no prefix (a dashboard key from before #889 among them): a commit
// hash, a digest and the engine's own ids have the same shape. New dashboard keys carry DASHBOARD_KEY_PREFIX.

/**
 * The broad rules (`broad: true`), for text whose source may cut a token short or name a secret by its key: gh's
 * output (src/gh-login.ts), the bench's printed lines (scripts/bench/cli.ts) and the root updater's files
 * (scripts/machine/<cli>-update.cjs, which carries a generated copy of this module). Applied before PATTERNS, each
 * puts `mask` (default [REDACTED]) in place of what it finds. They were those modules' own rules (#889): a known
 * token prefix and a short run, a URL's user info, a value after a secret's name, a short bearer token, and a JWT
 * after a hyphen. Each starts only where a run starts, or reads a bounded stretch from each start: linear.
 */
const BROAD: [RegExp, (mask: string) => string, string][] = [
  [/(^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, (k) => `$1${k}`, 'GitHub token, cut short'],
  [/sk-ant-[A-Za-z0-9_-]+/g, (k) => k, 'Anthropic key, cut short'],
  [/(^|[^A-Za-z0-9_])xox[abprs]-[A-Za-z0-9_-]+/g, (k) => `$1${k}`, 'Slack token, cut short'],
  [/(^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, (k) => `$1${k}`, 'JWT after a hyphen'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (k) => `$1 ${k}`, 'short bearer token'],
  [/(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, (k) => `$1$2${k}@`, 'user info in a URL'],
  [/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, (k) => `$1$2${k}`, 'value after a secret name'],
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

/**
 * Every pattern with its kind, for the linear-time test (test/redact.test.ts) and the shape tests
 * (test/redact-shapes.test.ts): `secret` for a secret's pattern (applied by default), `broad` for one applied with
 * `broad: true` (shown with the default mask), `identifier` for one applied with `identifiers: true`.
 */
export const REDACTION_PATTERNS: readonly { kind: string; re: RegExp; rep: Replacement; group: 'secret' | 'broad' | 'identifier' }[] = [
  ...PATTERNS.map(([re, rep, kind]) => ({ kind, re, rep, group: 'secret' as const })),
  ...BROAD.map(([re, rep, kind]) => ({ kind, re, rep: rep('[REDACTED]'), group: 'broad' as const })),
  ...IDENTIFIERS.map(([re, rep, kind]) => ({ kind, re, rep, group: 'identifier' as const })),
];

export interface RedactTextOptions {
  /** Also redact emails, internal hostnames, private IPs and home paths' user names (text for an issue, comment or PR). */
  identifiers?: boolean;
  /** Also apply the broad rules (BROAD), first: a token prefix cut short, a URL's user info, a value after a secret's name. */
  broad?: boolean;
  /** What a broad rule puts in place of what it finds; [REDACTED] when unset. */
  mask?: string;
  /** Keep the text's line count: a match over several lines (a private key) leaves its line breaks (redactRecords). */
  keepLines?: boolean;
}

/**
 * The prefixes of the shapes whose patterns start at `\b` (or after a character that isn't `_`): after an underscore
 * (`MY_ghp_...`, `x_sk-...`) a second pass reads from the prefix on (afterUnderscore), so a key glued to a name is
 * found too (#889). The first pass is unchanged, so nothing it found is lost.
 */
const GLUED_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'xoxa-', 'xoxb-', 'xoxe', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-', 'lin_api_', 'lin_oauth_', 'AKIA', 'ASIA', 'AIza', 'eyJ', '0x', 'Bearer', 'bearer', 'BEARER', DASHBOARD_KEY_PREFIX];

/** `s` with `f` applied again from each underscore that a known prefix follows: indexOf scans, so linear. */
function afterUnderscore(s: string, f: (part: string) => string): string {
  const cuts: number[] = [];
  for (let at = s.indexOf('_'); at !== -1; at = s.indexOf('_', at + 1)) if (GLUED_PREFIXES.some((p) => s.startsWith(p, at + 1))) cuts.push(at + 1);
  if (!cuts.length) return s;
  let out = '';
  let from = 0;
  for (const c of [...cuts, s.length]) {
    out += from === 0 ? s.slice(0, c) : f(s.slice(from, c));
    from = c;
  }
  return out;
}

/** `$1`, `$&` and `$$` in a replacement string, as String.prototype.replace reads them. */
const expand = (rep: string, m: string, groups: unknown[]) => rep.replace(/\$(\d|\$|&)/g, (_, k: string) => (k === '$' ? '$' : k === '&' ? m : String(groups[Number(k) - 1] ?? '')));
const breaks = (s: string) => s.split('\n').length - 1;

/** As apply, but each replacement keeps as many line breaks as what it replaced. */
function applyKeepingLines(s: string, re: RegExp, rep: Replacement): string {
  return s.replace(re, (m: string, ...rest: unknown[]) => {
    const groups = rest.slice(0, -2).filter((g) => typeof g !== 'object');
    const out = typeof rep === 'string' ? expand(rep, m, groups) : rep(m, ...(groups as string[]));
    return out + '\n'.repeat(Math.max(0, breaks(m) - breaks(out)));
  });
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
  const put = o.keepLines ? applyKeepingLines : apply;
  let out = s;
  if (o.broad) {
    // A private key first: a broad rule (a value after `TOKEN=`) would take its BEGIN line and leave its body unfound.
    for (const [re, rep, kind] of PATTERNS) if (kind === 'private key') out = put(out, re, rep);
    // A `$` in the mask is taken literally.
    const mask = (o.mask ?? '[REDACTED]').replace(/\$/g, '$$$$');
    for (const [re, rep] of BROAD) out = put(out, re, rep(mask));
  }
  const secrets = (t: string) => PATTERNS.reduce((x, [re, rep]) => put(x, re, rep), t);
  out = afterUnderscore(secrets(out), secrets);
  if (o.identifiers) out = outsideMachineBlocks(out, (part) => IDENTIFIERS.reduce((t, [re, rep]) => put(t, re, rep), part));
  return out;
}

/**
 * Records shown one after another (a service's journal entries, a log file's lines), redacted as one text so a secret
 * over several of them (a private key logged a line at a time) is found whole; the same number of records comes back,
 * each with as many lines as it had (a record inside a secret comes back empty or holding the marker).
 */
export function redactRecords(records: readonly string[], o: RedactTextOptions = {}): string[] {
  const lines = redactString(records.join('\n'), { ...o, keepLines: true }).split('\n');
  const out: string[] = [];
  let at = 0;
  for (const r of records) {
    const n = breaks(r) + 1;
    out.push(lines.slice(at, at + n).join('\n'));
    at += n;
  }
  return out;
}

export function redact<T>(value: T, o: RedactTextOptions = {}): T {
  if (typeof value === 'string') return redactString(value, o) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, o)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, o)])) as T;
  return value;
}
