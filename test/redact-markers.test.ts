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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { markerProblem, REDACTION_PATTERNS, redactString, secretKinds, TRACKER } from '../src/events/redact.js';
import { repoRoot } from './helpers.js';
import { leaks, run, SHAPES } from './token-standins.js';

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
 * A copy of the built module (it imports only node:util) with `line` put before the table's anchor rule (or in its
 * place), as a module URL; with `unchecked`, the snapshot's refusal of a marker problem taken out too (what main did
 * before #1257: the tables run as written).
 */
function moduleWith(table: keyof typeof ANCHORS, line: string | null, unchecked = false, replace = false): string {
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l.endsWith(ANCHORS[table]));
  assert.notEqual(at, -1, `the built module holds ${ANCHORS[table]}`);
  if (line !== null) lines.splice(at, replace ? 1 : 0, `    ${line}`);
  if (unchecked) {
    const check = lines.findIndex((l) => l.trim() === 'if (why !== null)');
    assert.ok(check !== -1 && lines[check + 1]!.trim() === 'refuse(who, why);', 'the built module refuses a marker problem');
    lines.splice(check, 2);
  }
  const file = join(mkdtempSync(join(tmpdir(), 'redact-markers-')), 'redact.js');
  writeFileSync(file, lines.join('\n'));
  return pathToFileURL(file).href;
}

/** `import()` of a module copy, then a turn of the event loop, so a microtask or timer an entry queued has run. */
async function loaded(url: string): Promise<Redact> {
  const mod = (await import(url)) as Redact;
  await new Promise((r) => setTimeout(r, 5));
  return mod;
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

/** The first 16 hex digits of SHA-256 of `text`. */
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The source text of a top-level function or const of src/events/redact.ts, from its first line to the `}` that closes
 * it (a one-line const is its line), for the pins below.
 */
function helperText(name: string): string {
  const lines = readFileSync(join(repoRoot, 'src', 'events', 'redact.ts'), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`const ${name} = `));
  assert.notEqual(at, -1, `src/events/redact.ts defines ${name}`);
  const end = lines[at]!.endsWith('{') ? lines.findIndex((l, i) => i > at && l === '}') : at;
  return lines.slice(at, end + 1).join('\n');
}

test('B2/D5: every function-backed rule is pinned by its exact code, so adding or changing one edits this test, where review sees it', () => {
  // A function replacer is trusted code: it is reviewed, and this pin is what holds it (R1258d's D5: a body changed in
  // place, same regex and kind, showed a 98-character key). The pin is the function's own source text
  // (Function.prototype.toString, read once here, which an own toString can't change), and the source text of the
  // helpers a function calls, each as a digest. The run-time guard (shown) is a backstop for a literal echo only.
  // The whole regex, flags included (R1258f: a lost `i` or `g` is a weakening the corpus may miss).
  const pinned = REDACTION_PATTERNS.filter((p) => typeof p.rep === 'function').map((p) => `${p.group}: ${p.kind}: ${p.re.source}/${p.re.flags} :: ${digest(Function.prototype.toString.call(p.rep))}`);
  const tick = '`';
  assert.deepEqual(pinned, [
    String.raw`secret: Stripe key: (^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g :: 3e7b9f030ef54515`,
    String.raw`secret: private key: ^[\s\S]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ :: ed5ccdf5c7b51080`,
    String.raw`secret: Basic credential: \b(basic)(\s+)((?:[A-Za-z0-9+/]|\\\/){8,}={0,2})/gi :: 126e8951f6072122`,
    String.raw`secret: secret under a JSON key: (\\?"|')([A-Za-z0-9_-]+)\1(\s*(?::|=>)\s*)(\\?"|')([A-Za-z0-9_\-.+/=~]{16,})\4/g :: fbee9afb455be897`,
    String.raw`identifier: home path: (^|[^\w.~/:-]|file:\/\/)\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/([^\s/"'${tick}<>()[\]{},;|\\]+)/g :: 2c3c46b26a5809ac`,
    String.raw`identifier: internal host: (^|[^A-Za-z0-9./-]|\/\/)([A-Za-z0-9][A-Za-z0-9.-]*\.(?:internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi :: 89fe6126a3f475b0`,
  ]);
  // The two named functions and the helpers the arrows call, by the digest of their TypeScript text: a change to any of
  // them changes a digest here.
  // (The name follows each digest: a word like "credential" right before a run of hex reads as a secret to gitleaks.)
  // With the data a pinned function reads and decides by (R1258e's E3): CODE_HEADS (internalHost; a word added there
  // is a host kept). The key-line regex is orphanEnd's own now (R1258h's H1c), so it is in orphanEnd's text. The
  // credential word tables credentialKey reads are never-shrink tables, held by the merge policy, and a word added to
  // one only redacts more.
  const helpers = ['orphanEnd', 'internalHost', 'basicShaped', 'basicPair', 'credentialShaped', 'credentialKey', 'credentialWord', 'shown', 'called', 'CODE_HEADS'];
  assert.deepEqual(
    helpers.map((n) => `${digest(helperText(n))} ${n}`),
    [
      '76694e1346c5bc5f orphanEnd',
      '77e40d90de5c6d8d internalHost',
      '170f2d0a6f9844da basicShaped',
      'b095f92176beae77 basicPair',
      '3af896b45f567401 credentialShaped',
      '484e812930fe8d19 credentialKey',
      'b59a42f6bde3a20a credentialWord',
      '8f17cc920a3237dc shown',
      '6fed88fc7eb6d7a3 called',
      '9071693a42c37fd1 CODE_HEADS',
    ],
  );
});

