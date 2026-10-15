// `<cli> gpu hold [--gpu <N>]... -- <command> [args...]`: run one of your own GPU jobs under the same per-GPU lock the
// test runs' GPU commands take (docs/test-runs.md "GPU"), so a test run never shares the GPU with it, and it never
// starts while a test run has the GPU. It waits as long as it takes, saying who holds the GPU, and lets go when the
// command ends. Without --gpu it holds every GPU root's file lists for any instance.
//
// WHY: the harness's own runs take the lock; your jobs don't, unless they go through this. Nothing here asks the
// driver (no nvidia-smi): it is the lock and nothing else.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { flockHolders, holdFlocksInOrder } from './os/index.js';
import { gpuCommands, gpuFilePath, gpuIndices, gpuLockPath, readGpuFile } from './testrun/gpu.js';

export interface GpuHoldDeps {
  /** Root's file (tests: one of their own) and the uid that must own it. */
  file?: string;
  rootUid?: number;
  lockPath?: (index: number) => string;
  err?: (line: string) => void;
}

/** The arguments: --gpu indices (before `--`), and the command after it. */
export function parseGpuHold(args: readonly string[]): { gpus: number[]; command: string[] } | { error: string } {
  const at = args.indexOf('--');
  if (at < 0 || at === args.length - 1) return { error: `usage: ${BRAND.cli} gpu hold [--gpu <N>]... -- <command> [args...]` };
  const gpus: number[] = [];
  const opts = args.slice(0, at);
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] !== '--gpu' || !/^[0-9]{1,2}$/.test(opts[i + 1] ?? '')) return { error: `gpu hold: unexpected ${opts[i]}${opts[i] === '--gpu' ? ' (a GPU index, 0 to 99)' : ''}` };
    gpus.push(Number(opts[++i]));
  }
  return { gpus: [...new Set(gpus)].sort((a, b) => a - b), command: args.slice(at + 1) };
}

/** Who holds a GPU's lock, as far as this user can tell: the helper's note in the file, and the holders' pids. */
export function gpuHolder(path: string): string {
  let note = '';
  try {
    note = readFileSync(path, 'utf8').replace(/[^\w ./:+-]/g, '').trim().slice(0, 200);
  } catch {
    // unreadable: the pids alone
  }
  const pids = (flockHolders(path) ?? []).filter((h) => h.mode === 'exclusive').map((h) => `pid ${h.pid}`);
  return [note, ...pids].filter(Boolean).join('; ') || 'another process';
}

/** Run `gpu hold`; its exit code is the command's (2 for a usage or setup problem, nothing run). */
export async function gpuHoldCommand(args: readonly string[], d: GpuHoldDeps = {}): Promise<number> {
  const err = d.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  const p = parseGpuHold(args);
  if ('error' in p) {
    err(p.error);
    return 2;
  }
  let gpus = p.gpus;
  if (!gpus.length) {
    const f = readGpuFile(d.file ?? gpuFilePath(), d.rootUid ?? 0);
    if ('state' in f || !gpuIndices(f).length) {
      err(`gpu hold: no instance's test runs may use a GPU here (${'state' in f ? f.why : 'root\'s file lists none'}), so no test run takes a GPU lock: run your command directly, or name a GPU with --gpu <N>. Root turns GPU test runs on with: ${gpuCommands('<name>').enable}`);
      return 2;
    }
    gpus = gpuIndices(f);
  }
  const lock = d.lockPath ?? gpuLockPath;
  const missing = gpus.filter((g) => !existsSync(lock(g)));
  if (missing.length) {
    err(`gpu hold: no lock file for GPU ${missing.join(', ')} (${lock(missing[0]!)}): root's script makes one for each GPU it lists (${gpuCommands('<name>').status})`);
    return 2;
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let held;
  try {
    held = await holdFlocksInOrder(
      gpus.map((g) => lock(g)),
      { signal: stop.signal, waiting: (path) => err(`gpu hold: waiting for ${path} (held by ${gpuHolder(path)})`) },
    );
  } catch (e) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    err(`gpu hold: ${stop.signal.aborted ? 'stopped while waiting; nothing was run' : (e as Error).message}`);
    return stop.signal.aborted ? 130 : 2;
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  err(`gpu hold: holding GPU ${gpus.join(', ')}; running ${p.command[0]}`);
  try {
    return await new Promise<number>((resolve) => {
      const child = spawn(p.command[0]!, p.command.slice(1), { stdio: 'inherit' });
      // The command gets what this process gets; the locks go only once it has ended.
      const pass = (sig: NodeJS.Signals) => () => child.kill(sig);
      const int = pass('SIGINT');
      const term = pass('SIGTERM');
      process.on('SIGINT', int);
      process.on('SIGTERM', term);
      const done = (code: number) => {
        process.off('SIGINT', int);
        process.off('SIGTERM', term);
        resolve(code);
      };
      child.on('error', (e) => {
        err(`gpu hold: can't run ${p.command[0]}: ${e.message}`);
        done(127);
      });
      child.on('exit', (code, signal) => done(code ?? (signal ? 128 + (signal === 'SIGKILL' ? 9 : signal === 'SIGINT' ? 2 : 15) : 1)));
    });
  } finally {
    await held.release();
  }
}
