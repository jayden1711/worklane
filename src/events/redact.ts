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
// 100 KB adversarial strings. No lookbehind, and no import: the updater's generated copy must load nothing
// (test/redact-vendored.test.ts), and src/ reaches no built-in by any other route (test/slot-path.test.ts).
//
// The tables below are read once, at load, into a frozen snapshot (snapshot): each regex rebuilt from its checked
// source, each marker copied as a primitive, each function kept as it is, and the redactor reads only the snapshot
// (#1257, R1258c/d: a value that differs between the check and the run, through an accessor, a Proxy, a later write or
// RegExp.prototype.compile, brought the leak back). No code runs from a table entry: test/redact-markers.test.ts holds
// every entry to data (a regex literal, a string or a template of literal consts, a pinned function, a string kind),
// pins every function in a table by its source text, and refuses any top-level binding here that isn't a frozen array,
// a literal, a function or a snapshot (R1258g/h: an entry's template span and a broad rule's arrow ran code at load).
type Replacement = string | ((match: string, ...groups: string[]) => string);

/** Credential-shaped: mixed case with a digit (a random key), or a long hex run (a classic token). */
function credentialShaped(v: string): boolean {
  return (hasChar(v, isLower) && hasChar(v, isUpper) && hasChar(v, isDigit)) || (v.length >= 32 && allChars(v, isHex));
}

/**
 * A value after `Basic` that is a credential, not a word: base64 with a digit, `+`, `/` or `=` in it, or a mixed-case
 * run of 16 or more characters whose length base64 can have (no padding: not 1 more than a multiple of 4).
 */
function basicShaped(v: string): boolean {
  return hasChar(v, (c) => isDigit(c) || c === '+' || c === '/' || c === '=') || (v.length >= 16 && v.length % 4 !== 1 && hasChar(v, isLower) && hasChar(v, isUpper)) || basicPair(v);
}
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
  return allChars(text, (c) => c >= ' ' && c <= '~') && hasChar(text, (c) => c === ':');
}

// The data the rules decide by is frozen arrays, never a Set, a Map or a RegExp in a module binding (R1258g/h: code that
// ran at load from a table entry reached KEY_QUALIFIERS.delete, CODE_HEADS.add and KEY_LINE.compile with every table
// line unchanged). A frozen array has no mutator that works; test/redact-markers.test.ts refuses any other top-level
// binding here.
/** A word that makes any key holding it a credential's: `db_password`, `slack_bot_token`, `aws_secret_access_key`. */
// check-table: never-shrink
const CREDENTIAL_WORDS = Object.freeze(['token', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'pass', 'passphrase', 'jwt', 'bearer', 'credential', 'credentials', 'authorization']);
/**
 * A word that ends in one of these is a credential word too: a name written as one word, with nothing to split on
 * (`csrftoken`, `clientsecret`, `adminpassword`, `secretaccesskey`). Only the end counts, so `tokenizer` and
 * `secretary` are not; `pass` and `pwd` count only whole (`compass`, `bypass`).
 */
// check-table: never-shrink
const CREDENTIAL_ENDINGS = Object.freeze(['token', 'secret', 'password', 'passwd', 'accesskey']);
function credentialWord(w: string): boolean {
  const o = intrinsics();
  return CREDENTIAL_WORDS.includes(w) || CREDENTIAL_ENDINGS.some((e) => o.endsWith(w, e));
}
/** The word before `key` that makes it a credential (`x-api-key`, `apiKey`, `signing_key`); `cacheKey`, `sort_key` are not. */
// check-table: never-shrink
const KEY_QUALIFIERS = Object.freeze(['api', 'access', 'secret', 'private', 'signing', 'encryption', 'master', 'client', 'app', 'auth', 'account', 'service', 'license', 'deploy', 'admin', 'webhook', 'session', 'ssh', 'hmac', 'consumer']);

/**
 * A JSON key that names a credential, by rule rather than a list: split into words (`_`, `-`, camelCase), it holds a
 * credential word (or a word ending in one), ends in `auth`, or is `key` on its own or after a qualifier (`apikey`
 * written as one word too).
 */
function credentialKey(k: string): boolean {
  const o = intrinsics();
  // The words: a break between a lower-case letter or digit and an upper-case one, between an upper-case letter and an
  // upper-case one followed by a lower-case one (camelCase, read as `([a-z0-9])([A-Z])` then `([A-Z])([A-Z][a-z])`
  // did), and at each run of `_`, `-` or spaces; lower-cased; empty words dropped.
  const words: string[] = [];
  let word = '';
  for (let i = 0; i < k.length; i++) {
    const c = k[i]!;
    const n = k[i + 1] ?? '';
    if (c === ' ' || c === '_' || c === '-') {
      if (word.length > 0) words.push(o.lower(word));
      word = '';
      continue;
    }
    word += c;
    if (((isLower(c) || isDigit(c)) && isUpper(n)) || (isUpper(c) && isUpper(n) && isLower(k[i + 2] ?? ''))) {
      words.push(o.lower(word));
      word = '';
    }
  }
  if (word.length > 0) words.push(o.lower(word));
  const last = words.at(-1) ?? '';
  if (words.some(credentialWord) || last === 'auth') return true;
  if (last === 'key') return words.length === 1 || KEY_QUALIFIERS.includes(words.at(-2)!);
  return o.endsWith(last, 'key') && KEY_QUALIFIERS.includes(o.slice(last, 0, -3));
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
export function isDashboardKey(key: string): boolean {
  return intrinsics().exec(new RegExp(`^${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}$`), key) !== null;
}

/**
 * `m` (the text up to its last END line) with everything up to its last END that no BEGIN opened redacted; as it was
 * when each END has its BEGIN. A BEGIN opens a key up to the next END, as the BEGIN rule reads it (#889 round 6: the
 * rules read the text as it was, so a closed key's END is still there, and it is not an orphan). One scan: linear.
 * The BEGIN/END line regex is this call's own (a literal here makes a new object each time): no module binding holds
 * a RegExp, which can't be frozen (R1258h's H1c recompiled one).
 */
function orphanEnd(m: string): string {
  const o = intrinsics();
  const keyLine = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;
  let open = false;
  let cut = -1;
  for (let k = o.exec(keyLine, m); k; k = o.exec(keyLine, m)) {
    if (k[1] === 'BEGIN') open = true;
    else if (open) open = false;
    else cut = k.index + k[0].length;
  }
  return cut === -1 ? m : `[REDACTED PRIVATE KEY]${o.slice(m, cut)}`;
}

/**
 * Why a string marker `rep` for `re` could put part of what `re` found into the "redacted" text (#1257), or null when
 * it can't. A marker may keep only what the match begins or ends with (a boundary, the scheme, a key's name), written
 * as `$1$2…` at its very start or `…$8$9` at its very end, where those groups are the first or the last things the
 * regex matches: a plain group (no quantifier, not inside another group, not after a top-level `|`), with only
 * zero-width items (`^`, `$`, `\b`, a lookaround) between. Then the marker's own text is all the span (spansOf)
 * becomes, and no group's text lies inside it. A reference anywhere else (`[REDACTED:$1_$2]`), `$&`, and a group that
 * can match inside the span (`(a|b)+`, a group after the secret's) are refused: with `$1`/`$2` for the key's own
 * groups, a rule added to PATTERNS gave `sk_[REDACTED:live_<key>]`, the key whole, and no test failed (R1184y's Y1).
 * `$<name>`, `` $` ``, `$'`, `$0` and `$nn` are refused too: expand and String.prototype.replace don't read them
 * alike. A regex this reader can't follow is refused as well (only a marker with a reference needs it read).
 * With `verbatim` (the identifier pass, which puts the marker's text out as it is, with nothing trimmed and no union
 * over other rules' spans), a kept group must be a boundary: each alternative `^`, one character, or literal text
 * (`(^|[^\w])`, `(^|[^\w.~/:-]|file:\/\/)`), so it can't hold the identifier itself (R1258b's B3: `$1$2-[email]`
 * with the address in group 2 passed, and the identifier pass showed it).
 * markersChecked runs it on every table at load, so a rule that could show a secret stops the module instead
 * (test/redact-markers.test.ts).
 */
export function markerProblem(re: RegExp, rep: string, verbatim = false): string | null {
  const refs: { n: number; at: number }[] = [];
  for (let i = 0; i < rep.length; i++) {
    if (rep[i] !== '$') continue;
    const c = rep[i + 1] ?? '';
    if (c === '$') {
      i++;
      continue;
    }
    if (c === '&') return '`$&` would put the whole match, the secret in it, in the marker';
    if (c === '`' || c === "'" || c === '<') return `\`$${c}\` isn't read alike by every replace path`;
    if (c === '0') return '`$0` names no group';
    if (/[1-9]/.test(c)) {
      if (/\d/.test(rep[i + 2] ?? '')) return `\`$${c}${rep[i + 2]}\`: a two-digit group reference isn't read alike by every replace path`;
      refs.push({ n: Number(c), at: i });
      i++;
    }
  }
  if (!refs.length) return null;
  const count = groupCount(re);
  for (const r of refs) if (r.n > count) return `\`$${r.n}\` names a group the regex doesn't have (it has ${count})`;
  const lead: number[] = [];
  while (refs[lead.length]?.at === lead.length * 2) lead.push(refs[lead.length]!.n);
  const trail: number[] = [];
  while (refs.length - trail.length > lead.length && refs[refs.length - 1 - trail.length]?.at === rep.length - 2 * (trail.length + 1)) trail.unshift(refs[refs.length - 1 - trail.length]!.n);
  if (lead.length + trail.length !== refs.length) return 'a group reference inside the marker would show what the group matched: a reference may only lead or trail it';
  if (rep.length === 2 * refs.length) return 'a marker of group references alone marks nothing';
  let parsed: ParsedRegex;
  try {
    parsed = parseRegex(re.source);
  } catch (e) {
    return `its regex can't be read for group references: ${(e as Error).message}`;
  }
  if (parsed.groups !== count) return "its regex can't be read for group references: the groups don't count up";
  const leading = leadingGroups(parsed.alternatives);
  for (const [k, n] of lead.entries()) if (leading[k] !== n) return `\`$${n}\` leads the marker, but group ${n} isn't what the match begins with (${these(leading)})`;
  const trailing = trailingGroups(parsed.alternatives);
  for (const [k, n] of trail.entries()) if (trailing[trailing.length - trail.length + k] !== n) return `\`$${n}\` trails the marker, but group ${n} isn't what the match ends with (${these(trailing)})`;
  if (verbatim) {
    for (const n of [...lead, ...trail]) {
      const g = parsed.alternatives[0]!.find((it) => it.kind === 'group' && it.capture === n);
      if (!g || g.kind !== 'group' || !boundaryGroup(g)) return `\`$${n}\` is put out as it is, so group ${n} must be a boundary (each alternative \`^\`, one character or literal text), not text of its own`;
    }
  }
  return null;
}

/**
 * Whether a group can hold nothing but a boundary: each alternative is `^` (or another zero-width item), one character
 * (a class, a character or an escape), or literal text (`file:\/\/`), none quantified. Such a group can't match an
 * identifier or a secret, so the identifier pass may put it out as it is.
 */
function boundaryGroup(g: Item & { kind: 'group' }): boolean {
  return g.alternatives.every((alt) => {
    const taking = alt.filter((it) => it.kind !== 'zero');
    if (taking.some((it) => it.quantified || it.kind === 'group' || it.kind === 'backref')) return false;
    return taking.length <= 1 || taking.every((it) => it.kind === 'atom');
  });
}

/** Which groups are, in words, for markerProblem's reasons. */
function these(groups: number[]): string {
  return groups.length === 0 ? 'no group is' : groups.length === 1 ? `group ${groups[0]} is` : `groups ${groups.join(', ')} are`;
}

/** The own property keys of `o`, strings and symbols, joined: what a plain regex has is exactly `lastIndex`. */
function ownKeys(o: object): string {
  return [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o).map((k) => String(k))].join();
}

