// The engine's side of the experiment jobs' root helper (scripts/machine/worklane-exp.sh): its protocol, the spec it
// reads on stdin, the eval tree's hash it checks, and the run record it prints. The helper decides everything that
// matters itself (root's file); this only says what is asked and reads what happened.
import { createHash } from 'node:crypto';
import { BRAND } from '../brand.js';

/** The helper's PROTOCOL (a test keeps them alike). Bump both when a command's arguments or output change. */
export const EXP_PROTOCOL = 1;
export const EXP_HELPER = `/usr/local/libexec/${BRAND.cli}-exp`;

/** What one job asks for. Commands are the study's own; ids are root's approved sources; nothing else is a path. */
export interface JobSpec {
  STUDY: string;
  /** The sealed eval copy's tree hash (evalTreeHash). */
  EVAL: string;
  MINUTES: number;
  GPUS: number;
  OUTPUT_GB: number;
  /** How long it may wait for the GPU, in seconds (not counted against MINUTES). */
  WAIT_MAX: number;
  /** sha256 of the lockfile: the environment's cache key. */
  LOCK: string;
  DATA: string[];
  INPUTS: string;
  LABELS: string;
  BUILD: string;
  PREFLIGHT: string;
  TRAIN: string;
  PREDICT: string;
  SCORE: string;
  CONFIG: Record<string, string | number>;
  SEED: number;
}

/** The spec as the helper reads it on stdin: NAME=value, each then a NUL. Refused here when a value has a newline or NUL. */
export function specText(s: JobSpec): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    const text = k === 'DATA' ? (v as string[]).join(',') : k === 'CONFIG' ? JSON.stringify(v) : String(v);
    if (/[\n\0]/.test(text)) throw new Error(`spec ${k}: one line, no NUL`);
    if (text.length > 4000) throw new Error(`spec ${k}: at most 4000 characters`);
    out.push(`${k}=${text}\0`);
  }
  return out.join('');
}

/** An eval copy's tree hash, as the helper's tree_hash computes it: sha256 of "<sha256>  <path>" lines sorted by path. */
export function evalTreeHash(files: Record<string, Buffer | string>): string {
  const lines = Object.keys(files)
    .sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0))
    .map((p) => `${createHash('sha256').update(files[p]!).digest('hex')}  ${p}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}

export interface RunRecord {
  protocol: number;
  job: string;
  outcome: 'scored' | 'crashed' | 'stopped';
  step: string | null;
  score: number | null;
  gpu_seconds: number;
  waited_s: number;
  gpus: number[];
  output_kb: number;
}

/** The record line ("<cli>-exp: record <json>", the last of `job`'s stdout), or null when there is none or it's malformed. */
export function readRecord(stdout: string): RunRecord | null {
  const line = stdout.trimEnd().split('\n').at(-1) ?? '';
  const prefix = `${BRAND.cli}-exp: record `;
  if (!line.startsWith(prefix)) return null;
  let r: unknown;
  try {
    r = JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
  const o = r as Partial<RunRecord>;
  if (o.protocol !== EXP_PROTOCOL || typeof o.job !== 'string' || !['scored', 'crashed', 'stopped'].includes(o.outcome as string)) return null;
  if (o.outcome === 'scored' ? typeof o.score !== 'number' || !Number.isFinite(o.score) : o.score !== null) return null;
  return o as RunRecord;
}