test('H1: every function in every table, the broad arrows included, is pinned by its source text', () => {
  // R1258h's H1: a broad rule's arrow runs at load (snapshot reads it with the default mask), and REDACTION_PATTERNS
  // exports only the string it gave, so the pin above never saw it. This pin reads every arrow and function name in
  // PATTERNS, BROAD and IDENTIFIERS from the source, so adding or changing any of them edits this test.
  const sf = ts.createSourceFile('redact.ts', SRC, ts.ScriptTarget.Latest, true);
  const pinned: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !TABLES.includes(d.name.text) || !d.initializer || !ts.isArrayLiteralExpression(d.initializer)) continue;
      for (const [i, e] of d.initializer.elements.entries()) {
        if (!ts.isArrayLiteralExpression(e) || e.elements.length !== 3) continue;
        const [rep, kind] = [e.elements[1]!, e.elements[2]!];
        if (ts.isArrowFunction(rep) || ts.isIdentifier(rep)) pinned.push(`${d.name.text}[${i}] ${kind.getText(sf)}: ${digest(rep.getText(sf))}`);
      }
    }
  }
  assert.deepEqual(pinned, [
    "PATTERNS[5] 'Stripe key': cdec13c7ca6816f0",
    "PATTERNS[16] 'private key': 20f9ea51ef1cc874",
    "PATTERNS[18] 'Basic credential': 9f157aed285362f5",
    "PATTERNS[21] 'secret under a JSON key': 7ce61b1f7b9341f4",
    "BROAD[0] 'GitHub token, cut short': 17cf907d191839f3",
    "BROAD[1] 'Anthropic key, cut short': 17cf907d191839f3",
    'BROAD[2] "the updater\'s token rule": 17cf907d191839f3',
    "BROAD[3] 'Slack token, cut short': 17cf907d191839f3",
    "BROAD[4] 'JWT after a hyphen': 17cf907d191839f3",
    "BROAD[5] 'short bearer token': 7c33a73af91df498",
    "BROAD[6] 'user info in a URL': 388a2ecafd786cf5",
    "BROAD[7] 'value after a secret name': 03819d4a7ac0fa24",
    "IDENTIFIERS[1] 'home path': 2c3c46b26a5809ac",
    "IDENTIFIERS[3] 'internal host': 56d2f72c486cf79e",
  ]);
});

