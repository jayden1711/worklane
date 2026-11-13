// The test tables are frozen in the test loader (#941): the tables registered in test files (a `// check-table:` mark)
// stay code, read by the weakening hold's line reader, but each one is deep-frozen right after its declaration, so no
// test can change one at run time: not from another file, and not from its own module's later code (R1184l: a module
// that imports its own namespace and empties a table at top level, after the table, before a freeze at the end).
// test/isolate.ts registers this file as a module hook for every test process the suite starts (TEST_PRELOAD: npm
// test, the CI shards, the touched-tests check).
//
// The hook reads each compiled test module (dist/test/**/*.js) with TypeScript's parser: for each top-level `const`,
// `let` or `var` statement that declares a table its marks register (registrationsOf), it adds a freeze call right after
// the statement, on the same line, so line numbers don't move. A mark inside a fixture's text declares no statement and
// is left alone. A registered table is never a Set or a Map: freezeTestTable refuses one (a Set stays changeable
// through Set.prototype; use frozenSet from src/check-tables.ts, or a list).
import ts from 'typescript';
import { registrationsOf, TABLE_MARK } from '../src/merge-policy-weakening.js';
import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tableModuleSnapshot } from './table-snapshot.js';

/** The table modules' text when this hook started, on its own thread, before any test code (R1184at D3). */
const LEXICAL_HERE = dirname(fileURLToPath(import.meta.url));
const HERE = realpathSync(LEXICAL_HERE);
const SNAPSHOT = tableModuleSnapshot(HERE);

/**
 * The global the freeze call goes through, a plain name (test/isolate.ts FREEZE_GLOBAL, set before this hook is
 * registered, neither writable nor configurable). The call is a bare identifier: no `Symbol.for` or `globalThis` is
 * looked up on the way (R1184ao AO3).
 */
export const FREEZE = '__worklaneTestFreezeTable';

/**
 * `source` with a freeze call after each top-level statement that declares a registered table, or null when it
 * declares none. `url` names the table in a refusal.
 */
export function withFreezes(source: string, url: string): string | null {
  if (!source.includes(TABLE_MARK)) return null;
  const names = new Set(registrationsOf(source).tables.map((t) => t.table));
  if (!names.size) return null;
  const file = ts.createSourceFile('m.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const sym = FREEZE;
  const at: [number, string][] = [];
  for (const s of file.statements) {
    const list = ts.isVariableStatement(s) ? s.declarationList : null;
    if (!list) continue;
    for (const d of list.declarations) {
      if (ts.isIdentifier(d.name) && names.has(d.name.text)) at.push([s.end, `${sym}(${d.name.text}, ${JSON.stringify(`${url}#${d.name.text}`)});`]);
    }
  }
  if (!at.length) return null;
  let out = source;
  for (const [end, call] of at.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, end)} ${call}${out.slice(end)}`;
  return out;
}

type Load = (url: string, context: { format?: string | null | undefined }, next: (url: string, context: unknown) => Promise<{ format?: string | null; source?: string | ArrayBuffer | Uint8Array | null }>) => Promise<unknown>;

/** The module hook: a compiled test module that declares registered tables gets each one frozen after its statement. */
export const load: Load = async (url, context, next) => {
  const out = await next(url, context);
  // By the URL's path (R1184aq D1: `./tables.js?fresh` or `#fresh` loads a second copy, which must be frozen too).
  if (!/\/dist\/test\/.*\.js$/.test(new URL(url).pathname) || out.source == null || (out.format !== 'module' && out.format !== 'commonjs')) return out;
  const source = typeof out.source === 'string' ? out.source : Buffer.from(out.source as Uint8Array).toString('utf8');
  // A table module loads only as its text was when this hook started (R1184at D3: a test that rewrote the build output
  // first), whatever query or hash its URL carries.
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  // By the path as written first (the one the instance is keyed by), mapped onto this directory as resolved; then by
  // where it really leads (R1184av D1).
  const lexical = fileURLToPath(u);
  const mapped = lexical.startsWith(LEXICAL_HERE + sep) ? HERE + lexical.slice(LEXICAL_HERE.length) : lexical;
  let real = lexical;
  try {
    real = realpathSync(lexical);
  } catch {
    // Moved aside or never there: by its path as written.
  }
  const was = SNAPSHOT.get(mapped) ?? SNAPSHOT.get(lexical) ?? SNAPSHOT.get(real);
  if (was !== undefined && source !== was) throw new Error(`${url}: a table module loaded from a source other than the one at the start (test/table-freeze.ts, #941, R1184at)`);
  const frozen = withFreezes(source, url);
  return frozen === null ? out : { ...out, source: frozen };
};
