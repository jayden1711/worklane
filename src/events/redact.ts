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

/**
 * A value after `Basic` that is a credential, not a word: base64 with a digit, `+`, `/` or `=` in it, or a mixed-case
 * run of 16 or more characters whose length base64 can have (no padding: not 1 more than a multiple of 4).
 */
const basicShaped = (v: string) => /[0-9+/=]/.test(v) || (v.length >= 16 && v.length % 4 !== 1 && /[a-z]/.test(v) && /[A-Z]/.test(v));

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
  // A dashboard key, wherever its prefix is (after a `-` or a letter too: `key-wld_...`): a match runs to the end of its
  // run of key characters and the next search starts after it, so linear.
  [new RegExp(`${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}(?![A-Za-z0-9_-])`, 'g'), `${DASHBOARD_KEY_PREFIX}[REDACTED]`, 'dashboard key'],
  // The token's end: no letter or digit after it, so `ghp_..._backup` is found too (a `\b` there needs a non-word).
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})(?![A-Za-z0-9])/g, 'gh*_[REDACTED]', 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'github_pat_[REDACTED]', 'GitHub token'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]', 'API key (sk-)'],
  // Stripe secret and restricted keys, live and test: random, so with a digit (a long camelCase name after the
  // prefix, with no digit, is a code identifier).
  [/(^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g, (m, pre, k, v) => (/\d/.test(v!) ? `${pre}${k}_[REDACTED]` : m), 'Stripe key'],
  // Google API keys: AIza and 35 more characters.
  [/(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, '$1AIza[REDACTED]', 'Google API key'],
  // JSON Web Tokens: a base64url JSON header (so `eyJ`), a payload and a signature (empty when unsigned).
  // Any further dotted parts go with it (#889 round 3): a JWE has five, and a token may be followed by more.
  [/(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/g, '$1[REDACTED JWT]', 'JWT'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, 'AKIA[REDACTED]', 'AWS access key'],
  // Slack's token-rotation and refresh tokens (xoxe-..., xoxe.xoxb-...), before the
  // other Slack tokens (one is inside it); then its app-level token (xapp-, Socket Mode).
  [/\bxoxe[.-][A-Za-z0-9.-]{10,}(?![A-Za-z0-9])/g, 'xoxe-[REDACTED]', 'Slack token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g, 'xox-[REDACTED]', 'Slack token'],
  [/\bxapp-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g, 'xapp-[REDACTED]', 'Slack app-level token'],
  // Linear personal API keys and OAuth tokens.
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, 'lin_[REDACTED]', 'Linear key'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]', 'Slack webhook'],
  // Tailscale auth keys, API tokens and OAuth client secrets (tskey-auth-..., tskey-api-..., tskey-client-...): the
  // prefix and the rest of its run, however short (src/tailscale-setup.ts redacted them this way on its own).
  [/tskey-[A-Za-z0-9_-]+/g, 'tskey-[REDACTED]', 'Tailscale key'],
  // A private key (PEM, and PGP's PRIVATE KEY BLOCK), failing closed (#889): from its BEGIN line to its END line, or
  // to the end of the text when no END follows (a key cut short, or still being written); then, for an END line with
  // no BEGIN before it (a key whose start is above a window), from the start of the text to that END line. Each BEGIN
  // is read once (its match runs to its END or to the end), and the second rule has one start: linear.
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g, '[REDACTED PRIVATE KEY]', 'private key'],
  [/^[\s\S]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/, '[REDACTED PRIVATE KEY]', 'private key'],
  // The scheme is case-insensitive (RFC 9110): `bearer` and `BEARER` too (#889).
  [/\b(Bearer|bearer|BEARER)\s+[A-Za-z0-9._~+/-]{20,}=*/g, '$1 [REDACTED]', 'bearer token'],
  // HTTP Basic credentials (base64 of user:password; git's extraheader, src/dashboard-auth.ts's client id and secret),
  // failing closed: any credential-looking value after the scheme. Prose ("Basic Authentication") has no digit, `+`,
  // `/` or `=`, and isn't a mixed-case run of a base64 length.
  [/\b(Basic|basic|BASIC)(\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g, (m, s, sp, v) => (basicShaped(v!) ? `${s}${sp}[REDACTED]` : m), 'Basic credential'],
  // Credentials inside connection strings: keep scheme, user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@', 'password in a URL'],
  // 0x-prefixed 32-byte hex (EVM private keys and the like).
  [/\b0x[0-9a-fA-F]{64}(?![A-Za-z0-9])/g, '0x[REDACTED-32-BYTES]', '32-byte hex key'],
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
 * (scripts/machine/<cli>-update.cjs, which carries a generated copy of this module). Run with PATTERNS, all on the
 * text as it was, and what any of them finds is masked with `mask` (maskUnion). They were those modules' own rules (#889): a known
 * token prefix and a short run, a URL's user info, a value after a secret's name, a short bearer token, and a JWT
 * after a hyphen. Each starts only where a run starts, or reads a bounded stretch from each start: linear.
 */
const BROAD: [RegExp, (mask: string) => string, string][] = [
  [/(^|[^A-Za-z0-9_])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, (k) => `$1${k}`, 'GitHub token, cut short'],
  [/sk-ant-[A-Za-z0-9_-]+/g, (k) => k, 'Anthropic key, cut short'],
  // The root updater's own token rule on main, as it was: where it ends (a GitHub token's run of letters and digits, a
  // Slack token's before a `_`) is where its next rule saw a boundary (maskUnion reads again there).
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, (k) => k, "the updater's token rule"],
  [/(^|[^A-Za-z0-9_])xox[abprs]-[A-Za-z0-9_-]+/g, (k) => `$1${k}`, 'Slack token, cut short'],
  [/(^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, (k) => `$1${k}`, 'JWT after a hyphen'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (k) => `$1 ${k}`, 'short bearer token'],
  // A scheme of up to 32 characters right before `://`, from any start (after `-`, `.`, `+` or a letter too: the
  // updater's own rule started at any `\b`, a scheme of any length): each start reads at most 33 characters, and each
  // `://` is reached from at most 32 starts, so linear.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]+@/gi, (k) => `$1${k}@`, 'user info in a URL'],
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
  /**
   * The broad mode: the shapes and the broad rules (BROAD: a token prefix cut short, a URL's user info, a value after a
   * secret's name), all on the text as it was; the union of what they find is masked with `mask` (maskUnion).
   */
  broad?: boolean;
  /** In the broad mode, what each masked run becomes (taken literally); [REDACTED] when unset. */
  mask?: string;
  /** Keep the text's line count: a match over several lines (a private key) leaves its line breaks (redactRecords). */
  keepLines?: boolean;
}

/**
 * The prefixes of the shapes whose patterns start at `\b` (or after a character that isn't `_`): after an underscore
 * (`MY_ghp_...`, `x_sk-...`) a token is glued to a name, and the second pass (glued) reads it from its prefix on.
 */
const GLUED_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'xoxa-', 'xoxb-', 'xoxe', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-', 'lin_api_', 'lin_oauth_', 'AKIA', 'ASIA', 'AIza', 'eyJ', '0x', 'Bearer', 'bearer', 'BEARER', 'Basic', 'basic', 'BASIC', DASHBOARD_KEY_PREFIX];
/**
 * What ends in a letter and may sit right before a token (#889): an ANSI escape sequence (a coloured log line,
 * `ESC[1m`) and a backslash escape in raw JSON or C-style text (`\n`, `\t`, `\"`, `\u001b`). A cut point goes after
 * each. Each ESC or backslash starts one bounded match: linear.
 */
const GLUE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|\\(?:u[0-9A-Fa-f]{4}|[nrtbf"\\/])/g;

/** Where a token may start glued to what is before it: after each GLUE match, and after `_` before a known prefix. */
function gluePoints(s: string): number[] {
  const cuts = [...s.matchAll(GLUE)].map((m) => m.index! + m[0].length);
  for (let at = s.indexOf('_'); at !== -1; at = s.indexOf('_', at + 1)) if (GLUED_PREFIXES.some((p) => s.startsWith(p, at + 1))) cuts.push(at + 1);
  return [...new Set(cuts)].filter((c) => c < s.length).sort((a, b) => a - b);
}

/** A character `s` doesn't hold (a private-use one), to mark the cut points with; null when it holds them all. */
function freeMark(s: string): string | null {
  const held = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xe000 && c <= 0xf8ff) held.add(c);
  }
  for (let c = 0xe000; c <= 0xf8ff; c++) if (!held.has(c)) return String.fromCharCode(c);
  return null;
}

/**
 * The second pass (#889): `f` again on `s` with a boundary at each glue point, so a token glued to a name, to an ANSI
 * escape or to a JSON escape is found from its start. The boundary is a mark no pattern takes in, inserted and taken
 * out again, so the text is otherwise kept as it was. When `s` holds every mark character, each piece after a glue
 * point is redacted on its own instead. The first pass ran on the text as it was, so nothing it found is lost.
 */
function glued(s: string, f: (part: string) => string): string {
  const cuts = gluePoints(s);
  if (!cuts.length) return s;
  const mark = freeMark(s);
  if (mark === null) {
    let out = s.slice(0, cuts[0]);
    for (const [i, c] of cuts.entries()) out += f(s.slice(c, cuts[i + 1] ?? s.length));
    return out;
  }
  let marked = '';
  let from = 0;
  for (const c of cuts) {
    marked += s.slice(from, c) + mark;
    from = c;
  }
  return f(marked + s.slice(from)).split(mark).join('');
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

/** A rule's regex as a global one, for matchAll (the orphan-END rule has no `g`). */
const globals = new Map<RegExp, RegExp>();
const globalOf = (re: RegExp) => {
  let g = globals.get(re);
  if (!g) globals.set(re, (g = re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`)));
  return g;
};

/**
 * Where `re` finds a secret in `t`, as [start, end) spans: each match's part its replacement takes out (what the match
 * and the replacement don't share at either end), so the scheme, the key's name or the separator a rule keeps is not
 * in the span. A match its replacement leaves as it was (a function that judged it no secret) gives none.
 */
function spansOf(t: string, re: RegExp, rep: Replacement, out: [number, number][]) {
  const g = globalOf(re);
  g.lastIndex = 0;
  for (let m = g.exec(t); m; m = g.exec(t)) {
    const whole = m[0];
    // The next search starts 64 characters before the match's end, not after it: a value a rule takes in may hold the
    // next secret's name (`token='abc password = 'x`, `Bearer abc+Bearer xyz`), and that next match must still be
    // found. Each match start is after the last one's, and at most 64 characters are read again: linear.
    g.lastIndex = Math.max(m.index + 1, m.index + whole.length - 64);
    const groups = m.slice(1).map((x) => x ?? '');
    const r = typeof rep === 'string' ? expand(rep, whole, groups) : rep(whole, ...groups);
    if (r === whole) continue;
    let a = 0;
    while (a < whole.length && a < r.length && whole[a] === r[a]) a++;
    let b = 0;
    while (b < whole.length - a && b < r.length - a && whole[whole.length - 1 - b] === r[r.length - 1 - b]) b++;
    if (whole.length - b > a) out.push([m.index! + a, m.index! + whole.length - b]);
  }
}

/** Every rule of the broad mode: the shapes and the broad rules, each shown with the default mask. */
const BROAD_RULES: [RegExp, Replacement][] = [...PATTERNS.map(([re, rep]): [RegExp, Replacement] => [re, rep]), ...BROAD.map(([re, rep]): [RegExp, Replacement] => [re, rep('[REDACTED]')])];

/**
 * The broad mode (#889 round 3, the final check's regression finding): every rule runs on the text as it was, and the
 * union of the spans they find is masked, each run once, with `mask`. Order-free by design: no rule's marker can hide
 * what another rule would have found, so each rule masks at least what it masked alone (the modules' own rules on
 * main among them; test/redact-broad-union.test.ts compares them on generated input). The glue points (gluePoints)
 * are found the same way, on the text with a mark at each, mapped back. One pass of maskUnion.
 */
function maskOnce(s: string, mask: string, keepLines: boolean): string {
  const spans: [number, number][] = [];
  for (const [re, rep] of BROAD_RULES) spansOf(s, re, rep, spans);
  // Two more reads, each with boundaries marked in: the glue points; and where a span found begins or ends between two
  // word characters (a module's own rules, applied in turn, saw a boundary where an earlier rule's replacement ended:
  // `xoxa-...[here]_db_password=...`). Apart, so a boundary of one kind can't break a match the other needs.
  const word = (i: number) => /[A-Za-z0-9_]/.test(s[i] ?? '');
  readAt(s, gluePoints(s), spans);
  readAt(s, [...new Set(spans.flat())].filter((c) => c > 0 && c < s.length && word(c - 1) && word(c)).sort((a, b) => a - b), spans);
  // What is already a mask stays as it is: a rule that takes in a mask word (`token=[REDACTED]`) adds nothing.
  const masks: [number, number][] = [];
  if (mask) for (let at = s.indexOf(mask); at !== -1; at = s.indexOf(mask, at + mask.length)) masks.push([at, at + mask.length]);
  const kept = masks.length ? spans.flatMap(([a, b]) => outside([a, b], masks)) : spans;
  if (!kept.length) return s;
  kept.sort((x, y) => x[0] - y[0]);
  let out = '';
  let at = 0;
  let open: [number, number] | null = null;
  const close = () => {
    if (!open) return;
    out += s.slice(at, open[0]) + mask + (keepLines ? '\n'.repeat(breaks(s.slice(open[0], open[1]))) : '');
    at = open[1];
  };
  for (const [a, b] of kept) {
    if (b <= a) continue;
    if (open && a <= open[1]) open[1] = Math.max(open[1], b);
    else {
      close();
      open = [a, b];
    }
  }
  close();
  return out + s.slice(at);
}

/** Every rule on `s` with a boundary marked in at each of `cuts` (sorted); the spans found, mapped back, go in `spans`. */
function readAt(s: string, cuts: number[], spans: [number, number][]) {
  if (!cuts.length) return;
  const markChar = freeMark(s);
  if (markChar === null) {
    // Every mark character is in the text: each piece after a cut is read on its own.
    for (const [i, c] of cuts.entries()) {
      const piece = s.slice(c, cuts[i + 1] ?? s.length);
      const more: [number, number][] = [];
      for (const [re, rep] of BROAD_RULES) spansOf(piece, re, rep, more);
      for (const [a, b] of more) spans.push([a + c, b + c]);
    }
    return;
  }
  let marked = '';
  let from = 0;
  for (const c of cuts) {
    marked += s.slice(from, c) + markChar;
    from = c;
  }
  marked += s.slice(from);
  // A position in the marked text, back to the text: less the marks before it.
  const back = (p: number) => {
    let lo = 0;
    let hi = cuts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cuts[mid]! + mid < p) lo = mid + 1;
      else hi = mid;
    }
    return p - lo;
  };
  const more: [number, number][] = [];
  for (const [re, rep] of BROAD_RULES) spansOf(marked, re, rep, more);
  for (const [a, b] of more) spans.push([back(a), back(b)]);
}

/** The parts of [a, b) outside every one of `regions` (sorted, not overlapping). */
function outside([a, b]: [number, number], regions: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let from = a;
  for (const [x, y] of regions) {
    if (y <= from || x >= b) continue;
    if (x > from) out.push([from, x]);
    from = Math.max(from, y);
  }
  if (from < b) out.push([from, b]);
  return out;
}

/**
 * The broad mode: masked once, then again on what that gave, until nothing changes (at most 3 times). A mask can make
 * a boundary a later rule needs (`[REDACTED]_db_password=...`), as each module's own rules, applied in turn, did.
 */
function maskUnion(s: string, mask: string, keepLines: boolean): string {
  let out = maskOnce(s, mask, keepLines);
  for (let i = 0; i < 2; i++) {
    const again = maskOnce(out, mask, keepLines);
    if (again === out) break;
    out = again;
  }
  return out;
}

export function redactString(s: string, o: RedactTextOptions = {}): string {
  const put = o.keepLines ? applyKeepingLines : apply;
  // The broad mode masks the union of every rule's spans (maskUnion); the default mode applies the shapes in turn,
  // each with its own marker, then again from each glue point (glued).
  const secrets = (t: string) => PATTERNS.reduce((y, [re, rep]) => put(y, re, rep), t);
  let out = o.broad ? maskUnion(s, o.mask ?? '[REDACTED]', o.keepLines === true) : glued(secrets(s), secrets);
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