test("D5: each function-backed secret rule's own output on every known secret shows none of it", () => {
  // The redactor's leak check (leaks) on what the function itself returns, for every stand-in its regex matches.
  const shown: string[] = [];
  for (const p of REDACTION_PATTERNS) {
    if (p.group !== 'secret' || typeof p.rep !== 'function') continue;
    const g = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    for (const s of SHAPES) {
      for (const text of [s.value, `export X=${s.value}`, `{"token": "${s.value}"}`]) {
        for (const m of text.matchAll(g)) {
          const out = p.rep(m[0], ...m.slice(1).map((x) => x ?? ''));
          if (out !== m[0] && leaks(out, s.secret)) shown.push(`${p.kind} on ${s.what}: ${out}`);
        }
      }
    }
  }
  assert.deepEqual(shown, []);
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

// R1258c and R1258d: a value the load check read that differs from what runs. Every table is now read once into a
// frozen snapshot (the regex rebuilt from its checked source, the marker a primitive), and the redactor reads only the
// snapshot. Each probe below is either refused at load or redacts as its control does.
const LIVE_RE = String.raw`/(?<=STRIPE_LIVE_KEY=[sr]k_)(live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g`;
const LIVE_LINE = `export STRIPE_LIVE_KEY=${KEY}`;
const CORP = ['bob.smith', 'corp-mail.example'].join('@');
const CORP_RE = String.raw`/(^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@(corp-mail\.example)(?![A-Za-z0-9-])/g`;
const corp = (m: Redact) => m.redactString(`mail ${CORP} now`, m.TRACKER);

test('C1: a rule slot that is an accessor (a marker or a regex swapped after the check) is refused at load', async () => {
  // The marker read by the check and the listing was `[REDACTED]`; from the third read on it was the Y1 marker.
  const swapped = `Object.defineProperty([${LIVE_RE}, '', 'Stripe key'], 1, { get: ((n) => () => (n++ < 2 ? '[REDACTED]' : '[REDACTED:$1_$2]'))(0) }),`;
  await assert.rejects(import(moduleWith('PATTERNS', swapped)), refused(/"Stripe key".*the marker must be a plain data property, not an accessor/));
  const regex = `Object.defineProperty(['', '$1$2-[email]', 'email'], 0, { get: ((n) => () => (n++ === 0 ? /(^)(a)b/g : ${EMAIL_RE}))(0) }),`;
  await assert.rejects(import(moduleWith('IDENTIFIERS', regex)), refused(/"email".*the regex must be a plain data property, not an accessor/));
});

test('C2/C3: a Proxy around a regex runs only the pattern it showed the check; a regex with an own symbol property is refused', async () => {
  // The Proxy shows a decoy `source` whose groups are boundaries, so `$1$2-[email]` passes; the snapshot copies that
  // decoy and runs the copy, never the Proxy's exec, so the real address is left to the email rule, as in the control.
  const proxy = `[new Proxy(${EMAIL_RE}, { get: (t, k) => (k === 'source' ? '(^)(a)b' : k !== 'constructor' && typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }), '$1$2-[email]', 'email'],`;
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', proxy))), 'mail [email] now');
  const symbol = `[Object.defineProperty(/@/g, Symbol.replace, { value: (s) => s.replace(/@/g, '@\\u200b') }), '[at]', 'email'],`;
  await assert.rejects(import(moduleWith('IDENTIFIERS', symbol)), refused(/"email".*plain RegExp with no own property/));
});

test("D1: an entry that rewrites the run's rule list after load finds it frozen, and the key stays redacted", async () => {
  // The write throws (a frozen row, in strict module code); the entry's own try swallows it, as the probe's did.
  const line = `(() => { const e = [${LIVE_RE}, '[REDACTED]', 'Stripe key']; queueMicrotask(() => { try { SHAPE_RULES.find((r) => r[0].source === e[0].source)[1] = '[REDACTED:$1_$2]'; } catch (err) { globalThis.__d1 = err.constructor.name; } }); return e; })(),`;
  const m = await loaded(moduleWith('PATTERNS', line));
  assert.equal(m.redactString(LIVE_LINE), 'export STRIPE_LIVE_KEY=sk_[REDACTED]');
  assert.deepEqual(m.secretKinds(LIVE_LINE), ['Stripe key']);
  assert.equal((globalThis as { __d1?: string }).__d1, 'TypeError', 'the write was refused');
  delete (globalThis as { __d1?: string }).__d1;
});

test('D2: an identifier entry with a getter or an own iterator is refused; one that rewrites itself later changes nothing', async () => {
  const getter = `(() => { let late = false; queueMicrotask(() => { late = true; }); return Object.defineProperty([${CORP_RE}, '', 'email'], 1, { get: () => (late ? '$1[email:$2@$3-]' : '[email]') }); })(),`;
  await assert.rejects(import(moduleWith('IDENTIFIERS', getter)), refused(/"email".*the marker must be a plain data property, not an accessor/));
  const iterator = `(() => { let late = false; queueMicrotask(() => { late = true; }); const e = [${CORP_RE}, '[email]', 'email']; e[Symbol.iterator] = function* () { yield e[0]; yield late ? '$1[email:$2@$3-]' : e[1]; yield e[2]; }; return e; })(),`;
  await assert.rejects(import(moduleWith('IDENTIFIERS', iterator)), refused(/no other own property \(own keys: 0,1,2,length,Symbol\(Symbol\.iterator\)\)/));
  const later = `(() => { const e = [${CORP_RE}, '[email]', 'email']; queueMicrotask(() => { try { e[1] = '$1[email:$2@$3-]'; } catch {} }); return e; })(),`;
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', later))), 'mail[email] now');
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', `[${CORP_RE}, '[email]', 'email'],`))), 'mail[email] now', 'the control');
});

test('D3: a regex recompiled in place after load changes nothing: the snapshot runs its own copy', async () => {
  const before = String.raw`(^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@corp-mail\.example(?![A-Za-z0-9-])`;
  const after = String.raw`((?:^|[^A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@corp-mail\\.example)(?![A-Za-z0-9-])`;
  const recompiled = `(() => { const re = new RegExp(String.raw\`${before}\`, 'g'); queueMicrotask(() => re.compile(String.raw\`${after}\`, 'g')); return [re, '$1-[email]', 'email']; })(),`;
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', recompiled))), 'mail -[email] now');
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', `[new RegExp(String.raw\`${before}\`, 'g'), '$1-[email]', 'email'],`))), 'mail -[email] now', 'the control');
});

test('D5: a function that echoes the key in another case is held by the run-time backstop', async () => {
  const line = String.raw`[/(^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g, (m, pre, k, v) => ` + '`${pre}${k}_[REDACTED:${v.toLowerCase()}]`' + `, 'Stripe key'],`;
  const m = await loaded(moduleWith('PATTERNS', line, false, true));
  assert.equal(m.redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
});

test('the snapshot and the listing are frozen, and the source tables too', () => {
  assert.ok(Object.isFrozen(REDACTION_PATTERNS));
  for (const p of REDACTION_PATTERNS) assert.ok(Object.isFrozen(p), p.kind);
  const text = built();
  for (const table of ['PATTERNS', 'BROAD', 'IDENTIFIERS']) assert.ok(text.includes(`Object.freeze(${table});`), `${table} is frozen after its snapshot`);
});

// R1258e: a RegExp object can't be frozen, so no object that runs may be reachable. The regexes that run live in a
// closure (`run`) that exposes only operations; REDACTION_PATTERNS exports copies of its own; each call verifies the
// run copies still read as the snapshot.
const LONG_KEY = 'sk_live_' + run(101, 'Hq8Xk2Lm9Tb4Wp7Rv3Ny6Hc');
const CORPUS = [...SHAPES.map((s) => `x ${s.value} y`), `mail ${EMAIL} now`, `host ${['10', '1', '2', '3'].join('.')} up`, '/home/you/proj/a.ts:42', 'peer fe80::1ff:fe23:4567:890a up', 'see vault.internal now', `export K=${LONG_KEY}`];
const MODES: Parameters<typeof redactString>[1][] = [{}, { broad: true }, TRACKER, { keepLines: true }, { identifiers: true, keepLines: true }];
const picture = (m: Redact) => CORPUS.map((s) => [...MODES.map((o) => m.redactString(s, o)), m.secretKinds(s).join()]);

test('E1: whatever an importer does to an exported regex (compile, an own Symbol.replace) changes no redaction', () => {
  const before = picture({ redactString, secretKinds } as Redact);
  const kept = REDACTION_PATTERNS.map((p) => [p.re.source, p.re.flags] as const);
  try {
    for (const p of REDACTION_PATTERNS) {
      p.re.compile('(?!)', 'g');
      Object.defineProperty(p.re, Symbol.replace, { value: (s: string) => s, configurable: true });
    }
    assert.ok(REDACTION_PATTERNS.every((p) => p.re.source === '(?!)'), 'the exported regexes were recompiled');
    assert.deepEqual(picture({ redactString, secretKinds } as Redact), before);
    assert.equal(redactString(`mail ${EMAIL} now`, TRACKER), 'mail [email] now');
  } finally {
    REDACTION_PATTERNS.forEach((p, i) => {
      delete (p.re as unknown as Record<symbol, unknown>)[Symbol.replace];
      p.re.compile(kept[i]![0], kept[i]![1]);
    });
  }
});

test("E2: a table entry that recompiles the run's Stripe regex after load reaches no regex: SHAPE_RULES holds primitives, and a long key stays redacted", async () => {
  // The review's line (compiled): the entry's own marker is plain, so it loads; its microtask then looks for the run
  // copy where it was. The rows hold the snapshot's primitives, so there is no regex to recompile.
  const line = `(() => { queueMicrotask(() => { try { const r = SHAPE_RULES.find((x) => x[0].source.startsWith('(^|[^A-Za-z0-9_])([sr]k)_')); r[0].compile(r[0].source.replace('{16,}', '{16,95}'), r[0].flags); } catch (e) { globalThis.__e2 = e.constructor.name; } }); return [/(?<=STRIPE_X_KEY=[sr]k_)(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/g, '[REDACTED]', 'Stripe key']; })(),`;
  const m = await loaded(moduleWith('PATTERNS', line));
  assert.equal((globalThis as { __e2?: string }).__e2, 'TypeError', 'the entry found no regex to recompile');
  delete (globalThis as { __e2?: string }).__e2;
  assert.equal(m.redactString(`export K=${LONG_KEY}`), 'export K=sk_[REDACTED]');
  assert.deepEqual(m.secretKinds(`export K=${LONG_KEY}`), ['Stripe key']);
  // No binding of the module names a run copy: the closure's handle (`run`) gives spans and text only.
  await loaded(moduleWith('PATTERNS', `(() => { queueMicrotask(() => { globalThis.__run = Object.keys(run); }); return [/(?<=STRIPE_Z_KEY=[sr]k_)(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/g, '[REDACTED]', 'Stripe key']; })(),`));
  assert.deepEqual((globalThis as { __run?: string[] }).__run, ['shapes', 'broad', 'broadAt', 'identifiers']);
  delete (globalThis as { __run?: string[] }).__run;
});

/** A copy of the built module with the run closure's shape copies handed out (what no code path does), as a module. */
async function withRunShapes(): Promise<{ m: Redact; shapes: readonly (readonly [RegExp, unknown])[] }> {
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l.trim() === 'const identifiers = build(IDENTIFIER_SNAPSHOT, false);');
  assert.notEqual(at, -1, 'the built module builds the identifier copies inside run');
  lines.splice(at + 1, 0, '    globalThis.__runShapes = shapes;');
  const file = join(mkdtempSync(join(tmpdir(), 'redact-markers-')), 'redact.js');
  writeFileSync(file, lines.join('\n'));
  const m = (await import(pathToFileURL(file).href)) as Redact;
  const shapes = (globalThis as { __runShapes?: readonly (readonly [RegExp, unknown])[] }).__runShapes!;
  delete (globalThis as { __runShapes?: unknown }).__runShapes;
  return { m, shapes };
}

test('E2/G1: a run copy that no longer reads as its snapshot stops the redactor on its first operation (fail closed), by source, by flags alone, or by an own property', async () => {
  // Checked once, on the first operation (R1258g's G1: a check on every operation was most of the redactor's time);
  // each clause has its own case. The intact control redacts.
  assert.equal((await withRunShapes()).m.redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]', 'intact: redacts');
  const stripeOf = (shapes: readonly (readonly [RegExp, unknown])[]) => shapes.find(([re]) => re.source.startsWith('(^|[^A-Za-z0-9_])([sr]k)_'))![0];
  const cases: [string, (re: RegExp) => void][] = [
    ['the source recompiled', (re) => re.compile(re.source.replace('{16,}', '{16,95}'), re.flags)],
    ['the flags alone recompiled', (re) => re.compile(re.source, `${re.flags}y`)],
    ['an own property added', (re) => Object.defineProperty(re, 'source', { value: re.source })],
  ];
  for (const [name, tamper] of cases) {
    const { m, shapes } = await withRunShapes();
    tamper(stripeOf(shapes));
    assert.throws(() => m.redactString(LINE), /the regex that runs for "Stripe key" no longer reads as its snapshot/, name);
    assert.throws(() => m.secretKinds(LINE), /no longer reads as its snapshot/, name);
    assert.throws(() => m.redactString(`mail ${EMAIL}`, TRACKER), /no longer reads as its snapshot/, name);
  }
});

const SRC_PATH = join(repoRoot, 'src', 'events', 'redact.ts');
const SRC = readFileSync(SRC_PATH, 'utf8');
const TABLES = ['PATTERNS', 'BROAD', 'IDENTIFIERS'];

/** A program of `text` alone (the module imports nothing), with its checker, for the two lints below. */
function programOf(text: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const file = join(mkdtempSync(join(tmpdir(), 'redact-lint-')), 'redact.ts');
  writeFileSync(file, text);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, noResolve: true, noLib: true, types: [] });
  return { sf: program.getSourceFile(file)!, checker: program.getTypeChecker() };
}

