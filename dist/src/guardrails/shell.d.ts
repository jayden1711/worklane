export interface SimpleCommand {
    /** argv with leading VAR=value assignments and wrappers removed. */
    argv: string[];
    /** VAR=value assignments that prefixed the command. */
    assignments: Record<string, string>;
    /** Files written by redirection (>, >>, &>) or tee. */
    writes: string[];
}
export declare function basename(p: string): string;
/** Every simple command in a shell command line, recursively. */
export declare function splitCommands(src: string, depth?: number): SimpleCommand[];
