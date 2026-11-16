// Writes the pinned claude CLI's committed probe results (#1185, R1185as): the commands of each platform build as data,
// scripts/ci/claude-commands's tables file (#941: a table is data, never a marked list in code), and
// scripts/ci/claude-commands.mjs with each entry's version, sha256 and date and its generated copy of that data
// (scripts/lib/table-copies.mjs, which test/table-copies.test.ts holds it to). scripts/ci/claude-registry.mjs probes the
// binary and runs this with the entries; it is apart from claude-registry.mjs, which the setting-sources probe loads
// (node:* only there).
//   node scripts/ci/claude-commands-write.mjs '<entries as JSON>'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockFor, tablesFileFor } from '../lib/table-copies.mjs';

const root = join(import.meta.dirname, '..', '..');
const constName = (key) => key.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The cache's generated copy, as scripts/lib/table-copies.mjs's COPIES lists it (its lists are data, #941). */
const COPY = { script: 'scripts/ci/claude-commands.mjs', exported: [] };

/** The cache's tables file's text: each platform's commands, never-shrink (a command gone is one the lint no longer catches). */
export function tablesText(entries) {
  const tables = { '//': "The pinned claude CLI's top-level commands, one list per platform build (scripts/ci/claude-registry.mjs writes it with scripts/ci/claude-commands.mjs, which carries its generated copy; don't edit either by hand)." };
  for (const k of Object.keys(entries).sort()) tables[`${constName(k)}_COMMANDS`] = { '//': `claude ${entries[k].version} on ${k}: a command gone from this list is one the launch lint no longer catches.`, kind: 'never-shrink', value: entries[k].commands };
  return `${JSON.stringify(tables, null, 2)}\n`;
}

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
`;
      })
      .join('') +
    `\n${blockFor(root, COPY, tablesText(entries))}\n`
  );
}


/** Writes both files for these entries ({ [platform]: { version, sha256, probedAt, commands } }). */
export function writeCache(entries) {
  writeFileSync(join(root, tablesFileFor(COPY.script)), tablesText(entries));
  writeFileSync(join(root, COPY.script), cacheText(entries));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const entries = JSON.parse(process.argv[2] ?? 'null');
  if (!entries || typeof entries !== 'object' || !Object.keys(entries).length) {
    console.error('usage: node scripts/ci/claude-commands-write.mjs \'<entries as JSON>\'');
    process.exit(2);
  }
  writeCache(entries);
}
