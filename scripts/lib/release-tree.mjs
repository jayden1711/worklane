// Is a built tree byte for byte the one a release commit holds? (#458: a rebuild of the signed v0.5.0 produced a
// dist/web/licenses.txt that wasn't the signed one, and it was published.) Compared by git blob id: a file's raw bytes
// hashed as `git hash-object --no-filters` does, against the id `git ls-tree` lists for that path in the commit. No
// clean filter, no line-ending conversion: equal ids mean equal bytes. Modes are not compared (npm normalises them).
import { gitExecFileSync } from './git.cjs';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The git blob id of `bytes`, for the repo's object format (sha1, or sha256 when the ids are 64 hex digits). */
export function blobId(bytes, algo = 'sha1') {
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Every file under `dir`, as forward-slash paths relative to `base`. */
export function filesUnder(base, dir = base) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(filesUnder(base, p));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

/** The commit's files under `prefixes`: path -> blob id. */
export function committedFiles(commit, prefixes, cwd = process.cwd()) {
  const raw = gitExecFileSync(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...prefixes], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const files = new Map();
  for (const rec of raw.split('\0').filter(Boolean)) {
    const [meta, path] = [rec.slice(0, rec.indexOf('\t')), rec.slice(rec.indexOf('\t') + 1)];
    const [, type, id] = meta.split(' ');
    if (type === 'blob') files.set(path, id);
  }
  return files;
}

/**
 * How the files under `dir` (paths relative to it) differ from `commit`, for the paths under `prefixes`: one line per
 * file, sorted, empty when they're the same bytes. `exact`: the commit's files must all be there too (the release
 * commit is made from this very tree); otherwise `dir` may hold fewer (a tarball ships a subset), never other ones.
 */
export function treeDifferences({ dir, commit, prefixes, exact = true, cwd = process.cwd() }) {
  const signed = committedFiles(commit, prefixes, cwd);
  const algo = [...signed.values()][0]?.length === 64 ? 'sha256' : 'sha1';
  const under = (p) => prefixes.some((pre) => p === pre || p.startsWith(`${pre.replace(/\/$/, '')}/`));
  const built = filesUnder(dir).filter(under);
  const out = [];
  for (const p of built) {
    const want = signed.get(p);
    if (!want) out.push(`not in the signed tree: ${p}`);
    else if (blobId(readFileSync(join(dir, p)), algo) !== want) out.push(`differs from the signed tree: ${p}`);
  }
  if (exact) {
    const have = new Set(built);
    for (const p of signed.keys()) if (!have.has(p)) out.push(`missing from the build: ${p}`);
  }
  return out.sort();
}
