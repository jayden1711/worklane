// GPU access for test runs (docs/test-runs.md "GPU"). Root's own file, /etc/<cli>/testrun-gpu.json (root:root 0644,
// written only by scripts/setup/testrun-gpu.sh), says which instances' runs may have which GPUs and for how long. A
// tier asks (tests.yaml test_run `gpu: true`); the sandbox helper reads root's file itself and grants or not, and
// says which on stderr ("<cli>-testrun: gpu 0 (devices ...)" or "gpu none (why)").
//
// INVARIANT: nothing here grants anything. The engine reads root's file only to plan and to show it: a run whose
// tiers ask for the GPU on an instance the file lists (or that can't be read) is recorded as gpu=planned when it
// starts, before any GPU command, so a run cut off by a hung machine is never run again by itself after the restart.
// WHY: on 2026-10-14 a GPU driver fault hung a whole machine; running the same job again at the next start would hang
// it again. A GPU command that timed out or was killed is never retried by itself either (gpuStopped).
import { lstatSync, readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { asRoot, etcPath, runPath } from '../os/system-paths.js';

export const GPU_FILE_NAME = 'testrun-gpu.json';
/** Root's opt-in, as the engine reads it (under the test root in tests). */
export const gpuFilePath = () => etcPath(GPU_FILE_NAME);
/** One GPU's lock: the sandbox helper holds it for each GPU command, and `<cli> gpu hold` for the owner's own jobs. */
export const gpuLockPath = (index: number) => runPath(`gpu/${index}.lock`);
/** The oldest systemd the helper's GPU sandbox is proven on (CI's real-systemd job); below it a run gets no GPU. */
export const GPU_MIN_SYSTEMD = 255;
/** max_minutes: the longest one GPU command may run (the unit's RuntimeMaxSec is at most this), machine-wide. */
export const GPU_MAX_MINUTES = { min: 1, max: 120, default: 20 } as const;

/** The root script that changes it, as a root shell runs it. */
export const GPU_SCRIPT = asRoot.opt('current/scripts/setup/testrun-gpu.sh');
export const gpuCommands = (instance: string) => ({
  enable: `sudo bash ${GPU_SCRIPT} enable ${instance} --devices 0 --max-minutes ${GPU_MAX_MINUTES.default}`,
  disable: `sudo bash ${GPU_SCRIPT} disable ${instance}`,
  status: `sudo bash ${GPU_SCRIPT} status`,
  holder: `sudo bash ${GPU_SCRIPT} holder <your user>`,
});

export interface GpuFile {
  maxMinutes: number;
  /** instance -> its GPUs' indices (/dev/nvidia<N>), in the file's order. */
  instances: Record<string, number[]>;
}

const INSTANCE = /^[a-z][a-z0-9-]{0,20}$/;

/** The file's text exactly as the script writes it (and the helper reads it): one instance a line. */
export function gpuFileText(f: GpuFile): string {
  const names = Object.keys(f.instances);
  const head = `{\n  "version": 1,\n  "max_minutes": ${f.maxMinutes},\n`;
  if (!names.length) return `${head}  "instances": {}\n}\n`;
  const lines = names.map((n, i) => `    "${n}": { "devices": [${f.instances[n]!.join(', ')}] }${i < names.length - 1 ? ',' : ''}`);
  return `${head}  "instances": {\n${lines.join('\n')}\n  }\n}\n`;
}

/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export function parseGpuFile(text: string): GpuFile | { error: string } {
  const bad = { error: `not in the form scripts/setup/testrun-gpu.sh writes` };
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return bad;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad;
  const o = j as Record<string, unknown>;
  const m = o.max_minutes;
  if (o.version !== 1 || !Number.isInteger(m) || (m as number) < GPU_MAX_MINUTES.min || (m as number) > GPU_MAX_MINUTES.max) return bad;
  if (!o.instances || typeof o.instances !== 'object' || Array.isArray(o.instances)) return bad;
  const instances: Record<string, number[]> = {};
  for (const [name, v] of Object.entries(o.instances as Record<string, unknown>)) {
    const d = (v as { devices?: unknown } | null)?.devices;
    if (!INSTANCE.test(name) || !Array.isArray(d) || d.length < 1 || d.length > 16 || d.some((x) => !Number.isInteger(x) || x < 0 || x > 99)) return bad;
    instances[name] = d as number[];
  }
  const f = { maxMinutes: m as number, instances };
  return gpuFileText(f) === text ? f : bad;
}

/** What root's file says of one instance: on (its GPUs and the cap), off (and why), or unknown (it can't be read). */
export type GpuOptIn = { state: 'on'; devices: number[]; maxMinutes: number } | { state: 'off'; why: string } | { state: 'unknown'; why: string };

/**
 * Root's file as the helper would read it: root's, 0644, a regular file, in the script's form. A file the helper would
 * refuse is off (it grants nothing then); one this user can't read at all is unknown.
 */
export function readGpuFile(file = gpuFilePath(), rootUid = 0): GpuFile | { state: 'off' | 'unknown'; why: string } {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'off', why: 'GPU test runs are off on this machine (no root opt-in file)' };
    return { state: 'unknown', why: `${file} can't be read: ${(e as Error).message}` };
  }
  if (!st.isFile()) return { state: 'off', why: `${file} is not a regular file, so the helper grants no GPU` };
  if (st.uid !== rootUid || (st.mode & 0o777) !== 0o644) return { state: 'off', why: `${file} is not root's and 0644, so the helper grants no GPU` };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { state: 'unknown', why: `${file} can't be read: ${(e as Error).message}` };
  }
  const f = parseGpuFile(text);
  return 'error' in f ? { state: 'off', why: `${file} is ${f.error}, so the helper grants no GPU` } : f;
}

