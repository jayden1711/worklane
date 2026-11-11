// #1257 (R1184y's Y1): a rule added to PATTERNS whose string marker holds `$1`/`$2` for groups inside the secret's span
// put the secret into the "redacted" text. The default mode (replaceOnce) gives a run that two rules find whole to the
// rule of the lower rank, and shows that rule's marker; expand fills the marker's `$n` from the match. So an entry
// `(?<=STRIPE_SECRET_KEY=[sr]k_)(live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])` with `[REDACTED:$1_$2]`, ranked before
// the Stripe rule, gave `sk_[REDACTED:live_<key>]`, secretKinds still said "Stripe key", and every redact test passed.
// Now markerProblem refuses a string marker whose group references don't lead or trail it, or name a group the match
// doesn't begin or end with, and markersChecked runs it on every table at load: a module with such a rule doesn't load.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { markerProblem, REDACTION_PATTERNS, redactString } from '../src/events/redact.js';
import { leaks, run } from './token-standins.js';

type Redact = typeof import('../src/events/redact.js');

/** The Y1 rule: the Stripe key's own two groups in the marker. */
const Y1_RE = /(?<=STRIPE_SECRET_KEY=[sr]k_)(live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g;
const Y1_REP = '[REDACTED:$1_$2]';
const Y1_LINE = `[${Y1_RE.toString()}, '${Y1_REP}', 'Stripe key'],`;
const KEY = ['sk', 'live', run(24)].join('_');
const LINE = `export STRIPE_SECRET_KEY=${KEY}`;

/** The built module's text. */
const built = () => readFileSync(new URL('../src/events/redact.js', import.meta.url), 'utf8');
/** The line of the built module that ends an existing rule of each table, to put a rule before (a rank below its). */
const ANCHORS = { PATTERNS: ", 'Stripe key'],", BROAD: ", 'short bearer token'],", IDENTIFIERS: ", 'email']," } as const;

/**
 * A copy of the built module (it imports nothing) with `line` put before the table's anchor rule, as a module URL; with
 * `unchecked`, the table's markersChecked line taken out too (what main did before #1257).
 */
function moduleWith(table: keyof typeof ANCHORS, line: string | null, unchecked = false): string {
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l.endsWith(ANCHORS[table]));
  assert.notEqual(at, -1, `the built module holds ${ANCHORS[table]}`);
  if (line !== null) lines.splice(at, 0, `    ${line}`);
  const text = lines.filter((l) => !unchecked || !new RegExp(`^markersChecked\\(${table}[,)]`).test(l)).join('\n');
  if (unchecked) assert.notEqual(text, lines.join('\n'), `the built module checks ${table}`);
  const file = join(mkdtempSync(join(tmpdir(), 'redact-markers-')), 'redact.js');
  writeFileSync(file, text);
  return pathToFileURL(file).href;
}

