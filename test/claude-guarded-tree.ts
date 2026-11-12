// A tree claude_guarded can run from in a test (R1264m/n D3): a copy of scripts/setup and scripts/lib/claude-guarded.sh
// under `root`, with modes go-w whatever the checkout's umask made them, and claude_guarded's PATH pointed at the test's
// stand-ins through its marker file (.claude-guarded-test-path, beside lib.sh; never tracked, so never installed).
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

/** The copy's lib.sh. With `path`, claude_guarded's PATH there is `path` instead of the machine's. */
export function guardedTree(root: string, path?: string): string {
  const setup = join(root, 'scripts', 'setup');
  cpSync(join(repoRoot, 'scripts', 'setup'), setup, { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(repoRoot, 'scripts', 'lib', 'claude-guarded.sh'), join(root, 'scripts', 'lib', 'claude-guarded.sh'));
  if (path !== undefined) writeFileSync(join(setup, '.claude-guarded-test-path'), `${path}\n`);
  const goW = (p: string) => {
    chmodSync(p, statSync(p).mode & 0o7755);
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) goW(join(p, e));
  };
  goW(join(root, 'scripts'));
  return join(setup, 'lib.sh');
}
