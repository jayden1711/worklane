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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { BRAND } from '../src/brand.js';
import { DASHBOARD_KEY_PREFIX, isDashboardKey, markerProblem, redactionPatterns, redactRecords, redactString, secretKinds, TRACKER } from '../src/events/redact.js';
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
  { const loading = import(moduleWith('PATTERNS', Y1_LINE)); await assert.rejects(loading, refused(/"Stripe key".*a group reference inside the marker/)); }
  // The control: the module as built loads, and the key is redacted whole.
  const control = (await import(moduleWith('PATTERNS', null))) as Redact;
  assert.equal(control.redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
  assert.equal(redactString(LINE), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
});

test('an identifier rule or a broad rule with a reference inside its marker is refused at load too', async () => {
  // The identifier pass replaces with String.prototype.replace: the marker's `$2` is the user's name, shown.
  const who = `[/(^|[^a-z])(user[0-9]{4})@example\\.com/g, '$1[email:$2]', 'email'],`;
  { const loading = import(moduleWith('IDENTIFIERS', who)); await assert.rejects(loading, refused(/"email".*a group reference inside the marker/)); }
  // A broad rule's marker only places its span, but it is held to the same rule: one rule for every table.
  const broad = '[/\\b(bearer)\\s+([A-Za-z0-9._~+/=-]{8,})/gi, (k) => `$1 [${k}:$2]`, \'short bearer token\'],';
  { const loading = import(moduleWith('BROAD', broad)); await assert.rejects(loading, refused(/"short bearer token".*a group reference inside the marker/)); }
});

test('every rule with a group reference keeps only what the match begins with: the boundary, the scheme or the name', () => {
  const withRefs = redactionPatterns().filter((p) => typeof p.rep === 'string' && /\$[^$]/.test(p.rep)).map((p) => `${p.group}: ${p.kind}: ${p.rep}`);
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
  for (const p of redactionPatterns()) if (typeof p.rep === 'string') assert.equal(markerProblem(p.re, p.rep), null, `${p.kind}: ${p.rep}`);
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
  { const loading = import(moduleWith('IDENTIFIERS', `[${EMAIL_RE}, new String('$1[email:$2@$3-]'), 'email'],`)); await assert.rejects(loading, why); }
  { const loading = import(moduleWith('IDENTIFIERS', `[${EMAIL_RE}, { toString: () => '$1[email:$2@$3-]' }, 'email'],`)); await assert.rejects(loading, why); }
  { const loading = import(moduleWith('PATTERNS', `[${Y1_RE.toString()}, new String('${Y1_REP}'), 'Stripe key'],`)); await assert.rejects(loading, why); }
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
 * The module's top-level value declarations by name (a function declaration, or the statement of a const, with or
 * without `export`), and what is wrong with them: a name declared twice at the top level, or a declaration at any
 * depth (a function, a function expression, a class, a const) bearing a top-level name (R1258n's N2: a decoy copy of
 * `build` nested in an uncalled function was what a line-based pin hashed, while a changed `build` ran).
 */
function topLevelOf(sf: ts.SourceFile): { top: Map<string, ts.Statement>; problems: string[] } {
  const top = new Map<string, ts.Statement>();
  const problems: string[] = [];
  const declare = (name: string, s: ts.Statement) => {
    if (top.has(name)) problems.push(`${name}: declared twice at the top level`);
    top.set(name, s);
  };
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s) && s.name) declare(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) declare(d.name.text, s);
  }
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const nested = (n: ts.Node): void => {
    const named = (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) ? n.name.text : null;
    if (named !== null && top.has(named)) {
      const t = top.get(named)!;
      const isTop = t === n || (ts.isVariableStatement(t) && ts.isVariableDeclaration(n) && t.declarationList.declarations.includes(n));
      if (!isTop) problems.push(`${named}: a nested declaration bears a top-level name (line ${line(n)})`);
    }
    ts.forEachChild(n, nested);
  };
  nested(sf);
  return { top, problems };
}

/**
 * The load path, pinned (R1258n's N4): every top-level function or const reachable from the builder call (`const BUILT
 * = build(…)`), by every identifier in it that the checker resolves to a top-level declaration, transitively: build,
 * snapshot, markerProblem and its parser, the tables and every function and helper they name, and the functions the
 * run closure holds. Each as `<digest of the whole declaration's text> <name>`. Whatever runs or could run at load is
 * in this list, so a line added to any of it (N4's one line in groupCount, which markerProblem calls from snapshot)
 * changes a digest here, where review sees it. A declaration is hashed whole, from the AST, never a line.
 */
function loadPins(text: string): { pins: string[]; problems: string[] } {
  const { sf, checker } = programOf(text);
  const { top, problems } = topLevelOf(sf);
  const builder = top.get(BUILDER.name);
  if (!builder) return { pins: [], problems: [...problems, `${BUILDER.name}: no builder call at the top level`] };
  const reachable = new Map<string, ts.Statement>();
  const queue: [string, ts.Statement][] = [[BUILDER.name, builder]];
  while (queue.length) {
    const [name, s] = queue.shift()!;
    if (reachable.has(name)) continue;
    reachable.set(name, s);
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const d = checker.getSymbolAtLocation(n)?.declarations?.[0];
        if (d && ts.isFunctionDeclaration(d) && d.parent === sf && d.name) queue.push([d.name.text, d]);
        else if (d && ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && ts.isVariableStatement(d.parent.parent) && d.parent.parent.parent === sf) queue.push([d.name.text, d.parent.parent]);
      }
      ts.forEachChild(n, visit);
    };
    visit(s);
  }
  return { pins: [...reachable].map(([name, s]) => `${digest(s.getText(sf))} ${name}`), problems };
}

/** Property names that reach a built-in's prototype or redefine a property; none is named in src/events/redact.ts, in any spelling the checker can see. A refusal list: registered never-shrink (the weakening backstop, #869). */
// check-table: never-shrink
const BANNED_PROPERTIES = new Set(['prototype', '__proto__', 'constructor', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'getPrototypeOf', 'assign', 'getOwnPropertyDescriptors', 'compile', '__lookupGetter__', '__lookupSetter__', '__defineGetter__', '__defineSetter__', 'valueOf', 'toString', 'apply', 'call', 'bind']);

/** Globals the module may not name in any position (a route to every object in the realm, or code from a string). A refusal list: registered never-shrink. */
// check-table: never-shrink
const REFUSED_GLOBALS = new Set(['Reflect', 'globalThis', 'global', 'self', 'window', 'frames', 'parent', 'top', 'Function', 'eval', 'process', 'require', 'module', 'exports', 'Proxy', 'Symbol', 'JSON', 'Promise', 'WeakRef', 'FinalizationRegistry']);

/**
 * The allowlists of the reference lint, GLOBAL_METHODS to ASSERTIONS: each registered never-grow (the weakening backstop,
 * #869), so a form added to any waits for the owner.
 */
/** The methods of a global the module may call directly (`X.m(...)`), and nothing else of it. */
// check-table: never-grow
const GLOBAL_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Object: ['freeze', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'getOwnPropertyDescriptor', 'fromEntries', 'entries'],
  Array: ['isArray'],
  Math: ['max', 'min'],
});
/** Globals read as plain values. */
// check-table: never-grow
const VALUE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
/** What may be constructed: these in any code; a RegExp in load-only code only (R1258t's T1: the global `RegExp` is read at each construction). In run-time code a Set or a Map takes an array, a set or a map the checker typed, or nothing (R1258u's U2, R1258v's V4: `new Set(s)` iterated the string through String.prototype[Symbol.iterator]), and an Error a string. No global function is called directly by run-time code (atob, String, Number: each read at call time). */
// check-table: never-grow
const NEWABLE = new Set(['Error', 'RangeError', 'Set', 'Map']);
/** Data properties a value of a regex or string type may give up (or, for lastIndex, take); every other access on such a value is refused in run-time code, or a direct method call in load-only code. */
// check-table: never-grow
const REGEX_DATA = new Set(['source', 'flags', 'global', 'lastIndex']);
// check-table: never-grow
const STRING_DATA = new Set(['length']);
/**
 * The functions that run at load only, reachable from the builder call before any redaction: a patch made after load
 * can't reach what already ran, so they may call a string's or a regex's own methods directly. Every other function,
 * and every arrow in a table, is run-time code, held to the allowlist below. A closure a load-only function returns,
 * stores or puts in an object or an array runs later, so it is run-time code too (R1258t's T3: the run closure's
 * arrows were linted as build); only a callback given straight to a call made in load-only code (a map over a table)
 * runs at load. Run-time code never names a load-only function (R1258t's T2: a call to groupCount from redactOrThrow
 * ran the prototype's exec at run time); at the top level only the builder call names one.
 */
// check-table: never-grow
const LOAD_ONLY = new Set(['build', 'captured', 'snapshot', 'listed', 'compiled', 'markerProblem', 'groupCount', 'parseRegex', 'leadingGroups', 'trailingGroups', 'boundaryGroup', 'these', 'ownKeys']);
/** What run-time code may do with a value: the methods of the captured intrinsics (Ops), of an array, a set or a map, and the run closure's four operations; and the data properties of the module's own objects. Everything else is refused. */
// check-table: never-grow
const OPS_METHODS = new Set(['exec', 'slice', 'indexOf', 'includes', 'startsWith', 'endsWith', 'lower', 'upper', 'repeat', 'codeAt', 'at', 'fromCode']);
// check-table: never-grow
const COLLECTION_METHODS = new Set(['push', 'map', 'filter', 'some', 'every', 'join', 'sort', 'entries', 'at', 'forEach', 'flatMap', 'reduce', 'find', 'unshift', 'slice', 'includes', 'has', 'add', 'keys', 'values']);
// check-table: never-grow
const RUN_METHODS = new Set(['shapes', 'broad', 'broadAt', 'identifiers']);
// check-table: never-grow
const DATA_PROPS = new Set(['length', 'size', 'index', 'source', 'flags', 'global', 'lastIndex', 'kind', 'rep', 'patterns', 'shapes', 'broad', 'identifiers', 'run', 'ops', 'text', 'more', 'mask', 'keepLines', 're', 'group']);
/** Assertion targets the module may write (`as T` only inside `redact`, the module's one generic function). */
// check-table: never-grow
const ASSERTIONS = new Set(['const', 'Replacement', 'string[]', '[RegExp, Replacement]', 'Error', '(mask: string) => unknown']);
/** The capture of the intrinsics (src/events/redact.ts: capture), exactly this text; build's first statement calls it. */
const CAPTURE_TEXT = `function captured(): Ops {
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
    codeAt: call.bind(''.charCodeAt) as Ops['codeAt'],
    at: call.bind(''.charAt) as Ops['at'],
    fromCode: String.fromCharCode,
  });
}`;
const CAPTURE_CALL = 'const ops = captured();';

/** A program of `text` with the standard library, so values have their real types (a regex literal is a RegExp, `Object` an ObjectConstructor). */
function typedProgramOf(text: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const file = join(mkdtempSync(join(tmpdir(), 'redact-typed-')), 'redact.ts');
  writeFileSync(file, text);
  const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, noResolve: true, types: [], strict: true });
  return { sf: program.getSourceFile(file)!, checker: program.getTypeChecker() };
}

/**
 * What the module's code may do, as an allowlist of forms (R1258q's D2, R1258r's R1: a lint of refusals, however it
 * read, fell to the next spelling: a destructuring, `__lookupGetter__`, a widened annotation, a cast to a type
 * parameter, a string typed as a number, a helper). With the standard library loaded, the checker knows what every
 * expression is, and in run-time code (every function not in LOAD_ONLY, and every arrow in a table):
 * - a value of a regex or string type gives up its data (REGEX_DATA, STRING_DATA) and a string is indexed by a
 *   number; no method of either is called: every operation is one of the captured intrinsics (OPS_METHODS, on a
 *   value of type Ops), so nothing is looked up on a prototype at run time;
 * - an array, a set or a map takes a method in COLLECTION_METHODS; the run closure takes one in RUN_METHODS; any
 *   other object gives up a property in DATA_PROPS, and no object's method is called;
 * - a global appears only as what is called or constructed (NEWABLE), the object of a direct call to a method in
 *   GLOBAL_METHODS, the right side of `instanceof`, or a value in VALUE_GLOBALS;
 * - an element access takes a numeric literal, or a number on a string, an array or a tuple the checker typed
 *   (never an asserted one); an `as` goes to ASSERTIONS, or to `T` inside `redact`, the one function with a type
 *   parameter; a const or let with a type annotation holds a value of that annotation's own kind;
 * - no `any`, no class, no object destructuring (an array pattern only over an array or a tuple), no angle-bracket
 *   assertion, no `satisfies`, no `delete`, no tagged template, no `import.meta`, no string built from literal
 *   pieces, no name in REFUSED_GLOBALS, no property in BANNED_PROPERTIES as a name, a key or a string.
 * Load-only code may also call a string's or a regex's own methods directly. The one function that reads a method of
 * a regex or a string as a value is `capture`, held to CAPTURE_TEXT, called first in build (CAPTURE_CALL).
 */