/** How many capturing groups `re` has, as the engine counts them (an empty alternative matches with every group unset). */
function groupCount(re: RegExp): number {
  return new RegExp(`${re.source}|`, re.flags.replace(/[gy]/g, '')).exec('')!.length - 1;
}

/**
 * A rule as checked: the regex's source and flags as primitives (the regexes that run are built from them inside
 * `run`, below, and REDACTION_PATTERNS exports other copies: R1258e's E1 and E2, a RegExp object can't be frozen and
 * any holder of one can recompile it), the marker as a primitive string or the function the table gave, and the
 * kind. Frozen.
 */
interface Rule {
  readonly source: string;
  readonly flags: string;
  readonly rep: Replacement;
  readonly kind: string;
}

/**
 * The frozen copy of `table` this module runs, or the module doesn't load: a rule that could show a secret is refused
 * here, not found in a log. Every value is read exactly once, here, and the redactor reads only the copy (#1257,
 * R1258c/d: the check read a rule once and the run read it again, so an accessor on the rule, a Proxy around the
 * regex, an own Symbol.replace, a later write to the rule or the run's copy, and RegExp.prototype.compile each handed
 * the run a value the check never saw, and the Y1 leak came back in one line). So:
 * - the table is a plain array, each slot a data property; each rule a plain array whose own keys are exactly
 *   `0`, `1`, `2` and `length`, all data properties (no accessor, no own iterator, no symbol);
 * - the regex is a RegExp made by RegExp itself, with no own property but `lastIndex`; its `source` and `flags` are
 *   read once, as primitives, and the marker is checked against `new RegExp(source, flags)`. The regexes that run are
 *   built from the same primitives inside `run` (below), which no binding exposes, and REDACTION_PATTERNS exports
 *   copies of its own, so no later `compile` or write reaches what runs (R1258e's E1 and E2);
 * - the marker is a string, copied as a primitive and checked with markerProblem against the copy, or a function
 *   (code: trusted as reviewed, pinned by its exact source text in test/redact-markers.test.ts, and its result held
 *   by shown at run time as a backstop). Anything else is refused (R1258b's B1: a String object or an object with
 *   toString is no function, but String.prototype.replace reads it as a marker and expands its `$n`). With `broad`,
 *   the function is a broad rule's `(mask) => marker`, read once with the default mask; `verbatim` is the identifier
 *   pass (markerProblem);
 * - each rule and the copy are frozen. The table itself is frozen by the caller, so nothing changes it afterwards
 *   either (what it holds is not read again, but a frozen table says so).
 * A Proxy isn't told apart (node:util's isProxy can't be reached here: the updater's copy may load nothing, and src/
 * reaches no built-in another way), and needn't be: a Proxy around the table, a rule or a regex can only choose what
 * is read here, once, and what is read is what is checked and copied. Its traps are never called again. A Proxy in
 * a function's place is a function with another source text, which the pin refuses.
 */
