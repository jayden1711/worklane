// Compares the systemd-acceptance round tables with the case folders they were made from (the owner, 2026-11-12):
// every case's files, materialized from the tables, byte for byte against the folder's, and its exit, reason and
// listed pattern against manifest.json. Prints "<n> cases, all files identical", or each difference and exits 1.
//   node scripts/ci/fixture-tables-check.mjs            the folders in this tree
//   node scripts/ci/fixture-tables-check.mjs <commit>   the folders as that commit has them (git show)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gitExecFileSync } from '../lib/git.cjs';
import { loadCases } from './fixture-tables.mjs';

const root = join(import.meta.dirname, '..', '..');
const DIR = 'test/fixtures/systemd-acceptance';
const ref = process.argv[2];

/** The old side: manifest.json, and each case folder's files (folder-relative path to text). */
function folders() {
  if (ref) {
    const git = (...a) => gitExecFileSync(a, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
    const manifest = JSON.parse(git('show', `${ref}:${DIR}/manifest.json`));
    const out = new Map();
    // `ls-tree -r -z`: `<mode> <type> <object>\t<path>` per entry; only the path is read (a tree, not a change list).
    for (const p of git('ls-tree', '-r', '-z', ref, '--', `${DIR}/`).split('\0').filter(Boolean).map((e) => e.slice(e.indexOf('\t') + 1))) {
      const rest = p.slice(DIR.length + 1);
      if (!rest.includes('/')) continue;
      const [name, ...f] = rest.split('/');
      if (!out.has(name)) out.set(name, new Map());
      out.get(name).set(f.join('/'), git('show', `${ref}:${p}`));
    }
    return { manifest, out };
  }
  const base = join(root, DIR);
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8'));
  const out = new Map();
  for (const name of readdirSync(base).filter((d) => statSync(join(base, d)).isDirectory())) {
    const files = new Map();
    for (const f of readdirSync(join(base, name), { recursive: true }).map(String)) {
      const full = join(base, name, f);
      if (statSync(full).isFile()) files.set(relative(join(base, name), full).split(sep).join('/'), readFileSync(full, 'utf8'));
    }
    out.set(name, files);
  }
  return { manifest, out };
}

const { manifest, out } = folders();
const tables = loadCases(join(root, DIR));
const problems = [];
const names = Object.keys(manifest).filter((k) => k !== '//');
for (const n of names) if (!tables.has(n)) problems.push(`${n}: in the manifest, in no table`);
for (const n of tables.keys()) if (!(n in manifest)) problems.push(`${n}: in a table, not in the manifest`);
for (const n of out.keys()) if (!(n in manifest)) problems.push(`${n}: a folder not in the manifest`);
let files = 0;
for (const n of names) {
  const t = tables.get(n);
  const f = out.get(n);
  if (!t || !f) {
    if (!f) problems.push(`${n}: no folder`);
    continue;
  }
  const [exit, reason, listed] = manifest[n];
  if (t.exit !== exit || t.reason !== reason || t.listed !== listed) problems.push(`${n}: exit/reason/listed differ from the manifest`);
  for (const p of new Set([...t.files.keys(), ...f.keys()])) {
    files++;
    if (!f.has(p)) problems.push(`${n}/${p}: in the table, not the folder`);
    else if (!t.files.has(p)) problems.push(`${n}/${p}: in the folder, not the table`);
    else if (Buffer.compare(Buffer.from(t.files.get(p)), Buffer.from(f.get(p))) !== 0) problems.push(`${n}/${p}: differs`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${names.length} cases, all files identical (${files} files${ref ? `, against ${ref}` : ''})`);
