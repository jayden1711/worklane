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
// Its tables (the credential words, the shapes, the broad rules and the glue) are data in src/events/redact.tables.json
// (#941), which the weakening hold compares parsed; loaded and deep-frozen by src/check-tables.ts. The RegExps made from
// them are this module's own: none is handed out (REDACTION_PATTERNS gives copies), since a RegExp can be rewritten in
// place. scripts/lib/redact-vendor.mjs puts the same data, as frozen literals, in the root updater's copy.
import { regExpOf, tablesOf, type FrozenSet, type Pattern } from '../check-tables.js';

type Replacement = string | ((match: string, ...groups: string[]) => string);

/** This module's tables (src/events/redact.tables.json): deep-frozen. */
const TABLES = tablesOf(import.meta.url);

/** Credential-shaped: mixed case with a digit (a random key), or a long hex run (a classic token). */
const credentialShaped = (v: string) => (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) || /^[0-9a-fA-F]{32,}$/.test(v);

/**
 * A value after `Basic` that is a credential, not a word: base64 with a digit, `+`, `/` or `=` in it, or a mixed-case
 * run of 16 or more characters whose length base64 can have (no padding: not 1 more than a multiple of 4).
 */
const basicShaped = (v: string) => /[0-9+/=]/.test(v) || (v.length >= 16 && v.length % 4 !== 1 && /[a-z]/.test(v) && /[A-Z]/.test(v)) || basicPair(v);
/**
 * Whether `v` is base64 of a `user:password` pair: it decodes to printable ASCII with a `:` in it (#889 round 8: a short
 * pair, `dXNlcjpwYXNz`, has no digit, `+`, `/` or `=` and is under 16 characters). A word after "Basic" in prose
 * ("Authentication") decodes to bytes that aren't, or doesn't decode at all.
 */
function basicPair(v: string): boolean {
  let text: string;
  try {
    text = atob(v);
  } catch {
    return false;
  }
  return /^[\x20-\x7e]*:[\x20-\x7e]*$/.test(text);
}

/** A word that makes any key holding it a credential's: `db_password`, `slack_bot_token`, `aws_secret_access_key`. */
const CREDENTIAL_WORDS: FrozenSet<string> = TABLES.get('CREDENTIAL_WORDS');
/**
 * A word that ends in one of these is a credential word too: a name written as one word, with nothing to split on
 * (`csrftoken`, `clientsecret`, `adminpassword`, `secretaccesskey`). Only the end counts, so `tokenizer` and
 * `secretary` are not; `pass` and `pwd` count only whole (`compass`, `bypass`).
 */
const CREDENTIAL_ENDINGS: readonly string[] = TABLES.get('CREDENTIAL_ENDINGS');
const credentialWord = (w: string) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_ENDINGS.some((e) => w.endsWith(e));
/** The word before `key` that makes it a credential (`x-api-key`, `apiKey`, `signing_key`); `cacheKey`, `sort_key` are not. */
const KEY_QUALIFIERS: FrozenSet<string> = TABLES.get('KEY_QUALIFIERS');

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

const KEY_LINE = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
/**
 * `m` (the text up to its last END line) with everything up to its last END that no BEGIN opened redacted; as it was
 * when each END has its BEGIN. A BEGIN opens a key up to the next END, as the BEGIN rule reads it (#889 round 6: the
 * rules read the text as it was, so a closed key's END is still there, and it is not an orphan). One scan: linear.
 */
function orphanEnd(m: string): string {
  let open = false;
  let cut = -1;
  KEY_LINE.lastIndex = 0;
  for (let k = KEY_LINE.exec(m); k; k = KEY_LINE.exec(m)) {
    if (k[1] === 'BEGIN') open = true;
    else if (open) open = false;
    else cut = k.index + k[0].length;
  }
  return cut === -1 ? m : `[REDACTED PRIVATE KEY]${m.slice(cut)}`;
}

/**
 * The functions a shape's replacement can name (`{"replacer": name}` in the data): each declines a match that is no
 * secret (gives it back as it was), or works out what to keep. Code, not data: a change to one is a change to this file.
 */