/**
 * What is wrong with the tables as data, or nothing (R1258d's fix 2, R1258e's E2, R1258g's G2, R1258h's H1): an entry
 * that runs code is code in this module, with every binding in reach. Each entry of PATTERNS, BROAD and IDENTIFIERS
 * is a three-element array literal: a regex literal or `new RegExp` of literals; a marker; a string literal kind. A
 * literal is a string literal, a substitution-free template, or a template whose every span names a top-level `const`
 * whose own initializer is such a literal (resolved with the checker, so `${X}` with an object X whose toString runs
 * is refused: G2). A marker in PATTERNS or IDENTIFIERS is a literal, an arrow function or the name of a top-level
 * `function` declaration (code, pinned below). A marker in BROAD, which snapshot calls at load, is an arrow of one
 * plain parameter whose body is that parameter or a template whose spans are that parameter or literal consts, and
 * nothing else (H1: an arrow's body ran at load and reached the module's data).
 */
function tableProblems(text: string): string[] {
  const { sf, checker } = programOf(text);
  const problems: string[] = [];
  const topConst = (id: ts.Identifier): ts.VariableDeclaration | null => {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    if (!d || !ts.isVariableDeclaration(d) || !(d.parent.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(d.parent.parent) || d.parent.parent.parent !== sf) return null;
    return d;
  };
  const literal = (n: ts.Node, seen: readonly string[] = []): boolean => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
    if (!ts.isTemplateExpression(n)) return false;
    return n.templateSpans.every((s) => {
      if (!ts.isIdentifier(s.expression) || seen.includes(s.expression.text)) return false;
      const d = topConst(s.expression);
      return d !== null && d.initializer !== undefined && literal(d.initializer, [...seen, s.expression.text]);
    });
  };
  const regex = (n: ts.Node) => ts.isRegularExpressionLiteral(n) || (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'RegExp' && (n.arguments ?? []).length > 0 && (n.arguments ?? []).every((a) => literal(a)));
  const topFunction = (id: ts.Identifier) => {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    return d !== undefined && ts.isFunctionDeclaration(d) && d.parent === sf;
  };
  const broadArrow = (n: ts.Node): boolean => {
    if (!ts.isArrowFunction(n) || n.parameters.length !== 1) return false;
    const p = n.parameters[0]!;
    if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken || p.questionToken) return false;
    const param = p.name.text;
    const body = n.body;
    if (ts.isIdentifier(body)) return body.text === param;
    if (!ts.isTemplateExpression(body)) return ts.isNoSubstitutionTemplateLiteral(body) || ts.isStringLiteral(body);
    return body.templateSpans.every((s) => ts.isIdentifier(s.expression) && (s.expression.text === param || (topConst(s.expression) !== null && literal(topConst(s.expression)!.initializer!))));
  };
  const seen: string[] = [];
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !TABLES.includes(d.name.text)) continue;
      const table = d.name.text;
      seen.push(table);
      if (!d.initializer || !ts.isArrayLiteralExpression(d.initializer)) {
        problems.push(`${table}: not an array literal`);
        continue;
      }
      for (const [i, e] of d.initializer.elements.entries()) {
        const where = `${table}[${i}]`;
        if (!ts.isArrayLiteralExpression(e) || e.elements.length !== 3 || e.elements.some((x) => ts.isSpreadElement(x) || ts.isOmittedExpression(x))) {
          problems.push(`${where}: not a three-element array literal: ${e.getText(sf).slice(0, 60)}`);
          continue;
        }
        const [re, rep, kind] = [e.elements[0]!, e.elements[1]!, e.elements[2]!];
        if (!regex(re)) problems.push(`${where}: the regex is not a regex literal or new RegExp of literals: ${re.getText(sf).slice(0, 60)}`);
        if (table === 'BROAD') {
          if (!broadArrow(rep)) problems.push(`${where}: a broad marker must be an arrow of one parameter whose body is that parameter or a template of it and literal consts: ${rep.getText(sf).slice(0, 60)}`);
        } else if (!(literal(rep) || ts.isArrowFunction(rep) || (ts.isIdentifier(rep) && topFunction(rep)))) problems.push(`${where}: the marker is not a literal, an arrow function or the name of a top-level function: ${rep.getText(sf).slice(0, 60)}`);
        if (!ts.isStringLiteral(kind)) problems.push(`${where}: the kind is not a string literal`);
      }
    }
  }
  if (seen.join() !== TABLES.join()) problems.push(`tables seen: ${seen.join()}`);
  return problems;
}