function referenceProblems(text: string): string[] {
  const { sf, checker } = typedProgramOf(text);
  const problems: string[] = [];
  const line = (n: ts.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const say = (n: ts.Node, what: string) => problems.push(`${what}: ${n.getText(sf).slice(0, 70)} (${line(n)})`);
  /** The expression under parentheses, assertions and `!`. */
  const inner = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) ? inner(e.expression) : e);
  const asserted = (e: ts.Expression): boolean => (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ? asserted(e.expression) : ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e));
  type Kind = 'regex' | 'string' | 'function' | 'array' | 'ops' | 'any' | 'object' | 'other';
  const kindOf = (t: ts.Type): Kind => {
    if (t.flags & ts.TypeFlags.Any) return 'any';
    if (t.isUnion()) {
      const kinds = new Set(t.types.map(kindOf));
      kinds.delete('other');
      return kinds.size === 1 ? [...kinds][0]! : kinds.size === 0 ? 'other' : 'object';
    }
    if (t.flags & ts.TypeFlags.StringLike) return 'string';
    if (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) return 'other';
    if (t.getCallSignatures().length || t.getConstructSignatures().length || t.symbol?.name === 'Function') return 'function';
    const name = t.symbol?.name ?? '';
    if (name === 'RegExp') return 'regex';
    if (name === 'Ops') return 'ops';
    if (checker.isArrayType(t) || checker.isTupleType(t) || name === 'Array' || name === 'ReadonlyArray' || name === 'RegExpExecArray' || name === 'Set' || name === 'Map' || name === 'ReadonlySet' || name === 'ReadonlyMap') return 'array';
    if (t.flags & ts.TypeFlags.TypeParameter) return 'other';
    if (t.isIntersection()) {
      // A string or a regex part makes the value that (R1258s's S2: `string & string[]`, from a type predicate or
      // Array.isArray on a string, was an array, and `slice` on it String.prototype's); `T & any[]` (redact's value,
      // narrowed by Array.isArray) is an array; otherwise the one kind among the parts.
      const kinds = new Set(t.types.map(kindOf));
      kinds.delete('other');
      if (kinds.has('string')) return 'string';
      if (kinds.has('regex')) return 'regex';
      if (kinds.has('array')) return 'array';
      if (kinds.size === 1) return [...kinds][0]!;
    }
    return 'object';
  };
  /** The kinds a template span or a `+` operand may be: a string, or a number, a boolean or the like; never a regex (its toString), an object, an array or a function. */
  const TEXTUAL = new Set<Kind>(['string', 'other']);
  const isGlobal = (id: ts.Identifier): boolean => {
    const decls = checker.getSymbolAtLocation(id)?.declarations ?? [];
    return decls.length > 0 && decls.every((d) => d.getSourceFile() !== sf);
  };
  const inTypePosition = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isHeritageClause(p)) return false;
      if (ts.isTypeNode(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
      if (ts.isExpression(p) || ts.isStatement(p)) return false;
    }
    return false;
  };
  const isCallee = (n: ts.Node): boolean => (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n;
  /** The top-level function a node is in, or null (a top-level const, a table's arrow, a type). */
  const enclosing = (n: ts.Node): string | null => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.parent === sf && p.name) return p.name.text;
    return null;
  };
  const isFunctionLike = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isAccessor(n) || ts.isConstructorDeclaration(n);
  /** The nearest function, arrow or method a node is inside of (the node itself excluded), or null at the top level. */
  const enclosingFn = (n: ts.Node): ts.Node | null => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
    return null;
  };
  /** Every identifier in the file by the symbol it names, for the references to a closure's binding. */
  const references = new Map<ts.Symbol, ts.Identifier[]>();
  const collect = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const s = checker.getSymbolAtLocation(n);
      if (s) references.set(s, [...(references.get(s) ?? []), n]);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const active = new Set<ts.Node>();
  /**
   * Whether the code of function-like `f` runs at load only (R1258t's T3): a top-level declaration named in LOAD_ONLY;
   * a callback given straight to a call made in load-only code; or a closure bound to a name in load-only code
   * (`const read = () => ...`, a nested declaration) whose every reference is a call made from load-only code. A closure
   * returned, put in an object or an array, passed or read as a value, or called from run-time code runs later: run-time
   * code, like the run closure's arrows and build's check. A cycle of closures calling each other is read as load-only
   * while it is being decided, and any reference from run-time code on the way decides it (no answer is kept).
   */
  const runsAtLoad = (f: ts.Node): boolean => {
    if (ts.isFunctionDeclaration(f) && f.parent === sf) return f.name !== undefined && LOAD_ONLY.has(f.name.text);
    const p = f.parent;
    const outer = enclosingFn(f);
    if (outer === null) return false;
    if (ts.isCallExpression(p) && p.arguments.some((a) => a === f)) return runsAtLoad(outer);
    const name = ts.isFunctionDeclaration(f) ? f.name : ts.isVariableDeclaration(p) && p.initializer === f && ts.isIdentifier(p.name) ? p.name : undefined;
    if (!name) return false;
    if (active.has(f)) return true;
    active.add(f);
    try {
      if (!runsAtLoad(outer)) return false;
      const symbol = checker.getSymbolAtLocation(name);
      const refs = (symbol && references.get(symbol)) ?? [];
      return refs.every((r) => {
        if (r === name) return true;
        if (!(ts.isCallExpression(r.parent) && r.parent.expression === r)) return false;
        const from = enclosingFn(r);
        return from !== null && runsAtLoad(from);
      });
    } finally {
      active.delete(f);
    }
  };
  const loadOnly = (n: ts.Node): boolean => {
    const f = isFunctionLike(n) ? n : enclosingFn(n);
    return f !== null && runsAtLoad(f);
  };
  /** The name of the top-level function an identifier resolves to, or null. */
  const topFunction = (id: ts.Identifier): string | null => {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    return d && ts.isFunctionDeclaration(d) && d.parent === sf && d.name ? d.name.text : null;
  };
  /**
   * Whether a string element access `X[i]` is in range by construction (R1258u's U1, R1258v's V1: a read past the end
   * is not an own property and went to String.prototype): inside a `for` that declares `i`, runs while `i < X.length`
   * and steps `i++`, where `X` and `i` name the loop's own bindings and nothing in the loop writes either.
   */
  const boundedRead = (n: ts.ElementAccessExpression): boolean => {
    const key = n.argumentExpression;
    const obj = n.expression;
    if (!ts.isIdentifier(key) || !ts.isIdentifier(obj)) return false;
    let loop: ts.ForStatement | undefined;
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isForStatement(p)) {
        loop = p;
        break;
      }
      if (isFunctionLike(p)) return false;
    }
    if (!loop?.initializer || !loop.condition || !loop.incrementor) return false;
    const same = (a: ts.Node, b: ts.Node) => checker.getSymbolAtLocation(a) !== undefined && checker.getSymbolAtLocation(a) === checker.getSymbolAtLocation(b);
    const init = loop.initializer;
    if (!ts.isVariableDeclarationList(init) || !init.declarations.some((d) => ts.isIdentifier(d.name) && same(d.name, key))) return false;
    const c = loop.condition;
    if (!(ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.LessThanToken && ts.isIdentifier(c.left) && same(c.left, key) && ts.isPropertyAccessExpression(c.right) && c.right.name.text === 'length' && ts.isIdentifier(c.right.expression) && same(c.right.expression, obj))) return false;
    const inc = loop.incrementor;
    if (!((ts.isPostfixUnaryExpression(inc) || ts.isPrefixUnaryExpression(inc)) && inc.operator === ts.SyntaxKind.PlusPlusToken && ts.isIdentifier(inc.operand) && same(inc.operand, key))) return false;
    let writes = false;
    const scan = (m: ts.Node): void => {
      const target = ts.isBinaryExpression(m) && m.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && m.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? m.left : (ts.isPostfixUnaryExpression(m) || ts.isPrefixUnaryExpression(m)) && (m.operator === ts.SyntaxKind.PlusPlusToken || m.operator === ts.SyntaxKind.MinusMinusToken) ? m.operand : undefined;
      if (target && ts.isIdentifier(target) && (same(target, key) || same(target, obj))) writes = true;
      ts.forEachChild(m, scan);
    };
    scan(loop.statement);
    return !writes;
  };
  /** The element type of an array, a tuple, a set or a map's values, for join and sort. */
  const elementKind = (t: ts.Type): Kind => {
    const el = checker.getIndexTypeOfType(t, ts.IndexKind.Number) ?? checker.getTypeArguments(t as ts.TypeReference)[0];
    return el ? kindOf(el) : 'object';
  };
  // The capture: exactly CAPTURE_TEXT, and build's first statement exactly CAPTURE_CALL.
  const captureFn = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'captured');
  if (!captureFn || captureFn.getText(sf) !== CAPTURE_TEXT) problems.push(`capture is not exactly:\n${CAPTURE_TEXT}`);
  const build = sf.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === BUILDER.fn) as ts.FunctionDeclaration | undefined;
  const first = build?.body?.statements[0];
  if (!first || first.getText(sf) !== CAPTURE_CALL) problems.push(`build's first statement is not exactly: ${CAPTURE_CALL}`);
  const walk = (n: ts.Node): void => {
    if (n === captureFn) return;
    const load = loadOnly(n);
    if (ts.isMetaProperty(n)) say(n, 'a meta property');
    if (ts.isTypeAssertionExpression(n)) say(n, 'an angle-bracket assertion');
    if (ts.isSatisfiesExpression(n)) say(n, 'a satisfies');
    if (ts.isDeleteExpression(n)) say(n, 'a delete');
    if (ts.isTaggedTemplateExpression(n)) say(n, 'a tagged template');
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) say(n, 'a class');
    if (n.kind === ts.SyntaxKind.AnyKeyword) say(n.parent, 'any');
    if (ts.isObjectBindingPattern(n)) say(n, 'an object destructuring');
    if (ts.isTypePredicateNode(n)) say(n.parent, 'a type predicate');
    if (ts.isYieldExpression(n) || (isFunctionLike(n) && (n as ts.FunctionLikeDeclaration).asteriskToken)) say(n, 'a generator');
    // R1258u's U2, R1258v's V4: a Set or a Map iterates its argument (a string through String.prototype[Symbol.iterator]).
    if (!load && ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      for (const a of n.arguments ?? []) {
        const k = kindOf(checker.getTypeAtLocation(inner(a)));
        const ok = n.expression.text === 'Set' || n.expression.text === 'Map' ? k === 'array' && !asserted(a) : k === 'string';
        if (!ok) say(a, `an argument of a ${k} kind to new ${n.expression.text}`);
      }
    }
    // R1258s's S2: iterating a string reads String.prototype[Symbol.iterator]; a regex as text reads its toString.
    if (!load && (ts.isForOfStatement(n) || ts.isSpreadElement(n)) && !(kindOf(checker.getTypeAtLocation(inner(n.expression))) === 'array' && !asserted(n.expression))) say(n, 'an iteration over something not an array, a set or a map the checker typed');
    if (!load && ts.isTemplateSpan(n) && !TEXTUAL.has(kindOf(checker.getTypeAtLocation(inner(n.expression))))) say(n, 'a template span that is not a string or a number');
    if (!load && ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.PlusToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && !(TEXTUAL.has(kindOf(checker.getTypeAtLocation(inner(n.left)))) && TEXTUAL.has(kindOf(checker.getTypeAtLocation(inner(n.right)))))) say(n, 'a + over something not a string or a number');
    if (ts.isArrayBindingPattern(n) && kindOf(checker.getTypeAtLocation(n)) !== 'array') say(n, 'an array pattern over something not an array or a tuple');
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.typeParameters?.length && !(ts.isFunctionDeclaration(n) && n.name?.text === 'redact')) say(n, 'a type parameter outside redact');
    if (ts.isAsExpression(n)) {
      const target = n.type.getText(sf);
      if (!(ASSERTIONS.has(target) || (target === 'T' && enclosing(n) === 'redact'))) say(n, `an assertion to ${target}`);
    }
    if (ts.isNewExpression(n) && !(ts.isIdentifier(n.expression) && isGlobal(n.expression) && (NEWABLE.has(n.expression.text) || (load && n.expression.text === 'RegExp')))) say(n, load ? 'a construction of something not in the allowlist' : 'a construction of something not in the allowlist (a RegExp only in load-only code)');
    if (ts.isVariableDeclaration(n) && n.type && n.initializer) {
      const k = kindOf(checker.getTypeAtLocation(inner(n.initializer)));
      if ((k === 'regex' || k === 'string' || k === 'function') && kindOf(checker.getTypeFromTypeNode(n.type)) !== k) say(n, `a ${k} value under an annotation of another kind`);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteralLike(n.left) && ts.isStringLiteralLike(n.right)) say(n, 'a string built from literal pieces');
    if (ts.isIdentifier(n) && !inTypePosition(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) && !ts.isPropertySignature(n.parent) && !ts.isMethodSignature(n.parent)) {
      const top = topFunction(n);
      if (REFUSED_GLOBALS.has(n.text)) say(n, 'a refused global is named');
      else if (top !== null && LOAD_ONLY.has(top) && !(ts.isFunctionDeclaration(n.parent) && n.parent.name === n) && !load) {
        // R1258t's T2: a load-only function named by run-time code; at the top level, only the builder call names one.
        const builderCall = top === BUILDER.fn && isCallee(n) && ts.isVariableDeclaration(n.parent.parent) && ts.isIdentifier(n.parent.parent.name) && n.parent.parent.name.text === BUILDER.name && enclosingFn(n) === null;
        if (!builderCall) say(n, 'a load-only function named outside load-only code');
      } else if (isGlobal(n) && !VALUE_GLOBALS.has(n.text)) {
        const p = n.parent;
        // A direct call of a global function (atob, String) reads it at call time: load-only code only (R1258t's T1).
        const direct = ts.isNewExpression(p) ? isCallee(n) : isCallee(n) && load;
        const method = ts.isPropertyAccessExpression(p) && p.expression === n && isCallee(p) && (GLOBAL_METHODS[n.text] ?? []).includes(p.name.text);
        const typeOf = ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === n;
        if (!direct && !method && !typeOf) say(n, 'a global used other than as a construction, an allowed direct method call, an instanceof, or a call in load-only code');
      }
    }
    if (ts.isPropertyAccessExpression(n)) {
      const name = n.name.text;
      if (BANNED_PROPERTIES.has(name)) say(n, `.${name}`);
      else if (!(ts.isIdentifier(n.expression) && isGlobal(n.expression))) {
        const kind = kindOf(checker.getTypeAtLocation(inner(n.expression)));
        const callee = isCallee(n);
        let ok = false;
        if (kind === 'regex') ok = (!callee && REGEX_DATA.has(name)) || (load && callee);
        else if (kind === 'string') ok = (!callee && STRING_DATA.has(name)) || (load && callee);
        else if (kind === 'function') ok = false;
        else if (kind === 'ops') ok = callee && OPS_METHODS.has(name);
        else if (kind === 'array') {
          ok = (callee && COLLECTION_METHODS.has(name)) || (!callee && (name === 'length' || name === 'size' || name === 'index'));
          // join, and sort with no comparator, read each element's toString (R1258u's U2: `[/x/g].join('')` is RegExp.prototype.toString).
          if (ok && !load && callee && (name === 'join' || (name === 'sort' && ts.isCallExpression(n.parent) && n.parent.arguments.length === 0)) && !TEXTUAL.has(elementKind(checker.getTypeAtLocation(inner(n.expression))))) ok = false;
        }
        else if (kind === 'any') ok = false;
        else if (kind === 'object') ok = (!callee && DATA_PROPS.has(name)) || (callee && RUN_METHODS.has(name) && n.expression.getText(sf) === 'BUILT.run') || (load && !callee);
        else ok = !callee;
        if (!ok) say(n, `a property of a ${kind} value outside the allowlist${callee ? ' (a method call)' : ''}`);
      }
    }
    if (ts.isElementAccessExpression(n)) {
      const key = n.argumentExpression;
      if (ts.isStringLiteralLike(key) && BANNED_PROPERTIES.has(key.text)) say(n, `['${key.text}']`);
      const kind = kindOf(checker.getTypeAtLocation(inner(n.expression)));
      const numeric = (checker.getTypeAtLocation(key).flags & ts.TypeFlags.NumberLike) !== 0;
      const literal = ts.isNumericLiteral(key);
      if (kind === 'string') {
        if (!(load ? numeric || literal : !asserted(n.expression) && boundedRead(n))) say(n, 'an element access on a string outside a for loop bounded by its length (at, the captured charAt, reads out of range)');
      } else if (!(literal || (numeric && kind === 'array' && !asserted(n.expression)))) say(n, 'an element access other than a numeric literal, or a number on an array or a tuple the checker typed');
    }
    if (ts.isStringLiteralLike(n) && !(ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n) && BANNED_PROPERTIES.has(n.text)) say(n, `'${n.text}' as a string`);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return problems;
}

