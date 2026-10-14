// The first-run page's Sign in to Claude (wizard screen 2).
//
// Local mode: the dashboard runs `claude auth login` as this user, relays the sign-in page's URL to the owner's
// browser as a button, and polls `claude auth status` every 2 s until it says signed in. Nothing is pasted: the URL
// relayed is the one Claude Code hands its browser opener ($BROWSER, src/os browserRelay), whose redirect goes back
// to Claude Code's own listener on localhost. The URL it prints for a browser elsewhere ends in a code to paste: it
// is never read (claude's output goes nowhere) and a URL whose redirect isn't localhost is never relayed. No token
// passes through here: Claude Code stores its own login; this sees only the URL and what `claude auth status` says.
// The URL is shown to the instance's owners only and is never in an event, the audit or a log line.
//
// Server mode: the agents' login is a token from `claude setup-token`, pasted once into the existing paste_secret
// ask (add-project's claude-token step) or at credentials.sh's hidden prompt; claudeServerView says which applies.
//
// WHY the account email is labelled cached: `claude auth status` names the account from Claude Code's cached
// profile (~/.claude.json), not from the token, so after a token change it can name the previous account (#341).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { readAccountStatus, CLAUDE_ACCOUNT_DIR } from './claude-account.js';
import { CLAUDE_TOKEN_CREDENTIAL } from './coordinator/add-project.js';
import { mayAnswerAsk, type Ask, type Role } from './console/asks.js';
import { browserRelay, ownerOnlyDir } from './os/index.js';
import { withToolPath } from './tool-path.js';
import { outboundEnv } from './network.js';

/** WHY: claude's login carries Anthropic credentials: no host-redirect variable reaches it (src/network.ts, #391). */
export const signinEnv = (relay: string | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => outboundEnv({ ...withToolPath(env), ...(relay ? { BROWSER: relay } : {}) });

/** How often a sign-in checks `claude auth status`, and how long it waits before giving up. */
export const SIGNIN_POLL_MS = 2_000;
export const SIGNIN_TIMEOUT_MS = 10 * 60_000;

/** Anthropic's sign-in hosts: a relayed URL must be on one of them. */
const SIGNIN_HOSTS = new Set(['claude.ai', 'claude.com', 'platform.claude.com', 'console.anthropic.com']);

/**
 * Whether a URL may be relayed: https on Anthropic's sign-in host, an OAuth authorize request whose redirect comes
 * back to localhost (Claude Code's own listener). INVARIANT: the paste-a-code URL (its redirect is Anthropic's
 * callback page) is refused, so nothing is ever pasted.
 */
export function relayableSigninUrl(raw: string): string | null {
  const s = raw.trim();
  if (s.length > 4000 || /\s/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !SIGNIN_HOSTS.has(u.hostname) || u.port) return null;
  if (!/\/oauth\/authorize$/.test(u.pathname)) return null;
  const back = u.searchParams.get('redirect_uri');
  if (!back) return null;
  try {
    const r = new URL(back);
    if (r.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(r.hostname)) return null;
  } catch {
    return null;
  }
  return u.toString();
}

export interface ClaudeStatus {
  loggedIn: boolean;
  method: string | null;
  /** The account's email as Claude Code's cached profile names it (see WHY above): shown as cached, never as current. */
  cachedAccount: string | null;
}

/** `claude auth status --json`'s answer, or null when it gave none. Never the token (the command doesn't print it). */
export function parseClaudeStatus(stdout: string): ClaudeStatus | null {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (typeof j.loggedIn !== 'boolean') return null;
    return { loggedIn: j.loggedIn, method: typeof j.authMethod === 'string' ? j.authMethod.slice(0, 40) : null, cachedAccount: j.loggedIn && typeof j.email === 'string' ? j.email.slice(0, 200) : null };
  } catch {
    return null;
  }
}

/** The running `claude auth login`, as the sign-in needs it. */
export interface SigninChild {
  kill(): void;
  onExit(fn: (code: number | null) => void): void;
}

// WHY: tests stand in for claude, its status and the timers.
export interface SigninDeps {
  /** Start `claude auth login` with this environment; its output goes nowhere. */
  login: (env: NodeJS.ProcessEnv) => SigninChild;
  status: () => Promise<ClaudeStatus | null>;
  relay: (dir: string, urlFile: string) => string | null;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
}

export function systemSigninDeps(): SigninDeps {
  return {
    login: (env) => {
      const c = spawn('claude', ['auth', 'login'], { env, stdio: 'ignore' });
      return {
        kill: () => {
          if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
        },
        onExit: (fn) => {
          c.on('exit', (code) => fn(code));
          c.on('error', () => fn(null));
        },
      };
    },
    status: () =>
      new Promise((resolve) => {
        execFile('claude', ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 30_000, env: signinEnv(null) }, (_e, stdout) => resolve(parseClaudeStatus(stdout ?? '')));
      }),
    relay: browserRelay,
    now: Date.now,
    pollMs: SIGNIN_POLL_MS,
    timeoutMs: SIGNIN_TIMEOUT_MS,
  };
}

export type SigninState = 'idle' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'timed-out';

export interface SigninView {
  state: SigninState;
  /** Anthropic's sign-in page, while waiting (the owners only; null for anyone else, or before claude hands it over). */
  url: string | null;
  detail: string;
  startedAt: string | null;
  endedAt: string | null;
  /** What `claude auth status` said last: signed in, how, and the cached account (labelled cached on the page). */
  status: ClaudeStatus | null;
}

/** One `claude auth login` at a time, relayed and polled. Only ever local mode's (the dashboard checks). */
export class ClaudeSignin {
  private s: { state: SigninState; url: string | null; detail: string; startedAt: number | null; endedAt: number | null; status: ClaudeStatus | null } = { state: 'idle', url: null, detail: 'not started', startedAt: null, endedAt: null, status: null };
  private child: SigninChild | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dir: string | null = null;
  private checking = false;