/** Root's file for `instance` (readGpuFile). */
export function gpuOptIn(instance: string, file = gpuFilePath(), rootUid = 0): GpuOptIn {
  const f = readGpuFile(file, rootUid);
  if ('state' in f) return f;
  const d = f.instances[instance];
  if (!d) return { state: 'off', why: `not on for ${instance}` };
  return { state: 'on', devices: [...new Set(d)].sort((a, b) => a - b), maxMinutes: f.maxMinutes };
}

/** Every GPU any instance may use, ascending: what `<cli> gpu hold` locks unless told which. */
export function gpuIndices(f: GpuFile): number[] {
  return [...new Set(Object.values(f.instances).flat())].sort((a, b) => a - b);
}

/** Whether a run that asks for the GPU is planned as a GPU run: on, or a file that can't be read (never assume off). */
export const gpuPlanned = (o: GpuOptIn): boolean => o.state !== 'off';

/** What the helper said of a command that asked for the GPU. */
export type GpuGrant = { granted: true; indices: number[]; devices: string[]; maxS: number; waitedS: number; note: string } | { granted: false; why: string };

/**
 * The helper's GPU line: the very first line of an exec's stderr when it was given --gpu, before systemd-run's own
 * (nothing of the run's can come first). `own`: its [start, end) range, taken out of the run's output; a GPU still held
 * at the run's timeout stays in it (the check says who held it).
 */
export function gpuLine(stderr: string): { grant: GpuGrant | null; own: Array<[number, number]> } {
  const re = new RegExp(`^${BRAND.cli}-testrun: gpu (?:none \\(([^\\n]*)\\)|(\\d{1,2}(?:,\\d{1,2})*) \\(devices ([^;\\n]+); max (\\d+) s; waited (\\d+) s(?:; ([^\\n]*))?\\)|\\d{1,2}(?:,\\d{1,2})*: (still held [^\\n]*))\\n`);
  const m = re.exec(stderr);
  if (!m) return { grant: null, own: [] };
  if (m[7] !== undefined) return { grant: { granted: false, why: m[7] }, own: [] };
  const own: Array<[number, number]> = [[0, m[0].length]];
  if (m[1] !== undefined) return { grant: { granted: false, why: m[1] }, own };
  return { grant: { granted: true, indices: m[2]!.split(',').map(Number), devices: m[3]!.trim().split(' '), maxS: Number(m[4]), waitedS: Number(m[5]), note: m[6] ?? '' }, own };
}

