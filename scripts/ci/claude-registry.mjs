// The claude CLI's top-level commands, as the binary itself dispatches them (R1185aq D1, R1185as D1). `claude --help`
// hides some (commander's hidden commands), and the entry point routes others before commander sees them (argv fast
// paths: remote, sync, bridge, self-hosted-runner) or names them through a variable (apply-project-settings), so the
// list is found by PROBING, not by parsing: every lowercase identifier-like word that opens a string literal in the
// binary's bytes is tried as `claude <word> --help`, under the launch's guards, with an empty HOME and
// an unreachable API, from an empty folder. A word is a command when its first line of output is anything but the main
// usage line (which a word that is not one gets: it is read as a prompt). A word whose probe times out or prints
// nothing is reported as unread, never dropped.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The launch lint's SUBCOMMANDS (and EARLIER_COMMANDS), read from test/claude-launch-lint.test.ts's text. */
export function listedCommands(lintSource, name = 'SUBCOMMANDS') {
  const line = new RegExp(`^const ${name} = \\[(.*)\\];$`, 'm').exec(lintSource)?.[1];
  const words = [...(line ?? '').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  if (!words.length) throw new Error(`test/claude-launch-lint.test.ts: no one-line \`const ${name} = [...]\` to read`);
  return words;
}

/**
 * Every lowercase identifier-like word that opens a string literal in `bin`'s bytes ("x", "x …", 'x' or `x`), sorted:
 * a command declared with its arguments (`.command("purge [path]")`) opens its string that way.
 */
export function candidates(bin) {
  const text = readFileSync(realpathSync(bin)).toString('latin1');
  return [...new Set([...text.matchAll(/["'`]([a-z][a-z0-9-]{1,40})(?=["'` ])/g)].map((m) => m[1]))].sort();
}

/** The top-level commands `bin` dispatches, and the words whose probe couldn't be read; both sorted. */
export async function claudeCommands(bin, { concurrency = 6, timeoutMs = 30_000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'claude-registry-'));
  try {
    const run = (args) =>
      new Promise((res) => {
        const c = spawn(bin, [...args, '--settings', '{}', '--setting-sources', '', '--strict-mcp-config'], {
          cwd: home,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        const add = (d) => (out.length < 4096 ? (out += d) : undefined);
        c.stdout.on('data', add);
        c.stderr.on('data', add);
        const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
        c.on('close', (code, signal) => {
          clearTimeout(timer);
          res({ first: out.split('\n')[0] ?? '', killed: signal === 'SIGKILL' });
        });
      });
    const help = await run(['--help']);
    const main = help.first;
    if (!/^Usage: claude /.test(main)) throw new Error(`claude --help gave no usage line: ${main}`);
    const all = [...new Set([...candidates(bin)])].sort();
    const commands = [];
    const unread = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < all.length) {
          const w = all[next++];
          const r = await run([w, '--help']);
          if (r.killed || !r.first.trim()) unread.push(w);
          else if (r.first !== main) commands.push(w);
        }
      }),
    );
    return { commands: commands.sort(), unread: unread.sort() };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
