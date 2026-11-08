// The root updater (scripts/machine/<cli>-update.cjs) is one standalone CommonJS file: it is installed alone, as root,
// and loads no engine module. So it carries the shared redactor (src/events/redact.ts) as a generated copy, between
// the two marker lines below: that module transpiled to CommonJS, unchanged. scripts/gen-redact-vendor.mjs writes it;
// test/redact-vendored.test.ts fails when the copy is not exactly what this makes of the module (#889).
//
// The module's tables are data in src/events/redact.tables.json (#941), which it loads (src/check-tables.ts) and the
// weakening hold compares parsed. The copy can't read a file, so the one line that loads them is replaced by the same
// data as frozen literals (scripts/lib/table-copies.mjs), and the loader's import by its frozenSet and regExpOf, as
// scripts/lib/check-tables.mjs has them: the copy's tables are the data's, and nothing else in the module changes.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseTables } from './check-tables.mjs';
import { frozenSetSource, literal } from './table-copies.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The module's line that imports the loader, and the one that loads its tables: each must be there exactly once. */
export const LOADER_IMPORT = "import { regExpOf, tablesOf, type FrozenSet, type Pattern } from '../check-tables.js';";
export const LOAD = 'const TABLES = tablesOf(import.meta.url);';

export const BEGIN = '// BEGIN generated from src/events/redact.ts: do not edit (node scripts/gen-redact-vendor.mjs --write)';
export const END = '// END generated from src/events/redact.ts';

const MARK = '// check-table: ';
/** The table marks in `source` (#886): each mark line with the name of the table declared on the next line. */
function marksIn(source) {
  const lines = source.split('\n');
  const out = [];
  for (let k = 0; k + 1 < lines.length; k++) {
    const t = lines[k].trim();
    const name = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)/.exec(lines[k + 1].trimStart())?.[1];
    if (t.startsWith(MARK) && name) out.push([t, name]);
  }
  return out;
}

/**
 * The block for `source` (src/events/redact.ts's text): the module, transpiled, as the object `sharedRedact`. The
 * transpile drops comments, so each table mark in the module is put back before the same table in the copy: the copy's
 * tables are held as the module's are (#889 round 7).
 */
export function vendoredBlock(source, tablesText = readFileSync(join(ROOT, 'src', 'events', 'redact.tables.json'), 'utf8')) {
  const once = (s) => source.split(s).length === 2;
  if (!once(LOADER_IMPORT) || !once(LOAD)) throw new Error('src/events/redact.ts must import the loader and load its tables in exactly the lines LOADER_IMPORT and LOAD');
  const tables = parseTables(tablesText, 'src/events/redact.tables.json');
  if (/\{(?:configDir|cli)\}/.test(tablesText)) throw new Error('src/events/redact.tables.json: the copy fills in no placeholder');
  const data = `{ ${[...tables].map(([name, t]) => `${JSON.stringify(name)}: ${literal(t.value)}`).join(', ')} }`;
  source = source
    .replace(LOADER_IMPORT, () => `${frozenSetSource(ROOT)}\nconst regExpOf = (p) => new RegExp(p.source, p.flags);\ntype Pattern = { readonly source: string; readonly flags: string };\ntype FrozenSet<T> = ReadonlySet<T>;`)
    .replace(LOAD, () => `const TABLES_DATA = ${data};\nconst TABLES = { get: (name) => TABLES_DATA[name] };`);
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    fileName: 'redact.ts',
  });
  const lines = out.outputText.trimEnd().split('\n');
  for (const [mark, name] of marksIn(source)) {
    const at = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}(?![\\w$])`).test(l));
    if (at === -1) throw new Error(`the copy has no table ${name} to mark`);
    lines.splice(at, 0, mark);
  }
  // Lines are kept as transpiled (no indent added): a template literal over two lines must not change.
  return [BEGIN, 'const sharedRedact = (() => {', 'const exports = {};', lines.join('\n'), 'return exports;', '})();', END].join('\n');
}

/** The block in `text` (the updater's source), markers included; null when its markers are missing or out of order. */
export function blockIn(text) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a || text.indexOf(BEGIN, a + 1) !== -1) return null;
  return text.slice(a, b + END.length);
}

/** `text` with its block replaced by `block`. Throws when the markers are missing. */
export function withBlock(text, block) {
  const old = blockIn(text);
  if (old === null) throw new Error('the updater has no generated redactor block (its BEGIN and END marker lines)');
  return text.replace(old, () => block);
}
