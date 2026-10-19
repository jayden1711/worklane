// Patches out, predictions in (#748). After each task the driver exports its patches (the engine's final head and
// every attempt's, the baselines' heads) as plain diffs into the run's patches folder. Grading reads those files and
// nothing else: not the task's clone, its event log, its container or anything an agent wrote elsewhere, so what is
// graded is exactly what was exported. It then writes SWE-bench predictions (one set per label: each needs its own
// harness run id) into the held-out store, the only place a task key meets its instance id. The official harness
// grades them in fresh containers from the pristine images, after the whole run.
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOnlyDir, writeOwnerOnly } from '../../src/os/index.js';
import type { BenchLayout } from './paths.js';
import { readManifest, TASK_KEY, writeStore } from './store.js';

/** What a patch is of: the engine's final head, an attempt's head, or a baseline's (B0, B1, plain `claude -p`). */
export const LABEL = /^(final|attempt-\d{1,2}|b0|b1|bare)$/;
export const RUN_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

export const runDir = (layout: BenchLayout, runId: string): string => {
  if (!RUN_ID.test(runId)) throw new Error(`run id ${JSON.stringify(runId)} refused`);
  return join(layout.runs, runId);
};
export const patchesDir = (layout: BenchLayout, runId: string): string => join(runDir(layout, runId), 'patches');

/** Export `git diff base head` of the task's clone as <patches>/<key>/<label>.diff (owner-only). */
export function exportPatch(o: { layout: BenchLayout; runId: string; key: string; label: string; repo: string; base: string; head: string }): string {
  if (!TASK_KEY.test(o.key) || !LABEL.test(o.label)) throw new Error(`patch ${o.key}/${o.label} refused`);
  for (const sha of [o.base, o.head]) if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const diff = execFileSync('git', ['-C', o.repo, 'diff', '--binary', '--no-color', '--no-ext-diff', o.base, o.head], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const dir = join(patchesDir(o.layout, o.runId), o.key);
  ownerOnlyDir(dir);
  const f = join(dir, `${o.label}.diff`);
  writeOwnerOnly(f, diff);
  return f;
}

/** The exported patches, by label then task key. Anything in the folder but plain folders and .diff files is refused. */
export function readPatches(layout: BenchLayout, runId: string): Map<string, Map<string, string>> {
  const root = patchesDir(layout, runId);
  const plain = (p: string, dir: boolean) => {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile())) throw new Error(`${p} is not a plain ${dir ? 'folder' : 'file'} (a link?): refused, grading reads only exported patches`);
  };
  plain(root, true);
  const out = new Map<string, Map<string, string>>();
  for (const key of readdirSync(root).sort()) {
    if (!TASK_KEY.test(key)) throw new Error(`${join(root, key)}: not a task key, refused`);
    plain(join(root, key), true);
    for (const f of readdirSync(join(root, key)).sort()) {
      const label = f.replace(/\.diff$/, '');
      if (!f.endsWith('.diff') || !LABEL.test(label)) throw new Error(`${join(root, key, f)}: not an exported patch, refused`);
      plain(join(root, key, f), false);
      if (!out.has(label)) out.set(label, new Map());
      out.get(label)!.set(key, readFileSync(join(root, key, f), 'utf8'));
    }
  }
  return out;
}

export interface Prediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

/**
 * The SWE-bench predictions for each label, from the exported patches and the store's manifest only, written into the
 * held-out store (grades/<run>/<label>.jsonl). Returns the files.
 */
export function writePredictions(layout: BenchLayout, runId: string): Record<string, string> {
  const ids = new Map(readManifest(layout).tasks.map((t) => [t.key, t.instance_id]));
  const files: Record<string, string> = {};
  for (const [label, byKey] of readPatches(layout, runId)) {
    const rows: Prediction[] = [...byKey].map(([key, patch]) => {
      const id = ids.get(key);
      if (!id) throw new Error(`patch for ${key}, which the manifest doesn't have: refused`);
      return { instance_id: id, model_name_or_path: `bench-${runId}-${label}`, model_patch: patch };
    });
    files[label] = writeStore(layout, join('grades', runId, `${label}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return files;
}