const REPLACERS: Readonly<Record<string, (match: string, ...groups: string[]) => string>> = Object.freeze({
  // Stripe secret and restricted keys: random, so with a digit (a long camelCase name after the prefix, with no
  // digit, is a code identifier).
  stripe: (m: string, pre?: string, k?: string, v?: string) => (/\d/.test(v!) ? `${pre}${k}_[REDACTED]` : m),
  orphanEnd,
  // HTTP Basic credentials: any credential-looking value after the scheme (basicShaped).
  basic: (m: string, s?: string, sp?: string, v?: string) => (basicShaped(v!) ? `${s}${sp}[REDACTED]` : m),
  // A JSON string value under a credential key, credential-shaped (credentialKey, credentialShaped).
  jsonKey: (m: string, q?: string, k?: string, sep?: string, vq?: string, v?: string) => (credentialKey(k!) && credentialShaped(v!) ? `${q}${k}${q}${sep}${vq}[REDACTED]${vq}` : m),
});

/** A replacement as the data gives it: a string, or the name of one of REPLACERS. Throws on a name that isn't one. */
function replacementOf(rep: string | { replacer: string }): Replacement {
  if (typeof rep === 'string') return rep;
  const f = REPLACERS[rep.replacer];
  if (!f) throw new Error(`redact.tables.json: no replacer ${rep.replacer}`);
  return f;
}

/** A rule as the data gives it. */
type RuleData = { re: Pattern; rep: string | { replacer: string } };

/**
 * Each pattern with what kind of secret it finds (secretKinds names the kind, never the value), in the data's order:
 * the comments on each are in src/events/redact.tables.json.
 */
const PATTERNS: readonly (readonly [RegExp, Replacement, string])[] = Object.freeze(
  TABLES.get<readonly (RuleData & { kind: string })[]>('PATTERNS').map((e) => Object.freeze([regExpOf(e.re), replacementOf(e.rep), e.kind] as const)),
);
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
/** Each broad rule: its RegExp, its replacement with `{mask}` where the mask goes, and its kind. */
const BROAD: readonly (readonly [RegExp, string, string])[] = Object.freeze(
  TABLES.get<readonly { re: Pattern; mask: string; kind: string }[]>('BROAD').map((e) => Object.freeze([regExpOf(e.re), e.mask, e.kind] as const)),
);
/** A broad rule's replacement with `mask` in it (taken literally). */
const masked = (template: string, mask: string) => template.split('{mask}').join(mask);

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
  // Copies of the RegExps: the ones this module runs are its own (a RegExp can be rewritten in place).
  ...PATTERNS.map(([re, rep, kind]) => ({ kind, re: new RegExp(re), rep, group: 'secret' as const })),
  ...BROAD.map(([re, rep, kind]) => ({ kind, re: new RegExp(re), rep: masked(rep, '[REDACTED]'), group: 'broad' as const })),
  ...IDENTIFIERS.map(([re, rep, kind]) => ({ kind, re: new RegExp(re), rep, group: 'identifier' as const })),
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
const GLUED_PREFIXES: readonly string[] = TABLES.get('GLUED_PREFIXES');
/**
 * What may sit right before a token (#889): an escape sequence (a coloured log line, `ESC[1m`, in any of the encodings
 * below) and a backslash escape in raw JSON or C-style text (`\n`, `\t`, `\"`). A cut point goes after each that ends
 * in a word character: a letter, a digit (`\u0026`, `ESC 7`) or `_` (gluePoints). Only the shapes with no distinctive prefix need it (Discord, Bearer, Basic, Stripe, `0x`,
 * a plain `sk-`, a JSON value): the others are found wherever their prefix is. Each start reads a bounded stretch,
 * but a CSI's parameter run: one scan each, linear.
 */
const GLUE_PARTS: readonly string[] = TABLES.get('GLUE_PARTS');
const GLUE = new RegExp(GLUE_PARTS.join('|'), 'g');

/**
 * Where a token may start glued to what is before it: after each GLUE match that ends in a letter, a digit or `_`, and
 * after `_` before a known prefix. After one that ends in anything else (`\/`, `\"`), every rule already sees a
 * boundary, and a cut there would split a value that holds it (`Bearer a\/b`, #996).
 */
