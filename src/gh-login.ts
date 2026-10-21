// WHY: Connect GitHub on the first-run page (local mode, audit row 8). The page can't run gh's login itself, so this
// runs `gh auth login --web` for the person and relays the one thing gh shows: its one-time device code, with a link to
// GitHub's device page. The person types the code on GitHub; gh finishes the login and keeps the token in its own store.
// Then `gh auth status` says so, which is how the page learns it is done (polled, so a login finished in a terminal
// counts too).
//
// INVARIANT: this module never reads, keeps, logs or returns the token. It runs no command that prints one (never
// `gh auth token`; `gh auth status` is read for its exit code only), and of gh's output it keeps only the device code
// and the exact device URL, matched by pattern; anything else gh says reaches the page only as one failure line, with
// anything token-shaped masked.
import { spawn, spawnSync } from './os/child-process.js';
import { findTool, withToolPath } from './tool-path.js';
import { outboundEnv } from './network.js';

export const GH_DEVICE_URL = 'https://github.com/login/device';
/** What runs: the web (device) flow for github.com, git over https, so gh asks nothing else. */
export const GH_LOGIN_ARGS = ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'] as const;
/** How long a login waits for the person: GitHub's device codes last 15 minutes. */
export const GH_LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How often `gh auth status` is asked while waiting, at most (only when the page asks). */
export const GH_STATUS_EVERY_MS = 3_000;

const CODE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const TOKENISH = /\b(gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;

/** The child gh process, as this module uses it (tests stand in for it). */
export interface LoginChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  kill(): unknown;
}

export interface GhLoginDeps {
  /** Start `gh auth login --web ...`; its stdin is closed, so gh waits for no Enter. */
  spawn: () => LoginChild;
  /** `gh auth status`'s exit code: 0 when signed in to github.com. */
  status: () => number | null;
  /** Whether gh is installed at all. */
  installed: () => boolean;
  now: () => number;
  timeoutMs: number;
}

/** WHY: gh's login and status carry a GitHub token: no host-redirect variable reaches them (src/network.ts, #391). */
export const ghEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => outboundEnv(withToolPath(env));

export function systemGhLoginDeps(): GhLoginDeps {
  return {
    spawn: () => spawn(findTool('gh') ?? 'gh', [...GH_LOGIN_ARGS], { stdio: ['ignore', 'pipe', 'pipe'], env: ghEnv() }),
    status: () => {
      // Exit code only: its output (which names the account and a masked token) is never read.
      const r = spawnSync(findTool('gh') ?? 'gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore', timeout: 20_000, env: ghEnv() });
      return r.error ? null : r.status;
    },
    installed: () => findTool('gh') !== null,
    now: Date.now,
    timeoutMs: GH_LOGIN_TIMEOUT_MS,
  };
}

export type GhLoginState = 'idle' | 'waiting' | 'done' | 'failed' | 'expired' | 'cancelled';

/** What the page sees. The code and URL only while waiting; never anything else gh printed. */
export interface GhLoginView {
  state: GhLoginState;
  /** The one-time device code to type on GitHub, once gh has shown it. */
  code: string | null;
  /** Always GitHub's device page when there is a code. */
  url: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  /** Why it failed, one line; or what happened. */
  detail: string | null;
  /** gh is installed (the tools step); without it there is nothing to run. */
  installed: boolean;
}

/** One line of gh's failure output, masked: never a token, never more than a line. */
export function safeLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !CODE.test(l) && !l.includes(GH_DEVICE_URL))
      .at(-1) ?? '';
  return line.replace(TOKENISH, '[hidden]').slice(0, 200);
}

/** The relay: one login at a time, per dashboard. */
export class GhLogin {
  private child: LoginChild | null = null;
  private v: Omit<GhLoginView, 'installed'> = { state: 'idle', code: null, url: null, startedAt: null, expiresAt: null, detail: null };
  private lastStatus = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly d: GhLoginDeps;

  constructor(deps: Partial<GhLoginDeps> = {}) {
    this.d = { ...systemGhLoginDeps(), ...deps };
  }

  view(): GhLoginView {
    return { ...this.v, installed: this.d.installed() };
  }

  /**
   * Where it stands, asking `gh auth status` (at most every few seconds) while a login waits: signed in counts as
   * done whichever way it happened, and the waiting gh is stopped.
   */
  poll(): GhLoginView {
    if (this.v.state === 'waiting' && this.d.now() - this.lastStatus >= GH_STATUS_EVERY_MS) {
      this.lastStatus = this.d.now();
      if (this.d.status() === 0) this.finish('done', 'signed in: gh keeps the login in its own store');
    }
    return this.view();
  }

  /** Start the device login. Refused while one waits, or when gh is missing or already signed in. */
  start(): GhLoginView {
    if (this.v.state === 'waiting') throw new GhLoginError('a GitHub login is waiting already: type its code on GitHub, or cancel it', 409);
    if (!this.d.installed()) throw new GhLoginError("gh isn't installed: install it first (the Tools step)", 409);
    if (this.d.status() === 0) {
      this.v = { state: 'done', code: null, url: null, startedAt: null, expiresAt: null, detail: 'gh is signed in already' };
      return this.view();
    }
    const at = this.d.now();
    this.v = { state: 'waiting', code: null, url: null, startedAt: new Date(at).toISOString(), expiresAt: new Date(at + this.d.timeoutMs).toISOString(), detail: null };
    this.lastStatus = at;
    let out = '';
    const c = this.d.spawn();
    this.child = c;
    const read = (chunk: Buffer | string) => {
      if (this.child !== c) return;
      out = (out + String(chunk)).slice(-4000);
      const m = CODE.exec(out);
      if (m && !this.v.code) {
        this.v.code = m[1]!;
        this.v.url = GH_DEVICE_URL;
      }
    };
    c.stdout?.on('data', read);
    c.stderr?.on('data', read);
    c.on('error', (e) => {
      if (this.child === c) this.finish('failed', `couldn't run gh: ${safeLine(e.message)}`);
    });
    c.on('close', (code) => {
      if (this.child !== c) return;
      // gh exits 0 once GitHub has the code typed in; `gh auth status` must agree before it counts.
      if (code === 0 && this.d.status() === 0) this.finish('done', 'signed in: gh keeps the login in its own store');
      else this.finish('failed', `gh stopped${code === null ? '' : ` (exit ${code})`}${safeLine(out) ? `: ${safeLine(out)}` : ''}`);
    });
    this.timer = setTimeout(() => {
      if (this.child === c) this.finish('expired', `nobody typed the code on GitHub within ${Math.round(this.d.timeoutMs / 60_000)} minutes; start again`);
    }, this.d.timeoutMs);
    this.timer.unref?.();
    return this.view();
  }

  /** Stop a waiting login. */
  cancel(): GhLoginView {
    if (this.v.state === 'waiting') this.finish('cancelled', 'cancelled');
    return this.view();
  }

  private finish(state: Exclude<GhLoginState, 'idle' | 'waiting'>, detail: string): void {
    const c = this.child;
    this.child = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      c?.kill();
    } catch {
      // gone already
    }
    this.v = { ...this.v, state, detail, code: null, url: null };
  }
}

export class GhLoginError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