/**
 * What is wrong with the module's top-level bindings, or nothing (R1258h's H1 and item 2 of its fix): code that ran
 * from a table entry reached mutable module data (a Set, a module RegExp, a plain array). Every top-level binding is a
 * `const` whose initializer is a literal, a frozen array or object (`Object.freeze(...)`), a function, a snapshot,
 * another binding's name, a number expression, or (by name) the three tables, frozen right after, and `run`, the
 * closure. No `let`, `var`, class, Set, Map, RegExp or unfrozen array or object at the top level.
 */
function bindingProblems(text: string): string[] {
  const { sf } = programOf(text);
  const problems: string[] = [];
  const numeric = (n: ts.Expression): boolean => ts.isNumericLiteral(n) || (ts.isBinaryExpression(n) && numeric(n.left) && numeric(n.right)) || (ts.isParenthesizedExpression(n) && numeric(n.expression));
  const allowed = (name: string, n: ts.Expression): boolean => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || numeric(n)) return true;
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isIdentifier(n)) return true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (callee === 'Object.freeze' || callee === 'snapshot') return true;
      return name === 'run' && ts.isParenthesizedExpression(n.expression) && ts.isArrowFunction(n.expression.expression) && n.arguments.length === 0;
    }
    if (ts.isAsExpression(n)) return allowed(name, n.expression);
    return TABLES.includes(name) && ts.isArrayLiteralExpression(n);
  };
  for (const s of sf.statements) {
    if (ts.isClassDeclaration(s)) problems.push(`${s.name?.text ?? 'a class'}: a class at the top level`);
    if (!ts.isVariableStatement(s)) continue;
    if (!(s.declarationList.flags & ts.NodeFlags.Const)) problems.push(`${s.declarationList.declarations.map((d) => d.name.getText(sf)).join()}: not const`);
    for (const d of s.declarationList.declarations) {
      const name = d.name.getText(sf);
      if (!d.initializer) problems.push(`${name}: no initializer`);
      else if (!allowed(name, d.initializer)) problems.push(`${name}: ${d.initializer.getText(sf).slice(0, 50)} is a mutable or unknown initializer`);
    }
  }
  return problems;
}

