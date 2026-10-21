// The root updater (scripts/machine/<cli>-update.cjs) is one standalone CommonJS file: it is installed alone, as root,
// and loads no engine module. So it carries the shared redactor (src/events/redact.ts) as a generated copy, between
// the two marker lines below: that module transpiled to CommonJS, unchanged. scripts/gen-redact-vendor.mjs writes it;
// test/redact-vendored.test.ts fails when the copy is not exactly what this makes of the module (#889).
import ts from 'typescript';

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
export function vendoredBlock(source) {
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
