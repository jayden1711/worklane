// The owner terminal: an escape hatch in the hub, decided by the owner. A login shell as the machine's admin
// user (configured as the hub's console_user, never hardcoded), whose sudo still asks for the admin's password
// every time. The hub's viewer user starts it through one reviewed sudoers rule that allows exactly the console
// shell (scripts/setup/console-shell.sh installs both; that's the owner's step), never arbitrary sudo.
//
// It opens only when all of these hold, and is refused, saying which, otherwise:
// - the person is signed in (the hub's GitHub session, which ends after 12 hours idle or 7 days) and is the owner
//   of the instance it's opened from, and the request carries the session's CSRF token;
// - then, on top of those: it's opened from a Tailscale device the owner listed (console_devices: tags or node
//   names), identified by Tailscale itself (terminal-devices.ts); an empty list, or a device that can't be
//   identified, is refused;
// - a console user is configured, isn't root, and isn't the user the hub runs as;
// - `sudo -n true` as that user FAILS (the console shell's `check`): if it succeeds (passwordless sudo, or a
//   cached sudo timestamp) the terminal would be root without a password, so it's refused. The shell itself
//   checks again, then runs `sudo -k` so no cached credential is reused, before the login shell starts.
// Every command line is recorded in the audit log (who, when, the line); input typed while the terminal
// doesn't echo (a password prompt) is recorded only as hidden input, never its text. It closes after 10
// minutes without input.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import { ptyCommand } from '../os/index.js';
import type { ConsoleSession } from './session.js';
import { libexecPath } from '../os/system-paths.js';

export const CONSOLE_SHELL = libexecPath('console-shell');
export const IDLE_MS = 10 * 60_000;
/** A Unix login name, as useradd takes it. */
export const CONSOLE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface TerminalConfig {
  /** The admin user the terminal runs as (the hub's console_user); null: not configured. */
  consoleUser: string | null;
  /** The user the hub runs as. */
  hubUser: string;
}

export interface AuditEntry {
  at: string;
  login: string;
  instance: string;
  kind: 'opened' | 'refused' | 'command' | 'hidden_input' | 'closed';
  /** command: the line as typed (edited: it used history or completion, so `shown` is what the terminal showed). */
  line?: string;
  edited?: boolean;
  shown?: string;
  why?: string;
  user?: string;
  /** The Tailscale device (its name and tags), once identified. */
  device?: string;
}

export interface AuditSink {
  record(e: AuditEntry): void;
}

/** An append-only JSONL audit file, for this user only (0600). */
export const fileAudit = (path: string): AuditSink => ({
  record: (e) => appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 }),
});