const refused = (why: RegExp) => (e: unknown) => {
  const msg = (e as Error).message;
  assert.match(msg, /could show a secret \(#1257\)/, msg);
  assert.match(msg, why, msg);
  return true;
};

test('Y1: the marker `[REDACTED:$1_$2]` would show the Stripe key; the rule is refused, and the module does not load with it', async () => {
  // The cause: the marker fills its references from the key's own groups, so what it puts in place of the key holds
  // the key. Without the check, the engine's own default mode showed it (the rule ranks before the Stripe rule).
  assert.ok(leaks(LINE.replace(Y1_RE, Y1_REP), KEY), 'the marker expands to the key');
  const before = (await import(moduleWith('PATTERNS', Y1_LINE, true))) as Redact;
  const shown = before.redactString(LINE);
  assert.ok(leaks(shown, KEY), `main's module with the rule showed the key: ${shown}`);
  assert.deepEqual(before.secretKinds(LINE), ['Stripe key']);
  // The rule: a reference inside the marker is refused.
  assert.match(markerProblem(Y1_RE, Y1_REP) ?? '', /a group reference inside the marker/);
  // At load: the module with that rule throws, naming the rule and why.
  await assert.rejects(import(moduleWith('PATTERNS', Y1_LINE)), refused(/"Stripe key".*a group reference inside the marker/));
  // The control: the module as built loads, and the key is redacted whole.
  const control = (await import(moduleWith('PATTERNS', null))) as Redact;
  assert.equal(control.redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
  assert.equal(redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
});

test('an identifier rule or a broad rule with a reference inside its marker is refused at load too', async () => {
  // The identifier pass replaces with String.prototype.replace: the marker's `$2` is the user's name, shown.
  const who = `[/(^|[^a-z])(user[0-9]{4})@example\\.com/g, '$1[email:$2]', 'email'],`;
  await assert.rejects(import(moduleWith('IDENTIFIERS', who)), refused(/"email".*a group reference inside the marker/));
  // A broad rule's marker only places its span, but it is held to the same rule: one rule for every table.
  const broad = '[/\\b(bearer)\\s+([A-Za-z0-9._~+/=-]{8,})/gi, (k) => `$1 [${k}:$2]`, \'short bearer token\'],';
  await assert.rejects(import(moduleWith('BROAD', broad)), refused(/"short bearer token".*a group reference inside the marker/));
});

test('every rule with a group reference keeps only what the match begins with: the boundary, the scheme or the name', () => {
  const withRefs = REDACTION_PATTERNS.filter((p) => typeof p.rep === 'string' && /\$[^$]/.test(p.rep)).map((p) => `${p.group}: ${p.kind}: ${p.rep}`);
  assert.deepEqual(withRefs, [
    'secret: JWT: $1$2[REDACTED JWT]',
    'secret: bearer token: $1 [REDACTED]',
    'secret: password in a URL: $1:[REDACTED]@',
    'secret: Discord bot token: $1[REDACTED]',
    'broad: short bearer token: $1 [REDACTED]',
    'broad: user info in a URL: $1[REDACTED]@',
    'broad: value after a secret name: $1$2[REDACTED]',
    'identifier: email: $1[email]',
    'identifier: home path: $1~',
    'identifier: private IP: $1[private-ip]',
    'identifier: private IP: $1[private-ip]',
  ]);
  for (const p of REDACTION_PATTERNS) if (typeof p.rep === 'string') assert.equal(markerProblem(p.re, p.rep), null, `${p.kind}: ${p.rep}`);
});

test('markerProblem: what is refused, and what a marker may keep', () => {
  const cases: [string, RegExp, string, RegExp | null][] = [
    ['Y1: references inside the marker', Y1_RE, Y1_REP, /inside the marker/],
    ['`$&`', /(a)b/g, '[R:$&]', /\$&/],
    ['`$0`', /(a)b/g, '$0[R]', /\$0/],
    ['`$<name>`', /(?<k>a)b/g, '$<k>[R]', /\$</],
    ['`$`` (the text before the match)', /(a)b/g, '$`[R]', /\$`/],
    ["`$'` (the text after the match)", /(a)b/g, "[R]$'", /\$'/],
    ['a two-digit reference', /(a)b/g, '$10[R]', /\$10/],
    ['a group the regex lacks', /(a)b/g, '$3[R]', /\$3.*doesn't have/],
    ['references alone', /(a)(b)/g, '$1$2', /marks nothing/],
    ['a leading reference to a group the match does not begin with', /(^|[^a])b(c)/g, '$2[R]', /\$2.*begins with \(group 1 is\)/],
    ['a trailing reference to a group the match does not end with', /(a)b(c)d/g, '[R]$2', /\$2.*ends with \(no group is\)/],
    ['a quantified group (its text is the last repetition)', /(a|b)+c/g, '$1[R]', /\$1.*begins with/],
    ['a group after a top-level `|`', /(a)b|c/g, '$1[R]', /\$1.*begins with/],
    ['a group inside another', /((a)b)c/g, '$2[R]', /\$2.*begins with \(group 1 is\)/],
    ['a group inside a lookahead with no backreference after it', /(?=(a))ab/g, '$1[R]', /\$1.*begins with \(no group is\)/],
    ['a boundary group', /(^|[^a])b(c)/g, '$1[R]', null],
    ['a word after `\\b`', /\b(bearer)\s+x+/gi, '$1 [R]', null],
    ['a group before a trailing lookahead', /x(a)(?!b)/g, '[R]$1', null],
    ['groups at both ends', /(a)(b)c(d)$/g, '$1$2[R]$3', null],
    ['a literal `$$`', /(a)b/g, '[R$$]', null],
    ['no reference', /a(b)c/g, '[REDACTED]', null],
    ['the JWT rule: a group in a lookahead, taken by the backreference after it', /(^|[^a])(?=([a-z]*?)eyJ)\2eyJ[a-z]+/g, '$1$2[R]', null],
  ];
  for (const [name, re, rep, why] of cases) {
    const got = markerProblem(re, rep);
    if (why === null) assert.equal(got, null, name);
    else assert.match(got ?? '', why, name);
  }
});

// R1258b (the adversarial review of #1258): the values the check never read, and the pass whose reasoning it didn't cover.
const EMAIL_RE = String.raw`/(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g`;
const EMAIL = ['alice.person', 'example.com'].join('@');
const identifiers = (m: Redact) => m.redactString(`contact ${EMAIL} please`, m.TRACKER);

test('B1: a marker that is neither a string nor a function (a String object, an object with toString) is refused at load', async () => {
  // String.prototype.replace reads such a value as a marker and expands its `$n`; the check read it as code.
  const why = refused(/a marker must be a string or a function, not (a String object|an object)/);
  await assert.rejects(import(moduleWith('IDENTIFIERS', `[${EMAIL_RE}, new String('$1[email:$2@$3-]'), 'email'],`)), why);
  await assert.rejects(import(moduleWith('IDENTIFIERS', `[${EMAIL_RE}, { toString: () => '$1[email:$2@$3-]' }, 'email'],`)), why);
  await assert.rejects(import(moduleWith('PATTERNS', `[${Y1_RE.toString()}, new String('${Y1_REP}'), 'Stripe key'],`)), why);
});

test('B2: a function that echoes what it replaced puts [REDACTED] there instead, in the default mode and the identifier pass', async () => {
  // The review's shape: the Y1 marker as a function, under a variable name the test's own Stripe line doesn't use.
  const re = String.raw`/(?<=STRIPE_API_KEY=[sr]k_)(live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g`;
  const line = `export STRIPE_API_KEY=${KEY}`;
  const groups = (await import(moduleWith('PATTERNS', `[${re}, (m, a, b) => \`[REDACTED:\${a}_\${b}]\`, 'Stripe key'],`))) as Redact;
  assert.equal(groups.redactString(line), 'export STRIPE_API_KEY=sk_[REDACTED]');
  assert.deepEqual(groups.secretKinds(line), ['Stripe key']);
  const whole = (await import(moduleWith('PATTERNS', `[${re}, (m) => \`[R:\${m}]\`, 'Stripe key'],`))) as Redact;
  assert.equal(whole.redactString(line), 'export STRIPE_API_KEY=sk_[REDACTED]');
  const who = (await import(moduleWith('IDENTIFIERS', `[${EMAIL_RE}, (m, pre, u) => \`\${pre}[email:\${u}]\`, 'email'],`))) as Redact;
  assert.equal(identifiers(who), 'contact [REDACTED] please');
  // The guard leaves a function that keeps only what the match begins with alone: main's own rules redact as before.
  assert.equal(redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
  assert.equal(redactString('see https://someone:Pa55word-x@example.test/x'), 'see https://someone:[REDACTED]@example.test/x');
  assert.equal(redactString('/home/you/proj/a.ts:42', { identifiers: true }), '~/proj/a.ts:42');
});

test('B2: every function-backed rule is listed here, so adding or changing one edits this test, where review sees it', () => {
  const tick = '`';
  const functions = REDACTION_PATTERNS.filter((p) => typeof p.rep === 'function').map((p) => `${p.group}: ${p.kind}: ${p.re.source}`);
  assert.deepEqual(functions, [
    String.raw`secret: Stripe key: (^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])`,
    String.raw`secret: private key: ^[\s\S]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----`,
    String.raw`secret: Basic credential: \b(basic)(\s+)((?:[A-Za-z0-9+/]|\\\/){8,}={0,2})`,
    String.raw`secret: secret under a JSON key: (\\?"|')([A-Za-z0-9_-]+)\1(\s*(?::|=>)\s*)(\\?"|')([A-Za-z0-9_\-.+/=~]{16,})\4`,
    String.raw`identifier: home path: (^|[^\w.~/:-]|file:\/\/)\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/([^\s/"'${tick}<>()[\]{},;|\\]+)`,
    String.raw`identifier: internal host: (^|[^A-Za-z0-9./-]|\/\/)([A-Za-z0-9][A-Za-z0-9.-]*\.(?:internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local))(?![A-Za-z0-9-]|\.[A-Za-z0-9])`,
  ]);
});

test('B3: an identifier marker may keep only a boundary group, since the identifier pass puts the marker out as it is', async () => {
  // The address itself as a leading group: the shapes' rule accepts it (the union trims a kept group out of the span),
  // but the identifier pass has no union and no trim, so the kept group is the output.
  const whole = /(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
  assert.equal(markerProblem(whole, '$1$2-[email]'), null);
  assert.match(markerProblem(whole, '$1$2-[email]', true) ?? '', /\$2.*must be a boundary/);
  await assert.rejects(import(moduleWith('IDENTIFIERS', `[${whole.toString()}, '$1$2-[email]', 'email'],`)), refused(/"email".*\$2.*must be a boundary/));
  // Boundaries: `^`, one character, literal text (the home path's `file://`), in any mix; every identifier rule's.
  for (const re of [/(^|[^\w])x/g, /(^|[^\w.~/:-]|file:\/\/)\//g, /(\s)x/g, /(^|\.|,)x/g]) assert.equal(markerProblem(re, '$1[x]', true), null, re.source);
  for (const re of [/(\w+)x/g, /(^|ab?)x/g, /(^|(a))x/g, /(a|\d\d)x/g]) assert.match(markerProblem(re, '$1[x]', true) ?? '', /must be a boundary/, re.source);
  for (const p of REDACTION_PATTERNS) if (p.group === 'identifier' && typeof p.rep === 'string') assert.equal(markerProblem(p.re, p.rep, true), null, p.kind);
});

test('B4: a regex with an own property (a shadowed `source`) is refused at load', async () => {
  const re = String.raw`/(?<=STRIPE_SECRET_KEY=[sr]k_)(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g`;
  await assert.rejects(import(moduleWith('PATTERNS', `[Object.defineProperty(${re}, 'source', { value: '(x)y' }), '$1[REDACTED]', 'Stripe key'],`)), refused(/plain RegExp with no own property/));
  await assert.rejects(import(moduleWith('PATTERNS', `[${re}, '$1[REDACTED]', 'Stripe key'],`)), refused(/\$1.*begins with \(no group is\)/));
});
