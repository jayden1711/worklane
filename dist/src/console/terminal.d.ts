import type { ConsoleSession } from './session.js';
export declare const CONSOLE_SHELL: string;
export declare const IDLE_MS: number;
/** A Unix login name, as useradd takes it. */
export declare const CONSOLE_USER: RegExp;
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
export declare const fileAudit: (path: string) => AuditSink;
export interface Pty {
    write(data: string): void;
    onData(fn: (data: string) => void): void;
    onExit(fn: (code: number | null) => void): void;
    kill(): void;
}
/** Start the PTY for `argv` as the hub's user (argv itself switches to the console user through sudo). */
export type SpawnPty = (o: {
    argv: string[];
    user: string;
    cols: number;
    rows: number;
}) => Pty;
/** Run a command and return its stdout; throws on a non-zero exit (machine.ts's Exec). */
export type Exec = (file: string, args: string[]) => string;
/** The command that starts the console shell as `user`: the one command the sudoers rule allows. */
export declare const shellArgv: (user: string) => string[];
/** The preflight: `sudo -n true` as `user`, through the console shell's `check`. */
export declare const checkArgv: (user: string) => string[];
/** Why the terminal may not open for this person now, before anything runs; null when it may. */
export declare function terminalRefusal(s: ConsoleSession | null, cfg: TerminalConfig): string | null;
/**
 * `sudo -n true` as the console user, through the console shell. Opens only on its exact "password-required"
 * (sudo asked for a password, so it would ask the owner too); anything else (it succeeded, the rule or the
 * shell is missing, an error) is a refusal.
 */
export declare function sudoPreflight(user: string, exec: Exec): string | null;
/** Terminal output as plain text: escape sequences and control characters (but newlines) removed. */
export declare const plain: (s: string) => string;
/**
 * Turns the keystrokes and the output of a terminal into the command lines entered. A line counts as
 * echoed when the output between its first keystroke and the next newline shows its characters in order;
 * a line that wasn't echoed (a password prompt turns echo off) is reported as hidden, without its text.
 */
export declare class CommandRecorder {
    private readonly emit;
    private readonly settleMs;
    private cur;
    private edited;
    private started;
    private seg;
    private pending;
    private timer;
    constructor(emit: (e: {
        kind: 'command';
        line: string;
        edited: boolean;
        shown?: string;
    } | {
        kind: 'hidden_input';
    }) => void, settleMs?: number);
    input(data: string): void;
    output(data: string): void;
    /** Report anything still pending (the session is closing). */
    flush(): void;
    private begin;
    private enter;
    /** Judge pending lines against the output up to each newline (or, forced, what there is). */
    private settle;
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
    device: () => {
        why: string | null;
        device: {
            name: string;
            tags: string[];
        } | null;
    };
    spawnPty?: SpawnPty;
    exec?: Exec;
    now?: () => number;
    idleMs?: number;
    size?: {
        cols: number;
        rows: number;
    };
}
export interface TerminalHandle {
    input(data: string): void;
    close(why: string): void;
}
/** Open the owner terminal, or say why not (and record the refusal). */
export declare function openTerminal(o: OpenTerminal): TerminalHandle | {
    refused: string;
};
/** A PTY through the OS adapter (util-linux script), its stdio piped. */
export declare const defaultSpawnPty: SpawnPty;