function gluePoints(s: string): number[] {
  const cuts = [...s.matchAll(GLUE)].map((m) => m.index! + m[0].length).filter((c) => /\w/.test(s[c - 1]!));
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

/** The kind secretKinds names for a text it can't scan (#889 round 6): a caller that refuses a secret refuses it too. */
export const UNSCANNABLE_KIND = 'text too large to scan';

/**
 * The kinds of secret `s` looks like it holds (sorted, each once): names only, never a matched value. It is the default
 * mode's own matcher (#996): every pass of replaceUnion, the glue points included, and the kind of each rule that found
 * a span. So whenever `redactString(s)` changes the text, a kind is named (test/redact-kinds-match.test.ts). A text
 * with a run too long to scan (V8's RangeError, as in redactString) fails closed: it is named UNSCANNABLE_KIND.
 */
export function secretKinds(s: string): string[] {
  const kinds = new Set<string>();
  try {
    replaceUnion(s, false, (rank) => kinds.add(PATTERNS[rank]![2]));
  } catch (e) {
    if (e instanceof RangeError) return [UNSCANNABLE_KIND];
    throw e;
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

/** What a rule found: [start, end), what its replacement puts there, and the rule's place in its list. */
type Span = [number, number, string, number];

/**
 * Where `re` finds a secret in `t`, as [start, end) spans: each match's part its replacement takes out (what the match
 * and the replacement don't share at either end), so the scheme, the key's name or the separator a rule keeps is not
 * in the span; with what the replacement puts there instead. A match its replacement leaves as it was (a function
 * that judged it no secret) gives none.
 */
function spansOf(t: string, re: RegExp, rep: Replacement, rank: number, out: Span[]) {
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
    if (r === whole) {
      // A match the rule's function declined (no secret) hides nothing it stepped over (#889 round 7): the next search
      // starts at its next character, so a start inside it is still tried. Linear only for a rule whose starts are
      // bounded (a prefix group or a quote): test/redact-declined.test.ts holds every function-backed rule to both.
      g.lastIndex = m.index + 1;
      continue;
    }
    let a = 0;
    while (a < whole.length && a < r.length && whole[a] === r[a]) a++;
    let b = 0;
    while (b < whole.length - a && b < r.length - a && whole[whole.length - 1 - b] === r[r.length - 1 - b]) b++;
    if (whole.length - b > a) out.push([m.index! + a, m.index! + whole.length - b, r.slice(a, r.length - b), rank]);
  }
}

/** Every rule of the default mode: the shapes, each with its own marker. */
const SHAPE_RULES: readonly (readonly [RegExp, Replacement])[] = PATTERNS.map(([re, rep]) => [re, rep] as const);
/**
 * Every rule of the broad mode: the shapes and the broad rules, each shown with the default mask. Its own list in the
 * data (#941), written out: test/check-tables-sync.test.ts holds it equal to PATTERNS' rules then BROAD's.
 */
const BROAD_RULES: readonly (readonly [RegExp, Replacement])[] = Object.freeze(
  TABLES.get<readonly RuleData[]>('BROAD_RULES').map((e) => Object.freeze([regExpOf(e.re), replacementOf(e.rep)] as const)),
);

/**
 * What is wrong with the written-out tables against what this module built them from (#941), each in words; none when
 * they hold: BROAD_RULES is PATTERNS' rules then BROAD's (shown with [REDACTED]); the first pattern is the dashboard
 * key's (DASHBOARD_KEY_PREFIX, DASHBOARD_KEY_BODY), and GLUED_PREFIXES ends with that prefix. Compared as data.
 * Checked at load (it throws), so this module never redacts with tables that drifted; test/check-tables-sync.test.ts
 * tries each.
 */
export function redactTableProblems(
  patterns: readonly { re: Pattern; rep: unknown }[] = TABLES.get('PATTERNS'),
  broad: readonly { re: Pattern; mask: string }[] = TABLES.get('BROAD'),
  rules: readonly { re: Pattern; rep: unknown }[] = TABLES.get('BROAD_RULES'),
  glued: readonly string[] = GLUED_PREFIXES,
): string[] {
  const out: string[] = [];
  const key = (re: Pattern, rep: unknown) => JSON.stringify([re.source, re.flags, rep]);
  const want = [...patterns.map((p) => key(p.re, p.rep)), ...broad.map((b) => key(b.re, masked(b.mask, '[REDACTED]')))];
  const got = rules.map((r) => key(r.re, r.rep));
  if (want.length !== got.length || want.some((w, k) => w !== got[k])) out.push("BROAD_RULES isn't PATTERNS' rules then BROAD's");
  const first = patterns[0]?.re;
  if (first?.source !== `${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}(?![A-Za-z0-9_-])` || first.flags !== 'g') out.push("PATTERNS' first isn't the dashboard key's");
  if (glued.at(-1) !== DASHBOARD_KEY_PREFIX) out.push("GLUED_PREFIXES doesn't end with DASHBOARD_KEY_PREFIX");
  return out;
}
if (redactTableProblems().length) throw new Error(`src/events/redact.tables.json: ${redactTableProblems().join('; ')}`);

/** What every rule of `rules` finds in `s`: on the text as it was, and again with a boundary at each glue point. */
function allSpans(s: string, rules: readonly (readonly [RegExp, Replacement])[]): Span[] {
  const spans: Span[] = [];
  rules.forEach(([re, rep], i) => spansOf(s, re, rep, i, spans));
  readAt(s, gluePoints(s), rules, spans);
  return spans;
}

/**
 * The default mode (#889 round 6, the round-3+4 delta check's regression finding): every shape runs on the text as it
 * was (and from each glue point), and each run of overlapping spans is replaced once. Order-free by design: no rule's
 * match can take in the text another rule starts from (`wld_<key>-redis://u:<pw>@`, `<jwt>.Bearer <tok>`), so each
 * shape hides at least what it hid alone; test/redact-default-union.test.ts holds this against main's rules on
 * composed input. A span that is the whole run keeps its rule's marker (the first rule's, when several are); a run of
 * spans that only overlap becomes `[REDACTED]`. One pass of replaceUnion. `found` is told the rule of every span.
 */
function replaceOnce(s: string, keepLines: boolean, found?: (rank: number) => void): string {
  const spans = allSpans(s, SHAPE_RULES);
  if (found) for (const sp of spans) found(sp[3]);
  if (!spans.length) return s;
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1] || x[3] - y[3]);
  let out = '';
  let at = 0;
  for (let i = 0; i < spans.length; ) {
    const a = spans[i]![0];
    let b = spans[i]![1];
    let j = i + 1;
    for (; j < spans.length && spans[j]![0] < b; j++) b = Math.max(b, spans[j]![1]);
    let pick: Span | undefined;
    for (let k = i; k < j; k++) if (spans[k]![0] === a && spans[k]![1] === b && (!pick || spans[k]![3] < pick[3])) pick = spans[k];
    const rep = pick ? pick[2] : '[REDACTED]';
    out += s.slice(at, a) + rep + (keepLines ? '\n'.repeat(Math.max(0, breaks(s.slice(a, b)) - breaks(rep))) : '');
    at = b;
    i = j;
  }
  return out + s.slice(at);
}

