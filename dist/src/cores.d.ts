export declare const CORES_PLACEHOLDER = "{cores}";
export interface CoreBudget {
    /** Cores kept back for the machine itself (the coordinator, the dashboard, the OS). */
    reserve: number;
    /** Never fewer than this per task. */
    min: number;
    /** Never more than this per task (absent: no cap beyond the machine). */
    max?: number | undefined;
}
export declare const DEFAULT_CORE_BUDGET: CoreBudget;
/**
 * A task's share: the cores left after the reserve, split evenly over the agents running (at least one, the
 * task itself), rounded down so the shares together never exceed the machine; then held within min..max.
 */
export declare function coreShare(o: {
    cores: number;
    running: number;
    budget?: CoreBudget;
}): number;
/** The share right now on this machine: its cores, over the live agent slots. */
export declare function currentCoreShare(budget?: CoreBudget, slotsDir?: string): number;
/** A command with `{cores}` filled in. */
export declare function withCores(command: string, share: number): string;
/** A project's env (tests.yaml `env`) with `{cores}` filled in. */
export declare function envWithCores(env: Record<string, string> | undefined, share: number): Record<string, string>;