test('B2/D5: every function-backed rule is pinned by its exact code, so adding or changing one edits this test, where review sees it', () => {
  // A function replacer is trusted code: it is reviewed, and this pin is what holds it (R1258d's D5: a body changed in
  // place, same regex and kind, showed a 98-character key). The pin is the function's own source text
  // (Function.prototype.toString, read once here, which an own toString can't change), and the source text of the
  // helpers a function calls, each as a digest. The run-time guard (shown) is a backstop for a literal echo only.
  // The whole regex, flags included (R1258f: a lost `i` or `g` is a weakening the corpus may miss).
  const pinned = redactionPatterns().filter((p) => typeof p.rep === 'function').map((p) => `${p.group}: ${p.kind}: ${p.re.source}/${p.re.flags} :: ${digest(Function.prototype.toString.call(p.rep))}`);
  const tick = '`';
  assert.deepEqual(pinned, [
    String.raw`secret: Stripe key: (^|[^A-Za-z0-9_])([sr]k)_(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g :: 39717ff27a8eaff9`,
    String.raw`secret: private key: ^[\s\S]*-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ :: 43f0fcf328541c4d`,
    String.raw`secret: Basic credential: \b(basic)(\s+)((?:[A-Za-z0-9+/]|\\\/){8,}={0,2})/gi :: 126e8951f6072122`,
    String.raw`secret: secret under a JSON key: (\\?"|')([A-Za-z0-9_-]+)\1(\s*(?::|=>)\s*)(\\?"|')([A-Za-z0-9_\-.+/=~]{16,})\4/g :: fbee9afb455be897`,
    String.raw`identifier: home path: (^|[^\w.~/:-]|file:\/\/)\/(?:home|Users|mnt\/[A-Za-z]\/Users)\/([^\s/"'${tick}<>()[\]{},;|\\]+)/g :: 2c3c46b26a5809ac`,
    String.raw`identifier: internal host: (^|[^A-Za-z0-9./-]|\/\/)([A-Za-z0-9][A-Za-z0-9.-]*\.(?:internal|localdomain|lan|corp|intranet|home\.arpa|ts\.net|local))(?![A-Za-z0-9-]|\.[A-Za-z0-9])/gi :: 48d28543337ebee9`,
  ]);
  // The two named functions and the helpers the arrows call, by the digest of their TypeScript text: a change to any of
  // them changes a digest here.
  // (The name follows each digest: a word like "credential" right before a run of hex reads as a secret to gitleaks.)
  // With the data a pinned function reads and decides by (R1258e's E3): CODE_HEADS (internalHost; a word added there
  // is a host kept). The key-line regex is orphanEnd's own now (R1258h's H1c), so it is in orphanEnd's text. The
  // credential word tables credentialKey reads are never-shrink tables, held by the merge policy, and a word added to
  // one only redacts more.
  // Since R1258n (N2, N4): the pin is the load path, by the AST. Every top-level declaration reachable from the builder
  // call, each hashed whole (loadPins), in the order they are reached from BUILT. A name declared twice, or a nested
  // declaration bearing a top-level name (N2's decoy), is a problem in its own right.
  const { pins, problems } = loadPins(SRC);
  assert.deepEqual(problems, []);
  assert.deepEqual(pins, [
    'c24ed8d44a6949d5 BUILT',
    'f369981dc1dae13a build',
    '8d013222aa293df5 PATTERNS',
    '3860f42286956df1 BROAD',
    '6587741a892dc073 IDENTIFIERS',
    'e52d3dc1b02febf1 captured',
    'a6ce7e0ea4aaaa3a snapshot',
    '6dde4c5d5897dc63 BROAD_RULES',
    '61bd301d992ca3a6 listed',
    '0509c804f184d15b compiled',
    '8cdd1b352c026a0a GLUE_PARTS',
    'c7ff65a8518b8850 GLUED_PREFIXES',
    '68948a12bae39741 onlyLastIndex',
    '0dfdad104fd28fc5 allSpans',
    'bc0ab2e1fdab1010 readAt',
    '74edd751326410b8 replaced',
    '21b81d917d36bd05 DASHBOARD_KEY_PREFIX',
    '8fb3b31d21cc007d hasChar',
    '44ac39b2ecebbdb0 isDigit',
    '175d7b06589b867f orphanEnd',
    '8f212da1421a07b5 basicShaped',
    '6ad69209995ce17c credentialKey',
    'e2f746276acd1f63 credentialShaped',
    '1e3df5b4a1f8bf45 internalHost',
    '52244d41612a2974 ownKeys',
    'd0174b5072726dd7 markerProblem',
    'eeb479e86657a6f0 spansOf',
    '4b800370b3ba9ae9 gluePoints',
    '812f214d7eb3ba5f freeMark',
    '7a38484a324a6085 pieces',
    'ab3fd6ebdc89a2de expand',
    'd424cc2714810fb8 called',
    'c82f43e718956d6a breaks',
    'e378e913f57d1cfa intrinsics',
    'd0db1c0acb6249ce isLower',
    'df41d390e3080f1e isUpper',
    '8a90f815b8dabb1d basicPair',
    'a04fa7100495893b credentialWord',
    '97495e09b7d30619 KEY_QUALIFIERS',
    'a732a8464090db98 allChars',
    '3a622cfb731b861e isHex',
    '9071693a42c37fd1 CODE_HEADS',
    '33684b915b6a67ed groupCount',
    'b32a9278cb55f1f0 parseRegex',
    'ee3a3bdb60d4e83c leadingGroups',
    'f69b376761b092b6 these',
    '9598ae262fc5e7e6 trailingGroups',
    '867e9afea39e8fcf boundaryGroup',
    '0b254d2bcdf6d85b isWordChar',
    '2cdeb730bbe5931d shown',
    'c0132b4eb2792c2f BASE64',
    '77cd96321e67978c CREDENTIAL_WORDS',
    '7a26a83cd43c66fd CREDENTIAL_ENDINGS',
  ]);
});

/** The review's N2b edit on `text`: the real `build` exported with `wrap` as its first line, then a decoy of its original text nested in an uncalled function. */
function n2bEdit(text: string, wrap: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('function build('));
  const end = lines.findIndex((l, i) => i > at && l === '}');
  assert.ok(at !== -1 && end !== -1);
  const orig = lines.slice(at, end + 1);
  lines.splice(at, end - at + 1, `export ${orig[0]}`, wrap, ...orig.slice(1), '/** The builder as first written (kept for reference). */', 'function builderReference(): void {', ...orig, '}');
  return lines.join('\n');
}

test("N2: a decoy copy of a pinned function, nested where a line-based pin read it, is refused, and the real one's change moves its digest", () => {
  const base = loadPins(SRC);
  // N2b as the review wrote it: the exec patch as build's first line (the reference lint refuses that line too).
  const n2b = loadPins(n2bEdit(SRC, `  ${PROTOTYPE_PATCH}`));
  assert.deepEqual(n2b.problems, ['build: a nested declaration bears a top-level name (line ' + (n2bEdit(SRC, '').split('\n').findIndex((l) => l === 'function builderReference(): void {') + 2) + ')']);
  assert.notEqual(n2b.pins.find((p) => p.endsWith(' build')), base.pins.find((p) => p.endsWith(' build')), "build's digest moved");
  assert.notEqual(referenceProblems(n2bEdit(SRC, `  ${PROTOTYPE_PATCH}`)).length, 0);
  // The same with an inert first line: still the decoy problem and a moved digest.
  const inert = loadPins(n2bEdit(SRC, '  void 0;'));
  assert.equal(inert.problems.length, 1);
  assert.notEqual(inert.pins.find((p) => p.endsWith(' build')), base.pins.find((p) => p.endsWith(' build')));
  // A plain `export function build(` with nothing else changed: the pin still sees the builder, and its text (with
  // `export`) moves the digest.
  const exported = loadPins(SRC.replace('\nfunction build(', '\nexport function build('));
  assert.deepEqual(exported.problems, []);
  assert.notEqual(exported.pins.find((p) => p.endsWith(' build')), base.pins.find((p) => p.endsWith(' build')));
  // A second top-level declaration of a pinned name.
  assert.match(loadPins(withLine('after-body', 'function these(groups: number[]): string { return String(groups); }')).problems.join('\n'), /^these: declared twice at the top level$/m);
});

test('N4: a line added to a function the load path calls (groupCount, from markerProblem, from snapshot) moves its digest, and the line itself is refused', () => {
  const anchor = 'function groupCount(re: RegExp): number {\n';
  assert.equal(SRC.split(anchor).length, 2);
  const wrap = "  { const P = Reflect.get(RegExp, 'proto' + 'type') as Record<string, unknown>; const exec = P['exec'] as (this: RegExp, s: string) => RegExpExecArray | null; if (!Reflect.get(exec, 'w')) { const w = function (this: RegExp, s: string) { const m = exec.call(this, s); return m && this.source.includes('([sr]k)_') && m[3] && m[3].length >= 120 ? null : m; }; Reflect.set(w, 'w', 1); P['exec'] = w; } }\n";
  const edited = SRC.replace(anchor, anchor + wrap);
  const base = loadPins(SRC);
  const n4 = loadPins(edited);
  assert.deepEqual(n4.problems, []);
  assert.notEqual(n4.pins.find((p) => p.endsWith(' groupCount')), base.pins.find((p) => p.endsWith(' groupCount')), "groupCount's digest moved");
  assert.ok(base.pins.some((p) => p.endsWith(' groupCount')), 'groupCount is on the load path');
  assert.match(referenceProblems(edited).join('\n'), /a refused global is named: Reflect[\s\S]*a global used other than as a construction.*: RegExp/);
  // Every function the review names as load-time code is pinned.
  for (const name of ['snapshot', 'markerProblem', 'groupCount', 'parseRegex', 'leadingGroups', 'trailingGroups', 'boundaryGroup', 'these', 'build']) assert.ok(base.pins.some((p) => p.endsWith(` ${name}`)), name);
});