/** How many passes a mode may take to reach a text no pass changes (fixedPoint). */
export const MAX_PASSES = 8;

/**
 * `pass` applied to `s`, then to what it gave, until it changes nothing, failing closed (#889 round 7): a text still
 * changing after MAX_PASSES passes becomes UNSCANNABLE (with `s`'s line breaks when `keepLines`), never the last pass's
 * output, which a further pass would have redacted more. Each pass reads the whole text: at most MAX_PASSES times
 * linear. No input measured so far needs a third pass.
 */
export function fixedPoint(s: string, pass: (t: string) => string, keepLines = false): string {
  let out = s;
  for (let i = 0; i < MAX_PASSES; i++) {
    const again = pass(out);
    if (again === out) return out;
    out = again;
  }
  return UNSCANNABLE + (keepLines ? '\n'.repeat(breaks(s)) : '');
}

/** The default mode: replaced again on what each pass gave until nothing changes. A marker can make a boundary a later rule needs, as main's rules, applied in turn, had. */
function replaceUnion(s: string, keepLines: boolean, found?: (rank: number) => void): string {
  return fixedPoint(s, (t) => replaceOnce(t, keepLines, found), keepLines);
}

/**
 * The broad mode (#889 round 3, the final check's regression finding): every rule runs on the text as it was, and the
 * union of the spans they find is masked, each run once, with `mask`. Order-free by design: no rule's marker can hide
 * what another rule would have found, so each rule masks at least what it masked alone (the modules' own rules on
 * main among them; test/redact-broad-union.test.ts compares them on generated input). The glue points (gluePoints)
 * are found the same way, on the text with a mark at each, mapped back. One pass of maskUnion.
 */
