/** This engine's package directory (dist/src/ is two levels down). */
export declare const ENGINE_DIR: string;
/** Is this package directory npx's cache (npm exec's own install), not an install of its own? */
export declare const fromNpxCache: (dir: string) => boolean;
export interface NpxRunner {
    run(cmd: string, args: string[]): {
        status: number | null;
        stdout: string;
        stderr: string;
    };
    /** Run the installed engine's CLI on this terminal: its exit status. */
    relaunch(cli: string, args: string[]): Promise<number>;
}
export declare const systemRunner: NpxRunner;
export interface HandOffArgs {
    /** The repo being set up. */
    root: string;
    prefix: string;
    yes: boolean;
    reset: boolean;
    /** init's --answer id=choice pairs, passed on. */
    answers?: Record<string, string>;
    say(line: string): void;
}
/** Hand local init over from npx's cache to an install of its own: its exit status, or null when not run from npx. */
export type HandOff = (a: HandOffArgs) => Promise<number | null>;
export declare function handOffFromNpx(a: HandOffArgs, engineDir?: string, r?: NpxRunner): Promise<number | null>;