export interface Pty {
  write(data: string): void;
  onData(fn: (data: string) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

/** Start the PTY for `argv` as the hub's user (argv itself switches to the console user through sudo). */
export type SpawnPty = (o: { argv: string[]; user: string; cols: number; rows: number }) => Pty;
/** Run a command and return its stdout; throws on a non-zero exit (machine.ts's Exec). */
export type Exec = (file: string, args: string[]) => string;

/** The command that starts the console shell as `user`: the one command the sudoers rule allows. */
export const shellArgv = (user: string) => ['sudo', '-n', '-u', user, CONSOLE_SHELL, 'shell'];
/** The preflight: `sudo -n true` as `user`, through the console shell's `check`. */
export const checkArgv = (user: string) => ['-n', '-u', user, CONSOLE_SHELL, 'check'];

/** Why the terminal may not open for this person now, before anything runs; null when it may. */
export function terminalRefusal(s: ConsoleSession | null, cfg: TerminalConfig): string | null {
  if (!s || !s.login) return 'not signed in';
  if (s.role !== 'owner') return `the terminal is the owner's alone; @${s.login} is ${s.role ?? 'not a member'} here`;
  if (!s.csrfOk) return 'missing or wrong CSRF token';
  if (!cfg.consoleUser) return 'no console user is configured for this hub (console_user in dashboards.sh)';
  if (!CONSOLE_USER.test(cfg.consoleUser) || cfg.consoleUser === 'root') return `console user ${cfg.consoleUser} isn't allowed (a login name, never root)`;
  if (cfg.consoleUser === cfg.hubUser) return `the hub runs as ${cfg.hubUser}, the console user itself; it must run as its own viewer user`;
  return null;
}

/**
 * `sudo -n true` as the console user, through the console shell. Opens only on its exact "password-required"
 * (sudo asked for a password, so it would ask the owner too); anything else (it succeeded, the rule or the
 * shell is missing, an error) is a refusal.
 */
export function sudoPreflight(user: string, exec: Exec): string | null {
  let out: string;
  try {
    out = exec('sudo', checkArgv(user)).trim();
  } catch (e) {
    const t = `${(e as { stdout?: unknown }).stdout ?? ''}`.trim();
    if (t === 'passwordless') return `sudo -n true succeeds as ${user} (passwordless sudo, or a cached sudo timestamp): the terminal would be root without a password, so it won't open. Remove the NOPASSWD rule, or wait for the timestamp to expire (sudo -k)`;
    return `couldn't check sudo as ${user} (${CONSOLE_SHELL} check): is scripts/setup/console-shell.sh installed for this hub's user? ${String((e as Error).message).split('\n')[0]}`;
  }
  if (out === 'password-required') return null;
  if (out === 'passwordless') return `sudo -n true succeeds as ${user} (passwordless sudo, or a cached sudo timestamp): the terminal would be root without a password, so it won't open`;
  return `unexpected answer from ${CONSOLE_SHELL} check: ${out.slice(0, 100)}`;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** Terminal output as plain text: escape sequences and control characters (but newlines) removed. */
export const plain = (s: string) => s.replace(ANSI, '').replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (i < needle.length && ch === needle[i]) i++;
  return i === needle.length;
}

/**
 * Turns the keystrokes and the output of a terminal into the command lines entered. A line counts as
 * echoed when the output between its first keystroke and the next newline shows its characters in order;
 * a line that wasn't echoed (a password prompt turns echo off) is reported as hidden, without its text.
 */
export class CommandRecorder {
  private cur = '';
  private edited = false;
  private started = false;
  private seg = '';
  private pending: { line: string; edited: boolean }[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly emit: (e: { kind: 'command'; line: string; edited: boolean; shown?: string } | { kind: 'hidden_input' }) => void,
    private readonly settleMs = 1000,
  ) {}

  input(data: string) {
    const s = data.replace(/\x1b\[20[01]~/g, ''); // bracketed paste markers
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        // An escape sequence (arrows, history): skip it; the line is now edited.
        const m = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/.exec(s.slice(i))!;
        i += m[0].length - 1;
        this.begin();
        this.edited = true;
      } else if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && s[i - 1] === '\r') continue;
        this.enter();
      } else if (ch === '\x7f' || ch === '\b') this.cur = this.cur.slice(0, -1);
      else if (ch === '\x03' || ch === '\x15') {
        // Ctrl+C or Ctrl+U: the line is gone.
        this.cur = '';
        this.edited = false;
        if (!this.pending.length) this.started = false;
      } else if (ch < ' ') {
        this.begin();
        this.edited = true; // completion (Tab) and other editing keys
      } else {
        this.begin();
        this.cur += ch;
      }
    }
  }

  output(data: string) {
    if (!this.started) return;
    this.seg += plain(data);
    this.settle(false);
  }

  /** Report anything still pending (the session is closing). */
  flush() {
    if (this.cur || this.edited) this.enter();
    this.settle(true);
  }

  private begin() {
    if (!this.started) {
      this.started = true;
      this.seg = '';
    }
  }

  private enter() {
    if (!this.cur && !this.edited) return;
    this.pending.push({ line: this.cur, edited: this.edited });
    this.cur = '';
    this.edited = false;
    this.begin();
    this.settle(false);
    if (this.pending.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.settle(true);
      }, this.settleMs);
      this.timer.unref?.();
    }
  }

  /** Judge pending lines against the output up to each newline (or, forced, what there is). */
  private settle(force: boolean) {
    while (this.pending.length) {
      const nl = this.seg.search(/[\r\n]/);
      if (nl < 0 && !force) return;
      const shown = nl < 0 ? this.seg : this.seg.slice(0, nl);
      this.seg = nl < 0 ? '' : this.seg.slice(nl + 1).replace(/^\n/, '');
      const p = this.pending.shift()!;
      const visible = p.line.replace(/\*/g, '');
      const echoed = p.edited ? shown.trim().length > 0 && (!visible || isSubsequence(visible, shown)) : visible.length > 0 && isSubsequence(visible, shown);
      if (!echoed) this.emit({ kind: 'hidden_input' });
      else this.emit({ kind: 'command', line: p.line, edited: p.edited, ...(p.edited ? { shown: shown.trim().slice(-500) } : {}) });
    }
    if (!this.pending.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!this.cur && !this.edited) {
        this.started = false;
        this.seg = '';
      }
    }
  }
}