test('the tables hold data: each entry is [a regex literal or new RegExp of literals, a literal or pinned function marker (for BROAD an arrow of its parameter only), a string literal]', () => {
  assert.deepEqual(tableProblems(SRC), []);
});

test('the module holds no mutable binding: every top-level const is a literal, a frozen array or object, a function, a snapshot or a name', () => {
  assert.deepEqual(bindingProblems(SRC), []);
});

/** `text` with `line` put before the table's anchor rule, as the module-copy helper does for the built module. */
const sourceWith = (table: keyof typeof ANCHORS, line: string) => {
  const lines = SRC.split('\n');
  const at = lines.findIndex((l) => l.endsWith(ANCHORS[table]));
  assert.notEqual(at, -1);
  lines.splice(at, 0, `  ${line}`);
  return lines.join('\n');
};

test("G2/H1: the data lint refuses the review's entries: a template span that is an object, any broad arrow that is more than its parameter", () => {
  // G2: an object with toString in a template span runs at load (it reached KEY_QUALIFIERS.delete with every table line unchanged).
  const g2 = SRC.replace("const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';", "const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';\nconst WLD_MARK = { toString: () => (queueMicrotask(() => { try { KEY_QUALIFIERS.delete('hmac'); } catch {} }), 'wld_') };").replace('`${DASHBOARD_KEY_PREFIX}[REDACTED]`, \'dashboard key\'],', '`${WLD_MARK}[REDACTED]`, \'dashboard key\'],');
  assert.notEqual(g2, SRC);
  assert.match(tableProblems(g2).join('\n'), /PATTERNS\[0\]: the marker is not a literal.*WLD_MARK/);
  // A span that is a `let`, or a const built by a call, is refused too; a const string, or a template of such, is a literal.
  const spanOf = (decl: string) => SRC.replace("const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';", `const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';\n${decl}`).replace('`${DASHBOARD_KEY_PREFIX}[REDACTED]`, \'dashboard key\'],', '`${SPAN}[REDACTED]`, \'dashboard key\'],');
  assert.match(tableProblems(spanOf("let SPAN = 'wld_';")).join('\n'), /PATTERNS\[0\]: the marker is not a literal/);
  assert.match(tableProblems(spanOf("const SPAN = ['wld', '_'].join('');")).join('\n'), /PATTERNS\[0\]: the marker is not a literal/);
  assert.deepEqual(tableProblems(spanOf("const SPAN = 'wld_';")), []);
  assert.deepEqual(tableProblems(spanOf('const SPAN = `${DASHBOARD_KEY_PREFIX}`;')), []);
  // H1: every broad arrow of the review ran code at load; each is refused, the plain forms are not.
  const broad = (arrow: string) => tableProblems(sourceWith('BROAD', `[/zz_never_matches_zz/g, ${arrow}, 'never'],`)).join('\n');
  for (const arrow of [
    "(k) => (queueMicrotask(() => CODE_HEADS.add('buildbox')), k)",
    '(k) => (CREDENTIAL_ENDINGS.pop(), k)',
    "(k) => (KEY_LINE.compile('(?<![\\\\s\\\\S]{2000})' + KEY_LINE.source, KEY_LINE.flags), k)",
    "(k) => (queueMicrotask(() => { try { MACHINE_BLOCKS.push(['```', /[^\\S\\n]*\\n/y]); } catch {} }), k)",
    '(k) => (((x) => { RegExp.prototype.exec = function (this: RegExp, s: string) { const m = x.call(this, s); return m && this.source.includes(\'([sr]k)_\') && m[3] && m[3].length >= 120 ? null : m; }; })(RegExp.prototype.exec), k)',
    '(k) => { return k; }',
    '(k, j) => k',
    '(k) => `${k}${DASHBOARD_KEY_BODY.length}`',
    'orphanEnd',
    "'[REDACTED]'",
  ]) assert.match(broad(arrow), /BROAD\[\d+\]: a broad marker must be an arrow of one parameter/, arrow);
  for (const arrow of ['(k) => k', '(k) => `$1 ${k}`', '(k) => `${DASHBOARD_KEY_PREFIX}${k}`']) assert.deepEqual(tableProblems(sourceWith('BROAD', `[/zz_never_matches_zz/g, ${arrow}, 'never'],`)), [], arrow);
  // A PATTERNS marker that names a const arrow rather than a top-level function is refused; an IIFE entry still is.
  assert.match(tableProblems(sourceWith('PATTERNS', "[/zz_never_matches_zz/g, credentialShaped, 'never'],")).join('\n'), /the marker is not a literal, an arrow function or the name of a top-level function/);
  assert.match(tableProblems(sourceWith('PATTERNS', "(() => [/zz/g, '[REDACTED]', 'never'] as [RegExp, Replacement, string])(),")).join('\n'), /not a three-element array literal/);
});