function snapshot(table: readonly unknown[], o: { broad?: boolean; verbatim?: boolean } = {}): readonly Rule[] {
  // Typed in full, so each call narrows what follows (a never-returning function narrows only when declared so).
  const refuse: (who: string, why: string) => never = (who, why) => {
    throw new Error(`redaction rule ${who} could show a secret (#1257): ${why}`);
  };
  if (!Array.isArray(table)) refuse('table', 'a table must be a plain array');
  /** The value of a data property `k` of `o`, or a refusal for an accessor or a missing slot. */
  const data = (who: string, o: object, k: PropertyKey, what: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d) refuse(who, `${what} is missing`);
    if (!('value' in d)) refuse(who, `${what} must be a plain data property, not an accessor`);
    return d.value;
  };
  const rows: Rule[] = [];
  for (let i = 0; i < table.length; i++) {
    let who = `#${i}`;
    const entry = data(who, table, i, 'a table slot');
    // Plain: an array whose three slots are own data properties (read by descriptor, so no prototype of the array,
    // a subclass's included, can stand between). `constructor` is read nowhere in this module: the reference lint
    // refuses it, since it reaches a prototype.
    if (!Array.isArray(entry)) refuse(who, 'a rule must be a plain array [regex, marker, kind]');
    const keys = ownKeys(entry);
    if (keys !== '0,1,2,length') refuse(who, `a rule must be exactly [regex, marker, kind], with no other own property (own keys: ${keys})`);
    const kind = data(who, entry, 2, 'the kind');
    if (typeof kind !== 'string') refuse(who, 'the kind must be a string');
    who = `"${kind}"`;
    const re = data(who, entry, 0, 'the regex');
    // Compared with the module's name RegExp: no binding in this module may be named as a global (the test's binding
    // lint, R1258j's J1a), and this module's code reaches no global object and no prototype in any spelling (the
    // test's reference lint, by type and position, R1258n/o/p), so the name is the intrinsic.
    // A RegExp with no own property but lastIndex. Its `source` and `flags` are read once, below, and the copy made
    // from them is what runs: a subclass that reads them its own way names the pattern that runs, so it is checked
    // against what it names (and the data lint holds a table's regex to a literal anyway).
    if (!(re instanceof RegExp) || ownKeys(re) !== 'lastIndex') refuse(who, 'its regex must be a plain RegExp with no own property but lastIndex (one could hide the pattern that runs)');
    const source = `${re.source}`;
    const flags = `${re.flags}`;
    // The identifier pass replaces every match (replaced), so its rule must be global; refused here, not on the first
    // TRACKER call (R1258q's observation).
    if (o.verbatim && !flags.includes('g')) refuse(who, 'an identifier rule must be global');
    // The copy the marker is checked against; what runs is built again from the same primitives (run).
    const copy = new RegExp(source, flags);
    const rep = data(who, entry, 1, 'the marker');
    let marker: string | null = null;
    let kept: Replacement;
    if (typeof rep === 'string') kept = marker = `${rep}`;
    else if (typeof rep === 'function') {
      if (o.broad) {
        const shownAs: unknown = (rep as (mask: string) => unknown)('[REDACTED]');
        if (typeof shownAs !== 'string') refuse(who, 'a broad rule must give its marker as a string');
        kept = marker = `${shownAs}`;
      } else kept = rep as Replacement;
    } else refuse(who, `a marker must be a string or a function, not ${rep === null ? 'null' : typeof rep !== 'object' ? `a ${typeof rep}` : rep instanceof String ? 'a String object' : 'an object'}`);
    const why = marker === null ? null : markerProblem(copy, marker, o.verbatim === true);
    if (why !== null) refuse(who, why);
    rows.push(Object.freeze({ source, flags, rep: kept, kind }));
  }
  return Object.freeze(rows);
}

/**
 * An item of a regex's sequence, as markerProblem reads it: a group (capturing, or a lookaround), a backreference,
 * something zero-width (`^`, `$`, `\b`), one literal character (`a`, `\.`, `\u{28}`) or a class, which takes one of
 * several characters (`[a-z]`, `\d`, `.`, a named backreference too) (parseRegex).
 */
type Item =
  | { kind: 'group'; capture: number | null; look: 'ahead' | 'behind' | null; alternatives: Item[][]; quantified: boolean }
  | { kind: 'backref'; n: number; quantified: boolean }
  | { kind: 'zero' | 'atom' | 'class'; quantified: boolean };
interface ParsedRegex {
  alternatives: Item[][];
  groups: number;
}

/**
 * The structure of `source`, enough to tell which groups a match begins and ends with: groups (`(…)`, `(?:…)`,
 * `(?<name>…)`, `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)`), `|`, classes, escapes (`\1`, `\b`, `\u{…}`, `\p{…}`, `\k<…>`),
 * `^`, `$`, quantifiers (`*`, `+`, `?`, `{n,m}`, lazy too). It throws on a shape it doesn't know (a modifier group).
 */
function parseRegex(source: string): ParsedRegex {
  let i = 0;
  let groups = 0;
  const skipQuantifier = (): boolean => {
    const c = source[i];
    if (c === '*' || c === '+' || c === '?') i++;
    else {
      const m = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i));
      if (!m) return false;
      i += m[0].length;
    }
    if (source[i] === '?') i++;
    return true;
  };
  const item = (): Item => {
    const c = source[i]!;
    let it: Item;
    if (c === '(') {
      i++;
      let capture: number | null = null;
      let look: 'ahead' | 'behind' | null = null;
      if (source.startsWith('?:', i)) i += 2;
      else if (source.startsWith('?=', i) || source.startsWith('?!', i)) {
        look = 'ahead';
        i += 2;
      } else if (source.startsWith('?<=', i) || source.startsWith('?<!', i)) {
        look = 'behind';
        i += 3;
      } else if (source.startsWith('?<', i)) {
        const close = source.indexOf('>', i);
        if (close === -1) throw new Error(`an unclosed group name at ${i}`);
        i = close + 1;
        capture = ++groups;
      } else if (source[i] === '?') throw new Error(`a group of an unknown kind at ${i}`);
      else capture = ++groups;
      const alts = alternatives();
      if (source[i] !== ')') throw new Error(`an unclosed group at ${i}`);
      i++;
      it = { kind: 'group', capture, look, alternatives: alts, quantified: false };
    } else if (c === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
      if (source[i] !== ']') throw new Error('an unclosed class');
      i++;
      it = { kind: 'class', quantified: false };
    } else if (c === '\\') {
      const n = source[i + 1] ?? '';
      if (/[1-9]/.test(n)) {
        const m = /^\d+/.exec(source.slice(i + 1))!;
        i += 1 + m[0].length;
        it = { kind: 'backref', n: Number(m[0]), quantified: false };
      } else {
        let kind: 'zero' | 'atom' | 'class' = 'atom';
        if ((n === 'u' || n === 'p' || n === 'P') && source[i + 2] === '{') {
          const close = source.indexOf('}', i);
          if (close === -1) throw new Error(`an unclosed escape at ${i}`);
          i = close + 1;
          if (n !== 'u') kind = 'class';
        } else if (n === 'k' && source[i + 2] === '<') {
          const close = source.indexOf('>', i);
          if (close === -1) throw new Error(`an unclosed named backreference at ${i}`);
          i = close + 1;
          kind = 'class';
        } else if (n === '') throw new Error('a trailing backslash');
        else {
          i += 2;
          if (n === 'b' || n === 'B') kind = 'zero';
          else if ('dDwWsSpP'.includes(n)) kind = 'class';
        }
        it = { kind, quantified: false };
      }
    } else if (c === '^' || c === '$') {
      i++;
      it = { kind: 'zero', quantified: false };
    } else if (c === '*' || c === '+' || c === '?' || c === ')') throw new Error(`a stray \`${c}\` at ${i}`);
    else {
      i++;
      it = { kind: c === '.' ? 'class' : 'atom', quantified: false };
    }
    if (skipQuantifier()) it.quantified = true;
    return it;
  };
  const alternatives = (): Item[][] => {
    const alts: Item[][] = [[]];
    while (i < source.length && source[i] !== ')') {
      if (source[i] === '|') {
        i++;
        alts.push([]);
      } else alts.at(-1)!.push(item());
    }
    return alts;
  };
  const alts = alternatives();
  if (i < source.length) throw new Error(`a stray \`)\` at ${i}`);
  return { alternatives: alts, groups };
}

/**
 * The groups a match begins with, in order: plain groups (no quantifier) that are the first things the one top-level
 * alternative matches, with only zero-width items between (a lookaround included: it takes nothing). A lookahead whose
 * first item is a plain group, followed at once by a backreference to it (the JWT rule's `(?=(…)eyJ)\2`), counts as
 * that group: the backreference takes exactly the text the group found, from the same place.
 */
function leadingGroups(alternatives: Item[][]): number[] {
  if (alternatives.length !== 1) return [];
  const items = alternatives[0]!;
  const out: number[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (it.quantified) break;
    if (it.kind === 'zero') continue;
    if (it.kind !== 'group') break;
    if (it.look === null) {
      if (it.capture === null) break;
      out.push(it.capture);
      continue;
    }
    const first = it.look === 'ahead' && it.alternatives.length === 1 ? it.alternatives[0]![0] : undefined;
    const next = items[k + 1];
    if (first?.kind === 'group' && first.look === null && first.capture !== null && !first.quantified && next?.kind === 'backref' && next.n === first.capture && !next.quantified) {
      out.push(first.capture);
      k++;
    }
  }
  return out;
}

/** The groups a match ends with, in order: plain groups (no quantifier) that are the last things the one top-level alternative matches, with only zero-width items between. */
function trailingGroups(alternatives: Item[][]): number[] {
  if (alternatives.length !== 1) return [];
  const items = alternatives[0]!;
  const out: number[] = [];
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.quantified) break;
    if (it.kind === 'zero') continue;
    if (it.kind !== 'group') break;
    if (it.look !== null) continue;
    if (it.capture === null) break;
    out.unshift(it.capture);
  }
  return out;
}