export interface OpenTerminal {
  session: ConsoleSession | null;
  instance: string;
  config: TerminalConfig;
  audit: AuditSink;
  /** Output to the browser. */
  send: (data: string) => void;
  /** The terminal ended (why); the connection should close. */
  closed: (why: string) => void;
  /**
   * The Tailscale device it's opened from, checked after the owner checks (terminal-devices.ts): a refusal
   * (why) or none, with the device when it was identified. Required, so a caller can't leave the check out.
   */
  device: () => { why: string | null; device: { name: string; tags: string[] } | null };
  spawnPty?: SpawnPty;
  exec?: Exec;
  now?: () => number;
  idleMs?: number;
  size?: { cols: number; rows: number };
}

export interface TerminalHandle {
  input(data: string): void;
  close(why: string): void;
}

/** Open the owner terminal, or say why not (and record the refusal). */
export function openTerminal(o: OpenTerminal): TerminalHandle | { refused: string } {
  const now = o.now ?? Date.now;
  const at = () => new Date(now()).toISOString();
  const login = o.session?.login ?? '';
  let device: string | undefined;
  const refuse = (why: string) => {
    o.audit.record({ at: at(), login, instance: o.instance, kind: 'refused', why, ...(device ? { device } : {}) });
    return { refused: why };
  };
  const why = terminalRefusal(o.session, o.config);
  if (why) return refuse(why);
  // On top of the owner checks: the Tailscale device it's opened from must be one the owner allowed.
  const d = o.device();
  if (d.device) device = `${d.device.name}${d.device.tags.length ? ` [${d.device.tags.join(',')}]` : ''}`;
  if (d.why) return refuse(d.why);
  const user = o.config.consoleUser!;
  const pre = sudoPreflight(user, o.exec ?? defaultExec);
  if (pre) return refuse(pre);
  let pty: Pty;
  try {
    pty = (o.spawnPty ?? defaultSpawnPty)({ argv: shellArgv(user), user, cols: o.size?.cols ?? 80, rows: o.size?.rows ?? 24 });
  } catch (e) {
    return refuse(`couldn't start the terminal: ${String((e as Error).message).split('\n')[0]}`);
  }
  o.audit.record({ at: at(), login, instance: o.instance, kind: 'opened', user, ...(device ? { device } : {}) });
  const recorder = new CommandRecorder((e) => o.audit.record({ at: at(), login, instance: o.instance, ...e }));
  let open = true;
  let idle: NodeJS.Timeout | null = null;
  const close = (reason: string) => {
    if (!open) return;
    open = false;
    if (idle) clearTimeout(idle);
    recorder.flush();
    try {
      pty.kill();
    } catch {
      // already gone
    }
    o.audit.record({ at: at(), login, instance: o.instance, kind: 'closed', why: reason });
    o.closed(reason);
  };
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => close('idle for 10 minutes'), o.idleMs ?? IDLE_MS);
    idle.unref?.(); // the server keeps the process alive, not a terminal's timer
  };
  pty.onData((d) => {
    if (!open) return;
    recorder.output(d);
    o.send(d);
  });
  pty.onExit((code) => close(`the shell exited${code === null ? '' : ` (${code})`}`));
  touch();
  return {
    input(data: string) {
      if (!open) return;
      touch();
      recorder.input(data);
      pty.write(data);
    },
    close,
  };
}

const defaultExec: Exec = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });

/** A PTY through the OS adapter (util-linux script), its stdio piped. */
export const defaultSpawnPty: SpawnPty = ({ argv, cols, rows }) => {
  const [file, args] = ptyCommand(argv, { cols, rows });
  const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: process.env.LANG ?? 'C.UTF-8' } });
  return {
    write: (d) => void child.stdin.write(d),
    onData: (fn) => {
      child.stdout.setEncoding('utf8').on('data', fn);
      child.stderr.setEncoding('utf8').on('data', fn);
    },
    onExit: (fn) => void child.on('exit', (code) => fn(code)),
    kill: () => void child.kill('SIGHUP'),
  };
};
