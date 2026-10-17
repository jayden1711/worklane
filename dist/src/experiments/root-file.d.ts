import type { RootCaps } from './approval.js';
export declare const rootFilePath: (instance: string) => string;
/** The root script that changes it, as a root shell runs it. */
export declare const EXP_SCRIPT = "scripts/setup/experiments.sh";
export interface RootFile extends RootCaps {
    env_network: boolean;
    /** The steps' systemd limits: processes, memory in GB (no swap), CPU cores. */
    tasks_max: number;
    memory_gb: number;
    cpu_cores: number;
}
/** The file's text exactly as the script writes it (and the helper reads it). */
export declare function rootFileText(f: RootFile): string;
/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export declare function parseRootFile(text: string): RootFile | {
    error: string;
};
export type RootState = {
    state: 'on';
    file: RootFile;
} | {
    state: 'off' | 'unknown';
    why: string;
};
/** Root's file for `instance` as the helper would read it: root's, 0644, regular, in the script's form. */
export declare function readRootFile(instance: string, file?: string, rootUid?: number): RootState;
/** The commands an owner runs in a root shell (the dashboard shows them; it never runs them). */
export declare const rootCommands: (instance: string) => {
    install: string;
    set: string;
    hash: string;
    add: string;
};
