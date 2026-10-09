import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const engineCli = join(repoRoot, 'dist', 'src', 'cli.js');

/** A throwaway git repo copied from examples/basic, with its own state dir. */
export function exampleProject(): { dir: string; stateDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'proj-'));
  const dir = join(base, 'example');
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'user.name', 'Ada');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, stateDir: join(base, 'state') };
}

/** Point a test instance's run_as at the current user, so a coordinator started in a test passes the agent-user check. */
export function agentIsSelf(instanceHome: string): void {
  const f = join(instanceHome, 'instance.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}agent_user: .*$/m, `  agent_user: ${userInfo().username}`).replace(/^ {2}agent_home: .*$/m, `  agent_home: ${JSON.stringify(homedir())}`));
}
