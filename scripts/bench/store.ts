// The bench's held-out store (#748): the dataset copy, the manifest, every hidden field, the predictions and the
// grades live here, on the host, owner-only (0700 folders, 0600 files), and are never mounted into a container. Its
// path ends in evals/held-out/, which every agent session is denied anyway (src/hook.ts, HELD_OUT_GLOB), and the
// agents' sandbox denies it too (agent.ts). It is the only place a task key (t01, ...) meets its instance id.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ownerOnlyDir, writeOwnerOnly } from '../../src/os/index.js';
import type { TaskRow } from './hidden.js';
import { realPath, type BenchLayout } from './paths.js';

/**
 * The held-out store as the run needs it: absent (the pinned download makes it 0700), or a real folder this user owns,
 * mode exactly 0700 (no group or other access, no setuid, setgid or sticky bit). Every folder from the bench root
 * (already a real path) down to the store must be a real folder, not a link, whether or not the store is made yet
 * (#851 round 2): the agents' sandbox denies the store by this path, and whether it would follow a link to deny the
 * place it names is a guess, so a link anywhere on the way fails closed. Only lstat'ed: nothing in it is read.
 * The preflight runs it, and `bench download` before it fetches and again before it writes (download.ts).
 */
export function heldOutCheck(layout: BenchLayout, uid: number): string {
  const rel = relative(layout.root, layout.heldOut);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${layout.heldOut} is not inside the bench root ${layout.root}`);
  let at = layout.root;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return `${layout.heldOut}: not made yet (the pinned download makes it, 0700)`;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`${at} is a link: every folder down to the held-out store must be a real folder under the bench root`);
    if (!st.isDirectory()) throw new Error(`${at} is not a folder`);
    if (at !== layout.heldOut) continue;
    if (st.uid !== uid) throw new Error(`${layout.heldOut} belongs to uid ${st.uid}, not this user (${uid})`);
    const mode = st.mode & 0o7777;
    if (mode !== 0o700) throw new Error(`${layout.heldOut} is mode 0${mode.toString(8)}, not exactly 0700: chmod 700 it (hidden tests and the task map live there)`);
  }
  // The walk saw no link; the real path must agree (a link the walk can't see, such as one swapped in since, fails here).
  if (realPath(layout.heldOut) !== layout.heldOut) throw new Error(`${layout.heldOut} really is ${realPath(layout.heldOut)}: a link on the way`);
  return `${layout.heldOut}: 0700, this user's, no link on the way`;
}

const REQUIRED = ['instance_id', 'repo', 'base_commit', 'problem_statement', 'patch', 'test_patch', 'FAIL_TO_PASS', 'PASS_TO_PASS', 'difficulty'] as const;

/** Rows from the download's JSON lines; a row without a required field refuses the whole file. */
export function parseDataset(text: string): TaskRow[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const r = JSON.parse(l) as Record<string, unknown>;
      for (const k of REQUIRED) if (typeof r[k] !== 'string' && !Array.isArray(r[k])) throw new Error(`dataset line ${i + 1} has no ${k}`);
      // FAIL_TO_PASS and PASS_TO_PASS come as JSON text in one copy and as lists in another: kept as text.
      for (const k of ['FAIL_TO_PASS', 'PASS_TO_PASS']) if (Array.isArray(r[k])) r[k] = JSON.stringify(r[k]);
      return r as unknown as TaskRow;
    });
}

/** Write a file into the held-out store: owner-only folders and file. */
export function writeStore(layout: BenchLayout, name: string, data: string): string {
  const f = join(layout.heldOut, name);
  ownerOnlyDir(layout.heldOut);
  ownerOnlyDir(dirname(f));
  writeOwnerOnly(f, data);
  return f;
}

export function readStore(layout: BenchLayout, name: string): string | null {
  const f = join(layout.heldOut, name);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** A task's key outside the store: t01, t02, ... (never an instance id, which names the upstream PR). */
export const TASK_KEY = /^t\d{2,4}$/;

/** The run's task set: opaque keys (what everything outside the store names a task by) and the rows they stand for. */
export interface Manifest {
  dataset_revision: string;
  seed: number;
  tasks: { key: string; instance_id: string }[];
}

export const MANIFEST = 'manifest.json';

export function readManifest(layout: BenchLayout): Manifest {
  const text = readStore(layout, MANIFEST);
  if (text === null) throw new Error(`no task manifest in the bench's held-out store (${join(layout.heldOut, MANIFEST)})`);
  const m = JSON.parse(text) as Manifest;
  const keys = new Set<string>();
  for (const t of m.tasks) {
    if (!TASK_KEY.test(t.key) || keys.has(t.key)) throw new Error(`manifest task key ${JSON.stringify(t.key)} is not a unique t<NN> key`);
    keys.add(t.key);
  }
  return m;
}