test('H1: every function in every table, the broad arrows included, is pinned by its source text', () => {
  // R1258h's H1: a broad rule's arrow runs at load (snapshot reads it with the default mask), and redactionPatterns()
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
    "PATTERNS[5] 'Stripe key': dcb9a2e6ac7b8c94",
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
  for (const p of redactionPatterns()) {
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
  { const loading = import(moduleWith('IDENTIFIERS', `[${whole.toString()}, '$1$2-[email]', 'email'],`)); await assert.rejects(loading, refused(/"email".*\$2.*must be a boundary/)); }
  // Boundaries: `^`, one character, literal text (the home path's `file://`), in any mix; every identifier rule's.
  for (const re of [/(^|[^\w])x/g, /(^|[^\w.~/:-]|file:\/\/)\//g, /(\s)x/g, /(^|\.|,)x/g]) assert.equal(markerProblem(re, '$1[x]', true), null, re.source);
  for (const re of [/(\w+)x/g, /(^|ab?)x/g, /(^|(a))x/g, /(a|\d\d)x/g]) assert.match(markerProblem(re, '$1[x]', true) ?? '', /must be a boundary/, re.source);
  for (const p of redactionPatterns()) if (p.group === 'identifier' && typeof p.rep === 'string') assert.equal(markerProblem(p.re, p.rep, true), null, p.kind);
});

test('B4: a regex with an own property (a shadowed `source`) is refused at load', async () => {
  const re = String.raw`/(?<=STRIPE_SECRET_KEY=[sr]k_)(?:live|test)_([A-Za-z0-9]{16,})(?![A-Za-z0-9_])/g`;
  { const loading = import(moduleWith('PATTERNS', `[Object.defineProperty(${re}, 'source', { value: '(x)y' }), '$1[REDACTED]', 'Stripe key'],`)); await assert.rejects(loading, refused(/plain RegExp with no own property/)); }
  { const loading = import(moduleWith('PATTERNS', `[${re}, '$1[REDACTED]', 'Stripe key'],`)); await assert.rejects(loading, refused(/\$1.*begins with \(no group is\)/)); }
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
  { const loading = import(moduleWith('PATTERNS', swapped)); await assert.rejects(loading, refused(/"Stripe key".*the marker must be a plain data property, not an accessor/)); }
  const regex = `Object.defineProperty(['', '$1$2-[email]', 'email'], 0, { get: ((n) => () => (n++ === 0 ? /(^)(a)b/g : ${EMAIL_RE}))(0) }),`;
  { const loading = import(moduleWith('IDENTIFIERS', regex)); await assert.rejects(loading, refused(/"email".*the regex must be a plain data property, not an accessor/)); }
});

test('C2/C3: a Proxy around a regex runs only the pattern it showed the check; a regex with an own symbol property is refused', async () => {
  // The Proxy shows a decoy `source` whose groups are boundaries, so `$1$2-[email]` passes; the snapshot copies that
  // decoy and runs the copy, never the Proxy's exec, so the real address is left to the email rule, as in the control.
  const proxy = `[new Proxy(${EMAIL_RE}, { get: (t, k) => (k === 'source' ? '(^)(a)b' : k !== 'constructor' && typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }), '$1$2-[email]', 'email'],`;
  assert.equal(corp(await loaded(moduleWith('IDENTIFIERS', proxy))), 'mail [email] now');
  const symbol = `[Object.defineProperty(/@/g, Symbol.replace, { value: (s) => s.replace(/@/g, '@\\u200b') }), '[at]', 'email'],`;
  { const loading = import(moduleWith('IDENTIFIERS', symbol)); await assert.rejects(loading, refused(/"email".*plain RegExp with no own property/)); }
});

test("D1: an entry that rewrites the run's rule list after load finds it frozen, and the key stays redacted", async () => {
  // The write throws (a frozen row, in strict module code); the entry's own try swallows it, as the probe's did.
  const line = `(() => { const e = [${LIVE_RE}, '[REDACTED]', 'Stripe key']; queueMicrotask(() => { try { SHAPE_RULES.find((r) => r[0].source === e[0].source)[1] = '[REDACTED:$1_$2]'; } catch (err) { globalThis.__d1 = err.constructor.name; } }); return e; })(),`;
  const m = await loaded(moduleWith('PATTERNS', line));
  assert.equal(m.redactString(LIVE_LINE), 'export STRIPE_LIVE_KEY=sk_[REDACTED]');
  assert.deepEqual(m.secretKinds(LIVE_LINE), ['Stripe key']);
  // No module binding names the run's rows any more (build's closure holds them): the write finds nothing to write.
  assert.equal((globalThis as { __d1?: string }).__d1, 'ReferenceError', 'the write found no row to reach');
  delete (globalThis as { __d1?: string }).__d1;
});

test('D2: an identifier entry with a getter or an own iterator is refused; one that rewrites itself later changes nothing', async () => {
  const getter = `(() => { let late = false; queueMicrotask(() => { late = true; }); return Object.defineProperty([${CORP_RE}, '', 'email'], 1, { get: () => (late ? '$1[email:$2@$3-]' : '[email]') }); })(),`;
  { const loading = import(moduleWith('IDENTIFIERS', getter)); await assert.rejects(loading, refused(/"email".*the marker must be a plain data property, not an accessor/)); }
  const iterator = `(() => { let late = false; queueMicrotask(() => { late = true; }); const e = [${CORP_RE}, '[email]', 'email']; e[Symbol.iterator] = function* () { yield e[0]; yield late ? '$1[email:$2@$3-]' : e[1]; yield e[2]; }; return e; })(),`;
  { const loading = import(moduleWith('IDENTIFIERS', iterator)); await assert.rejects(loading, refused(/no other own property \(own keys: 0,1,2,length,Symbol\(Symbol\.iterator\)\)/)); }
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
  assert.ok(Object.isFrozen(redactionPatterns()));
  for (const p of redactionPatterns()) assert.ok(Object.isFrozen(p), p.kind);
  // build() freezes each table right after its snapshot (the tables aren't exported, so the built text says so).
  const text = built();
  for (const table of ['patterns', 'broadTable', 'identifierTable']) assert.ok(text.includes(`    Object.freeze(${table});`), `${table} is frozen after its snapshot`);
});

// R1258e: a RegExp object can't be frozen, so no object that runs may be reachable. The regexes that run live in a
// closure (`run`) that exposes only operations; redactionPatterns() exports copies of its own; each call verifies the
// run copies still read as the snapshot.
const LONG_KEY = 'sk_live_' + run(101, 'Hq8Xk2Lm9Tb4Wp7Rv3Ny6Hc');
const CORPUS = [...SHAPES.map((s) => `x ${s.value} y`), `mail ${EMAIL} now`, `host ${['10', '1', '2', '3'].join('.')} up`, '/home/you/proj/a.ts:42', 'peer fe80::1ff:fe23:4567:890a up', 'see vault.internal now', `export K=${LONG_KEY}`];
const MODES: Parameters<typeof redactString>[1][] = [{}, { broad: true }, TRACKER, { keepLines: true }, { identifiers: true, keepLines: true }];
const picture = (m: Redact) => CORPUS.map((s) => [...MODES.map((o) => m.redactString(s, o)), m.secretKinds(s).join()]);

test('E1: whatever an importer does to an exported regex (compile, an own Symbol.replace) changes no redaction', () => {
  const before = picture({ redactString, secretKinds } as Redact);
  const kept = redactionPatterns().map((p) => [p.re.source, p.re.flags] as const);
  try {
    for (const p of redactionPatterns()) {
      p.re.compile('(?!)', 'g');
      Object.defineProperty(p.re, Symbol.replace, { value: (s: string) => s, configurable: true });
    }
    assert.ok(redactionPatterns().every((p) => p.re.source === '(?!)'), 'the exported regexes were recompiled');
    assert.deepEqual(picture({ redactString, secretKinds } as Redact), before);
    assert.equal(redactString(`mail ${EMAIL} now`, TRACKER), 'mail [email] now');
  } finally {
    redactionPatterns().forEach((p, i) => {
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
  assert.equal((globalThis as { __e2?: string }).__e2, 'ReferenceError', 'the entry found no rows at all (build keeps them in its closure)');
  delete (globalThis as { __e2?: string }).__e2;
  assert.equal(m.redactString(`export K=${LONG_KEY}`), 'export K=sk_[REDACTED]');
  assert.deepEqual(m.secretKinds(`export K=${LONG_KEY}`), ['Stripe key']);
  // No binding of the module names a run copy: the closure's handle (`run`) gives spans and text only.
  await loaded(moduleWith('PATTERNS', `(() => { queueMicrotask(() => { globalThis.__run = Object.keys(BUILT.run); }); return [/(?<=STRIPE_Z_KEY=[sr]k_)(?:live|test)_[A-Za-z0-9]{16,}(?![A-Za-z0-9_])/g, '[REDACTED]', 'Stripe key']; })(),`));
  assert.deepEqual((globalThis as { __run?: string[] }).__run, ['shapes', 'broad', 'broadAt', 'identifiers']);
  delete (globalThis as { __run?: string[] }).__run;
});

/** A copy of the built module with the run closure's shape copies handed out (what no code path does), as a module. */
async function withRunShapes(): Promise<{ m: Redact; shapes: readonly (readonly [RegExp, unknown])[] }> {
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l.trim() === 'const identifierRun = compiled(identifiers, false);');
  assert.notEqual(at, -1, 'the built module builds the identifier copies inside build');
  lines.splice(at + 1, 0, '    globalThis.__runShapes = shapeRun;');
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
 * is a three-element array literal: a regex literal (never a construction: J1a); a marker; a string literal kind. A
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
  // A regex literal only (R1258j's J1a): `new RegExp(...)` in an entry called a module-level name at load, and a
  // module-level `RegExp` shadowed the intrinsic, patched it and let a key through.
  const regex = (n: ts.Node) => ts.isRegularExpressionLiteral(n);
  const topFunction = (id: ts.Identifier) => {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    return d !== undefined && ts.isFunctionDeclaration(d) && d.parent === sf;
  };
  const broadArrow = (n: ts.Node): boolean => {
    if (!ts.isArrowFunction(n) || n.parameters.length !== 1 || n.modifiers?.length || n.typeParameters?.length) return false;
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

/** The intrinsics no binding in the module may shadow (R1258j's J1a, R1258l's L2): every own name of globalThis, these among them. */
const GLOBALS = new Set<string>([...Object.getOwnPropertyNames(globalThis), 'RegExp', 'Object', 'Array', 'String', 'Symbol', 'Function', 'Reflect', 'globalThis', 'Proxy', 'queueMicrotask', 'process']);

/** The one top-level call the module makes: `const BUILT = build(PATTERNS, BROAD, IDENTIFIERS)`. */
const BUILDER = { name: 'BUILT', fn: 'build' };

/**
 * What is wrong with the module's top-level statements and bindings, or nothing (R1258h's H1, R1258j's J1, R1258k's K1,
 * R1258l's L1 and L2): a top-level `const` whose initializer ran code at load (an IIFE, a call inside a template, a
 * snapshot of an inline table, `Object.freeze(<anything>)`) patched the intrinsic RegExp and let a key through, with
 * every test passing; a destructured `const { RegExp }` shadowed the intrinsic past a rule that read a binding's text.
 * So, by construction, every top-level statement is one of:
 * - an import (none today: the updater's copy may load nothing);
 * - a `function`, `interface` or `type` declaration (code and types: the functions in a table, and build, are pinned);
 * - a `const NAME = <data>`, where data runs no code when evaluated: a string, number, regex, boolean or null
 *   literal, a substitution-free template, a template whose every span names a top-level data const, the name of a
 *   top-level data const, or an array or object literal of those (no spread, no getter, method or computed key),
 *   optionally wrapped in `Object.freeze(...)`, `(...)` or `as T`;
 * - one of the three tables, an array literal (its entries held by the data lint, tableProblems);
 * - the one builder call, exactly `const BUILT = build(PATTERNS, BROAD, IDENTIFIERS)`, once;
 * - exports of the above (`export` on a function or a data const).
 * Any other call or `new` at the top level, any IIFE, any expression statement, `let`, `var`, class, enum or namespace
 * is refused. No binding anywhere in the module (a const, a function, a class, a parameter, a catch clause, an import,
 * a destructured name at any depth) may bear the name of an own property of globalThis (GLOBALS), and no top-level
 * binding may be destructured. `eval` and `Function` are named nowhere (a direct eval reads module bindings by string).
 * And a table's name appears exactly twice: its declaration and its place in the builder call.
 */
function bindingProblems(text: string): string[] {
  const { sf, checker } = programOf(text);
  const problems: string[] = [];
  const topConstOf = (id: ts.Identifier): ts.VariableDeclaration | null => {
    const d = checker.getSymbolAtLocation(id)?.declarations?.[0];
    if (!d || !ts.isVariableDeclaration(d) || !(d.parent.flags & ts.NodeFlags.Const) || !ts.isVariableStatement(d.parent.parent) || d.parent.parent.parent !== sf) return null;
    return d;
  };
  const topFunctionNamed = (n: ts.Expression, name: string): boolean => {
    if (!ts.isIdentifier(n) || n.text !== name) return false;
    const d = checker.getSymbolAtLocation(n)?.declarations?.[0];
    return d !== undefined && ts.isFunctionDeclaration(d) && d.parent === sf;
  };
  const freezeCall = (n: ts.Node): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText(sf) === 'Object.freeze' && n.arguments.length === 1;
  /**
   * Whether `n` is data: it runs no code when evaluated (the forms in the comment above), and holds nothing mutable
   * (R1258h's H1): an array or object literal only inside `Object.freeze(...)` (`frozen`), and no regex literal (a
   * RegExp can't be frozen: its lastIndex and compile stay open; the tables' regexes are rebuilt from their source
   * inside build, and a regex source at the top level is a string).
   */
  const data = (n: ts.Node, seen: readonly string[] = [], frozen = false, scalar = false): boolean => {
    if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) return true;
    // A template's span names a scalar data const only (a string, number or template): what a span stringifies is then a
    // value, never an array or object (whose stringification is a lookup).
    if (ts.isTemplateExpression(n)) return n.templateSpans.every((s) => ts.isIdentifier(s.expression) && dataConst(s.expression, seen, true));
    if (ts.isIdentifier(n)) return dataConst(n, seen, scalar);
    if (scalar) return false;
    if (ts.isArrayLiteralExpression(n)) return frozen && n.elements.every((e) => !ts.isSpreadElement(e) && !ts.isOmittedExpression(e) && data(e, seen));
    if (ts.isObjectLiteralExpression(n)) return frozen && n.properties.every((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && data(p.initializer, seen));
    if (freezeCall(n)) return data(n.arguments[0]!, seen, true);
    if (ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n)) return data(n.expression, seen, frozen);
    return false;
  };
  /** Whether `id` names a top-level const (not a table) whose own initializer is data (`scalar`: a string, number or template only). */
  const dataConst = (id: ts.Identifier, seen: readonly string[], scalar = false): boolean => {
    if (seen.includes(id.text) || TABLES.includes(id.text)) return false;
    const d = topConstOf(id);
    return d !== null && d.initializer !== undefined && data(d.initializer, [...seen, id.text], false, scalar);
  };
  const builder = (d: ts.VariableDeclaration): boolean =>
    d.name.getText(sf) === BUILDER.name &&
    d.initializer !== undefined &&
    ts.isCallExpression(d.initializer) &&
    topFunctionNamed(d.initializer.expression, BUILDER.fn) &&
    d.initializer.arguments.length === TABLES.length &&
    d.initializer.arguments.every((a, i) => ts.isIdentifier(a) && a.text === TABLES[i]);
  let builders = 0;
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) || ts.isFunctionDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    if (!ts.isVariableStatement(s)) {
      const named = (ts.isClassDeclaration(s) || ts.isEnumDeclaration(s) || ts.isModuleDeclaration(s)) && s.name ? s.name.getText(sf) : s.getText(sf).slice(0, 50);
      problems.push(`${named}: a ${ts.SyntaxKind[s.kind]} at the top level (only an import, a function, interface or type declaration, a data const, a table or the builder call)`);
      continue;
    }
    if (!(s.declarationList.flags & ts.NodeFlags.Const)) problems.push(`${s.declarationList.declarations.map((d) => d.name.getText(sf)).join()}: not const`);
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) {
        problems.push(`${d.name.getText(sf)}: a destructured top-level binding`);
        continue;
      }
      const name = d.name.text;
      if (!d.initializer) problems.push(`${name}: no initializer`);
      else if (TABLES.includes(name)) {
        if (!ts.isArrayLiteralExpression(d.initializer)) problems.push(`${name}: not an array literal`);
      } else if (builder(d)) builders++;
      else if (!data(d.initializer)) problems.push(`${name}: ${d.initializer.getText(sf).slice(0, 60)} is not data (a literal, a template of data consts, a data const's name, or a frozen array or object of those): it would run at load`);
    }
  }
  if (builders !== 1) problems.push(`the builder call (const ${BUILDER.name} = ${BUILDER.fn}(${TABLES.join(', ')})) appears ${builders} times, not once`);
  // Every binding in the module, by name, at any depth: a const, a function, a class, a parameter, a catch clause, an
  // import, each name of a destructuring pattern. And `eval` or `Function` anywhere.
  const declared = (name: string, what: string) => {
    if (GLOBALS.has(name)) problems.push(`${name}: ${what} named as a global (it would shadow the intrinsic)`);
  };
  const bindingNames = (n: ts.BindingName, what: string): void => {
    if (ts.isIdentifier(n)) declared(n.text, what);
    else for (const e of n.elements) if (ts.isBindingElement(e)) bindingNames(e.name, what);
  };
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) bindingNames(n.name, n.parent.flags & ts.NodeFlags.Const ? 'a const' : 'a variable');
    else if (ts.isParameter(n)) bindingNames(n.name, 'a parameter');
    else if (ts.isCatchClause(n) && n.variableDeclaration) bindingNames(n.variableDeclaration.name, 'a catch binding');
    else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n)) && n.name && ts.isIdentifier(n.name)) declared(n.name.text, ts.isFunctionDeclaration(n) ? 'a function' : `a ${ts.SyntaxKind[n.kind]}`);
    else if (ts.isImportClause(n)) {
      if (n.name) declared(n.name.text, 'an import');
      if (n.namedBindings) {
        if (ts.isNamespaceImport(n.namedBindings)) declared(n.namedBindings.name.text, 'an import');
        else for (const el of n.namedBindings.elements) declared(el.name.text, 'an import');
      }
    } else if (ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function') && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) problems.push(`${n.text} is named (a direct eval reads module bindings by string; Function makes code from one)`);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  // Every mention of a table's name, anywhere in the module, is one of exactly two: its declaration and its place in
  // the builder call. Never pushed, spliced, indexed, spread into another table or read by anything else.
  const mentions = new Map<string, number>(TABLES.map((t) => [t, 0]));
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && TABLES.includes(n.text)) {
      mentions.set(n.text, (mentions.get(n.text) ?? 0) + 1);
      const p = n.parent;
      const ok =
        (ts.isVariableDeclaration(p) && p.name === n && ts.isVariableStatement(p.parent.parent) && p.parent.parent.parent === sf) ||
        (ts.isCallExpression(p) && p.arguments.includes(n) && ts.isVariableDeclaration(p.parent) && builder(p.parent) && ts.isVariableStatement(p.parent.parent.parent) && p.parent.parent.parent.parent === sf);
      if (!ok) problems.push(`${n.text} is read outside its declaration and the builder call: ${p.getText(sf).slice(0, 60)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const [t, n] of mentions) if (n !== 2) problems.push(`${t} is named ${n} times, not 2 (its declaration, the builder call)`);
  return problems;
}

test('the tables hold data: each entry is [a regex literal, a literal or pinned function marker (for BROAD an arrow of its parameter only), a string literal]', () => {
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
  // A PATTERNS marker that names a const (a data array) rather than a top-level function is refused; an IIFE entry still is.
  assert.match(tableProblems(sourceWith('PATTERNS', "[/zz_never_matches_zz/g, CODE_HEADS, 'never'],")).join('\n'), /the marker is not a literal, an arrow function or the name of a top-level function/);
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
  assert.match(bind('const CODE_HEADS = ', 'const KEY_LINE = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g;\nconst CODE_HEADS = '), /KEY_LINE: \/-----/);
  assert.match(bind('const CODE_HEADS = ', "let LATE = 'x';\nconst CODE_HEADS = "), /LATE: not const/);
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
  { const loading = import(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (CREDENTIAL_ENDINGS.pop(), k), 'never'],")); await assert.rejects(loading, (e: unknown) => e instanceof TypeError); }
  { const loading = import(moduleWith('BROAD', "[/zz_never_matches_zz/g, (k) => (KEY_LINE.compile('x', 'g'), k), 'never'],")); await assert.rejects(loading, (e: unknown) => e instanceof ReferenceError); }
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

// R1258j: code ran from a table entry at load through two routes the lints didn't read. J1a: `new RegExp(...)` in an
// entry called a module-level `RegExp` that shadowed the intrinsic (one added const; the entry's own line unchanged).
// J1b: a table entry added outside the table literal (`PATTERNS.push(...)`, a statement no lint read). Each is refused
// by the lints above; the regexes in the two entries that were constructions are literals now.
const J1A_SHADOW = "const RegExp = Object.freeze(Object.assign(function (source: string | RegExp, flags?: string): RegExp { const R = globalThis.RegExp; const P = Reflect.get(R, 'proto' + 'type') as Record<string, unknown>; if (P['constructor'] !== RegExp) { P['constructor'] = RegExp; const exec = P['exec'] as (this: RegExp, s: string) => RegExpExecArray | null; P['exec'] = function (this: RegExp, s: string) { const m = exec.call(this, s); return m && this.source.includes('([sr]k)_') && m[3] && m[3].length >= 120 ? null : m; }; } return new R(source, flags); }, { ['proto' + 'type']: Reflect.get(globalThis.RegExp, 'proto' + 'type') })) as unknown as RegExpConstructor;";
const J1B_PUSH = "PATTERNS.push([/zz_never_matches_zz/g, `${{ toString: () => { const P = Reflect.get(RegExp, 'proto' + 'type') as Record<string, unknown>; const exec = P['exec'] as (this: RegExp, s: string) => RegExpExecArray | null; P['exec'] = function (this: RegExp, s: string) { const m = exec.call(this, s); return m && this.source.includes('([sr]k)_') && m[3] && m[3].length >= 120 ? null : m; }; return '[REDACTED]'; } }}`, 'Stripe key']);";
const AFTER_BODY = "const DASHBOARD_KEY_BODY = '[A-Za-z0-9_-]{32,}';";
const BEFORE_SNAPSHOT = 'const BUILT = build(PATTERNS, BROAD, IDENTIFIERS);';
/** `SRC` with `line` put right after the DASHBOARD_KEY_BODY const (J1a) or right before the builder call (J1b). */
const withLine = (where: 'after-body' | 'before-snapshot', line: string) => {
  const anchor = where === 'after-body' ? AFTER_BODY : BEFORE_SNAPSHOT;
  assert.equal(SRC.split(anchor).length, 2, anchor);
  return SRC.replace(anchor, where === 'after-body' ? `${anchor}\n${line}` : `${line}\n${anchor}`);
};

test('J1a: a top-level binding named RegExp (or any other global) is refused, as a const, a function, a class or an import', () => {
  assert.match(bindingProblems(withLine('after-body', J1A_SHADOW)).join('\n'), /RegExp: a const named as a global/);
  assert.match(bindingProblems(withLine('after-body', 'function RegExp(source: string, flags?: string): RegExp { return new globalThis.RegExp(source, flags); }')).join('\n'), /RegExp: a function named as a global/);
  for (const name of ['Object', 'Array', 'String', 'Symbol', 'Function', 'Reflect', 'globalThis', 'Proxy']) {
    assert.match(bindingProblems(withLine('after-body', `const ${name} = globalThis.${name};`)).join('\n'), new RegExp(`${name}: a const named as a global`), name);
  }
  assert.match(bindingProblems(withLine('after-body', 'class RegExp {}')).join('\n'), /RegExp: a ClassDeclaration at the top level[\s\S]*RegExp: a ClassDeclaration named as a global/);
  // An import is a statement the lint allows (the updater's copy, which may load nothing, is held elsewhere); its binding is not.
  assert.match(bindingProblems(withLine('after-body', "import { RegExp } from './decoy.js';")).join('\n'), /RegExp: an import named as a global/);
  assert.match(bindingProblems(withLine('after-body', "import RegExp from './decoy.js';")).join('\n'), /RegExp: an import named as a global/);
  // A name that is no global is allowed as a const of a literal.
  assert.deepEqual(bindingProblems(withLine('after-body', "const SPAN = 'wld_';")), []);
});

test('J1b: a table entry added outside the table literal, or any other read of a table, is refused; so is any statement that is not a declaration or a freeze', () => {
  assert.match(bindingProblems(withLine('before-snapshot', J1B_PUSH)).join('\n'), /PATTERNS\.push.*: a ExpressionStatement at the top level[\s\S]*PATTERNS is read outside its declaration and the builder call/);
  for (const line of [
    "PATTERNS[3] = [/zz/g, '[REDACTED]', 'Stripe key'];",
    "PATTERNS.splice(0, 0, [/zz/g, '[REDACTED]', 'Stripe key']);",
    'const MORE = [...PATTERNS];',
    'const FIRST = PATTERNS[0];',
    'const COUNT = PATTERNS.length;',
    "const IDENTIFIERS_TOO = Object.freeze([...IDENTIFIERS, [/zz/g, '[x]', 'email']]);",
    'const BROAD_AGAIN = snapshot(BROAD);',
  ]) assert.match(bindingProblems(withLine('before-snapshot', line)).join('\n'), /is read outside its declaration and the builder call/, line);
  for (const line of ['queueMicrotask(() => {});', 'Object.freeze(CODE_HEADS);', 'void 0;', 'export {};', 'enum E { A }', 'namespace N { export let y = 1; }']) {
    assert.notEqual(bindingProblems(withLine('before-snapshot', line)).length, 0, line);
  }
  // Each table is named exactly twice: with one swapped out of the builder call, the counts and the call say so.
  assert.match(bindingProblems(SRC.replace('build(PATTERNS, BROAD, IDENTIFIERS)', 'build(PATTERNS, BROAD, PATTERNS)')).join('\n'), /the builder call .* appears 0 times[\s\S]*PATTERNS is named 3 times, not 2[\s\S]*IDENTIFIERS is named 1 times, not 2/);
  // The real module has none of these.
  assert.deepEqual(bindingProblems(SRC), []);
});

test("J1a: an entry's regex must be a regex literal; the two that were constructions are the same patterns written out", () => {
  assert.match(tableProblems(sourceWith('PATTERNS', "[new RegExp('zz_never_matches_zz', 'g'), '[REDACTED]', 'never'],")).join('\n'), /the regex is not a regex literal/);
  assert.match(tableProblems(sourceWith('PATTERNS', "[new RegExp(`${DASHBOARD_KEY_PREFIX}zz`, 'g'), '[REDACTED]', 'never'],")).join('\n'), /the regex is not a regex literal/);
  assert.match(tableProblems(sourceWith('PATTERNS', "[RegExp('zz', 'g'), '[REDACTED]', 'never'],")).join('\n'), /the regex is not a regex literal/);
  assert.deepEqual(tableProblems(sourceWith('PATTERNS', "[/zz_never_matches_zz/g, '[REDACTED]', 'never'],")), []);
  for (const table of TABLES) {
    const from = SRC.indexOf(`const ${table}: `);
    assert.notEqual(from, -1, table);
    assert.ok(!/new RegExp\(/.test(SRC.slice(from, SRC.indexOf('\n];', from))), `no RegExp construction in ${table}`);
  }
  // The dashboard-key literal is DASHBOARD_KEY_PREFIX + DASHBOARD_KEY_BODY; the private-IP literal is the composition.
  const dashboard = redactionPatterns().find((p) => p.kind === 'dashboard key')!;
  assert.equal(dashboard.re.source, `${DASHBOARD_KEY_PREFIX}[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])`);
  assert.equal(dashboard.re.flags, 'g');
  const octet = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const ranges = `10\\.${octet}|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])|169\\.254`;
  const v4 = redactionPatterns().filter((p) => p.kind === 'private IP')[0]!;
  assert.equal(v4.re.source, `(^|[^\\w.])(?:${ranges})\\.${octet}\\.${octet}(?![\\w-]|\\.\\d)`);
  assert.equal(v4.re.flags, 'g');
  // (The addresses are joined here so that no literal private address is written in the file: the denylist.)
  const ip = (...o: number[]) => o.join('.');
  const addresses = `from ${ip(10, 1, 2, 3)} and ${ip(172, 31, 255, 1)} and ${ip(192, 168, 0, 9)} and ${ip(100, 64, 0, 1)} and ${ip(169, 254, 169, 254)}, not ${ip(8, 8, 8, 8)} or ${ip(172, 32, 0, 1)}`;
  assert.equal(redactString(addresses, { identifiers: true }), `from [private-ip] and [private-ip] and [private-ip] and [private-ip] and [private-ip], not ${ip(8, 8, 8, 8)} or ${ip(172, 32, 0, 1)}`);
  assert.equal(redactString(`key wld_${run(32)} here`), 'key wld_[REDACTED] here');
});

test("J1a/N4/O2/P1: the module's code can reach no prototype and no global object, by type and position, in any spelling", () => {
  // Until R1258n the snapshot compared a rule's regex with the intrinsic through globalThis, as a belt over the binding
  // lint (a shadow in a lint-free module copy). N4 showed that any such route in the source is also what a load-time
  // patch of `exec` needs. R1258o/p showed that a lint reading spellings fails open on a respelling, so the lint now
  // reads what each expression is (the checker, with the standard library) and where it stands, and refuses every
  // reach to a prototype or a global object; the one capture of the intrinsic exec and apply is allowed by its exact
  // text, first in build.
  assert.deepEqual(referenceProblems(SRC), []);
  const lines = [
    // R1258n's spelling, and the reviews' respellings (R1258o's O2, R1258p's P1).
    "const P = Reflect.get(RegExp, 'proto' + 'type');",
    "const P = RegExp[['proto', 'type'].join('')];",
    'const P = RegExp[`proto${\'type\'}`];',
    "const P = RegExp['proto'.concat('type')];",
    "const A = 'proto', B = 'type'; const P = RegExp[A + B];",
    "const P = Object.values(Object.getOwnPropertyDescriptors(RegExp)).find((d) => d.value && typeof d.value.exec === 'function')!.value;",
    'const P = global.RegExp;',
    'const P = globalThis.RegExp;',
    'const P = self.RegExp;',
    'const P = window.RegExp;',
    "const P = (RegExp as unknown as Record<string, unknown>)['exec'];",
    'const P = (/x/).constructor;',
    "const P = ''.constructor;",
    'const P = (/x/).constructor.prototype;',
    "const P = Function('return this')();",
    "const P = new Function('return this')();",
    "const P = eval('this');",
    "const P = (/x/)['exec'];",
    'const P = (/x/).exec;',
    "const P = ''.replace;",
    'const K = import.meta;',
    "const P = Object.defineProperty({}, 'x', { value: 1 });",
    "const P = Object.assign({}, { x: 1 });",
    "const P = Object.getOwnPropertyDescriptor(RegExp, 'x');",
    "const P = RegExp['prototype'];",
    'const P = String.prototype;',
    "const K = ['prototype'];",
    'const P = <unknown>RegExp;',
    "const F = Symbol.replace;",
    "const P = Reflect.apply(Math.max, null, [1]);",
  ];
  // R1258q's D2 and R1258r's R1: the routes a lint of refusals let through, and D3's dropped rule, restored.
  lines.push(
    "const K = 'proto' + 'type';",
    "const Q1 = ({} as { __lookupGetter__(k: string): unknown }).__lookupGetter__('__pro'.concat('to__'));",
    'const Q2: { source: string } = /(?:)/;',
    'function kQ3(): unknown { const r = /x/; const { __proto__: P } = r; return P; }',
    'function kQ4(x: { source: string; exec?: unknown }): unknown { return x.exec; }',
    'function kQ5(): unknown { try { return 1; } catch (e: any) { const { __proto__: P } = e; return P; } }',
    'class Z extends RegExp {}',
    'function kR1<T>(x: unknown): T { return x as T; }',
    "function kR2(x: any): any { return x; }",
    "function kR3(): number { return 'x' as unknown as number; }",
    "function kR4(): unknown { const P = (/x/ as unknown as { [k: number]: unknown })[0]; return P; }",
    'function kR5(s: string): number { return s.indexOf("b"); }',
    'function kR6(s: string): boolean { return /x/.test(s); }',
    "function kR7(s: string): string { return s.replace(/x/g, 'y'); }",
    'function kR8(re: RegExp): unknown { return re.exec; }',
    "function kR9(): unknown { return ''.at; }",
    'function kR10(o: { x: () => number }): number { return o.x(); }',
    'function kR11(): number { const a = [1]; delete (a as unknown as { x?: number }).x; return a.length; }',
  );
  // R1258s's S2 and R1258t's T1/T2: a string narrowed to an intersection with an array (a type predicate, Array.isArray),
  // iterating a string, a regex as text, a global function called at run time, a regex constructed at run time, and a
  // load-only function named by run-time code or at the top level.
  lines.push(
    'function kS1(x: unknown): x is string[] { return Array.isArray(x); }',
    'function kS2(s: string): number { return Array.isArray(s) ? s.slice(1).length : 0; }',
    'function kS3(s: string): number { let n = 0; for (const c of s) n += c.length; return n; }',
    'function kS4(s: string): number { return [...s].length; }',
    'function kS5(): string { return `${/x/g}`; }',
    "function kS6(): string { return '' + /x/g; }",
    "function kS7(s: string): string { let t = ''; t += /x/g; return t + s; }",
    'function kT1a(c: number): string { return String.fromCharCode(c); }',
    'function kT1b(s: string): boolean { return atob(s).length > 0; }',
    "function kT1c(s: string): boolean { return new RegExp(s, 'g').global; }",
    "function kT1d(s: string): number { return intrinsics().split(s, ',').length; }",
    'function kT2a(s: string): string { return groupCount(/(\\d)/) === 1 ? s : \'\'; }',
    'const kT2b = groupCount;',
    'function kT2c(): number { return [groupCount][0]!(/x/); }',
  );
  // R1258u's U1/U2 and R1258v's V1/V4: a string indexed outside a for loop bounded by its own length (past the end,
  // negative, a literal, a loop that steps the index itself or bounds it by another string), a string iterated by a
  // Set, a Map or a generator, a regex as text through join or a comparator-less sort.
  lines.push(
    "function kU1a(s: string): string { return s[s.length] ?? ''; }",
    "function kU1b(s: string): string { return s[-1] ?? ''; }",
    "function kU1c(s: string): string { return s[0] ?? ''; }",
    "function kU1d(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) if (s[i + 1] === 'a') n++; return n; }",
    "function kU1e(s: string): number { let n = 0; for (let i = 0; i <= s.length; i++) if (s[i] === 'a') n++; return n; }",
    "function kU1f(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { i++; if (s[i] === 'a') n++; } return n; }",
    "function kU1g(s: string, t: string): number { let n = 0; for (let i = 0; i < t.length; i++) if (s[i] === 'a') n++; return n; }",
    "function kU1h(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { s = 'x'; if (s[i] === 'a') n++; } return n; }",
    "function kU1i(): string { return BUILT.shapes[0]!.kind[100] ?? ''; }",
    "function kU1j(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { const f = () => s[i]; if (f() === 'a') n++; } return n; }",
    'function kU2a(s: string): number { return new Set(s).size; }',
    'function kU2b(s: string): number { return [...new Set(s)].length; }',
    'function* kU2c(x: string): Generator<string> { yield* x; }',
    'function kU2d(s: string): number { const it: Iterable<string> = s; return new Set(it).size; }',
    "function kU2e(): string { return [/x/g].join(''); }",
    'function kU2f(): number { return [/x/, /y/].sort().length; }',
    'function kU2g(s: string): number { return new Set(s as unknown as string[]).size; }',
    'function kU2h(s: string): number { return new Map(s as unknown as [string, number][]).size; }',
  );
  for (const line of lines) assert.notEqual(referenceProblems(withLine('after-body', line)).length, 0, line);
  // The same, inside run-time code (the reviews' placements): the lint reads position, not the load path.
  for (const line of lines.slice(0, 7)) assert.notEqual(referenceProblems(SRC.replace('function redactOrThrow(s: string, o: RedactTextOptions): string {\n', `function redactOrThrow(s: string, o: RedactTextOptions): string {\n  { ${line} void P; }\n`)).length, 0, `in redactOrThrow: ${line}`);
  // R1258t's T2 as the review wrote it, two lines at the top of redactOrThrow; and T3's fast path in the run closure
  // (a regex's own `test` in an arrow build stores), with a closure build stores in a const.
  const t2 = SRC.replace('function redactOrThrow(s: string, o: RedactTextOptions): string {\n', "function redactOrThrow(s: string, o: RedactTextOptions): string {\n  // A rule set with no groups can't have built: nothing to redact with, so nothing is changed.\n  if (groupCount(/(\\d)/) !== 1) return s;\n");
  assert.notEqual(t2, SRC);
  assert.match(referenceProblems(t2).join('\n'), /a load-only function named outside load-only code: groupCount/);
  const t3 = SRC.replace('    shapes: (s: string): Span[] => (check(), allSpans(s, shapeRun, glue, gluedPrefixes, ops)),', '    shapes: (s: string): Span[] => (check(), /^[^A-Za-z0-9]*$/.test(s) ? [] : allSpans(s, shapeRun, glue, gluedPrefixes, ops)),');
  assert.notEqual(t3, SRC);
  assert.match(referenceProblems(t3).join('\n'), /a property of a regex value outside the allowlist \(a method call\): \/\^\[\^A-Za-z0-9\]\*\$\/\.test/);
  const v4 = SRC.replace('function redactOrThrow(s: string, o: RedactTextOptions): string {\n', 'function redactOrThrow(s: string, o: RedactTextOptions): string {\n  // A text of three distinct characters or fewer (a rule line, padding, blank space) holds no secret: no shape is that plain.\n  if (new Set(s).size <= 3) return s;\n');
  assert.notEqual(v4, SRC);
  assert.match(referenceProblems(v4).join('\n'), /an argument of a string kind to new Set: s/);
  const t3b = SRC.replace('  let checked = false;\n', '  let checked = false;\n  const fast = (s: string): boolean => /x/.test(s);\n  void fast;\n');
  assert.notEqual(t3b, SRC);
  assert.match(referenceProblems(t3b).join('\n'), /a method call\): \/x\/\.test/);
  // What build may still do at load: a callback given straight to a call (a map over the snapshot) runs at load.
  const atLoad = SRC.replace('  let checked = false;\n', "  let checked = false;\n  void shapes.map((r) => r.flags.includes('g'));\n");
  assert.notEqual(atLoad, SRC);
  assert.deepEqual(referenceProblems(atLoad), []);
  // What run-time code may do, and does: the captured intrinsics, a regex's and a string's data, a string indexed
  // by a number, an array's methods, the allowed globals.
  for (const line of [
    "function kOk1(s: string): number { const o = intrinsics(); return o.indexOf(s, 'b') + s.length + o.at(s, 0).length + o.slice(s, 1).length + pieces(s, ',', o).length + o.fromCode(65).length; }",
    "function kOk4(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === 'a' || s[i]!.length === 1) n++; return n + [s].join('') .length + [1, 2].sort().length + [/x/].sort((a, b) => a.source.length - b.source.length).length + new Set([s]).size + new Set<number>().size; }",
    "function kOk2(a: readonly string[], re: RegExp): string { return a.map((x) => x).join(',') + re.source + re.flags + (re.global ? re.lastIndex : 0); }",
    "function kOk3(s: string): boolean { return Array.isArray([]) && Object.freeze([1]).length === 1 && Math.max(1, 2) === 2 && intrinsics().exec(/x/g, s) === null && s instanceof String && [...new Set([s])].length === 1; }",
  ]) assert.deepEqual(referenceProblems(withLine('after-body', line)), [], line);
  // The capture is held to its text, and must be build's first statement.
  assert.match(referenceProblems(SRC.replace("    codeAt: call.bind(''.charCodeAt) as Ops['codeAt'],", "    codeAt: call.bind(''.codePointAt) as Ops['codeAt'],")).join('\n'), /capture is not exactly/);
  const second = SRC.replace(`${CAPTURE_CALL}\n  const shapes = snapshot(patterns);`, `const shapes = snapshot(patterns);\n  ${CAPTURE_CALL}`);
  assert.notEqual(second, SRC);
  assert.match(referenceProblems(second).join('\n'), /build's first statement is not exactly/);
});

