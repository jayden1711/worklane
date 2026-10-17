import { HarnessTask } from './tasks.js';
export type Gh = (args: string[]) => string;
export declare const gh: Gh;
/** Read a merged PR into a task (nothing is written). */
export declare function taskFromPr(repo: string, pr: number, o?: {
    id?: string;
    gh?: Gh;
}): HarnessTask;
/**
 * Where a task may be kept. Public: only a task from the engine's own repository, and only while GitHub says that
 * repository is public. Anything else is held out.
 */
export declare function publicAllowed(repo: string, run?: Gh, own?: string | null): {
    ok: true;
} | {
    ok: false;
    why: string;
};
export declare function saveTask(t: HarnessTask, where: {
    publicDir: string;
} | {
    heldOutDir: string;
}): string;
