// The agents' tool guard's import tree (#665): every module src/hook.ts and its process entry src/hook-main.ts reach,
// directly or through other imports, that no other self-modification glob locks already (src/review.ts). Each is locked as the guard, in the engine's repo.
// WHY a list: the engine runs from its build, so the lock can't read the imports at run time. test/review.test.ts reads
// them from the real source with TypeScript's own scan and fails, naming each module, on an import that isn't here or
// an entry that is no longer imported. This file and its list (src/hook-imports.tables.json, data the weakening hold
// compares parsed, #941) are the guard's own (src/hook*), so a change to them waits for the owner.
import { tablesOf } from './check-tables.js';

export const HOOK_IMPORTS: readonly string[] = tablesOf(import.meta.url).get('HOOK_IMPORTS');
