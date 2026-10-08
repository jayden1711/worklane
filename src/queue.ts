// Queued exclusive runs (e.g. a project's full test suite). `queue` spawns a
// detached runner in its own session, so it outlives the shell and Claude
// session that started it, then returns. The runner waits for the
// machine-wide full-run lock AND for the project's idle probe (e.g. "no
// other full run is live") before starting, and records the result.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { childEnv, pidAlive } from './os/index.js';
import { fullRunLock } from './slots.js';

export interface Job {
  id: string;
  kind: 'full-run';
  cwd: string;
  command: string;
  idleProbe?: string | undefined;
  createdAt: string;
  status: 'queued' | 'waiting' | 'running' | 'passed' | 'failed' | 'error';
  runnerPid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  waitingFor?: string;
  log: string;
  error?: string;
}

const jobsDir = (stateDir: string) => join(stateDir, 'jobs');
const jobFile = (stateDir: string, id: string) => join(jobsDir(stateDir), `${id}.json`);

export function readJob(stateDir: string, id: string): Job {
  return JSON.parse(readFileSync(jobFile(stateDir, id), 'utf8')) as Job;
}
function writeJob(stateDir: string, job: Job) {
  writeFileSync(jobFile(stateDir, job.id), JSON.stringify(job, null, 2));
}

export function listJobs(stateDir: string): Job[] {
  try {
    return readdirSync(jobsDir(stateDir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(jobsDir(stateDir), f), 'utf8')) as Job)
      .map((j) => (['queued', 'waiting', 'running'].includes(j.status) && j.runnerPid && !pidAlive(j.runnerPid) ? { ...j, status: 'error' as const, error: 'runner died' } : j))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

/** Queue a job and start its detached runner. Returns immediately. */
export function queueJob(opts: { stateDir: string; cwd: string; command: string; idleProbe?: string | undefined; cliPath: string }): Job {
  mkdirSync(jobsDir(opts.stateDir), { recursive: true });
  const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const job: Job = { id, kind: 'full-run', cwd: opts.cwd, command: opts.command, idleProbe: opts.idleProbe, createdAt: new Date().toISOString(), status: 'queued', log: join(jobsDir(opts.stateDir), `${id}.log`) };
  writeJob(opts.stateDir, job);
  const out = openSync(job.log, 'a');
  const child = spawn(process.execPath, [opts.cliPath, '_run-job', opts.stateDir, id], { detached: true, stdio: ['ignore', out, out], env: childEnv() });
  closeSync(out);
  child.unref();
  job.runnerPid = child.pid!;
  writeJob(opts.stateDir, job);
  return job;
}

function sh(command: string, cwd: string, logFd: number | 'ignore'): Promise<number | null> {
  return new Promise((res) => {
    const c = spawn(command, { cwd, shell: true, stdio: ['ignore', logFd, logFd], env: childEnv() });
    c.on('error', () => res(null));
    c.on('close', (code) => res(code));
  });
}

/** The detached runner. Never "skips": it waits, runs, and records an outcome. */
export async function runJob(stateDir: string, id: string, pollMs = 30_000): Promise<Job> {
  let job = readJob(stateDir, id);
  const update = (patch: Partial<Job>) => {
    job = { ...job, ...patch };
    writeJob(stateDir, job);
  };
  update({ status: 'waiting', runnerPid: process.pid, waitingFor: 'machine-wide full-run lock' });
  for (;;) {
    const got = await fullRunLock(`${job.kind} job ${id} (pid ${process.pid})`, 24 * 3600_000);
    if (!('lock' in got)) continue;
    try {
      if (job.idleProbe) {
        const idle = await sh(job.idleProbe, job.cwd, 'ignore');
        if (idle !== 0) {
          update({ waitingFor: `idle probe (${job.idleProbe}) reports another run is live` });
          got.lock.release();
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
      }
      update({ status: 'running', startedAt: new Date().toISOString(), waitingFor: '' });
      const fd = openSync(job.log, 'a');
      const code = await sh(job.command, job.cwd, fd);
      closeSync(fd);
      update({ status: code === 0 ? 'passed' : code === null ? 'error' : 'failed', exitCode: code, finishedAt: new Date().toISOString() });
      return job;
    } finally {
      got.lock.release();
    }
  }
}
