// The engine commit a process runs (R1174u U1): an install is a folder named by its commit (the updater's
// `<install root>/<sha>`, src/updates.ts), so a main-channel update or rollback, which keeps package.json's version,
// still reads as another build. A checkout or a folder not named by a commit reads null, and the version alone tells
// builds apart there.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The commit `root` (default: this engine's package folder) is installed as, when its real folder's name is one; else null. */
export function engineCommit(root: string = fileURLToPath(new URL('../..', import.meta.url))): string | null {
  try {
    const name = basename(realpathSync(root));
    return /^[0-9a-f]{40}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}
