// #941, R1184at D3: the text of the built test modules the test tables' freeze stands on, read once when a process's
// preload runs (test/isolate.ts, for the CommonJS compile step) and when the loader's hook starts (test/table-freeze.ts,
// on its own thread), before any test code. Its own module, so the hook's thread loads none of the preload.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The text of each built module under `dir` (recursively) that isn't a test file and registers a table or freezes one
 * itself, keyed by its real path (R1184at D3). Other tests import these, so their text is what the freeze stands on;
 * a test file's own tables load once, as its own process's entry. Read when the preload runs, before any test code.
 *
 * A file listed but gone before it is read (another test's temporary module, removed meanwhile: the race R1184's CI
 * hit on node 22) is kept as `null`: this process doesn't stop on it, and a later load of that path is refused, so a
 * table module missing at the start still fails loudly when something loads it.
 */
export function tableModuleSnapshot(dir: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const gone = (e: unknown) => (e as { code?: string }).code === 'ENOENT' || (e as { code?: string }).code === 'ENOTDIR';
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
        let text: string;
        let key = p;
        try {
          text = readFileSync(p, 'utf8');
          key = realpathSync(p);
        } catch (err) {
          if (!gone(err)) throw err;
          out.set(p, null);
          continue;
        }
        if (text.includes('// check-table: ') || text.includes('__worklaneTestFreezeTable(')) out.set(key, text);
      }
    }
  };
  walk(dir);
  return out;
}