// Each pattern with what kind of secret it finds (secretKinds names the kind, never the value). A string marker keeps
// only what the match begins or ends with (markerProblem, #1257): `$1[REDACTED]` for a boundary group, never
// `[REDACTED:$1]`.
// check-table: never-shrink
const PATTERNS: [RegExp, Replacement, string][] = [
  // A dashboard key, wherever its prefix is (after a `-` or a letter too: `key-wld_...`): a match runs to the end of its
  // run of key characters and the next search starts after it, so linear.
  // Written out as a literal: a table entry's regex is a regex literal, never a construction (test/redact-markers.test.ts
  // holds it equal to DASHBOARD_KEY_PREFIX + DASHBOARD_KEY_BODY; R1258j's J1a: `new RegExp` in an entry called a
  // module-level name at load).
  [/wld_[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, `${DASHBOARD_KEY_PREFIX}[REDACTED]`, 'dashboard key'],
  // A shape with a distinctive prefix is found wherever the prefix is (#889 round 4): no left boundary, so whatever is
  // glued before it (a name, an escape sequence in any encoding, a digit) can't hide it. Each such match runs to the end
  // of its run and the next search starts after it: linear. Only shapes with no distinctive prefix keep a boundary.
  // The token's end: no letter or digit after it, so `ghp_..._backup` is found too (a `\b` there needs a non-word).
  [/gh[pousr]_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g, 'gh*_[REDACTED]', 'GitHub token'],
  [/github_pat_[A-Za-z0-9_]{40,}/g, 'github_pat_[REDACTED]', 'GitHub token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]', 'API key (sk-)'],
  // Other `sk-` keys: `sk-` alone is no distinctive prefix (`task-`, `disk-`), so after a boundary.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]', 'API key (sk-)'],
  // Stripe secret and restricted keys, live and test: random, so with a digit (a long camelCase name after the
  // prefix, with no digit, is a code identifier).
  [/(^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g, (m, pre, k, v) => (hasChar(v!, isDigit) ? `${pre}${k}_[REDACTED]` : m), 'Stripe key'],
  // Google API keys: AIza and 35 more characters.
  [/AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, 'AIza[REDACTED]', 'Google API key'],
  // JSON Web Tokens: a base64 JSON header (so `eyJ` and 8 or more), a payload of 8 or more and a signature (empty when
  // unsigned). Any further dotted parts go with it, empty ones too (#889 rounds 3 and 7): a JWE has five, and a token
  // may be followed by more. A part is base64url or standard base64 (`+`, `/`), and may end in `=` padding (#996).
  // - The header is found in any part, glued after anything in it (`x<jwt>`, `%3D<jwt>`, `name.<jwt>`): the match
  //   starts at a part's start (after a character no part holds: `.`, a space, `%`, `=`), and a lookahead looks in that
  //   part for `eyJ`. It can't leave its part, so each part is read once from its start: linear.
  // - Each of the header and the payload is read whole, with no way back into it (a lookahead takes the run, a
  //   backreference steps over it), with no bound on its length (an `x5c` chain makes a header several KB, round 5):
  //   a run of millions of characters is passed in one step, not given back a character at a time until V8's
  //   backtracking stack overflows (round 6).
  // - A plain replacement: no match is declined, so nothing the search steps over can hide a token (round 7).
  [
    /(^|[^A-Za-z0-9_+/-])(?=([A-Za-z0-9_+/-]*?)eyJ)\2eyJ(?=[A-Za-z0-9_+/-]{8})(?=([A-Za-z0-9_+/-]+))\3=*\.(?=[A-Za-z0-9_+/-]{8})(?=([A-Za-z0-9_+/-]+))\4=*\.[A-Za-z0-9_+/=-]*(?:\.[A-Za-z0-9_+/=-]*)*/g,
    '$1$2[REDACTED JWT]',
    'JWT',
  ],
  [/(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, 'AKIA[REDACTED]', 'AWS access key'],
  // Slack's token-rotation and refresh tokens (xoxe-..., xoxe.xoxb-...), before the
  // other Slack tokens (one is inside it); then its app-level token (xapp-, Socket Mode).
  [/xoxe[.-][A-Za-z0-9.-]{10,}(?![A-Za-z0-9])/g, 'xoxe-[REDACTED]', 'Slack token'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g, 'xox-[REDACTED]', 'Slack token'],
  [/xapp-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g, 'xapp-[REDACTED]', 'Slack app-level token'],
  // Linear personal API keys and OAuth tokens.
  [/lin_(?:api|oauth)_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, 'lin_[REDACTED]', 'Linear key'],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'https://hooks.slack.com/services/[REDACTED]', 'Slack webhook'],
  // Tailscale auth keys, API tokens and OAuth client secrets (tskey-auth-..., tskey-api-..., tskey-client-...): the
  // prefix and the rest of its run, however short (src/tailscale-setup.ts redacted them this way on its own).
  [/tskey-[A-Za-z0-9_-]+/g, 'tskey-[REDACTED]', 'Tailscale key'],
  // A private key (PEM, and PGP's PRIVATE KEY BLOCK), failing closed (#889): from its BEGIN line to its END line, or
  // to the end of the text when no END follows (a key cut short, or still being written); then, for an END line with
  // no BEGIN before it (a key whose start is above a window), from the start of the text to that END line. Each BEGIN
  // is read once (its match runs to its END or to the end), and the second rule has one start: linear.
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/g, '[REDACTED PRIVATE KEY]', 'private key'],
  [/^[\s\S]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/, orphanEnd, 'private key'],
  // The scheme is case-insensitive (RFC 9110): any case (#889). `bearer` is a word, so after a boundary. A `/` may be
  // written JSON-escaped (`\/`), in this rule and the Basic one (#996).
  [/\b(bearer)\s+(?:[A-Za-z0-9._~+/-]|\\\/){20,}=*/gi, '$1 [REDACTED]', 'bearer token'],
  // HTTP Basic credentials (base64 of user:password; git's extraheader, src/dashboard-auth.ts's client id and secret),
  // failing closed: any credential-looking value after the scheme. Prose ("Basic Authentication") has no digit, `+`,
  // `/` or `=`, and isn't a mixed-case run of a base64 length. The value ends where its run and padding end, whatever is
  // glued after it (#889 round 7: a check that nothing followed left `Basic <value>==<more>` to a later pass, after
  // another rule's marker made the boundary; broad mode, which masks that rule's text, showed it).
  [/\b(basic)(\s+)((?:[A-Za-z0-9+/]|\\\/){8,}={0,2})/gi, (m, s, sp, v) => (basicShaped(v!) ? `${s}${sp}[REDACTED]` : m), 'Basic credential'],
  // Credentials inside connection strings: keep scheme, user and host. The last 1 to 32 characters of the scheme right
  // before `://`, from any start (#889 round 4: from `\b` with any length it was quadratic on a long dotted run): each
  // start reads at most 33 characters, and each `://` is reached from at most 32 starts, so linear. No letter is
  // required among them (round 8: a scheme whose last 32 characters are digits or `-` was main's too), so every match
  // main's rule made, with at least one scheme character before `://`, this one makes.
  [/([a-z0-9+.-]{1,32}:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:[REDACTED]@', 'password in a URL'],
  // 0x-prefixed 32-byte hex (EVM private keys and the like).
  [/\b0x[0-9a-fA-F]{64}(?![A-Za-z0-9])/g, '0x[REDACTED-32-BYTES]', '32-byte hex key'],
  // A JSON string value under a credential key (credentialKey: "aws_secret_access_key", "db_password", "x-api-key",
  // "slack_bot_token", "authorization", ...), also inside an escaped JSON string (\"token\":\"...\"). Not "cacheKey"
  // or "sort_key", and only a credential-shaped value (16 or more characters; mixed case with a digit, or long hex),
  // so {"key": "issue-644"}, {"token": "intake.triaged.v2"} and a UUID stay. The key is judged in a function, so the
  // regex only reads one run of key characters from each quote. Other languages' dictionary literals too (#996): single
  // quotes (Python's `{'password': '...'}`), each string quoted on its own, and `=>` (Ruby, PHP).
  [
    /(\\?"|')([A-Za-z0-9_-]+)\1(\s*(?::|=>)\s*)(\\?"|')([A-Za-z0-9_\-.+/=~]{16,})\4/g,
    (m, q, k, sep, vq, v) => (credentialKey(k!) && credentialShaped(v!) ? `${q}${k}${q}${sep}${vq}[REDACTED]${vq}` : m),
    'secret under a JSON key',
  ],
  // A Discord bot token: three base64url parts (the bot's id, a timestamp, an HMAC). Last, as src/watchdog/incidents.ts
  // applied it after the rest (#889: it was redacted only there; there it started at `\b`, here after any character
  // but a letter or digit, so `x_<token>` is found too). It may start inside a run of `-` or `_`, but the first part
  // is bounded (23 to 28 characters, then a dot), so each start reads a bounded stretch: linear (redact-shapes.test.ts).
  [/(^|[^A-Za-z0-9])[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, '$1[REDACTED]', 'Discord bot token'],
];
// Read once, by build() below (BUILT): the only reading of PATTERNS, which build() freezes.
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
// check-table: never-shrink
const BROAD: [RegExp, (mask: string) => string, string][] = [
  // Wherever the prefix is, as in PATTERNS (#889 round 4).
  [/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, (k) => k, 'GitHub token, cut short'],
  [/sk-ant-[A-Za-z0-9_-]+/g, (k) => k, 'Anthropic key, cut short'],
  // The root updater's own token rule on main, as it was: where it ends (a GitHub token's run of letters and digits, a
  // Slack token's before a `_`) is where its next rule saw a boundary (maskUnion reads again there).
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})/g, (k) => k, "the updater's token rule"],
  [/xox[abprs]-[A-Za-z0-9_-]+/g, (k) => k, 'Slack token, cut short'],
  [/eyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g, (k) => k, 'JWT after a hyphen'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (k) => `$1 ${k}`, 'short bearer token'],
  // The last 1 to 32 characters of a scheme right before `://`, from any start (after `-`, `.`, `+` or a letter too: the
  // updater's own rule started at any `\b`, a scheme of any length; no letter required, round 8): each start reads at
  // most 33 characters, and each `://` is reached from at most 32 starts, so linear.
  [/([a-z0-9+.-]{1,32}:\/\/)[^\s/@]+@/gi, (k) => `$1${k}@`, 'user info in a URL'],
  [/\b([A-Za-z_]*(?:token|secret|password|passwd|api[_-]?key))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, (k) => `$1$2${k}`, 'value after a secret name'],
];
// A broad rule's marker only places its span (spansOf); read once as shown with the default mask (snapshot). The arrow
// is data by the lint (test/redact-markers.test.ts): `(k) => k` or a template of literals and `k`, nothing else, so the
// call here runs no code of its own (R1258h's H1), and each arrow is pinned by its source text.
// Read once, by build() below (BUILT), which freezes it.

/**
 * The first word of a dotted name that is code, not a host: `this.internal`, `opts.corp`, `config.lan.x`. Only
 * receivers no one names a machine after: `app`, `data` and `node` are left out, since `app.internal` (one app on a
 * private network), `data.corp` and `node.cluster.local` are hosts.
 */
const CODE_HEADS = Object.freeze(['this', 'self', 'super', 'opts', 'options', 'o', 'ctx', 'context', 'config', 'cfg', 'conf', 'settings', 'props', 'state', 'env', 'process', 'module', 'exports', 'window', 'document', 'globalThis', 'args', 'params', 'req', 'res', 'request', 'response', 'obj', 'result', 'item', 'e', 'err', 'x']);

/**
 * A dotted name under a private-use suffix is a host, one plain word included (`nas.lan`, `vault.internal`): a false
 * positive costs a few characters, a false negative names a machine. It is code only when no label has a hyphen (an
 * identifier can't) and it starts with a usual receiver (`this.internal`, `this.config.internal`) or a label is
 * camelCase (`someObj.lan`). And it is prose when the suffix is in mixed case (`passed.Internal`, a missing space):
 * a host name is written in one case.
 */
function internalHost(m: string, pre: string, name: string): string {
  const o = intrinsics();
  const lower = o.lower(name);
  const labels = o.split(name, '.').slice(0, o.endsWith(lower, '.home.arpa') || o.endsWith(lower, '.ts.net') ? -2 : -1);
  const suffix = o.slice(name, labels.join('.').length + 1);
  const prose = suffix !== o.lower(suffix) && suffix !== o.upper(suffix);
  // camelCase: a lower-case letter right before an upper-case one.
  const camel = (l: string): boolean => {
    for (let i = 0; i + 1 < l.length; i++) if (isLower(l[i]!) && isUpper(l[i + 1]!)) return true;
    return false;
  };
  const code = !labels.some((l) => o.includes(l, '-')) && (CODE_HEADS.includes(labels[0]!) || labels.some(camel));
  return prose || code ? m : `${pre}[internal-host]`;
}

// The private IPv4 rule below is written out as one regex literal (a table entry's regex is a literal, never a
// construction: test/redact-markers.test.ts, the data lint). Read it as: a boundary; one of the private ranges, in order
// 10/8, 172.16/12, 192.168/16, the shared range (RFC 6598: carrier NAT and tailnets, 100.64/10) and link-local
// (169.254/16, cloud metadata among it); two more octets, each `(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`; no word character
// or further octet after. The test holds the literal equal to that composition.

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
  [/(^|[^\w.])(?:10\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w-]|\.\d)/g, '$1[private-ip]', 'private IP'],
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) addresses.
  [/(^|[^\w:])f(?:[cd][0-9a-f]{2}|e[89ab][0-9a-f]):(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}(?![\w:])/gi, '$1[private-ip]', 'private IP'],
];
// The identifier pass puts a marker out as it is (apply), so a kept group must be a boundary (verbatim: build()).

