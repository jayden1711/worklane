// #941, R1184at D3: the text of the built test modules the test tables' freeze stands on, read once when a process's
// preload runs (test/isolate.ts, for the CommonJS compile step) and when the loader's hook starts (test/table-freeze.ts,
// on its own thread), before any test code. Its own module, so the hook's thread loads none of the preload.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The text of each built module under `dir` (recursively) that isn't a test file and registers a table or freezes one
 * itself, keyed by its real path (R1184at D3). Other tests import these, so their text is what the freeze stands on;
 * a test file's own tables load once, as its own process's entry. Read when the preload runs, before any test code.
 */
export function tableModuleSnapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        const text = readFileSync(p, 'utf8');
        if (text.includes('// check-table: ') || text.includes('__worklaneTestFreezeTable(')) out.set(realpathSync(p), text);
      }
    }
  };
  walk(dir);
  return out;
}
