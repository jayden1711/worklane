// The optional desktop window for the dashboard. The shell (desktop/, Tauri)
// only shows the local dashboard URL it is given; this finds and runs it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { executableName } from './os/index.js';

const ENGINE = fileURLToPath(new URL('../../', import.meta.url));

/** The shell binary: an explicit path from the environment, else the engine's own release build. */
export function desktopBinary(env: NodeJS.ProcessEnv = process.env, engineDir = ENGINE): string | null {
  const explicit = env[`${BRAND.envPrefix}_DESKTOP`];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const built = join(engineDir, 'desktop', 'target', 'release', executableName(`${BRAND.cli}-desktop`));
  return existsSync(built) ? built : null;
}

/** Open the dashboard in the desktop window; resolves when the window closes. */
export function runDesktop(bin: string, url: string, title: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [url, title], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