/**
 * Every pattern with its kind, for the linear-time test (test/redact.test.ts) and the shape tests
 * (test/redact-shapes.test.ts): `secret` for a secret's pattern (applied by default), `broad` for one applied with
 * `broad: true` (shown with the default mask), `identifier` for one applied with `identifiers: true`.
 */
export interface RedactionPattern {
  readonly kind: string;
  readonly re: RegExp;
  readonly rep: Replacement;
  readonly group: 'secret' | 'broad' | 'identifier';
}
export function redactionPatterns(): readonly RedactionPattern[] {
  return BUILT.patterns;
}

/**
 * Everything built from the tables, built once here, by the one call this module makes at the top level (R1258k/l:
 * any other top-level call or construction ran code at load; the lint in test/redact-markers.test.ts refuses every
 * top-level statement but a function declaration, a literal const, this call and the exports). build() reads each
 * table once into its snapshot (and freezes the table), builds the regexes that run inside its closure, and exports
 * copies for the listing.
 */
// BUILT, the builder call, is the last statement of this module: every data const it reads is declared above it.

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
// check-table: never-shrink
const GLUED_PREFIXES = Object.freeze(['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'sk-', 'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'xoxa-', 'xoxb-', 'xoxe', 'xoxp-', 'xoxr-', 'xoxs-', 'xapp-', 'lin_api_', 'lin_oauth_', 'AKIA', 'ASIA', 'AIza', 'eyJ', '0x', 'Bearer', 'bearer', 'BEARER', 'Basic', 'basic', 'BASIC', DASHBOARD_KEY_PREFIX]);
/**
 * What may sit right before a token (#889): an escape sequence (a coloured log line, `ESC[1m`, in any of the encodings
 * below) and a backslash escape in raw JSON or C-style text (`\n`, `\t`, `\"`). A cut point goes after each that ends
 * in a word character: a letter, a digit (`\u0026`, `ESC 7`) or `_` (gluePoints). Only the shapes with no distinctive prefix need it (Discord, Bearer, Basic, Stripe, `0x`,
 * a plain `sk-`, a JSON value): the others are found wherever their prefix is. Each start reads a bounded stretch,
 * but a CSI's parameter run: one scan each, linear.
 */
// check-table: never-shrink
const GLUE_PARTS = Object.freeze([
  // ESC as the byte, as a JSON or C escape (`\u001b`, `\x1b`, `\033`, `\e`) or in caret notation (`^[`), then a whole
  // sequence: a CSI with its parameters (`[1m`), an nF one (`(B`), or one character (`7`, `8`, `c`).
  // (Plain string literals, every backslash doubled: a tagged template is a call, which no top-level statement may
  // make: R1258k/l.)
  '(?:\\u001b|\\\\u001[bB]|\\\\x1[bB]|\\\\033|\\\\e|\\^\\[)(?:\\[[0-?]*[ -/]*[@-~]|[ -/]+[0-~]|[0-~])',
  // The 8-bit CSI.
  '\\u009b[0-?]*[ -/]*[@-~]',
  // A backslash escape in raw JSON or C-style text.
  '\\\\(?:u[0-9A-Fa-f]{4}|[nrtbf"\\\\/])',
]);

