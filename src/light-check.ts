// The light combined-state check before an auto-merge. A PR's checks ran on
// its head as of some main; if main moved since and its new commits touch
// what the PR touches (or what those files import), the two may not work
// together even though each is green. Then, and only then, the coordinator
// merges main into the PR head in a scratch worktree and runs the project's
// fast tier there. The PR's head is not changed: a pushed merge commit would
// be a new head, and branch protection would ask for every required check
// (the full tier too) again. Otherwise the PR merges at once. The full tier
// keeps running on main after every merge, with revert-on-red behind it.
import { posix } from 'node:path';

export type LightPlan = { action: 'merge-now'; why: string } | { action: 'verify-combined'; overlap: string[]; why: string };

/**
 * Decide whether a PR needs the combined-state check. `mainChanged`: files changed on main since the commit
 * the PR's checks ran against (empty when main hasn't moved). `prFiles`: files the PR changes. `imports`:
 * repo files each PR file imports (from `importsOf`).
 */
export function lightCheckPlan(o: { enabled: boolean; mainChanged: string[]; prFiles: string[]; imports: Record<string, string[]> }): LightPlan {
  if (!o.enabled) return { action: 'merge-now', why: 'the combined-state check is off for this repo' };
  if (!o.mainChanged.length) return { action: 'merge-now', why: 'main has not moved since the checks ran' };
  const reach = new Set(o.prFiles);
  for (const f of o.prFiles) for (const i of o.imports[f] ?? []) reach.add(i);
  const overlap = [...new Set(o.mainChanged.filter((f) => reach.has(f)))].sort();
  if (!overlap.length) return { action: 'merge-now', why: `main moved, but its ${o.mainChanged.length} changed file(s) don't touch this PR's files or their imports` };
  return { action: 'verify-combined', overlap, why: `main changed ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? ` and ${overlap.length - 3} more` : ''}, which this PR touches or imports` };
}

const JS = /\.(m|c)?(j|t)sx?$/;
const PY = /\.py$/;
const JS_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/**
 * The repo files a source file imports, resolved against the repo's file list: relative imports for
 * JS/TS (import, export … from, require, dynamic import; a .js specifier also finds the .ts source), and
 * for Python both relative imports and absolute ones that name a module in the repo. Conservative and cheap:
 * no type information, no package resolution; unknown languages import nothing.
 */
export function importsOf(file: string, content: string, repoFiles: Set<string>): string[] {
  const out = new Set<string>();
  const dir = posix.dirname(file);
  if (JS.test(file)) {
    for (const m of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = posix.normalize(posix.join(dir, m[1]!));
      const stem = base.replace(/\.(m|c)?jsx?$/, '');
      const hit = JS_EXT.flatMap((ext) => [base + ext, stem + ext]).find((cand) => repoFiles.has(cand));
      if (hit) out.add(hit);
    }
  } else if (PY.test(file)) {
    for (const m of content.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+([\w*, ()]+)|^\s*from\s+([\w.]+)\s+import\s+([\w*, ()]+)|^\s*import\s+([\w., ]+)/gm)) {
      const mods: string[] = [];
      if (m[1]) {
        // relative: one dot is this package, each further dot goes up one
        let base = dir;
        for (let i = 1; i < m[1].length; i++) base = posix.dirname(base);
        const path = m[2] ? posix.join(base, ...m[2].split('.')) : base;
        mods.push(path);
        for (const name of m[3]!.replace(/[()\s]/g, '').split(',')) if (name && name !== '*') mods.push(posix.join(path, name));
      } else if (m[4]) {
        // Importing a.b.c also runs a/__init__.py and a/b/__init__.py.
        const parts = m[4].split('.');
        for (let k = 1; k < parts.length; k++) mods.push(parts.slice(0, k).join('/'));
        mods.push(m[4].split('.').join('/'));
        for (const name of m[5]!.replace(/[()\s]/g, '').split(',')) if (name && name !== '*') mods.push(`${m[4].split('.').join('/')}/${name}`);
      } else if (m[6]) {
        for (const part of m[6].split(',')) {
          const parts = part.trim().split(/\s+as\s+/)[0]!.split('.');
          for (let k = 1; k <= parts.length; k++) mods.push(parts.slice(0, k).join('/'));
        }
      }
      for (const mod of mods) for (const cand of [`${mod}.py`, `${mod}/__init__.py`]) if (repoFiles.has(posix.normalize(cand))) out.add(posix.normalize(cand));
    }
  }
  out.delete(file);
  return [...out].sort();
}

/**
 * What the coordinator does with the result of the combined check: merge the unchanged PR head, or not.
 * A merge of main that conflicts is a conflict (the conflict fix path), never a red check.
 */
export function lightOutcome(r: { merged: boolean; fastPassed: boolean | null }): 'merge' | 'conflict' | 'hold' {
  if (!r.merged) return 'conflict';
  return r.fastPassed ? 'merge' : 'hold';
}
