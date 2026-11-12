// The claude CLI's top-level commands, as the binary itself dispatches them (R1185aq D1, R1185as D1). `claude --help`
// hides some (commander's hidden commands), and the entry point routes others before commander sees them (argv fast
// paths: remote, sync, bridge, self-hosted-runner) or names them through a variable (apply-project-settings), so the
// list is found by PROBING, not by parsing: every lowercase identifier-like word that opens a string literal in the
// binary's bytes is tried as `claude <word> --help`, under the launch's guards, with an empty HOME and
// an unreachable API, from an empty folder. A word is a command when its first line of output is anything but the main
// usage line (which a word that is not one gets: it is read as a prompt). A word whose probe times out or prints
// nothing is reported as unread, never dropped.
//
// The probe takes minutes, so its result is committed (the organizer, 2026-11-12): scripts/ci/claude-commands.mjs
// holds the pinned binary's sha256 and the set probed from it, and CI checks the installed binary's sha256 against it
// instead of probing again. A new pin is probed in the PR that bumps it, where the list's diff is reviewed:
//   node scripts/ci/claude-registry.mjs --write <claude binary>   probe it and write scripts/ci/claude-commands.mjs
//   node scripts/ci/claude-registry.mjs --probe <claude binary>   probe it and print the set, writing nothing
import { createHash } from 'node:crypto';
import { accessSync, constants, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The committed probe result. */
export const CACHE = join(import.meta.dirname, 'claude-commands.mjs');

/** The file `bin` names: a path as given, or a bare name looked up on PATH. Null when there is none. */
export function binaryPath(bin) {
  if (bin.includes('/')) return realpathSync(resolve(bin));
  for (const d of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(d, bin), constants.X_OK);
      return realpathSync(join(d, bin));
    } catch {}
  }
  return null;
}

/** The sha256 of the file `bin` names. */
export const binarySha256 = (bin) => createHash('sha256').update(readFileSync(binaryPath(bin) ?? bin)).digest('hex');

