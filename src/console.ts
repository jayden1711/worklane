// The console: the owner's line to a running agent, from the instance's own
// dashboard. The dashboard and the coordinator are separate processes, so a
// request is a file in the instance's state (<state>/console/requests/), which
// the coordinator takes within seconds and acts on; every outcome is an event.
// The coordinator lists its live runs in <state>/console/live.json. Only the
// owner (owners.default) may message or stop a run, or read its live feed:
// checked here, and again by the coordinator.
//
// A message is held until the agent's current turn ends, then delivered (one
// sent mid-turn would be folded into that turn and change its outcome); the
// dashboard shows it as pending until then. Interrupt is not offered: it isn't
// confirmed for runs as another OS user yet.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from './config/load.js';
import { groupOnlyDir } from './os/index.js';
import { readFeed, type FeedItem } from './run-feed.js';

export const CONSOLE_DIR = 'console';
export const MAX_MESSAGE = 4000;
const VALID_ID = /^[A-Za-z0-9_-]+$/;

export class ConsoleError extends Error {}

export interface PendingMessage {
  id: string;
  text: string;
  by: string;
  at: string;
}

/** A run the coordinator holds the input of, as live.json lists it. */
export interface LiveRun {
  run: string;
  issue: number | null;
  role: string;
  model: string;
  startedAt: string;
  /** Messages queued and not yet delivered (they go in when the current turn ends). */
  pending: PendingMessage[];
}

export type ConsoleRequest = { v: 1; id: string; at: string; by: string; run: string } & ({ kind: 'message'; text: string } | { kind: 'stop' });

const dirs = (stateDir: string) => ({ root: join(stateDir, CONSOLE_DIR), requests: join(stateDir, CONSOLE_DIR, 'requests'), live: join(stateDir, CONSOLE_DIR, 'live.json') });

function ownerOnly(cfg: Config, by: string, what: string) {
  const owner = cfg.project.owners.default;
  if (!by || by.toLowerCase() !== owner.toLowerCase()) throw new ConsoleError(`only the owner (@${owner}) may ${what}; @${by || 'unknown'} may not`);
}

/** The runs live right now (empty when the coordinator isn't running any, or hasn't written the list). */
export function liveRuns(stateDir: string): LiveRun[] {
  try {
    const v = JSON.parse(readFileSync(dirs(stateDir).live, 'utf8')) as { runs?: LiveRun[] };
    return Array.isArray(v.runs) ? v.runs : [];
  } catch {
    return [];
  }
}

function request(stateDir: string, r: { kind: 'message'; run: string; text: string; by: string } | { kind: 'stop'; run: string; by: string }, now = new Date()): { id: string } {
  const d = dirs(stateDir);
  groupOnlyDir(d.requests);
  const id = `${now.getTime()}-${randomBytes(4).toString('hex')}`;
  const tmp = join(d.requests, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ v: 1, id, at: now.toISOString(), ...r }), { mode: 0o600 });
  renameSync(tmp, join(d.requests, `${id}.json`));
  return { id };
}

function liveRun(stateDir: string, run: string): LiveRun {
  if (!VALID_ID.test(run)) throw new ConsoleError(`not a run id: ${run}`);
  const r = liveRuns(stateDir).find((x) => x.run === run);
  if (!r) throw new ConsoleError(`run ${run} isn't live`);
  return r;
}

/** Message a live run (owner only). Queued at once; delivered when the agent's current turn ends. */
export function sendMessage(o: { stateDir: string; cfg: Config; run: string; text: string; by: string; now?: Date }): { id: string } {
  ownerOnly(o.cfg, o.by, 'message a run');
  const text = o.text.trim();
  if (!text) throw new ConsoleError('the message is empty');
  if (text.length > MAX_MESSAGE) throw new ConsoleError(`the message is over ${MAX_MESSAGE} characters`);
  liveRun(o.stateDir, o.run);
  return request(o.stateDir, { kind: 'message', run: o.run, text, by: o.by }, o.now);
}

/** Stop a live run (owner only): its process tree ends; the task it was on is blocked, saying who stopped it. */
export function stopRun(o: { stateDir: string; cfg: Config; run: string; by: string; now?: Date }): { id: string } {
  ownerOnly(o.cfg, o.by, 'stop a run');
  liveRun(o.stateDir, o.run);
  return request(o.stateDir, { kind: 'stop', run: o.run, by: o.by }, o.now);
}

/** A run's live feed after `after` (owner only); the same items whether the run is live or ended. */
export function runFeed(o: { stateDir: string; cfg: Config; run: string; by: string; after?: number }): { items: FeedItem[]; ended: boolean } {
  ownerOnly(o.cfg, o.by, "read a run's live feed");
  const f = readFeed(o.stateDir, o.run, o.after ?? -1);
  if (!f) throw new ConsoleError(`no feed for run ${o.run}`);
  return f;
}

// ---------------------------------------------------------------- the coordinator's side

/** Requests waiting, oldest first; each is removed as it's taken (a malformed one too). */
export function takeRequests(stateDir: string): ConsoleRequest[] {
  const d = dirs(stateDir);
  if (!existsSync(d.requests)) return [];
  const out: ConsoleRequest[] = [];
  for (const f of readdirSync(d.requests).filter((x) => x.endsWith('.json')).sort()) {
    const p = join(d.requests, f);
    try {
      const r = JSON.parse(readFileSync(p, 'utf8')) as ConsoleRequest;
      if (r && r.v === 1 && typeof r.id === 'string' && typeof r.run === 'string' && typeof r.by === 'string' && (r.kind === 'stop' || (r.kind === 'message' && typeof r.text === 'string'))) out.push(r);
    } catch {
      // unreadable: dropped
    }
    rmSync(p, { force: true });
  }
  return out;
}

/** The coordinator's list of live runs, for the dashboard. */
export function writeLive(stateDir: string, runs: LiveRun[]): void {
  try {
    const d = dirs(stateDir);
    groupOnlyDir(d.root);
    const tmp = join(d.root, `.live.${randomBytes(3).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), runs }), { mode: 0o600 });
    renameSync(tmp, d.live);
  } catch {
    // the list is best effort; the events are the record
  }
}
