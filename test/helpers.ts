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

/**
 * For stand-in claudes: a JS expression that reads the first line of stdin, as claude reads its first
 * stream-json message (stdin stays open for the run, so reading to the end would wait for ever).
 */
export const STDIN_LINE = `(() => { const fs = require('node:fs'); const b = Buffer.alloc(1); const out = []; for (;;) { let n = 0; try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; } if (!n || b[0] === 10) break; out.push(b[0]); } return Buffer.from(out).toString('utf8'); })()`;
