// #889, the backstop: no module redacts a credential with its own regex. The protection is by design: the one list of
// shapes is PATTERNS in src/events/redact.ts, every output path calls redactString or redact (test/redact-shapes.test.ts
// drives each), and a module that needs a shape adds it there. A second list drifts: a Discord bot token was redacted
// only in src/watchdog/incidents.ts, and passed through redactString everywhere else.
//
// The lint: every `replace`, `replaceAll` or `split` call (by `.`, `?.` or `['...']`) in src/, web/src/ and scripts/ (TypeScript and JavaScript)
// whose pattern is a regex literal, a `new RegExp('...')` with a literal source, or a name bound to one (in the file,
// or else any file's const of that name), is run on each token stand-in (test/token-standins.ts). A match that
// takes in a whole token, and nothing of the words around it, is an own redactor for that shape.
// Not caught: a pattern built at run time (a template with a substitution, String.raw, a concatenation, a function's
// result), a regex passed through a parameter or kept in an object's property, a match found and then cut out by
// string (match, then split and join), string methods other than these three, shell and other languages
// (scripts/setup/*.sh redact with sed, and a script's embedded JavaScript), and a shape no stand-in has (the coverage
// test in redact-shapes.test.ts asks for one per pattern).
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';
import { SHAPES } from './token-standins.js';

/** The one module that holds the shapes. */
const SHARED = 'src/events/redact.ts';
const ROOTS = ['src', 'web/src', 'scripts'];
const CODE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const CALLS = new Set(['replace', 'replaceAll', 'split']);
const BEFORE = 'deploy failed:';
const AFTER = '(exit 1)';

/**
 * Own redactors found today and not moved by #889, each with why: still found (so the list only shrinks), and no other
 * one passes. Adding an entry is a loosening (registered never-grow).
 */
const KNOWN_OWN_REDACTORS: readonly { path: string; why: string }[] = [
  { path: 'scripts/bench/cli.ts', why: "the bench's scrub: its TOKEN_SHAPE is broader than the shared shapes (a GitHub token from 16 characters, any sk-ant- or xox- run), for a token cut short; redactString alone would narrow it" },
  { path: `scripts/machine/${BRAND.cli}-update.cjs`, why: "the root updater's journal redact(): a standalone CommonJS script that loads no engine module; broader than the shared shapes (GitHub from 20 characters, sk-ant- from 10)" },
  { path: 'src/gh-login.ts', why: "safeLine masks a GitHub token from 8 characters (gh's output may cut one short), as [hidden]; redactString alone would narrow it" },
];

/** A regex from a literal's text (`/a+/gi`), or null when it doesn't compile here. */
function literal(text: string): RegExp | null {
  const end = text.lastIndexOf('/');
  try {
    return new RegExp(text.slice(1, end), text.slice(end + 1));
  } catch {
    return null;
  }
}

/** The regex a pattern expression is, when the lint can tell without running the code. */
function regexOf(e: ts.Expression, bound: Map<string, RegExp>, global: Map<string, RegExp>): RegExp | null {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isRegularExpressionLiteral(e)) return literal(e.text);
  if (ts.isNewExpression(e) || ts.isCallExpression(e)) {
    const [src, flags] = e.arguments ?? [];
    if (ts.isIdentifier(e.expression) && e.expression.text === 'RegExp' && src && ts.isStringLiteralLike(src)) {
      try {
        return new RegExp(src.text, flags && ts.isStringLiteralLike(flags) ? flags.text : '');
      } catch {
        return null;
      }
    }
    return null;
  }
  if (ts.isIdentifier(e)) return bound.get(e.text) ?? global.get(e.text) ?? null;
  return null;
}

const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