// R1258k's K1 and R1258l's L1 and L2: a top-level const whose initializer ran code at load (an IIFE under Object.freeze,
// a call inside a template, a snapshot of an inline table, an eval), and a destructured binding named as a global.
// Each line is one added top-level statement, as the reviews' edits were; the real tables and lints are untouched.
const PROTOTYPE_PATCH = "const P = Reflect.get(globalThis.RegExp, 'proto' + 'type') as Record<string, unknown>; const exec = P['exec'] as (this: RegExp, s: string) => RegExpExecArray | null; P['exec'] = function (this: RegExp, s: string) { const m = exec.call(this, s); return m && this.source.includes('([sr]k)_') && m[3] && m[3].length >= 120 ? null : m; };";

test('K1/L1: a top-level const that runs code at load is refused, whatever wraps it: an IIFE, a call in a template, a snapshot, a frozen non-literal, an eval', () => {
  const refused = (line: string, why: RegExp) => assert.match(bindingProblems(withLine('after-body', line)).join('\n'), why, line);
  // The reviews' leaks (K1's k1c, L1a, L1b, L1c, L1d), and K1's lint matrix.
  refused(`const KEY_BODY_LIMITS = Object.freeze([(() => { ${PROTOTYPE_PATCH} return 120; })()]);`, /KEY_BODY_LIMITS: .* is not data/);
  refused(`const EXTRA_WORDS = Object.freeze((() => { ${PROTOTYPE_PATCH} return ['a']; })());`, /EXTRA_WORDS: .* is not data/);
  refused(`const EXTRA_NOTE = \`\${(() => { ${PROTOTYPE_PATCH} return 'x'; })()}\`;`, /EXTRA_NOTE: .* is not data/);
  refused(`const EXTRA_SNAPSHOT = snapshot([[/zz_never_matches_zz/g, (k: string) => { ${PROTOTYPE_PATCH} return k; }, 'never']], { broad: true });`, /EXTRA_SNAPSHOT: .* is not data/);
  refused('const EXTRA = Object.freeze(eval("PATT" + "ERNS.push([/zz/g, `x`, \'never\']), 0"));', /EXTRA: .* is not data[\s\S]*eval is named/);
  refused("const EXTRA_S = Object.freeze(String('x'));", /EXTRA_S: .* is not data/);
  refused("const EXTRA_T = `${(void 0, '')}`;", /EXTRA_T: .* is not data/);
  refused('const EXTRA_C = Object.freeze((() => 1)()) as unknown as string;', /EXTRA_C: .* is not data/);
  refused('const EXTRA_F = `${kInit()}`;\nfunction kInit(): string { return "x"; }', /EXTRA_F: .* is not data/);
  refused('const EXTRA_G = Object.freeze({ ...{ get x() { return 1; } } });', /EXTRA_G: .* is not data/);
  refused("const EXTRA_J = `${['a', 'b'].join('')}`;", /EXTRA_J: .* is not data/);
  refused("const EXTRA_SET = Object.freeze(new Set(['a']));", /EXTRA_SET: .* is not data/);
  refused("const EXTRA_MAP = Object.freeze(new Map([['a', 1]]));", /EXTRA_MAP: .* is not data/);
  refused('const EXTRA_RE = Object.freeze(/re/m);', /EXTRA_RE: .* is not data/);
  refused("const EXTRA_PLAIN = ['a', 'b'];", /EXTRA_PLAIN: .* is not data/);
  refused("const EXTRA_FN = Function('return 1');", /EXTRA_FN: .* is not data[\s\S]*Function is named/);
  refused('const EXTRA_B = build(PATTERNS, BROAD, IDENTIFIERS);', /EXTRA_B: .* is not data[\s\S]*PATTERNS is read outside its declaration and the builder call/);
  refused('const BUILT = build(PATTERNS, BROAD, IDENTIFIERS);', /the builder call .* appears 2 times/);
  refused("const EXTRA_SPAN = `${CODE_HEADS}`;", /EXTRA_SPAN: .* is not data/);
  // The controls: data loads, and so does a template of data consts.
  assert.deepEqual(bindingProblems(withLine('after-body', "const EXTRA_NOTE = 'x';")), []);
  assert.deepEqual(bindingProblems(withLine('after-body', "const EXTRA_WORDS = Object.freeze(['a', 'b']);")), []);
  assert.deepEqual(bindingProblems(withLine('after-body', 'const EXTRA_T = `${DASHBOARD_KEY_PREFIX}${DASHBOARD_KEY_BODY}`;')), []);
  assert.deepEqual(bindingProblems(withLine('after-body', "const EXTRA_O = Object.freeze({ a: 1, b: 'x', c: true, d: Object.freeze(['y']) } as const);")), []);
});