test("H1: the module's data can't be changed from code that runs: a Set, a RegExp or a plain array at the top level is refused, and the review's writes fail", async () => {
  // The binding lint on the shapes of the review's reach.
  const bind = (from: string, to: string) => {
    assert.ok(SRC.includes(from), from);
    return bindingProblems(SRC.replace(from, to)).join('\n');
  };
  assert.match(bind("const CODE_HEADS = Object.freeze(['this',", "const CODE_HEADS = new Set(['this',"), /CODE_HEADS: new Set/);
  assert.match(bind("const CREDENTIAL_ENDINGS = Object.freeze(['token', 'secret', 'password', 'passwd', 'accesskey']);", "const CREDENTIAL_ENDINGS = ['token', 'secret', 'password', 'passwd', 'accesskey'];"), /CREDENTIAL_ENDINGS: \[/);
  assert.match(bind('const OCTET = ', 'const KEY_LINE = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;\nconst OCTET = '), /KEY_LINE: \/-----/);
  assert.match(bind('const OCTET = ', "let LATE = 'x';\nconst OCTET = "), /LATE: not const/);
  // At run time, in a module copy: the review's writes find frozen arrays or no binding, and the output is the control's.
  // (Their microtask forms are try-wrapped, as the probes were; an unwrapped TypeError in a microtask would end this process.)
  const corpHost = (m: Redact) => m.redactString('see buildbox.corp now', m.TRACKER);
  const fenced = (m: Redact) => m.redactString(`\`\`\`\nmail ${CORP} now\n\`\`\``, m.TRACKER);
  const control = await loaded(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => k, 'never'],"));
  assert.equal(corpHost(control), 'see [internal-host] now');
  assert.equal(fenced(control), '```\nmail [email] now\n```');
  const a = await loaded(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (queueMicrotask(() => { try { CODE_HEADS.add('buildbox'); } catch (e) { globalThis.__h1a = e.constructor.name; } }), k), 'never'],"));
  assert.equal((globalThis as { __h1a?: string }).__h1a, 'TypeError');
  delete (globalThis as { __h1a?: string }).__h1a;
  assert.equal(corpHost(a), 'see [internal-host] now');
  await assert.rejects(import(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (CREDENTIAL_ENDINGS.pop(), k), 'never'],")), (e: unknown) => e instanceof TypeError);
  await assert.rejects(import(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (KEY_LINE.compile('x', 'g'), k), 'never'],")), (e: unknown) => e instanceof ReferenceError);
  const d = await loaded(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (queueMicrotask(() => { try { MACHINE_BLOCKS.push(['```', /[^\\S\\n]*\\n/y]); } catch (e) { globalThis.__h1d = e.constructor.name; } }), k), 'never'],"));
  assert.equal((globalThis as { __h1d?: string }).__h1d, 'TypeError');
  delete (globalThis as { __h1d?: string }).__h1d;
  assert.equal(fenced(d), '```\nmail [email] now\n```');
  // G2 at run time: the template span's toString runs at load, and its write to KEY_QUALIFIERS finds a frozen array.
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l.startsWith('const PATTERNS = ['));
  assert.notEqual(at, -1);
  lines.splice(at, 0, "const WLD_MARK = { toString: () => (queueMicrotask(() => { try { KEY_QUALIFIERS.delete('hmac'); } catch (e) { globalThis.__g2 = e.constructor.name; } }), 'wld_') };");
  const marker = lines.findIndex((l) => l.includes('`${DASHBOARD_KEY_PREFIX}[REDACTED]`'));
  assert.notEqual(marker, -1);
  lines[marker] = lines[marker]!.replace('`${DASHBOARD_KEY_PREFIX}[REDACTED]`', '`${WLD_MARK}[REDACTED]`');
  const file = join(mkdtempSync(join(tmpdir(), 'redact-markers-')), 'redact.js');
  writeFileSync(file, lines.join('\n'));
  const g2 = await loaded(pathToFileURL(file).href);
  assert.equal((globalThis as { __g2?: string }).__g2, 'TypeError');
  delete (globalThis as { __g2?: string }).__g2;
  const hmac = `{"hmac_key": "${run(20, 'aB3dE5gH7jK9mN1pQ3sT')}"}`;
  assert.equal(g2.redactString(hmac), '{"hmac_key": "[REDACTED]"}');
  assert.deepEqual(g2.secretKinds(hmac), ['secret under a JSON key']);
});