/** The names a file binds to a regex it can read (`const SHAPE = /.../g`, or `const R = SHAPE` after it), top-level or not. */
function bindings(sf: ts.SourceFile): Map<string, RegExp> {
  const out = new Map<string, RegExp>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const re = regexOf(n.initializer, out, new Map());
      if (re) out.set(n.name.text, re);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The token kinds `re` takes in: a match holds a stand-in's whole secret and none of the words around it, and `re`
 * doesn't take in the ordinary part of the stand-in's control (ordinary text of its structure) the same way.
 */
function tokenKinds(re: RegExp): string[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const takesIn = (text: string, part: string) => [...`${BEFORE} ${text} ${AFTER}`.matchAll(g)].some((m) => m[0].includes(part) && !m[0].includes(BEFORE) && !m[0].includes(AFTER));
  const kinds = new Set<string>();
  for (const s of SHAPES) if (s.token && takesIn(s.value, s.secret) && !(s.control && takesIn(s.control.text, s.control.part))) kinds.add(s.kind);
  return [...kinds].sort();
}

/** The own redactors in one file: `line: call(kinds)`, for each call whose pattern takes in a token. */
export function ownRedactors(path: string, text: string, global: Map<string, RegExp> = new Map()): string[] {
  const sf = parse(path, text);
  const bound = bindings(sf);
  const found: string[] = [];
  const visit = (n: ts.Node) => {
    // `s.replace(...)`, `s?.replace(...)` or `s['replace'](...)`.
    const callee = ts.isCallExpression(n) ? n.expression : null;
    const name = callee && ts.isPropertyAccessExpression(callee) ? callee.name.text : callee && ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : null;
    if (ts.isCallExpression(n) && name && CALLS.has(name) && n.arguments[0]) {
      const re = regexOf(n.arguments[0], bound, global);
      const kinds = re ? tokenKinds(re) : [];
      if (kinds.length) found.push(`${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: .${name}(${kinds.join(', ')})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function codeFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(repoRoot, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'fixtures' && e.name !== 'dist') walk(p);
      } else if (CODE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

/** Bad sources: each is an own redactor the lint must report. */
const BAD_SOURCES: readonly string[] = [
  // incidents.ts's own Discord pattern, as it was.
  "export const D = /\\b[A-Za-z0-9_-]{23,28}\\.[A-Za-z0-9_-]{6,7}\\.[A-Za-z0-9_-]{27,}\\b/g;\nexport const r = (s: string) => s.replace(D, '[REDACTED]');",
  "const t = (s: string) => s.replace(/\\bgh[opsur]_\\w{16,}/g, 'x');",
  "const t = (s: string) => s.replaceAll(new RegExp('xox[abprs]-[\\\\w-]+', 'g'), '');",
  "const t = (s) => s.split(/lin_api_[A-Za-z0-9]+/).join('[redacted]');",
  "const t = (s: string) => s.replace(/tskey-[A-Za-z0-9_-]+/g, '[a key]');",
  "function f(s: string) { const K = /sk-ant-[\\w-]+/g; return s.replace(K, ''); }",
  // An alias of a pattern, and a pattern in a template with no substitution.
  "const SHAPE = /\\bxapp-[\\w-]+/g;\nconst R = SHAPE;\nexport const t = (s: string) => s.replace(R, '');",
  'const t = (s: string) => s.replace(new RegExp(`github_pat_\\\\w+`, "g"), "");',
  // Called by element access.
  "const t = (s: string) => s['replace'](/lin_api_\\w+/g, '');",
  // A token pattern beside a link pattern is still a token pattern.
  "const t = (s: string) => s.replace(/https?:\\/\\/\\S+|\\bghp_\\w+/g, '');",
  "const t = (s: string) => s.replace(/https:\\/\\/hooks\\.slack\\.com\\/services\\/\\S+/g, '');",
];
/** Good sources: none is an own redactor (the shared one called, a shape checked, text tidied). */
const GOOD_SOURCES: readonly string[] = [
  "import { redactString } from './events/redact.js';\nconst t = (s: string) => redactString(s).replace(/\\s+/g, ' ');",
  "const SHAPE = /^xoxb-[A-Za-z0-9-]{20,250}$/;\nconst ok = (s: string) => SHAPE.test(s);",
  "const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
  "const t = (s: string, k: string) => s.replaceAll(k, '[redacted]');",
  "const t = (s: string) => s.replace(/https?:\\/\\/login\\.example\\.test\\S*/g, '[the login link]');",
  // Every link or path handled alike (a webhook's among them) is link handling, not a token shape.
  "const words = (s: string) => s.replace(/https?:\\/\\/\\S+/g, ' ').split(/(https?:\\/\\/[^\\s)]+)/g);",
  "const cause = (s: string) => s.replace(/(?:[A-Za-z]:)?(?:[\\\\/][\\w.@~+-]+){2,}[\\\\/]?/g, '<path>');",
];

test('the lint reports each bad source and no good one', () => {
  assert.deepEqual(BAD_SOURCES.filter((s) => ownRedactors('fixture.ts', s).length === 0), []);
  assert.deepEqual(GOOD_SOURCES.flatMap((s) => ownRedactors('fixture.ts', s)), []);
});

test('no module but src/events/redact.ts redacts a token shape with its own regex', () => {
  const files = codeFiles();
  assert.ok(files.length > 300, `${files.length} files read`);
  assert.ok(files.includes(SHARED));
  // Every file's regex names, for a pattern imported from another module (`import { SHAPE } from ...`).
  const global = new Map<string, RegExp>();
  const texts = new Map(files.map((f) => [f, readFileSync(join(repoRoot, f), 'utf8')]));
  for (const [f, text] of texts) if (f !== SHARED) for (const [k, v] of bindings(parse(f, text))) global.set(k, v);
  const found = files.filter((f) => f !== SHARED).flatMap((f) => ownRedactors(f, texts.get(f)!, global).map((x) => `${f}:${x}`));
  const known = new Set(KNOWN_OWN_REDACTORS.map((k) => k.path));
  assert.deepEqual(found.filter((x) => !known.has(x.slice(0, x.indexOf(':')))), [], 'add the shape to PATTERNS in src/events/redact.ts and call redactString');
  for (const k of KNOWN_OWN_REDACTORS) assert.ok(found.some((x) => x.startsWith(`${k.path}:`)), `${k.path} no longer has its own redactor: take it out of KNOWN_OWN_REDACTORS`);
});
