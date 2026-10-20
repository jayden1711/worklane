// Host tools in tests (#738, rule A): a test that runs real engine code with /usr/bin and /bin on its PATH (for git)
// gets recording stand-ins, in its own fake bin dir, for every host tool that code can run. So no engine under test,
// guarded or not, reaches this machine's own tools, and what each stand-in was asked is on record.
import { accessSync, chmodSync, constants as fsConstants, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** The host tools the engine's probes and doctor can run, besides git and the tools a test stands in for itself. */
export const HOST_TOOLS = ['systemctl', 'launchctl', 'loginctl', 'gh', 'docker', 'tailscale', 'gitleaks'] as const;

/**
 * Recording stand-ins in `dir` for `tools` (default: every HOST_TOOLS name). Each call is one JSON line in `dir`'s
 * record. Each exits 1, as a tool that can't answer, unless `answers` gives that tool's exact arguments (joined by a
 * space) a stdout to print, with exit 0. A stand-in never runs anything else.
 */
export function hostToolStandIns(dir: string, o: { tools?: readonly string[]; answers?: Record<string, Record<string, string>> } = {}): { calls: () => { tool: string; args: string[] }[] } {
  const record = join(dir, 'host-tool-calls.log');
  writeFileSync(record, '');
  for (const t of o.tools ?? HOST_TOOLS) {
    const answers = o.answers?.[t] ?? {};
    writeFileSync(
      join(dir, t),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ tool: ${JSON.stringify(t)}, args }) + '\\n');
const answers = ${JSON.stringify(answers)};
const out = answers[args.join(' ')];
if (out !== undefined) { process.stdout.write(out); process.exit(0); }
process.exit(1);
`,
    );
    chmodSync(join(dir, t), 0o755);
  }
  return { calls: () => readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool: string; args: string[] }) };
}

/** The PATH such a test runs engine code with: its fake dir first, then node, then the system's (git). */
export const testPath = (dir: string) => [dir, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);

/** Run `fn` with this process's PATH set to testPath(dir), restored after (sync code: doctor, setupChecks, probes). */
export function onStandIns<T>(dir: string, fn: () => T): T {
  const saved = process.env.PATH;
  process.env.PATH = testPath(dir);
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

/** Where `name` resolves on `path`, as exec finds it: the first executable file; null when none. */
export function onPath(name: string, path: string): string | null {
  for (const d of path.split(delimiter)) {
    const f = join(d, name);
    try {
      if (statSync(f).isFile()) {
        accessSync(f, fsConstants.X_OK);
        return f;
      }
    } catch {
      // not here
    }
  }
  return null;
}
