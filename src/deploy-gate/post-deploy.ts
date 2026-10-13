// The post-deploy check (docs/deploy-gate.md): after the gate moved the deploy branch to a commit, wait for the host
// to deploy exactly that commit to production, smoke-test production, and on a failed check roll the host back.
//
//   1. Deployed: every configured production service's latest deployment is on the commit and SUCCESS (the host's
//      API, with the stored token). GitHub's deployments of the commit are the cross-check; without a token they are
//      the only signal. Not deployed within wait_for_deploy_s: an ops alert and an incident, nothing rolled back.
//   2. Smoke: each check is one GET on the production origin (never with credentials, never following a redirect off
//      it), with a short timeout and one retry.
//   3. A check failed: each service is rolled back to its last good deployment of the previous deploy-branch commit
//      (the host's rollback, else a redeploy of that deployment). Nothing moves on git: the deploy branch stays, and
//      the commit is marked so the gate never moves to it again. A red incident, and an ops post with the failing
//      check, its status and a redacted snippet, and the rollback's result. No token: the same, without a rollback,
//      and the post says the rollback needs the token.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { redactString } from '../events/redact.js';
import { writeGroupOnly } from '../os/index.js';
import type { IncidentSink } from '../usage-limit.js';
import { POST_DEPLOY_INCIDENT, POST_DEPLOY_WAIT_INCIDENT, type PostDeployCheck, type PostDeployConfig } from './config.js';
import { NoHostToken, type DeployHost, type HostDeployment } from './railway.js';

export type PostDeployEvent = EventPayload<'deploy_gate.post_deploy'>;
type CheckResult = PostDeployEvent['checks'][number];
type Rollback = NonNullable<PostDeployEvent['rollback']>;

export interface PostDeployDeps {
  config: PostDeployConfig;
  /** The deploy branch's name (for the posts). */
  branch: string;
  host: DeployHost;
  /** Whether the host's token is stored now (read on every pass, so a token stored later is used). */
  hasToken: () => boolean;
  /** GitHub's deployments of a commit by the host's App (the cross-check); null when GitHub couldn't be asked. */
  github: (sha: string) => Promise<{ total: number; success: number } | null>;
  /** Mark a commit the gate must never move the deploy branch to again. */
  markFailed: (sha: string, reason: string) => void;
  log: EventLog;
  actor: string;
  stateDir: string;
  incidents?: IncidentSink;
  /** The smoke checks' HTTP (default fetch). */
  http?: typeof fetch;
  /** How often the host is asked while waiting for the deploy (default 30 s). */
  pollMs?: number;
  /** The pause before a check's retry (default 2 s). */
  retryMs?: number;
  now?: () => number;
}

interface PostDeployFile {
  /** The commit waiting for its deploy and check, and the previous deploy-branch commit to roll back to. */
  pending: { sha: string; prev: string | null; since: number } | null;
  /** The last commit that passed the check: the rollback target when the previous one failed its own. */
  lastGood: string | null;
  /** Commits that failed it. */
  failed: string[];
}

/** Statuses of a deployment that served production (a later deploy turns SUCCESS into REMOVED). */
const SERVED = new Set(['SUCCESS', 'REMOVED', 'SLEEPING']);
/** A deployment of the commit that will never become SUCCESS. */
const DEAD = new Set(['FAILED', 'CRASHED', 'SKIPPED', 'REMOVED']);
const SNIPPET = 200;
const MAX_BODY = 256 * 1024;

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : 'nothing');

export class PostDeploy {
  private lastPoll = -Infinity;
  private running: Promise<void> | null = null;
  private readonly stopped = new AbortController();

  constructor(private d: PostDeployDeps) {}

  private get file() {
    return join(this.d.stateDir, 'post-deploy.json');
  }

  private read(): PostDeployFile {
    const empty: PostDeployFile = { pending: null, lastGood: null, failed: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PostDeployFile>;
      return { pending: j.pending ?? null, lastGood: j.lastGood ?? null, failed: Array.isArray(j.failed) ? j.failed : [] };
    } catch {
      return empty;
    }
  }

