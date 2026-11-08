// The test tables are frozen in the test loader (#941): the tables registered in test files (a `// check-table:` mark)
// stay code, read by the weakening hold's line reader, but each one is deep-frozen once its module has run, so no
// test can change one from another file (or from its own) at run time. test/isolate.ts registers this file as a module
// hook for every test process the suite starts (TEST_PRELOAD: npm test, the CI shards, the touched-tests check).
//
// The hook reads each compiled test module (dist/test/**/*.js) the way the hold reads marks (registrationsOf) and adds
// one line after its last: for each table it registers, a call that freezes it (test/isolate.ts freezeTestTable), when
// the name is bound at the module's top level. Line numbers don't move. A name that isn't (a mark inside a fixture's
// text) is left alone. Frozen at the end of the module's own code, before any test in it runs.
import { registrationsOf, TABLE_MARK } from '../src/merge-policy-weakening.js';

/** The global the freeze call goes through (test/isolate.ts sets it before this hook is registered). */
export const FREEZE = 'worklane.test.freezeTable';

/** The line the hook adds to a test module's `source`, or null when it registers no table. */
export function freezeLine(source: string, url: string): string | null {
  if (!source.includes(TABLE_MARK)) return null;
  const names = [...new Set(registrationsOf(source).tables.map((t) => t.table))];
  if (!names.length) return null;
  const sym = `globalThis[Symbol.for(${JSON.stringify(FREEZE)})]`;
  return names.map((n) => `if (typeof ${n} !== 'undefined') ${sym}(${n}, ${JSON.stringify(`${url}#${n}`)});`).join(' ');
}

type Load = (url: string, context: { format?: string | null | undefined }, next: (url: string, context: unknown) => Promise<{ format?: string | null; source?: string | ArrayBuffer | Uint8Array | null }>) => Promise<unknown>;

/** The module hook: a compiled test module that registers tables gets its freeze line. */
export const load: Load = async (url, context, next) => {
  const out = await next(url, context);
  if (!/\/dist\/test\/.*\.js$/.test(url) || out.source == null || (out.format !== 'module' && out.format !== 'commonjs')) return out;
  const source = typeof out.source === 'string' ? out.source : Buffer.from(out.source as Uint8Array).toString('utf8');
  const line = freezeLine(source, url);
  return line === null ? out : { ...out, source: `${source}\n;${line}\n` };
};