  constructor(
    private readonly d: SigninDeps,
    /** Called once a sign-in ends, however it ended (the dashboard audits it). Never given the URL. */
    private readonly onEnd: (state: SigninState, detail: string) => void = () => {},
  ) {}

  get running(): boolean {
    return this.s.state === 'waiting';
  }

  /** Start a sign-in. Throws when one is running already. */
  start(): void {
    if (this.running) throw new Error('a Claude sign-in is running already: one at a time');
    this.dir = mkdtempSync(join(tmpdir(), `${BRAND.cli}-claude-signin-`));
    ownerOnlyDir(this.dir);
    const urlFile = join(this.dir, 'url');
    const relay = this.d.relay(this.dir, urlFile);
    const env = signinEnv(relay);
    this.s = {
      state: 'waiting',
      url: null,
      detail: relay ? "waiting for Claude Code's sign-in link" : "Claude Code opens Anthropic's sign-in in this machine's browser itself; finish it there",
      startedAt: this.d.now(),
      endedAt: null,
      status: null,
    };
    let child: SigninChild;
    try {
      child = this.d.login(env);
    } catch (e) {
      this.end('failed', `couldn't start claude auth login: ${String((e as Error).message).split('\n')[0]}`);
      return;
    }
    this.child = child;
    child.onExit((code) => {
      if (this.child !== child) return;
      this.child = null;
      // Its exit (signed in, or given up): one last check says which.
      if (this.running) void this.check(code);
    });
    this.timer = setInterval(() => void this.check(), this.d.pollMs);
    this.timer.unref?.();
  }

  cancel(why = 'cancelled'): boolean {
    if (!this.running) return false;
    this.end('cancelled', why);
    return true;
  }

  /** Read the relayed URL once it is there; then ask `claude auth status`. `exited`: claude auth login's exit code. */
  async check(exited?: number | null): Promise<void> {
    if (!this.running || this.checking) return;
    this.checking = true;
    try {
      if (!this.s.url && this.dir) {
        const f = join(this.dir, 'url');
        if (existsSync(f)) {
          const url = relayableSigninUrl(readFileSync(f, 'utf8'));
          rmSync(f, { force: true });
          if (url) {
            this.s.url = url;
            this.s.detail = "open Anthropic's sign-in, in a browser on this machine (it comes back to Claude Code on localhost)";
          } else this.s.detail = "Claude Code's sign-in link isn't one this page relays (only Anthropic's, coming back to localhost)";
        }
      }
      const st = await this.d.status();
      if (!this.running) return;
      if (st) this.s.status = st;
      if (st?.loggedIn) return this.end('done', `signed in${st.method ? ` (${st.method})` : ''}, per \`claude auth status\``);
      if (exited !== undefined) return this.end('failed', `claude auth login ended (exit ${exited ?? 'none'}) and \`claude auth status\` says not signed in`);
      if (this.d.now() - (this.s.startedAt ?? 0) > this.d.timeoutMs) return this.end('timed-out', `not signed in after ${Math.round(this.d.timeoutMs / 60_000)} min: stopped claude auth login`);
    } finally {
      this.checking = false;
    }
  }

  private end(state: SigninState, detail: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const c = this.child;
    this.child = null;
    c?.kill();
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.s = { ...this.s, state, detail, url: null, endedAt: this.d.now() };
    this.onEnd(state, detail);
  }

  /** The view; the URL only for the instance's owners. */
  view(owner: boolean): SigninView {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    return { state: this.s.state, url: owner ? this.s.url : null, detail: this.s.detail, startedAt: iso(this.s.startedAt), endedAt: iso(this.s.endedAt), status: this.s.status };
  }
}

/** Server mode's panel: the open paste box (add-project's claude-token ask) and what claude-account status last found. */
export interface ClaudeServerView {
  agentUser: string;
  /** add-project's open claude-token ask for this instance, when one is waiting: the page shows its paste box. */
  ask: (Ask & { canAnswer: boolean }) | null;
  /** The agent user, as claude-account.sh status last found it (status.json); null when it hasn't run. */
  status: { at: string; loggedIn: boolean; method: string | null; cachedAccount: string | null; installedAt: string | null } | null;
  /** The terminal's way: the same token, at a hidden prompt (for automation: on stdin). */
  command: string;
  /** The equivalent setup script, named on the screen and in the docs. */
  script: string;
}

export function claudeServerView(o: { instance: string; asks: readonly Ask[]; role: Role | null; engineRoot: string; accountDir?: string }): ClaudeServerView {
  const agentUser = `wl-${o.instance}-agent`;
  const open = [...o.asks].reverse().find((a) => a.kind === 'paste_secret' && a.status === 'open' && a.instance === o.instance && a.credential === CLAUDE_TOKEN_CREDENTIAL) ?? null;
  const all = readAccountStatus(o.accountDir ?? CLAUDE_ACCOUNT_DIR);
  const rec = all?.users.find((u) => u.instance === o.instance && u.kind === 'agent') ?? null;
  const script = `sudo bash ${join(o.engineRoot, 'scripts', 'setup', 'credentials.sh')} ${o.instance} claude`;
  return {
    agentUser,
    ask: open ? { ...open, canAnswer: mayAnswerAsk(open, o.role) } : null,
    status: rec ? { at: all!.at, loggedIn: rec.loggedIn, method: rec.authMethod, cachedAccount: rec.loggedIn ? rec.account : null, installedAt: rec.installedAt } : null,
    command: `claude setup-token    # on a machine signed in to the account the agents should use\n${script}    # paste the token it printed (not shown)`,
    script,
  };
}