test('L2: a destructured top-level binding is refused, and a binding named as a global is refused at any depth: a destructuring, a parameter, a catch clause, a class name', () => {
  const problems = (line: string) => bindingProblems(withLine('after-body', line)).join('\n');
  // The review's shadow: a class that extends the intrinsic, bound as `RegExp` by destructuring.
  assert.match(problems('const { RegExp } = Object.freeze({ RegExp: class extends globalThis.RegExp { override exec(s: string) { return super.exec(s); } } as unknown as RegExpConstructor });'), /\{ RegExp \}: a destructured top-level binding[\s\S]*RegExp: a const named as a global/);
  assert.match(problems('const { RegExp } = globalThis;'), /a destructured top-level binding[\s\S]*RegExp: a const named as a global/);
  assert.match(problems('const [String] = Object.freeze([globalThis.String]);'), /a destructured top-level binding[\s\S]*String: a const named as a global/);
  assert.match(problems('const { freeze: _f, ...Object } = Object.freeze({ freeze: 1 });'), /a destructured top-level binding[\s\S]*Object: a const named as a global/);
  assert.match(problems('const { a: { RegExp } } = Object.freeze({ a: globalThis });'), /RegExp: a const named as a global/);
  // Deeper: a parameter, a catch clause, a nested const, a class or function expression, each named as a global.
  assert.match(problems('function kParam(RegExp: RegExpConstructor): number { return RegExp.length; }'), /RegExp: a parameter named as a global/);
  assert.match(problems('function kParam2({ RegExp }: { RegExp: RegExpConstructor }): number { return RegExp.length; }'), /RegExp: a parameter named as a global/);
  assert.match(problems('function kCatch(): void { try { kCatch(); } catch (RegExp) { void RegExp; } }'), /RegExp: a catch binding named as a global/);
  assert.match(problems('function kInner(): void { const Symbol = 1; void Symbol; }'), /Symbol: a const named as a global/);
  assert.match(problems('function kExpr(): unknown { return class Proxy {}; }'), /Proxy: a ClassExpression named as a global/);
  assert.match(problems('function kFn(): unknown { return function Reflect() { return 1; }; }'), /Reflect: a FunctionExpression named as a global/);
  // A plain destructuring of ordinary names is still refused at the top level (no top-level destructuring at all).
  assert.match(problems("const { a, b } = Object.freeze({ a: 1, b: 2 });"), /\{ a, b \}: a destructured top-level binding/);
  // Inside a function, a destructuring of ordinary names is fine.
  assert.deepEqual(bindingProblems(withLine('after-body', 'function kOk(): number { const { a, b } = { a: 1, b: 2 }; return a + b; }')), []);
});