/** A tier's GPU as its record and its check say it. */
export function gpuRecord(asked: boolean, g: GpuGrant | null): { granted: boolean; devices: string[]; detail: string } | undefined {
  if (!asked) return undefined;
  if (!g) return { granted: false, devices: [], detail: "the helper didn't say (it may have stopped before the command)" };
  if (!g.granted) return { granted: false, devices: [], detail: g.why.slice(0, 300) };
  return { granted: true, devices: g.devices, detail: `GPU ${g.indices.join(',')}; max ${g.maxS} s; waited ${g.waitedS} s${g.note ? `; ${g.note}` : ''}`.slice(0, 300) };
}

/** The line a GPU tier's check starts with. */
export function gpuSummaryLine(r: { granted: boolean; devices: string[]; detail: string }): string {
  return r.granted ? `GPU: yes (${r.devices.join(' ')}; ${r.detail})` : `GPU: no (${r.detail})`;
}

/**
 * A granted GPU command that didn't end by itself: stopped at its cap, killed (systemd's result), or cut off with no
 * exit. Our own cancel (a superseded head, a stopping coordinator) is not one. Such a run is never run again by itself.
 */
export function gpuStopped(g: GpuGrant | null, r: { code: number | null; timedOut?: boolean; unitResult?: string | null }, aborted: boolean): boolean {
  if (!g?.granted || aborted) return false;
  return !!r.timedOut || r.code === null || ['signal', 'core-dump', 'oom-kill', 'watchdog'].includes(r.unitResult ?? '');
}

/**
 * The GPU runs of `sha` (any, when null) that must never run again by themselves: planned as GPU runs and then cut
 * off (no testrun.finished, or one saying interrupted) or stopped (gpu_stopped). Their ids, oldest first.
 */
export function gpuRunsNotToRepeat(events: readonly StoredEvent[], sha: string | null = null): string[] {
  const shaOf = new Map<string, string>();
  const planned = new Set<string>();
  const done = new Map<string, EventPayload<'testrun.finished'>>();
  for (const e of events) {
    if (e.type === 'testrun.queued') shaOf.set((e.payload as EventPayload<'testrun.queued'>).id, (e.payload as EventPayload<'testrun.queued'>).sha);
    else if (e.type === 'testrun.started' && (e.payload as EventPayload<'testrun.started'>).gpu === 'planned') planned.add((e.payload as EventPayload<'testrun.started'>).id);
    else if (e.type === 'testrun.finished') done.set((e.payload as EventPayload<'testrun.finished'>).id, e.payload as EventPayload<'testrun.finished'>);
  }
  return [...planned].filter((id) => {
    if (sha !== null && shaOf.get(id) !== sha) return false;
    const f = done.get(id);
    return !f || f.outcome === 'interrupted' || f.gpu_stopped === true;
  });
}

/** What a GPU run that must not repeat says, for the record and the check. */
export const GPU_NO_REPEAT = 'a GPU run that timed out, was killed or was cut off (the coordinator or the machine stopped) is never run again by itself: push a new commit to run it again';

/** The setup step a cut-off GPU run's posted check names (./checks.ts gives it its own title). */
export const GPU_STEP = 'gpu';
/** What that check says: the run was cut off and is not run again by itself. */
export const gpuCutOffLine = (reason: string) => `cut off (GPU run ended by ${reason}): not rerun automatically; push again to run it`;
/** The group whose members may hold a GPU's lock (`<cli> gpu hold`): the owner only, never an agent, test or coordinator user. */
export const GPU_GROUP = `${BRAND.cli}-gpu`;