function maskOnce(s: string, mask: string, keepLines: boolean): string {
  // Every rule, on the text as it was and from each glue point (allSpans); then one more read with a boundary marked in
  // where a span found begins or ends between two word characters (a module's own rules, applied in turn, saw a
  // boundary where an earlier rule's replacement ended: `xoxa-...[here]_db_password=...`). Apart from the glue points,
  // so a boundary of one kind can't break a match the other needs.
  const spans = allSpans(s, BROAD_RULES);
  const word = (i: number) => /[A-Za-z0-9_]/.test(s[i] ?? '');
  readAt(s, [...new Set(spans.flatMap(([a, b]) => [a, b]))].filter((c) => c > 0 && c < s.length && word(c - 1) && word(c)).sort((a, b) => a - b), BROAD_RULES, spans);
  // What is already a mask stays as it is: a rule that takes in a mask word (`token=[REDACTED]`) adds nothing.
  const masks: [number, number][] = [];
  if (mask) for (let at = s.indexOf(mask); at !== -1; at = s.indexOf(mask, at + mask.length)) masks.push([at, at + mask.length]);
  const kept = outside(merged(spans.map(([a, b]): [number, number] => [a, b])), masks);
  if (!kept.length) return s;
  let out = '';
  let at = 0;
  for (const [a, b] of kept) {
    out += s.slice(at, a) + mask + (keepLines ? '\n'.repeat(breaks(s.slice(a, b))) : '');
    at = b;
  }
  return out + s.slice(at);
}

