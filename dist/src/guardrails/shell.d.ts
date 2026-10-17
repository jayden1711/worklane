export interface SimpleCommand {
    /** argv with leading VAR=value assignments and wrappers removed. */
    argv: string[];
    /** VAR=value assignments that prefixed the command. */
    assignments: Record<string, string>;
    /**
     * Files written by redirection (>, >>, &>) or tee, or that the command's own arguments name as changed: copied
     * or moved to, moved or removed, edited in place (sed -i, perl -i), created (touch, mkdir), linked, dd of=.
     * A copy or move into what may be a directory is also listed with the file's name in it, so `cp x .claude`
     * counts as a write to `.claude/x`.
     */
    writes: string[];
}
export declare function basename(p: string): string;
/** Every simple command in a shell command line, recursively. */
export declare function splitCommands(src: string, depth?: number): SimpleCommand[];
