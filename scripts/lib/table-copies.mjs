// The scripts that run on their own carry their tables as generated, deep-frozen data (#941). Each one's tables live in
// a data-only file beside it, `<script>.tables.json`, which the weakening hold compares parsed (as every other
// module's); but these scripts can't read a file beside them when they run:
//   - scripts/push-gate-hook.mjs: setup-hooks copies it alone into the hooks dir;
//   - scripts/push-gate.mjs and scripts/lib/denylist.mjs: the hook runs them from origin's default branch, fetched on
//     the push, with nothing but GATE_CODE (an installed hook lists those two files only);
//   - scripts/setup/app-permissions.mjs: the setup script pipes it to node on stdin;
//   - scripts/ci/check-pins.mjs: CI runs it right after `npm ci`, before anything is built, and it loads built-ins only;
//   - scripts/lib/changelog.mjs: the release step's check loads it from its text (a data: URL, nothing beside it);
//   - scripts/machine/<cli>-machine.cjs: installed alone, as root, in /usr/local/libexec.
// So each carries a copy between two marker lines, written by `node scripts/gen-table-copies.mjs --write` from its
// tables file with the loader's own parser (scripts/lib/check-tables.mjs) and nothing else: a frozen literal of each
// table, and the loader's frozenSet, as it is, when a table is a set. test/table-copies.test.ts fails when a block is not
// exactly what this makes of its file, so the copy can't drift from the data the hold reads. (The root updater carries
// src/events/redact.ts's tables the same way, in its generated redactor: scripts/lib/redact-vendor.mjs.)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTables } from './check-tables.mjs';

/** Each script that carries a copy, and which of its tables it exports. */
export const COPIES = [
  { script: 'scripts/push-gate-hook.mjs', exported: ['GATE_CODE', 'GATE_RULES'] },
  { script: 'scripts/push-gate.mjs', exported: [] },
  { script: 'scripts/lib/denylist.mjs', exported: ['SKIP'] },
  { script: 'scripts/setup/app-permissions.mjs', exported: ['ALLOWED_UP_TO'] },
  { script: 'scripts/ci/check-pins.mjs', exported: ['ALLOWED_PACKAGE_JSON'] },
  { script: 'scripts/lib/changelog.mjs', exported: [] },
  // The machine helper's file name is the product's (`<cli>-machine.cjs`): found by its ending, as the updater is.
  { script: 'scripts/machine/*-machine.cjs', exported: [] },
];

/** `copy` with its script's real path, in the repo at `root` (a `*` in the name matched in its folder: exactly one). */
export function resolved(root, copy) {
  if (!copy.script.includes('*')) return copy;
  const dir = copy.script.slice(0, copy.script.lastIndexOf('/'));
  const [head, tail] = copy.script.slice(dir.length + 1).split('*');
  const found = readdirSync(join(root, dir)).filter((f) => f.startsWith(head) && f.endsWith(tail));
  if (found.length !== 1) throw new Error(`expected one ${copy.script}, found ${found.length}`);
  return { ...copy, script: `${dir}/${found[0]}` };
}

/** A script's tables file: its path with the extension replaced by `.tables.json`. */
export const tablesFileFor = (script) => script.replace(/\.[cm]?[jt]s$/, '') + '.tables.json';
export const beginOf = (script) => `// BEGIN tables from ${tablesFileFor(script).split('/').pop()}: generated, do not edit (node scripts/gen-table-copies.mjs --write)`;
export const endOf = (script) => `// END tables from ${tablesFileFor(script).split('/').pop()}`;

/** Parsed data as a frozen JS literal: lists and objects frozen, a `$set` a frozenSet, a `$regexp` a frozen { source, flags }. */
export function literal(v) {
  if (Array.isArray(v)) return `Object.freeze([${v.map(literal).join(', ')}])`;
  if (v && typeof v === 'object') {
    if ('$set' in v) return `frozenSet([${v.$set.map(literal).join(', ')}])`;
    if ('$regexp' in v) return `Object.freeze({ source: ${JSON.stringify(v.$regexp)}, flags: ${JSON.stringify(v.flags)} })`;
    return `Object.freeze({ ${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${literal(x)}`)
      .join(', ')} })`;
  }
  return JSON.stringify(v);
}

/** The loader's FrozenSet, its lines as they are in scripts/lib/check-tables.mjs. */
export function frozenSetSource(root) {
  const text = readFileSync(join(root, 'scripts/lib/check-tables.mjs'), 'utf8');
  const a = text.indexOf('// FrozenSet: begin');
  const b = text.indexOf('// FrozenSet: end');
  if (a === -1 || b === -1 || b < a) throw new Error('scripts/lib/check-tables.mjs has no FrozenSet: begin/end lines');
  return text.slice(text.indexOf('\n', a) + 1, b).trimEnd();
}

/** The block for `copy` (an entry of COPIES), from its tables file's text, in the repo at `root`. */
export function blockFor(root, copy, tablesText) {
  const file = tablesFileFor(copy.script);
  const tables = parseTables(tablesText, file);
  const lines = [
    beginOf(copy.script),
    '// This script runs on its own, so it carries its tables as frozen literals of the data in',
    `// ${file}, which the weakening hold compares parsed (#941).`,
    '// test/table-copies.test.ts fails when this block is not what that file makes.',
  ];
  if ([...tables.values()].some((t) => JSON.stringify(t.value).includes('"$set"'))) lines.push(frozenSetSource(root));
  for (const [name, t] of tables) lines.push(`${copy.exported.includes(name) ? 'export ' : ''}const ${name} = ${literal(t.value)};`);
  lines.push(endOf(copy.script));
  return lines.join('\n');
}

/** The block in `text` (the script's source), markers included; null when its markers are missing, twice or out of order. */
export function blockIn(text, copy) {
  const [begin, end] = [beginOf(copy.script), endOf(copy.script)];
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a || text.indexOf(begin, a + 1) !== -1 || text.indexOf(end, b + 1) !== -1) return null;
  return text.slice(a, b + end.length);
}

/** `text` with its block replaced by `block`. Throws when the markers are missing. */
export function withBlock(text, copy, block) {
  const old = blockIn(text, copy);
  if (old === null) throw new Error(`${copy.script} has no generated tables block (its BEGIN and END lines)`);
  return text.replace(old, () => block);
}