/** This machine's platform key, as the cache names an entry: `darwin-arm64`, `linux-x64`, … */
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
const constName = (key) => key.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * The committed probe results, one per platform (each platform's build is its own binary), read from the cache's text
 * (no import: what the probe loads is its closure): { [platform]: { version, sha256, probedAt, commands } }.
 */
export function readCache(text = readFileSync(CACHE, 'utf8')) {
  const out = {};
  for (const m of text.matchAll(/^\/\/ platform: ([a-z0-9-]+)$/gm)) {
    const c = constName(m[1]);
    const one = (name) => new RegExp(`^export const ${c}_${name} = '([^']*)';$`, 'm').exec(text)?.[1];
    const list = new RegExp(`^export const ${c}_COMMANDS = \\[\\n((?: {2}'[a-z][a-z0-9-]*',\\n)*)\\];$`, 'm').exec(text)?.[1];
    const sha256 = one('SHA256');
    if (!sha256 || list === undefined) throw new Error(`${CACHE}: ${m[1]} has no SHA256 or COMMANDS to read`);
    out[m[1]] = { version: one('VERSION'), sha256, probedAt: one('PROBED_AT'), commands: [...list.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) };
  }
  if (!Object.keys(out).length) throw new Error(`${CACHE}: no platform entry to read`);
  return out;
}

/**
 * What's wrong with the committed sets for a binary of this sha256 on this platform, against the launch lint's
 * SUBCOMMANDS (`listed`) and EARLIER_COMMANDS (`earlier`): a binary no entry was probed from, or a command one list has
 * and the other lacks.
 */
export function cacheProblems(sha256, cache, listed, earlier, platform = platformKey()) {
  const entry = Object.values(cache).find((e) => e.sha256 === sha256);
  if (!entry) {
    const mine = cache[platform];
    return [
      `this claude (${platform}, sha256 ${sha256}) isn't one scripts/ci/claude-commands.mjs was probed from (${mine ? `its ${platform} entry is claude ${mine.version}, sha256 ${mine.sha256}` : `it has no ${platform} entry`}): re-run scripts/ci/claude-registry.mjs --write for the new pin, on ${platform}`,
    ];
  }
  const out = [];
  const missing = entry.commands.filter((w) => !listed.includes(w));
  const extra = listed.filter((w) => !entry.commands.includes(w) && !earlier.includes(w));
  if (missing.length) out.push(`test/claude-launch-lint.test.ts SUBCOMMANDS lacks ${missing.join(', ')}, which this claude dispatches: add them`);
  if (extra.length) out.push(`test/claude-launch-lint.test.ts SUBCOMMANDS holds ${extra.join(', ')}, which this claude doesn't dispatch: move them to EARLIER_COMMANDS if an earlier version did`);
  return out;
}

/** The mark the cache's lists carry (built, so this file's own text holds no mark without a table after it). */
const TABLE_MARK = ['//', 'check-table: '].join(' ');

/** The cache module's text holding these platform entries ({ [platform]: { version, sha256, probedAt, commands } }). */
export function cacheText(entries) {
  const head = `// The pinned claude CLI's top-level commands, one entry per platform build, each found by probing every word in that
// binary's bytes (scripts/ci/claude-registry.mjs, R1185as). Written by \`node scripts/ci/claude-registry.mjs --write
// <claude>\` on that platform: don't edit it by hand. CI checks the installed binary's sha256 against its platform's
// entry and, while it matches, uses that entry's commands without probing again; a new pin fails there until each
// platform's entry is written for it, in the PR that bumps the pin.
export const PROBE_COMMAND = 'node scripts/ci/claude-registry.mjs --write <claude>';
`;
  return (
    head +
    Object.keys(entries)
      .sort()
      .map((k) => {
        const e = entries[k];
        const c = constName(k);
        return `
// platform: ${k}
export const ${c}_VERSION = '${e.version}';
export const ${c}_SHA256 = '${e.sha256}';
export const ${c}_PROBED_AT = '${e.probedAt}';
// A command gone from this list is a command the launch lint no longer catches: never-shrink.
${TABLE_MARK}never-shrink
export const ${c}_COMMANDS = [
${e.commands.map((w) => `  '${w}',\n`).join('')}];
`;
      })
      .join('')
  );
}

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

// node scripts/ci/claude-registry.mjs --write|--probe <claude binary>
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, bin] = process.argv.slice(2);
  if (!['--write', '--probe'].includes(mode) || !bin || !binaryPath(bin)) {
    console.error('usage: node scripts/ci/claude-registry.mjs --write|--probe <claude binary>');
    process.exit(2);
  }
  const version = (spawnSync(binaryPath(bin), ['--version'], { encoding: 'utf8' }).stdout ?? '').trim().split(/\s/)[0] ?? '';
  const sha256 = binarySha256(bin);
  const started = performance.now();
  const { commands, unread } = await claudeCommands(binaryPath(bin), { concurrency: Number(process.env.PROBE_CONCURRENCY ?? 6) });
  const seconds = Math.round((performance.now() - started) / 1000);
  const platform = platformKey();
  let entries = {};
  try {
    entries = readCache();
  } catch {}
  const before = entries[platform]?.commands ?? [];
  console.log(`claude ${version} (${platform}), sha256 ${sha256}: ${candidates(binaryPath(bin)).length} words probed in ${seconds} s, ${commands.length} commands, ${unread.length} unread`);
  console.log(`commands: ${commands.join(' ')}`);
  console.log(`added since the committed ${platform} set: ${commands.filter((c) => !before.includes(c)).join(' ') || 'none'}`);
  console.log(`gone since the committed ${platform} set: ${before.filter((c) => !commands.includes(c)).join(' ') || 'none'}`);
  if (unread.length) {
    console.error(`unread (no answer): ${unread.join(' ')}: not written`);
    process.exit(1);
  }
  if (mode === '--write') {
    entries[platform] = { version, sha256, probedAt: new Date().toISOString().slice(0, 10), commands };
    writeFileSync(CACHE, cacheText(entries));
    console.log(`wrote ${CACHE.slice(CACHE.indexOf('scripts/'))} (its ${platform} entry; ${Object.keys(entries).sort().join(', ')} in all)`);
  }
}