  private write(f: PostDeployFile) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeGroupOnly(tmp, JSON.stringify({ ...f, failed: f.failed.slice(-50) }, null, 2));
    renameSync(tmp, this.file);
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** The commit waiting for its check, if any. */
  get pending() {
    return this.read().pending;
  }

  /**
   * The deploy branch moved from `from` to `sha`: watch for the host's deploy of it. The rollback target is `from`,
   * unless `from` failed its own check: then the last commit that passed.
   */
  start(sha: string, from: string | null): void {
    const f = this.read();
    const prev = from && !f.failed.includes(from) ? from : f.lastGood;
    this.write({ ...f, pending: { sha, prev, since: this.now() } });
    this.lastPoll = -Infinity;
  }

  /** One pass at most every pollMs while a commit is pending; the pass is not waited for. */
  step(): void {
    if (this.stopped.signal.aborted || this.running || !this.read().pending) return;
    const now = this.now();
    if (now - this.lastPoll < (this.d.pollMs ?? 30_000)) return;
    this.lastPoll = now;
    this.running = this.pass()
      .catch((e: unknown) => {
        this.d.log.append('coordinator.error', { instance: this.d.actor, where: 'post-deploy check', kind: 'error', message: redactString(String((e as Error).message)).slice(0, 500) }, this.d.actor);
      })
      .finally(() => {
        this.running = null;
      });
  }

  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped.abort();
  }

  /** Where each service's latest deployment is: deployed (all SUCCESS on the commit), dead, or waiting (and why). */
  private async whereIsIt(sha: string): Promise<{ state: 'deployed' | 'dead' | 'waiting'; detail: string; github?: { total: number; success: number } | null }> {
    const services = this.d.config.services;
    if (!this.d.hasToken()) {
      const gh = await this.d.github(sha);
      if (gh && gh.success >= services.length) return { state: 'deployed', detail: `GitHub shows ${gh.success} successful deployment(s) of it (no host token: GitHub is the only signal)`, github: gh };
      return { state: 'waiting', detail: `no host token, and GitHub shows ${gh ? `${gh.success} of ${services.length} successful deployment(s)` : 'no answer'}` };
    }
    const lines: string[] = [];
    let deployed = 0;
    let dead = false;
    for (const s of services) {
      let latest: HostDeployment | undefined;
      try {
        latest = (await this.d.host.deployments(s.id, 5))[0];
      } catch (e) {
        lines.push(`${s.name}: ${(e as Error).message.slice(0, 200)}`);
        continue;
      }
      if (!latest) lines.push(`${s.name}: no deployments`);
      else if (latest.commit !== null && sha.startsWith(latest.commit)) {
        if (latest.status === 'SUCCESS') deployed++;
        else if (DEAD.has(latest.status)) dead = true;
        lines.push(`${s.name}: ${short(latest.commit)} ${latest.status}`);
      } else lines.push(`${s.name}: latest is ${short(latest.commit)} ${latest.status}`);
    }
    if (dead) return { state: 'dead', detail: lines.join('; ') };
    return { state: deployed === services.length ? 'deployed' : 'waiting', detail: lines.join('; ') };
  }

  private async pass(): Promise<void> {
    const p = this.read().pending;
    if (!p) return;
    const where = await this.whereIsIt(p.sha);
    if (where.state === 'waiting') {
      if (this.now() - p.since < this.d.config.wait_for_deploy_s * 1000) return;
      return this.finish(p, 'timed_out', `production didn't deploy ${short(p.sha)} within ${this.d.config.wait_for_deploy_s} s (${where.detail})`, [], null);
    }
    if (where.state === 'dead') return this.finish(p, 'deploy_failed', `the host's deploy of ${short(p.sha)} failed (${where.detail})`, [], null);
    const github = where.github !== undefined ? where.github : await this.d.github(p.sha);
    const checks: CheckResult[] = [];
    for (const c of this.d.config.checks) checks.push(await this.smoke(c));
    const failed = checks.filter((c) => !c.ok);
    if (!failed.length) return this.finish(p, 'passed', `every check passed on ${short(p.sha)}`, checks, null, github);
    const rollback = await this.rollBack(p.prev);
    const reason = `failed: ${failed.map((c) => c.name).join(', ')}`;
    return this.finish(p, 'failed', reason, checks, rollback, github);
  }

  /** One check: a GET with a timeout, one retry. Never sends a cookie or a credential; never follows a redirect. */
  private async smoke(c: PostDeployCheck): Promise<CheckResult> {
    const http = this.d.http ?? fetch;
    const once = async (): Promise<CheckResult> => {
      const t0 = this.now();
      try {
        const res = await http(c.url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept: '*/*', 'cache-control': 'no-cache' },
          signal: AbortSignal.any([AbortSignal.timeout(this.d.config.timeout_s * 1000), this.stopped.signal]),
        });
        const body = await readCapped(res);
        const textOk = c.expect_text === undefined || body.includes(c.expect_text);
        const ok = res.status === c.expect_status && textOk;
        const error = ok ? null : res.status !== c.expect_status ? `expected ${c.expect_status}, got ${res.status}` : `the body doesn't contain the expected text`;
        return { name: c.name, ok, status: res.status, ms: Math.max(0, Math.round(this.now() - t0)), error, snippet: ok ? '' : snippet(body) };
      } catch (e) {
        const err = e as Error;
        const why = err.name === 'TimeoutError' || err.name === 'AbortError' ? `no answer within ${this.d.config.timeout_s} s` : `request failed: ${String(err.message).slice(0, 200)}`;
        return { name: c.name, ok: false, status: null, ms: Math.max(0, Math.round(this.now() - t0)), error: redactString(why), snippet: '' };
      }
    };
    const first = await once();
    if (first.ok || this.stopped.signal.aborted) return first;
    await new Promise((r) => setTimeout(r, this.d.retryMs ?? 2000));
    return once();
  }

  /** Each service back to its last served deployment of `prev`: the host's rollback, else a redeploy of it. */
  private async rollBack(prev: string | null): Promise<Rollback> {
    if (!this.d.hasToken()) return { attempted: false, ok: false, detail: "rollback needs the host's API token, which isn't stored", services: [] };
    if (!prev) return { attempted: false, ok: false, detail: 'no previous deploy-branch commit to roll back to', services: [] };
    const services: Rollback['services'] = [];
    for (const s of this.d.config.services) {
      const r: Rollback['services'][number] = { service: s.name, to: null, via: null, ok: false, detail: '' };
      try {
        const list = await this.d.host.deployments(s.id, 30);
        const target = list.find((x) => x.commit !== null && prev.startsWith(x.commit) && SERVED.has(x.status));
        if (!target) {
          r.detail = `no earlier deployment of ${short(prev)} among the last ${list.length}`;
        } else {
          r.to = target.id;
          let rolled = false;
          if (target.canRollback) {
            try {
              rolled = await this.d.host.rollback(target.id);
            } catch (e) {
              if (e instanceof NoHostToken) throw e;
              r.detail = `rollback refused (${(e as Error).message.slice(0, 150)}); `;
            }
          }
          if (rolled) {
            r.via = 'rollback';
            r.ok = true;
            r.detail = `rolled back to ${target.id} (${short(prev)})`;
          } else {
            const id = await this.d.host.redeploy(target.id);
            r.via = 'redeploy';
            r.ok = true;
            r.detail = `${r.detail}redeployed ${target.id} (${short(prev)}) as ${id}`;
          }
        }
      } catch (e) {
        r.detail = `${r.detail}${(e as Error).message.slice(0, 300)}`;
      }
      r.detail = redactString(r.detail).slice(0, 500);
      services.push(r);
    }
    const ok = services.every((x) => x.ok);
    return { attempted: true, ok, detail: ok ? `every service back on ${short(prev)}` : `not every service rolled back: ${services.filter((x) => !x.ok).map((x) => x.service).join(', ')}`, services };
  }

  private finish(p: NonNullable<PostDeployFile['pending']>, outcome: PostDeployEvent['outcome'], detail: string, checks: CheckResult[], rollback: Rollback | null, github: { total: number; success: number } | null = null) {
    const f = this.read();
    // A newer commit took over while this one ran: its own watch goes on.
    const still = f.pending?.sha === p.sha;
    const failed = outcome === 'failed' ? [...f.failed.filter((x) => x !== p.sha), p.sha] : f.failed;
    this.write({ pending: still ? null : f.pending, lastGood: outcome === 'passed' ? p.sha : f.lastGood, failed });
    const token = this.d.hasToken();
    this.d.log.append('deploy_gate.post_deploy', { sha: p.sha, prev: p.prev, outcome, detail: redactString(detail).slice(0, 2000), checks, rollback, github, token }, this.d.actor);
    const key = this.d.branch;
    if (outcome === 'passed') {
      this.d.incidents?.resolveIncident(POST_DEPLOY_INCIDENT, key);
      this.d.incidents?.resolveIncident(POST_DEPLOY_WAIT_INCIDENT, key);
      return;
    }
    if (outcome === 'failed') {
      this.d.markFailed(p.sha, detail);
      const first = checks.find((c) => !c.ok)!;
      this.d.incidents?.raiseIncident(
        POST_DEPLOY_INCIDENT,
        key,
        `production failed its post-deploy check on ${short(p.sha)}: ${first.name} ${first.error ?? ''}. ${rollback?.attempted ? `Rollback: ${rollback.detail}.` : `Not rolled back: ${rollback?.detail ?? 'nothing to do'}.`}`.slice(0, 1000),
        rollback?.ok
          ? `Production is back on ${short(p.prev)}. Fix forward on the default branch; the gate moves ${this.d.branch} on at the next green commit, never to ${short(p.sha)} again.`
          : `Check production now and roll it back on the host by hand if it is still on ${short(p.sha)} (docs/deploy-gate.md, "Post-deploy check").`,
      );
      return;
    }
    this.d.incidents?.raiseIncident(POST_DEPLOY_WAIT_INCIDENT, key, detail.slice(0, 1000), `Check the host's deploy of ${short(p.sha)}; nothing was rolled back and nothing was smoke-tested.`);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

/** A key=value or key: value whose value must never be kept (a cookie, a session, a token). */
const SECRET_PAIR = /\b((?:set-)?cookie|session[\w-]*|[\w-]*token|password|secret|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&;,<]+/gi;

/** A short, redacted piece of a failing response's body: one line, no cookie or session value, no secrets the redactor knows. */
export function snippet(body: string): string {
  return redactString(body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET * 2))
    .replace(SECRET_PAIR, '$1$2[redacted]')
    .slice(0, SNIPPET);
}

