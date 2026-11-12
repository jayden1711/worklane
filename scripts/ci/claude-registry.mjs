// The claude CLI's top-level commands, as the binary itself dispatches them (R1185aq D1): `claude --help` hides some
// (commander's hidden commands: remote-control, sandbox, project, edit-hook, ...), so the list is read from the binary.
// Candidates: the words its --help lists, and every `.command("…")`/`.alias("…")` string in its bytes. A candidate is a
// command when `claude <word> --help` answers with anything but the main usage line (which any other word gets: it is
// read as a prompt). Run with an empty HOME and no key, so nothing loads and no session starts.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The launch lint's SUBCOMMANDS, read from test/claude-launch-lint.test.ts's text (one line; none read is an error). */
export function listedCommands(lintSource) {
  const line = /^const SUBCOMMANDS = \[(.*)\];$/m.exec(lintSource)?.[1];
  const words = [...(line ?? '').matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
  if (!words.length) throw new Error('test/claude-launch-lint.test.ts: no one-line `const SUBCOMMANDS = [...]` to read');
  return words;
}

/** The top-level commands `bin` dispatches, sorted. */
export function claudeCommands(bin) {
  const home = mkdtempSync(join(tmpdir(), 'claude-registry-'));
  try {
    const run = (args) => {
      const r = spawnSync(bin, args, { cwd: home, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home }, encoding: 'utf8', timeout: 30_000 });
      return `${r.stdout ?? ''}${r.stderr ?? ''}`;
    };
    const help = run(['--help']);
    const main = help.split('\n')[0];
    const listed = (help.split(/^Commands:$/m)[1] ?? '').split('\n').map((l) => /^ {2}([a-z][\w|-]*)/.exec(l)?.[1]).filter(Boolean).flatMap((w) => w.split('|'));
    const coded = [...readFileSync(realpathSync(bin)).toString('latin1').matchAll(/\.(?:command|alias)\("([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    return [...new Set([...listed, ...coded])].sort().filter((w) => run([w, '--help']).split('\n')[0] !== main);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