/**
 * Where a token may start glued to what is before it: after each match of `glue` (GLUE_PARTS as one regex, built once
 * inside `run`: no module binding holds a RegExp) that ends in a letter, a digit or `_`, and after `_` before a known
 * prefix. After one that ends in anything else (`\/`, `\"`), every rule already sees a boundary, and a cut there would
 * split a value that holds it (`Bearer a\/b`, #996).
 */
function gluePoints(s: string, glue: RegExp, prefixes: readonly string[], ops: Ops): number[] {
  // The glue regex is a run copy: searched with the captured exec, like every other.
  const cuts: number[] = [];
  glue.lastIndex = 0;
  for (let m = ops.exec(glue, s); m; m = ops.exec(glue, s)) {
    const c = m.index + m[0].length;
    if (m[0].length === 0) glue.lastIndex = m.index + 1;
    if (isWordChar(s[c - 1]!)) cuts.push(c);
  }
  for (let at = ops.indexOf(s, '_'); at !== -1; at = ops.indexOf(s, '_', at + 1)) if (prefixes.some((p) => ops.startsWith(s, p, at + 1))) cuts.push(at + 1);
  return [...new Set(cuts)].filter((c) => c < s.length).sort((a, b) => a - b);
}

/** A character `s` doesn't hold (a private-use one), to mark the cut points with; null when it holds them all. */
function freeMark(s: string): string | null {
  const o = intrinsics();
  const held = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const c = o.codeAt(s, i);
    if (c >= 0xe000 && c <= 0xf8ff) held.add(c);
  }
  for (let c = 0xe000; c <= 0xf8ff; c++) if (!held.has(c)) return String.fromCharCode(c);
  return null;
}

/**
 * `$1`, `$&` and `$$` in a replacement string, as String.prototype.replace reads them (markerProblem refuses every
 * other `$` form at load). One scan of the marker, with no regex: what a marker puts out is never found by a
 * prototype's exec (R1258o/p).
 */
function expand(rep: string, m: string, groups: unknown[]): string {
  let out = '';
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i]!;
    const k = c === '$' ? (rep[i + 1] ?? '') : '';
    if (k === '$') {
      out += '$';
      i++;
    } else if (k === '&') {
      out += m;
      i++;
    } else if (k >= '0' && k <= '9') {
      out += String(groups[Number(k) - 1] ?? '');
      i++;
    } else out += c;
  }
  return out;
}
/**
 * What a function-backed rule's replacement `r` for the match `whole` may show (#1257, R1258b's B2): `r`, unless the
 * part of it that stands for what it replaced (what `whole` and `r` don't share at either end, as spansOf cuts the
 * span) holds that replaced text, or a group's text of 4 or more characters that the replaced text holds. Then the
 * replacement fails closed: that part becomes `[REDACTED]`. A one-line function that echoes the key's groups
 * (`` (m, a, b) => `[REDACTED:${a}_${b}]` ``) showed the key, while every hold and test passed; the string markers
 * can't (markerProblem), and a function is held to the same at run time. Costs one scan of the replaced text per
 * group that stands in the marker.
 */
function shown(whole: string, groups: readonly string[], r: string): string {
  if (r === whole) return r;
  let a = 0;
  while (a < whole.length && a < r.length && whole[a] === r[a]) a++;
  let b = 0;
  while (b < whole.length - a && b < r.length - a && whole[whole.length - 1 - b] === r[r.length - 1 - b]) b++;
  // Compared in one case (an echo lowercased is still the secret). A backstop for a literal echo only: a piecewise,
  // reversed or encoded echo is code a reviewer reads, held by the function's pin in test/redact-markers.test.ts.
  const o = intrinsics();
  const taken = o.lower(o.slice(whole, a, whole.length - b));
  const put = o.lower(o.slice(r, a, r.length - b));
  if (!taken || (!o.includes(put, taken) && !groups.some((g) => g.length >= 4 && o.includes(put, o.lower(g)) && o.includes(taken, o.lower(g))))) return r;
  return `${o.slice(whole, 0, a)}[REDACTED]${o.slice(whole, whole.length - b)}`;
}

/** A rule's function, called with the match and its groups as strings, its result guarded (shown). */
function called(rep: (match: string, ...groups: string[]) => string, m: string, groups: string[]): string {
  return shown(m, groups, rep(m, ...groups));
}

/** The options for text bound for an issue, a comment or a pull request (src/backlog): secrets and identifiers. */
export const TRACKER: Readonly<RedactTextOptions> = Object.freeze({ identifiers: true });

/**
 * Every match of the global run copy `re` in `s` replaced by `rep` (the identifier pass): a string marker expanded as
 * String.prototype.replace reads it (expand), a function guarded (called); with `keepLines`, each replacement keeps
 * as many line breaks as what it replaced. Searched with the captured exec only, never String.prototype.replace,
 * which looks a regex's Symbol.replace and exec up on the prototype at each call (R1258o/p). An empty match moves on
 * one character, as replace does.
 */
function replaced(s: string, re: RegExp, rep: Replacement, keepLines: boolean, ops: Ops): string {
  if (!re.global) throw new Error("replaced needs the run closure's global regex");
  let out = '';
  let at = 0;
  re.lastIndex = 0;
  for (let m = ops.exec(re, s); m; m = ops.exec(re, s)) {
    const whole = m[0];
    const groups = m.slice(1).map((x) => (typeof x === 'string' ? x : ''));
    const r = typeof rep === 'string' ? expand(rep, whole, groups) : called(rep, whole, groups);
    out += ops.slice(s, at, m.index) + r + (keepLines ? ops.repeat('\n', Math.max(0, breaks(whole) - breaks(r))) : '');
    at = m.index + whole.length;
    if (whole.length === 0) {
      if (m.index >= s.length) break;
      re.lastIndex = m.index + 1;
    }
  }
  return out + ops.slice(s, at);
}

/**
 * Fenced blocks the harness parses back out of an issue (```done_when, src/backlog/types.ts parseContract and
 * contractKey; ```research, src/research.ts): the identifier pass leaves them byte for byte, or a contract's command
 * would change or stop parsing. Secrets are still redacted inside them. Only an opener its parser would take counts:
 * the fence word then a line break, with nothing but blanks between (parseContract's `\s*\n`, research's
 * `[ \t]*\r?\n`), so a mention in prose (`add a ```done_when block.`) leaves the text after it redacted. Found with
 * indexOf and a sticky check at each opener, not a scan: linear.
 */
// Each opener with the source of its sticky line-break check: data, frozen; the regex is built per call (R1258h's H1d
// pushed a plain ``` opener onto this list from a table entry).
const MACHINE_BLOCKS = Object.freeze([Object.freeze(['```done_when', '[^\\S\\n]*\\n'] as const), Object.freeze(['```research', '[ \\t]*\\r?\\n'] as const)]);
function outsideMachineBlocks(s: string, f: (part: string) => string): string {
  const o = intrinsics();
  const spans: [number, number][] = [];
  for (const [open, lineBreakSource] of MACHINE_BLOCKS) {
    const lineBreak = new RegExp(lineBreakSource, 'y');
    for (let at = o.indexOf(s, open); at !== -1; ) {
      lineBreak.lastIndex = at + open.length;
      if (o.exec(lineBreak, s) === null) {
        at = o.indexOf(s, open, at + open.length);
        continue;
      }
      // The block's body starts after the opener's line break; the first line that starts with ``` closes it.
      const close = o.indexOf(s, '\n```', lineBreak.lastIndex);
      if (close === -1) break;
      spans.push([at, close + 4]);
      at = o.indexOf(s, open, close + 4);
    }
  }
  if (!spans.length) return f(s);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let from = 0;
  for (const [a, b] of spans) {
    if (a < from) continue;
    out += f(o.slice(s, from, a)) + o.slice(s, a, b);
    from = b;
  }
  return out + f(o.slice(s, from));
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
    replaceUnion(s, false, (rank) => kinds.add(BUILT.shapes[rank]!.kind));
  } catch (e) {
    if (e instanceof RangeError) return [UNSCANNABLE_KIND];
    throw e;
  }
  return [...kinds].sort();
}