/** The ops post for a check that didn't pass (null for one that did). */
export function postDeployMessage(p: PostDeployEvent, repo: string, branch: string): string | null {
  const link = `https://github.com/${repo}/commit/${p.sha}`;
  if (p.outcome === 'passed') return null;
  if (p.outcome === 'timed_out' || p.outcome === 'deploy_failed') {
    const head = p.outcome === 'timed_out' ? '**Post-deploy check: not deployed**' : '**Post-deploy check: the deploy failed**';
    return `${head}: ${p.detail}. Nothing was smoke-tested or rolled back; \`${branch}\` stays at \`${short(p.sha)}\`.${p.token ? '' : " (No host token is stored: rollback would need it.)"} ${link}`.slice(0, 1900);
  }
  const failing = p.checks.filter((c) => !c.ok).map((c) => `\`${c.name}\`: ${c.error ?? 'failed'}${c.status !== null ? ` (status ${c.status})` : ''}${c.snippet ? `, body: "${c.snippet.slice(0, 160)}"` : ''}`);
  const rb = p.rollback;
  const rollback = !rb
    ? 'not rolled back'
    : !rb.attempted
      ? `**not rolled back**: ${rb.detail}${p.token ? '' : '. Store the token from the dashboard (the setup console\'s host token step) so the next one rolls back'}`
      : `${rb.ok ? 'rolled back' : '**rollback incomplete**'} to \`${short(p.prev)}\`: ${rb.services.map((s) => `${s.service} ${s.ok ? `${s.via} ok` : `failed (${s.detail.slice(0, 120)})`}`).join(', ')}`;
  return `**Post-deploy check failed** on \`${short(p.sha)}\`: ${failing.join('; ')}. Production ${rollback}. \`${branch}\` stays at \`${short(p.sha)}\`, and the gate won't move it there again. ${link}`.slice(0, 1900);
}