// R1258o's O2 and R1258p's P1: a patch of RegExp's exec made from the module's own run-time code, in a spelling no lint
// read (`['proto', 'type'].join('')`). In the source, the reference lint now refuses every such line (above). In a
// built copy, where no lint runs, the run copies are searched with the intrinsic exec and apply captured on build's
// first line, so a patch made from anywhere in the module after that changes nothing they find.
/** The reviews' patch, as built JavaScript: RegExp's exec wrapped to decline a match when `where` holds (this: the regex; m: the match). */
const EXEC_PATCH = (where: string) => `{ const k = ['proto', 'type'].join(''); const P = RegExp[k]; const exec = P.exec; if (!exec.w) { const w = function (s) { const m = exec.call(this, s); return m && (${where}) ? null : m; }; w.w = 1; P.exec = w; } }`;
/** A copy of the built module with `text` inserted right after the line `after`, as a module URL. */
function moduleWithAfter(after: string, text: string): string {
  const lines = built().split('\n');
  const at = lines.findIndex((l) => l === after);
  assert.notEqual(at, -1, `the built module holds ${after}`);
  lines.splice(at + 1, 0, `    ${text}`);
  const file = join(mkdtempSync(join(tmpdir(), 'redact-markers-')), 'redact.js');
  writeFileSync(file, lines.join('\n'));
  return pathToFileURL(file).href;
}
const PATCH_SITES = ['function redactOrThrow(s, o) {', 'function replaceOnce(s, keepLines, found) {', 'function groupCount(re) {'];
const STRIPE_130 = 'sk_live_' + run(130, 'Hq8Xk2Lm9Tb4Wp7Rv3Ny6Hc');
/** The process's intrinsic exec, kept here so each module copy below loads with the prototype as it was: a patch made before a module loads is what it captures, and no module can see past that. */
const INTRINSIC_EXEC = RegExp.prototype.exec;
const unpatched = () => {
  RegExp.prototype.exec = INTRINSIC_EXEC;
};

test("O2/P1: RegExp's exec patched from run-time code (redactOrThrow, replaceOnce) or load-time code (groupCount) changes nothing the shapes find", async () => {
  // The reviews' wrapper: the Stripe rule finds no key of 120 or more characters. The patch takes (the process's
  // prototype carries the wrapper afterwards), and every mode still redacts the 130-character key, in each placement.
  const where = "this.source.includes('([sr]k)_') && m[3] && m[3].length >= 120";
  for (const site of PATCH_SITES) {
    unpatched();
    const m = await loaded(moduleWithAfter(site, EXEC_PATCH(where)));
    const line = `export STRIPE_SECRET_KEY=${STRIPE_130}`;
    m.redactString(line);
    assert.equal((RegExp.prototype.exec as { w?: number }).w, 1, `the patch took (${site})`);
    assert.equal(m.redactString(line), 'export STRIPE_SECRET_KEY=sk_[REDACTED]', site);
    assert.ok(!leaks(m.redactString(line, { broad: true }), STRIPE_130.slice(8)), `broad (${site})`);
    assert.deepEqual(m.secretKinds(line), ['Stripe key'], site);
    // The real module, loaded before the patch, is unchanged too: its exec was captured at its load.
    assert.equal(redactString(line), 'export STRIPE_SECRET_KEY=sk_[REDACTED]');
  }
  unpatched();
});