/** What a rule found: [start, end), what its replacement puts there, and the rule's place in its list. */
type Span = [number, number, string, number];

/**
 * Where `re` finds a secret in `t`, as [start, end) spans: each match's part its replacement takes out (what the match
 * and the replacement don't share at either end), so the scheme, the key's name or the separator a rule keeps is not
 * in the span; with what the replacement puts there instead. A match its replacement leaves as it was (a function
 * that judged it no secret) gives none.
 */
function spansOf(t: string, re: RegExp, rep: Replacement, rank: number, out: Span[], ops: Ops) {
  // The rule's global copy, built inside `run` from the snapshot's primitives, searched with the captured exec only.
  if (!re.global) throw new Error("spansOf needs the run closure's global regex");
  const g = re;
  g.lastIndex = 0;
  for (let m = ops.exec(g, t); m; m = ops.exec(g, t)) {
    const whole = m[0];
    // The next search starts 64 characters before the match's end, not after it: a value a rule takes in may hold the
    // next secret's name (`token='abc password = 'x`, `Bearer abc+Bearer xyz`), and that next match must still be
    // found. Each match start is after the last one's, and at most 64 characters are read again: linear.
    g.lastIndex = Math.max(m.index + 1, m.index + whole.length - 64);
    const groups = m.slice(1).map((x) => x ?? '');
    // A function's result is guarded (shown): one that echoes what it replaced puts `[REDACTED]` there instead.
    const r = typeof rep === 'string' ? expand(rep, whole, groups) : called(rep, whole, groups);
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
    if (whole.length - b > a) out.push([m.index! + a, m.index! + whole.length - b, ops.slice(r, a, r.length - b), rank]);
  }
}

/**
 * Every rule of the broad mode, as the rule sets it runs, in order: the shapes (PATTERNS' snapshot), then the broad
 * rules (BROAD's, each shown with the default mask). build() reads it; a set dropped is a weakening (never-shrink).
 */
// check-table: never-shrink
const BROAD_RULES = Object.freeze(['shapes', 'broad'] as const);

/** What build() makes of the tables: the snapshots, the listing's copies, and the closure that runs (`run`). */
/**
 * The intrinsics the run-time code uses, and nothing else of a regex or a string: RegExp's own exec and String's own
 * methods, read once at load from fresh literals (capture), each bound to Function.prototype.call read at the same
 * time, so a call is `exec(re, s)`, `slice(s, a, b)`: nothing is looked up on a prototype at run time, and a built-in
 * patched after load, from this module or any other, changes nothing that is redacted (R1258q's D1, R1258r's R2: the
 * run copies were searched with a captured exec, but a rule function's `/\d/.test(v)` and the helpers' `.slice`
 * still ran the prototype's, and a patch of `exec` for `\d` on long inputs showed a 130-character key). Character
 * classes a rule decides by (`\d`, `\w`, `\s`, a letter's case) are comparisons on characters, with no regex at all.
 */
interface Ops {
  readonly exec: (re: RegExp, s: string) => RegExpExecArray | null;
  readonly slice: (s: string, a: number, b?: number) => string;
  readonly indexOf: (s: string, x: string, from?: number) => number;
  readonly includes: (s: string, x: string) => boolean;
  readonly startsWith: (s: string, x: string, at?: number) => boolean;
  readonly endsWith: (s: string, x: string) => boolean;
  readonly lower: (s: string) => string;
  readonly upper: (s: string) => string;
  readonly repeat: (s: string, n: number) => string;
  readonly split: (s: string, sep: string) => string[];
  readonly codeAt: (s: string, i: number) => number;
}

/**
 * The one place this module reads a method of a regex or a string as a value: build's first call, before any table is
 * read. Each intrinsic is bound to Function.prototype.call (`call.bind(f)` gives `(self, ...args) => f.call(self,
 * ...args)` with the binding's own slots, so no later patch of `call`, `bind`, `exec` or a String method reaches it).
 * The reference lint in test/redact-markers.test.ts holds this function to its exact text and refuses, everywhere
 * else in the module, every method call on a regex or a string value and every reach to a prototype.
 */
function captured(): Ops {
  const call = (() => undefined).call;
  return Object.freeze({
    exec: call.bind(/(?:)/.exec) as Ops['exec'],
    slice: call.bind(''.slice) as Ops['slice'],
    indexOf: call.bind(''.indexOf) as Ops['indexOf'],
    includes: call.bind(''.includes) as Ops['includes'],
    startsWith: call.bind(''.startsWith) as Ops['startsWith'],
    endsWith: call.bind(''.endsWith) as Ops['endsWith'],
    lower: call.bind(''.toLowerCase) as Ops['lower'],
    upper: call.bind(''.toUpperCase) as Ops['upper'],
    repeat: call.bind(''.repeat) as Ops['repeat'],
    split: call.bind(''.split) as Ops['split'],
    codeAt: call.bind(''.charCodeAt) as Ops['codeAt'],
  });
}

/** The captured intrinsics, for run-time code outside the run closure (BUILT exists by the time any of it runs). */
function intrinsics(): Ops {
  return BUILT.ops;
}

/** Whether `c` (one character) is a digit, a lower-case or an upper-case ASCII letter, a word character (`\w`), or hex. */
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}
function isLower(c: string): boolean {
  return c >= 'a' && c <= 'z';
}
function isUpper(c: string): boolean {
  return c >= 'A' && c <= 'Z';
}
function isWordChar(c: string): boolean {
  return isDigit(c) || isLower(c) || isUpper(c) || c === '_';
}
function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
/** Whether some character of `s` satisfies `p`. */
function hasChar(s: string, p: (c: string) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (p(s[i]!)) return true;
  return false;
}
/** Whether every character of `s` satisfies `p`. */
function allChars(s: string, p: (c: string) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (!p(s[i]!)) return false;
  return true;
}
/** How many line breaks `s` holds. */
function breaks(s: string): number {
  const o = intrinsics();
  let n = 0;
  for (let at = o.indexOf(s, '\n'); at !== -1; at = o.indexOf(s, '\n', at + 1)) n++;
  return n;
}

interface Built {
  /** The captured intrinsics (capture), for every run-time operation on a regex or a string. */
  readonly ops: Ops;
  readonly shapes: readonly Rule[];
  readonly broad: readonly Rule[];
  readonly identifiers: readonly Rule[];
  readonly patterns: readonly RedactionPattern[];
  readonly run: {
    /** What every shape finds in `s` (allSpans). */
    readonly shapes: (s: string) => Span[];
    /** What every rule of the broad mode finds in `s` (allSpans). */
    readonly broad: (s: string) => Span[];
    /** The broad rules read again from each of `cuts` (readAt), the spans found added to `spans`. */
    readonly broadAt: (s: string, cuts: number[], spans: Span[]) => void;
    /** The identifier pass over `part`: each rule in turn, the line count kept with `keepLines`. */
    readonly identifiers: (part: string, keepLines: boolean) => string;
  };
}

/**
 * The one thing this module computes at load (BUILT): each table read once into its snapshot (snapshot; the table
 * frozen), the listing's copies (each `re` a copy of its own, R1258e's E1: what an importer does to an exported one,
 * compile or an own Symbol.replace, changes nothing here), and `run`, the regexes that run and the only operations on
 * them (E2): built from the snapshots' primitives inside this closure (the glue regex too), held by no module binding,
 * so nothing outside can name them, and nothing an operation returns is a regex: spans, text and a kind only. What
 * keeps them as built is that no code runs at load but this function: every top-level statement is a function
 * declaration, a literal const, this one call or an export (the lint in test/redact-markers.test.ts, R1258k/l), every
 * table entry is data by the same lint, the module's data is frozen, and every arrow and function in a table, and
 * this function, is pinned by its source text. The first operation checks once that every run copy still reads as
 * its snapshot (source, flags, no own property but lastIndex) and throws if not; later calls don't repeat it
 * (R1258g's G1: a check on every operation was most of the redactor's time, and by the argument above it guards
 * against nothing a check could see). A built-in patched is met two ways (R1258o/p): the run copies are searched
 * with the intrinsic exec and apply captured on this function's first line, so a patch made after load changes
 * nothing they find; and the reference lint (test/redact-markers.test.ts) refuses, by type and by position rather
 * than by spelling, every way this module's own code could reach a prototype or a global object to make one.
 */