/** `spans` sorted and merged: no two overlap or touch. */
function merged(spans: [number, number][]): [number, number][] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Every one of `rules` on `s` with a boundary marked in at each of `cuts` (sorted), so a token glued to what is before
 * it is read from its start; the spans found, mapped back, go in `spans`. The boundary is a character no rule takes in
 * (a private-use one the text doesn't hold); when the text holds them all, each piece after a cut is read on its own.
 */
function readAt(s: string, cuts: number[], rules: readonly (readonly [RegExp, Replacement])[], spans: Span[]) {
  if (!cuts.length) return;
  const markChar = freeMark(s);
  if (markChar === null) {
    for (const [i, c] of cuts.entries()) {
      const piece = s.slice(c, cuts[i + 1] ?? s.length);
      const more: Span[] = [];
      rules.forEach(([re, rep], k) => spansOf(piece, re, rep, k, more));
      for (const [a, b, r, k] of more) spans.push([a + c, b + c, r, k]);
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
  const more: Span[] = [];
  rules.forEach(([re, rep], k) => spansOf(marked, re, rep, k, more));
  for (const [a, b, r, k] of more) spans.push([back(a), back(b), r.split(markChar).join(''), k]);
}

/**
 * The parts of `spans` outside every one of `regions`, both sorted and not overlapping: one walk over each, with the
 * regions' pointer only moving forward (#889 round 4: one loop over every region per span was quadratic).
 */
function outside(spans: [number, number][], regions: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let r = 0;
  for (const [a, b] of spans) {
    while (r < regions.length && regions[r]![1] <= a) r++;
    let from = a;
    for (let k = r; k < regions.length && regions[k]![0] < b; k++) {
      const [x, y] = regions[k]!;
      if (x > from) out.push([from, x]);
      from = Math.max(from, y);
    }
    if (from < b) out.push([from, b]);
  }
  return out;
}

/**
 * The broad mode: masked again on what each pass gave until nothing changes (fixedPoint). A mask can make a boundary a
 * later rule needs (`[REDACTED]_db_password=...`), as each module's own rules, applied in turn, did.
 */
function maskUnion(s: string, mask: string, keepLines: boolean): string {
  return fixedPoint(s, (t) => maskOnce(t, mask, keepLines), keepLines);
}

/** What a text becomes when it can't be scanned (#889 round 5): shown as nothing of it. */
export const UNSCANNABLE = '[REDACTED: too large to scan]';

export function redactString(s: string, o: RedactTextOptions = {}): string {
  try {
    return redactOrThrow(s, o);
  } catch (e) {
    // V8's backtracking stack overflows on one run of millions of characters after a prefix (`RangeError: Maximum
    // call stack size exceeded`): fail closed, with the text's line count kept for redactRecords.
    if (e instanceof RangeError) return UNSCANNABLE + (o.keepLines ? '\n'.repeat(breaks(s)) : '');
    throw e;
  }
}

function redactOrThrow(s: string, o: RedactTextOptions): string {
  const put = o.keepLines ? applyKeepingLines : apply;
  // Both modes read every rule on the text as it was, so no rule's match hides another's: the broad mode masks the
  // union of what the shapes and the broad rules find (maskUnion); the default mode replaces each run of what the
  // shapes find, with its rule's marker (replaceUnion).
  let out = o.broad ? maskUnion(s, o.mask ?? '[REDACTED]', o.keepLines === true) : replaceUnion(s, o.keepLines === true);
  if (o.identifiers) out = outsideMachineBlocks(out, (part) => IDENTIFIERS.reduce((t, [re, rep]) => put(t, re, rep), part));
  return out;
}

/** What a cut site reads past its cut before redacting (#889 round 4): enough for a token, or a key's END line. */
export const CUT_MARGIN = 16 * 1024;

/**
 * `s` redacted and then cut to `max` characters, reading only the first `max` + CUT_MARGIN of it (#889 round 4): a
 * token across the cut is redacted whole, and a private key across the window's end still fails closed (its BEGIN
 * with no END redacts to the end), while a huge input costs no more than the window. Synchronous callers (the
 * dashboard) stay responsive.
 */
export function redactCut(s: string, max: number, o: RedactTextOptions = {}): string {
  return redactClip(s, max, o).text;
}

/**
 * redactCut's text, and how many characters of it weren't shown (0: all of it was), for a store that marks its cuts
 * (#988): of the redacted text when all of `s` was read, else of `s` itself.
 */
export function redactClip(s: string, max: number, o: RedactTextOptions = {}): { text: string; more: number } {
  const windowed = s.length > max + CUT_MARGIN;
  const r = redactString(windowed ? readWindow(s, max + CUT_MARGIN) : s, o);
  if (!windowed && r.length <= max) return { text: r, more: 0 };
  return { text: r.slice(0, max), more: (windowed ? s.length : r.length) - max };
}

/**
 * The first `end` characters of `s` as a window to redact, ending at its last whitespace (#889 round 5): the raw end of
 * a window is never shown. A token cut by the window's end is too short for its rule, and redaction earlier in the
 * window (a key, an END line with no BEGIN) can shrink the text so far that the cut lands inside what is shown. No
 * token, URL user info or credential value holds whitespace, so ending at one drops the cut run whole; a window with no
 * whitespace at all is dropped (empty). A private key cut this way still fails closed by its BEGIN.
 */
export function readWindow(s: string, end: number): string {
  if (s.length <= end) return s;
  for (let i = end - 1; i >= 0; i--) if (/\s/.test(s[i]!)) return s.slice(0, i + 1);
  return '';
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
  if (value && typeof value === 'object') return Object.fromEntries(redactKeys(Object.entries(value), o)) as T;
  return value;
}

/**
 * An object's entries with each key redacted like a value (#972): a secret in a key's place is stored no more than one
 * in a value's. Every entry is kept: a key with no secret stays as it is, and a redacted key that would take another
 * entry's name (two secrets redacted alike, or a key that already reads like the redacted text) is numbered, ` (2)`
 * and on, in the entries' order.
 */
function redactKeys(entries: [string, unknown][], o: RedactTextOptions): [string, unknown][] {
  const keys = entries.map(([k]) => redactString(k, o));
  const used = new Set(entries.filter(([k], i) => keys[i] === k).map(([k]) => k));
  return entries.map(([k, v], i) => {
    let key = keys[i]!;
    if (key !== k) {
      const base = key;
      for (let n = 2; used.has(key); n++) key = `${base} (${n})`;
      used.add(key);
    }
    return [key, redact(v, o)];
  });
}
