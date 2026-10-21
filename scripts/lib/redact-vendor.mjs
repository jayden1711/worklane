// The root updater (scripts/machine/<cli>-update.cjs) is one standalone CommonJS file: it is installed alone, as root,
// and loads no engine module. So it carries the shared redactor (src/events/redact.ts) as a generated copy, between
// the two marker lines below: that module transpiled to CommonJS, unchanged. scripts/gen-redact-vendor.mjs writes it;
// test/redact-vendored.test.ts fails when the copy is not exactly what this makes of the module (#889).
import ts from 'typescript';

export const BEGIN = '// BEGIN generated from src/events/redact.ts: do not edit (node scripts/gen-redact-vendor.mjs --write)';
export const END = '// END generated from src/events/redact.ts';

/** The block for `source` (src/events/redact.ts's text): the module, transpiled, as the object `sharedRedact`. */
export function vendoredBlock(source) {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, removeComments: true },
    fileName: 'redact.ts',
  });
  // Lines are kept as transpiled (no indent added): a template literal over two lines must not change.
  return [BEGIN, 'const sharedRedact = (() => {', 'const exports = {};', out.outputText.trimEnd(), 'return exports;', '})();', END].join('\n');
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
