export interface Tidied {
    /** Paths under state/ whose mode was tightened. */
    tightened: string[];
    /** Old task files removed from state/tasks/. */
    removedTasks: string[];
}
export declare function tidyState(stateDir: string, opts?: {
    agentTasksDir?: string;
}): Tidied;