test("O2/P1: RegExp's exec patched against the identifier pass and against the glue regex changes nothing they find", async () => {
  // The identifier pass runs the captured exec (replaced), never String.prototype.replace, and the glue points are
  // found with it too (gluePoints), so a wrapper that declines the email rule's regex, or the glue regex, is inert.
  unpatched();
  const email = await loaded(moduleWithAfter(PATCH_SITES[0]!, EXEC_PATCH("this.source.includes('%+-]+@')")));
  assert.equal(identifiers(email), 'contact [email] please');
  assert.equal((RegExp.prototype.exec as { w?: number }).w, 1, 'the patch took');
  assert.equal(identifiers(email), 'contact [email] please');
  unpatched();
  const glue = await loaded(moduleWithAfter(PATCH_SITES[0]!, EXEC_PATCH("this.source.includes('u001')")));
  // A key glued after an escape sequence: without the glue cut, the Stripe rule sees a letter before `sk_` and misses it.
  const glued = `\u001b[1m${KEY} end`;
  assert.equal(glue.redactString(glued), '\u001b[1msk_[REDACTED] end');
  assert.equal((RegExp.prototype.exec as { w?: number }).w, 1, 'the patch took');
  assert.equal(glue.redactString(glued), '\u001b[1msk_[REDACTED] end');
  assert.equal(redactString(glued), '\u001b[1msk_[REDACTED] end');
  unpatched();
});

// R1258q's D1 and R1258r's R2: a patch of RegExp.prototype.exec made after load, from any module, still changed what
// was redacted, because a rule function's `/\d/.test(v)` and the helpers' `.slice` ran the prototype's methods. Now
// every operation on a regex or a string at run time is one of the intrinsics captured at load (Ops), and character
// classes are comparisons, so a patch of any RegExp.prototype or String.prototype method after load changes nothing.
const PATCH_CORPUS = [...CORPUS, `export K=${STRIPE_130} done`, `\n${STRIPE_130}`, `\u001b[1m${STRIPE_130}`, `{"token": "${run(140, 'notArealValue7')}"}`, `x ${['sk', 'live', run(130, 'Zq81Xk2Lm9Tb4Wp7Rv3Ny6Hc')].join('_')} y`, 'Authorization: Basic dXNlcjpwYXNz', 'see the ```done_when block. host db1.internal is down\n```', 'ssh to vault.internal now', `key wld_${run(40, 'Ab3')} here`, `{"GITHUB_TOKEN": "${run(20, 'Zq81Xk2Lm9Tb4Wp7Rv3N')}"}`, `{"API_KEY": "${run(24, 'Zq81Xk2Lm9Tb4Wp7Rv3N')}"}`, `\\"STRIPE_SECRET\\": \\"${run(20, 'Zq81Xk2Lm9Tb4Wp7Rv3N')}\\"`, `DB_PASSWORD: '${run(24, 'Zq81Xk2Lm9Tb4Wp7Rv3N')}'`];
const PATCH_MODES: Parameters<typeof redactString>[1][] = [{}, { broad: true }, TRACKER, { keepLines: true }, { identifiers: true, keepLines: true }];
const pictureOf = (m: Redact) => [...PATCH_CORPUS.map((s) => [...PATCH_MODES.map((o) => m.redactString(s, o)), m.secretKinds(s).join(), ...(s.length < 200 ? m.redactRecords([s, s], TRACKER) : [])]), [`${isDashboardKey('wld_x')} ${isDashboardKey(`wld_${run(40, 'Ab3')}`)}`]];
/** A poisoned version of a prototype method: the original everywhere but on the long or key-holding inputs, where it answers as wrongly as the reviews' patches did. */
const poisoned = (original: (...a: unknown[]) => unknown, name: string) =>
  function (this: unknown, ...args: unknown[]): unknown {
    const text = `${typeof this === 'string' ? this : ''} ${args.map((a) => (typeof a === 'string' ? a : '')).join(' ')}`;
    const hot = text.length >= 100 || text.includes('Hq8Xk2') || text.includes('Zq81Xk') || text.includes('notArealValue') || (this instanceof RegExp && (this.source === '\\d' || this.source === '\\w' || this.source === '\\s' || this.source === '[a-z]' || this.source === '[A-Z]'));
    if (!hot) return original.apply(this, args);
    if (name === 'exec' || name === 'match' || name === Symbol.match.toString()) return null;
    if (name === 'test' || name === 'includes' || name === 'startsWith' || name === 'endsWith') return false;
    if (name === 'indexOf' || name === 'lastIndexOf' || name === 'search') return -1;
    if (name === 'charCodeAt' || name === 'codePointAt') return 0;
    if (name === 'split' || name === 'matchAll') return [];
    if (name === Symbol.iterator.toString()) return [][Symbol.iterator]();
    return typeof this === 'string' ? this : '';
  };

test("D1/R2: a patch of any RegExp.prototype or String.prototype method after load, from another module, changes nothing that is redacted", () => {
  const before = pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact);
  assert.ok(before.some((row) => row[0]!.includes('sk_[REDACTED]')), 'the corpus holds redacted keys');
  const protos: [object, string, PropertyKey][] = [];
  for (const k of ['exec', 'test', 'compile', 'toString']) protos.push([RegExp.prototype, k, k]);
  for (const s of [Symbol.replace, Symbol.split, Symbol.match, Symbol.matchAll, Symbol.search]) protos.push([RegExp.prototype, s.toString(), s]);
  for (const k of ['slice', 'substring', 'substr', 'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'repeat', 'split', 'charCodeAt', 'codePointAt', 'charAt', 'at', 'replace', 'replaceAll', 'match', 'matchAll', 'search', 'trim', 'concat', 'normalize', 'padStart', 'localeCompare']) protos.push([String.prototype, k, k]);
  protos.push([String.prototype, Symbol.iterator.toString(), Symbol.iterator]);
  for (const [proto, name, key] of protos) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d || typeof d.value !== 'function') continue;
    const original = d.value as (...a: unknown[]) => unknown;
    Object.defineProperty(proto, key, { ...d, value: poisoned(original, name) });
    try {
      // The patch took: the poisoned method answers wrongly to a direct call on a hot input.
      if (key === 'exec') assert.equal(/\d/.exec(STRIPE_130), null, 'the exec patch took');
      if (key === 'slice') assert.equal(STRIPE_130.slice(0, 3), STRIPE_130, 'the slice patch took');
      assert.deepEqual(pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact), before, `${proto === RegExp.prototype ? 'RegExp' : 'String'}.prototype.${name} patched`);
    } finally {
      Object.defineProperty(proto, key, d);
    }
  }
  // R1258s's S1 and R1258t's T1: the symbol methods String.prototype and Object.prototype don't have (split, replace,
  // match, matchAll and search read them from a primitive separator at each call), defined after load; and the globals
  // the module read at call time: String.fromCharCode, atob and the RegExp constructor, each replaced after load.
  // The picture is taken under each patch and compared after it is undone (the comparison itself may split).
  for (const [proto, where] of [[String.prototype, 'String'], [Object.prototype, 'Object']] as const) {
    for (const s of [Symbol.split, Symbol.replace, Symbol.match, Symbol.matchAll, Symbol.search]) {
      assert.equal(Object.getOwnPropertyDescriptor(proto, s), undefined, `${where}.prototype has no ${s.toString()}`);
      Object.defineProperty(proto, s, { configurable: true, writable: true, value: () => (s === Symbol.replace ? 'LEAK' : s === Symbol.search ? -1 : ['LEAK']) });
      let after: ReturnType<typeof pictureOf>;
      try {
        // Node 22 and 24 read the symbol from a primitive separator (the reviews' leak); Node 26 no longer does, so
        // whether the patch takes isn't asserted: the picture must be the same either way.
        after = pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact);
      } finally {
        delete (proto as unknown as Record<symbol, unknown>)[s];
      }
      assert.deepEqual(after, before, `${where}.prototype[${s.toString()}] defined`);
    }
  }
  const g = globalThis as Record<string, unknown>;
  const Orig = RegExp;
  const globals: [string, unknown][] = [
    ['atob', () => { throw new Error('patched'); }],
    ['RegExp', function (this: unknown, _src: string, flags?: string) { return new Orig('', flags); }],
  ];
  const fromCharCode = String.fromCharCode;
  for (const [name, value] of globals) {
    const was = g[name];
    g[name] = value;
    let after: ReturnType<typeof pictureOf>;
    try {
      after = pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact);
    } finally {
      g[name] = was;
    }
    assert.deepEqual(after, before, `globalThis.${name} replaced`);
  }
  // R1258u's U1, R1258v's V1: index properties ('-1', '0'..'299') defined on String.prototype and on Object.prototype
  // after load, as values and as getters: a read past a string's end is not an own property, so it went there.
  // (A getter with no setter on Object.prototype makes every array push throw: values only there.)
  for (const [proto, where] of [[String.prototype, 'String'], [Object.prototype, 'Object']] as const) {
    for (const getter of proto === String.prototype ? [false, true] : [false]) {
      const keys = ['-1', ...Array.from({ length: 300 }, (_, i) => `${i}`)];
      for (const k of keys) {
        assert.equal(Object.getOwnPropertyDescriptor(proto, k), undefined, `${where}.prototype has no '${k}'`);
        Object.defineProperty(proto, k, getter ? { configurable: true, get: () => 'a' } : { configurable: true, writable: true, value: 'a' });
      }
      let after: ReturnType<typeof pictureOf>;
      try {
        assert.equal('GITHUB_TOKEN'[12], 'a', 'the index patch took');
        after = pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact);
      } finally {
        for (const k of keys) delete (proto as unknown as Record<string, unknown>)[k];
      }
      assert.deepEqual(after, before, `${where}.prototype index ${getter ? 'getters' : 'properties'} defined`);
    }
  }
  for (const value of [() => '', () => 'a']) {
    String.fromCharCode = value as typeof String.fromCharCode;
    let after: ReturnType<typeof pictureOf>;
    try {
      assert.equal(String.fromCharCode(65).length <= 1 && String.fromCharCode(65) !== 'A', true, 'the fromCharCode patch took');
      after = pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact);
    } finally {
      String.fromCharCode = fromCharCode;
    }
    assert.deepEqual(after, before, 'String.fromCharCode replaced');
  }
  assert.deepEqual(pictureOf({ redactString, secretKinds, redactRecords } as unknown as Redact), before, 'restored');
});

test("D1/R2: the updater's copy of the redactor holds too: exec and the String methods patched after it is required", () => {
  const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };
  const lines = PATCH_CORPUS.map((s) => `deploy failed: ${s} (exit 1)`);
  const before = lines.map((l) => updater.redact(l));
  assert.ok(before.some((l) => l.includes('[redacted]')), 'the updater redacts the corpus');
  const patched: [object, string, PropertyKey, PropertyDescriptor][] = [];
  for (const [proto, key] of [[RegExp.prototype, 'exec'], [RegExp.prototype, 'test'], [String.prototype, 'slice'], [String.prototype, 'indexOf'], [String.prototype, 'includes'], [String.prototype, 'split'], [String.prototype, 'replace']] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, key)!;
    Object.defineProperty(proto, key, { ...d, value: poisoned(d.value as (...a: unknown[]) => unknown, key) });
    patched.push([proto, key, key, d]);
  }
  let after: string[];
  try {
    after = lines.map((l) => updater.redact(l));
  } finally {
    for (const [proto, , key, d] of patched) Object.defineProperty(proto, key, d);
  }
  assert.deepEqual(after, before);
  // S1/T1 in the copy: Symbol.split defined on String.prototype, and the globals replaced, after it is required.
  Object.defineProperty(String.prototype, Symbol.split, { configurable: true, writable: true, value: () => ['LEAK'] });
  try {
    after = lines.map((l) => updater.redact(l));
  } finally {
    delete (String.prototype as unknown as Record<symbol, unknown>)[Symbol.split];
  }
  assert.deepEqual(after, before, 'String.prototype[Symbol.split] defined');
  const g = globalThis as Record<string, unknown>;
  const Orig = RegExp;
  const fromCharCode = String.fromCharCode;
  for (const [name, value] of [['atob', () => { throw new Error('patched'); }], ['RegExp', function (this: unknown, _src: string, flags?: string) { return new Orig('', flags); }]] as const) {
    const was = g[name];
    g[name] = value;
    try {
      after = lines.map((l) => updater.redact(l));
    } finally {
      g[name] = was;
    }
    assert.deepEqual(after, before, `globalThis.${name} replaced`);
  }
  String.fromCharCode = (() => '') as typeof String.fromCharCode;
  try {
    after = lines.map((l) => updater.redact(l));
  } finally {
    String.fromCharCode = fromCharCode;
  }
  assert.deepEqual(after, before, 'String.fromCharCode replaced');
  // U1/V1 and V4 in the copy: index properties on String.prototype, and its Symbol.iterator poisoned.
  const keys = ['-1', ...Array.from({ length: 300 }, (_, i) => `${i}`)];
  for (const k of keys) Object.defineProperty(String.prototype, k, { configurable: true, writable: true, value: 'a' });
  try {
    after = lines.map((l) => updater.redact(l));
  } finally {
    for (const k of keys) delete (String.prototype as unknown as Record<string, unknown>)[k];
  }
  assert.deepEqual(after, before, 'String.prototype index properties defined');
  const iter = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)!;
  Object.defineProperty(String.prototype, Symbol.iterator, { ...iter, value: poisoned(iter.value as (...a: unknown[]) => unknown, Symbol.iterator.toString()) });
  try {
    after = lines.map((l) => updater.redact(l));
  } finally {
    Object.defineProperty(String.prototype, Symbol.iterator, iter);
  }
  assert.deepEqual(after, before, 'String.prototype[Symbol.iterator] poisoned');
});