function build(patterns: readonly unknown[], broadTable: readonly unknown[], identifierTable: readonly unknown[]): Built {
  // First, before any table is read: the intrinsics (capture), so every operation on a regex or a string at run time
  // is one of these and nothing else (R1258o/p, q/r). The reference lint in test/redact-markers.test.ts holds this
  // statement first in build, and capture to its exact text.
  const ops = captured();
  const shapes = snapshot(patterns);
  Object.freeze(patterns);
  const broadRules = snapshot(broadTable, { broad: true });
  Object.freeze(broadTable);
  const identifiers = snapshot(identifierTable, { verbatim: true });
  Object.freeze(identifierTable);
  const broad: readonly Rule[] = Object.freeze(BROAD_RULES.flatMap((set) => (set === 'shapes' ? shapes : broadRules)));
  const copy = (rules: readonly Rule[], group: RedactionPattern['group']) => rules.map((r) => Object.freeze({ kind: r.kind, re: new RegExp(r.source, r.flags), rep: r.rep, group }));
  const patternsOut: readonly RedactionPattern[] = Object.freeze([...copy(shapes, 'secret'), ...copy(broadRules, 'broad'), ...copy(identifiers, 'identifier')]);
  // Plain arrays, not frozen: nothing outside this closure can reach them, and a frozen tuple destructured on every
  // rule of every call cost a third of the redactor's time (measured, R1258g's G1 round).
  const compile = (rules: readonly Rule[], withG: boolean) => rules.map((r) => [new RegExp(r.source, withG && !r.flags.includes('g') ? `${r.flags}g` : r.flags), r.rep] as [RegExp, Replacement]);
  // The span search needs `g`; the identifier pass runs each rule's own flags (String.prototype.replace).
  const shapeRun = compile(shapes, true);
  const broadRun = compile(broad, true);
  const identifierRun = compile(identifiers, false);
  const glue = new RegExp(GLUE_PARTS.join('|'), 'g');
  // A plain copy of the frozen list: `some` over a frozen array on every `_` of every call was measurably slow.
  const gluedPrefixes = [...GLUED_PREFIXES];
  const copies: readonly (readonly [RegExp, Rule, string])[] = [
    ...shapeRun.map((c, i) => [c[0], shapes[i]!, c[0].flags] as const),
    ...broadRun.map((c, i) => [c[0], broad[i]!, c[0].flags] as const),
    ...identifierRun.map((c, i) => [c[0], identifiers[i]!, c[0].flags] as const),
  ];
  let checked = false;
  /** Once, on the first operation: every run copy still reads as its snapshot, or the redactor stops (fail closed). */
  const check = () => {
    if (checked) return;
    for (const [re, r, flags] of copies) {
      if (re.source !== r.source || re.flags !== flags || ownKeys(re) !== 'lastIndex') throw new Error(`src/events/redact.ts: the regex that runs for "${r.kind}" no longer reads as its snapshot (#1257)`);
    }
    checked = true;
  };
  const run: Built['run'] = Object.freeze({
    shapes: (s: string): Span[] => (check(), allSpans(s, shapeRun, glue, gluedPrefixes, ops)),
    broad: (s: string): Span[] => (check(), allSpans(s, broadRun, glue, gluedPrefixes, ops)),
    broadAt: (s: string, cuts: number[], spans: Span[]): void => (check(), readAt(s, cuts, broadRun, spans, ops)),
    identifiers: (part: string, keepLines: boolean): string => (check(), identifierRun.reduce((t, [re, rep]) => replaced(t, re, rep, keepLines, ops), part)),
  });
  return Object.freeze({ ops, shapes, broad: broadRules, identifiers, patterns: patternsOut, run });
}

/** What every rule of `rules` finds in `s`: on the text as it was, and again with a boundary at each glue point. */
function allSpans(s: string, rules: readonly (readonly [RegExp, Replacement])[], glue: RegExp, prefixes: readonly string[], ops: Ops): Span[] {
  const spans: Span[] = [];
  rules.forEach(([re, rep], i) => spansOf(s, re, rep, i, spans, ops));
  readAt(s, gluePoints(s, glue, prefixes, ops), rules, spans, ops);
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
  const o = intrinsics();
  const spans = BUILT.run.shapes(s);
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
    out += o.slice(s, at, a) + rep + (keepLines ? o.repeat('\n', Math.max(0, breaks(o.slice(s, a, b)) - breaks(rep))) : '');
    at = b;
    i = j;
  }
  return out + o.slice(s, at);
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
  return UNSCANNABLE + (keepLines ? intrinsics().repeat('\n', breaks(s)) : '');
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
  const o = intrinsics();
  const spans = BUILT.run.broad(s);
  const word = (i: number) => isWordChar(s[i] ?? '');
  BUILT.run.broadAt(s, [...new Set(spans.flatMap(([a, b]) => [a, b]))].filter((c) => c > 0 && c < s.length && word(c - 1) && word(c)).sort((a, b) => a - b), spans);
  // What is already a mask stays as it is: a rule that takes in a mask word (`token=[REDACTED]`) adds nothing.
  const masks: [number, number][] = [];
  if (mask) for (let at = o.indexOf(s, mask); at !== -1; at = o.indexOf(s, mask, at + mask.length)) masks.push([at, at + mask.length]);
  const kept = outside(merged(spans.map(([a, b]): [number, number] => [a, b])), masks);
  if (!kept.length) return s;
  let out = '';
  let at = 0;
  for (const [a, b] of kept) {
    out += o.slice(s, at, a) + mask + (keepLines ? o.repeat('\n', breaks(o.slice(s, a, b))) : '');
    at = b;
  }
  return out + o.slice(s, at);
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
function readAt(s: string, cuts: number[], rules: readonly (readonly [RegExp, Replacement])[], spans: Span[], ops: Ops) {
  if (!cuts.length) return;
  const markChar = freeMark(s);
  if (markChar === null) {
    for (const [i, c] of cuts.entries()) {
      const piece = ops.slice(s, c, cuts[i + 1] ?? s.length);
      const more: Span[] = [];
      rules.forEach(([re, rep], k) => spansOf(piece, re, rep, k, more, ops));
      for (const [a, b, r, k] of more) spans.push([a + c, b + c, r, k]);
    }
    return;
  }
  let marked = '';
  let from = 0;
  for (const c of cuts) {
    marked += ops.slice(s, from, c) + markChar;
    from = c;
  }
  marked += ops.slice(s, from);
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
  rules.forEach(([re, rep], k) => spansOf(marked, re, rep, k, more, ops));
  for (const [a, b, r, k] of more) spans.push([back(a), back(b), ops.split(r, markChar).join(''), k]);
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
    if (e instanceof RangeError) return UNSCANNABLE + (o.keepLines ? intrinsics().repeat('\n', breaks(s)) : '');
    throw e;
  }
}

function redactOrThrow(s: string, o: RedactTextOptions): string {
  // Both modes read every rule on the text as it was, so no rule's match hides another's: the broad mode masks the
  // union of what the shapes and the broad rules find (maskUnion); the default mode replaces each run of what the
  // shapes find, with its rule's marker (replaceUnion).
  let out = o.broad ? maskUnion(s, o.mask ?? '[REDACTED]', o.keepLines === true) : replaceUnion(s, o.keepLines === true);
  if (o.identifiers) out = outsideMachineBlocks(out, (part) => BUILT.run.identifiers(part, o.keepLines === true));
  return out;
}

/** What a cut site reads past its cut before redacting (#889 round 4): enough for a token, or a key's END line. */
export const CUT_MARGIN = 16384;

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
  return { text: intrinsics().slice(r, 0, max), more: (windowed ? s.length : r.length) - max };
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
  const o = intrinsics();
  const space = /\s/;
  for (let i = end - 1; i >= 0; i--) if (o.exec(space, s[i]!) !== null) return o.slice(s, 0, i + 1);
  return '';
}

/**
 * Records shown one after another (a service's journal entries, a log file's lines), redacted as one text so a secret
 * over several of them (a private key logged a line at a time) is found whole; the same number of records comes back,
 * each with as many lines as it had (a record inside a secret comes back empty or holding the marker).
 */
export function redactRecords(records: readonly string[], o: RedactTextOptions = {}): string[] {
  const lines = intrinsics().split(redactString(records.join('\n'), { ...o, keepLines: true }), '\n');
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

/** The one call this module makes at the top level (build): last, after every data const it reads. */
const BUILT = build(PATTERNS, BROAD, IDENTIFIERS);
