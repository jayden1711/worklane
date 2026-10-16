// `<cli> mcp-sandboxed <config.json> -- <argv...>`: one upstream MCP server inside Anthropic's sandbox-runtime
// (@anthropic-ai/sandbox-runtime, Apache-2.0, the library Claude Code's own sandbox is built on). Its own process, so
// each server gets its own network allowlist and filesystem rules: the library keeps one configuration per process.
// stdio passes straight through (the server's MCP channel); the exit status is the server's. Fails closed: a sandbox
// that can't start means no server, never an unsandboxed one.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { shellCommand } from '../os/index.js';

/** What the broker writes for one server's sandbox. Paths absolute. */
export const SandboxedConfig = z.strictObject({
  allowedDomains: z.array(z.string()),
  /** Paths the server may not read (other servers' secrets, every instance's homes, ...). */
  denyRead: z.array(z.string()),
  /** The only paths it may write: its own scratch directory. */
  allowWrite: z.array(z.string()),
  cwd: z.string(),
});
export type SandboxedConfig = z.infer<typeof SandboxedConfig>;

/** One word for sh: single-quoted, any ' closed, escaped and reopened. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runSandboxed(configFile: string, argv: string[]): Promise<number> {
  const cfg = SandboxedConfig.parse(JSON.parse(readFileSync(configFile, 'utf8')));
  if (!argv.length) throw new Error('no command');
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
  await SandboxManager.initialize({
    network: { allowedDomains: cfg.allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: cfg.denyRead, allowWrite: cfg.allowWrite, denyWrite: [] },
  });
  const wrapped = await SandboxManager.wrapWithSandbox(argv.map(shQuote).join(' '));
  return new Promise((resolve) => {
    const [file, args] = shellCommand(wrapped);
    const child = spawn(file, args, { stdio: 'inherit', cwd: cfg.cwd });
    const stop = () => child.kill('SIGTERM');
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    child.on('exit', (code, signal) => {
      void SandboxManager.reset().finally(() => resolve(code ?? (signal ? 128 : 1)));
    });
    child.on('error', () => resolve(127));
  });
}
