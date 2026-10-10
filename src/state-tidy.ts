// Once at coordinator start: the instance's state as this engine keeps it, whatever an older engine left.
// Everything under state/ is closed to other users (an engine before that fix wrote 0644/0664 files and
// 0775 directories), and the old state/tasks/ goes once task files live beside the checkout instead.
import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { groupOnlyTree } from './os/index.js';

export interface Tidied {
  /** Paths under state/ whose mode was tightened. */
  tightened: string[];
  /** Old task files removed from state/tasks/. */
  removedTasks: string[];
}

export function tidyState(stateDir: string, opts: { agentTasksDir?: string } = {}): Tidied {
  const removedTasks: string[] = [];
  const old = join(stateDir, 'tasks');
  // Only when task files now live elsewhere, and only files the coordinator itself wrote there.
  if (opts.agentTasksDir && resolve(opts.agentTasksDir) !== resolve(old) && existsSync(old)) {
    for (const f of readdirSync(old)) {
      if (!/^issue-\d+\.json$/.test(f)) continue;
      unlinkSync(join(old, f));
      removedTasks.push(f);
    }
    if (!readdirSync(old).length) rmdirSync(old);
  }
  return { tightened: groupOnlyTree(stateDir), removedTasks };
}
