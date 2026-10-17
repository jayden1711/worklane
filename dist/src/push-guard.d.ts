/** The marker on the pre-push hook this engine writes (a hook without it is someone else's, kept and chained). */
export declare const PRE_PUSH_MARKER: string;
/** The full ref a push refspec's destination names (`main`, `heads/main` and `refs/heads/main` are all refs/heads/main). */
export declare function destinationRef(ref: string): string;
/** Whether a push to `ref` would update the default branch. */
export declare const isDefaultBranchRef: (ref: string, defaultBranch: string) => boolean;
export interface PushGuard {
    /** The repo's default branch (config.yaml project.default_branch). */
    defaultBranch: string;
    /** land_mode direct: this push is the direct land, a fast-forward of the default branch by design. */
    directLand?: boolean;
    /** Record the refusal (a push.blocked event). */
    blocked(ref: string, head: string): void;
}
/** Why this push may not go ahead, or null. A refusal is recorded through the guard. */
export declare function defaultBranchRefusal(guard: PushGuard, ref: string, head: string): string | null;
/** Record a refused push to the default branch in an event log (the hook's `push-blocked`, and tune). */
export declare function recordPushBlocked(eventsDb: string, ref: string, head: string | null, via: 'coordinator' | 'hook'): void;
/**
 * The pre-push hook: refuses any push to refs/heads/<branch> for the branches named here and the remote's HEAD
 * (whatever origin/HEAD names at push time), records each refusal through the engine when it is there (best effort:
 * the refusal never depends on it), then runs a hook it replaced, with the same input.
 */
export declare function prePushHook(o: {
    branches: string[];
    node?: string;
    engine?: string;
    chained?: string;
}): string;
/**
 * Write the pre-push hook into `hooksDir`, keeping (and chaining) a pre-push hook that isn't ours. Returns its path.
 * `ownerOnly`: the directory and hook are this user's only (0700), as the coordinator's own hooks dir must be (a
 * hooks dir anyone else can write runs their code); otherwise 0755, beside a checkout's other hooks.
 */
export declare function installPrePushHook(hooksDir: string, o: {
    branches: string[];
    node?: string;
    engine?: string;
    ownerOnly?: boolean;
}): string;
/** The coordinator's own git hooks dir, in its instance home (core.hooksPath in its git environment): only pre-push. */
export declare const coordinatorHooksDir: (instanceHome: string) => string;
/**
 * Write the coordinator's hooks dir: the pre-push hook for its default branch, or, with land_mode direct (whose land
 * is a push of the default branch), no hook at all. Run at every coordinator start, from the config in effect.
 */
export declare function writeCoordinatorHooks(instanceHome: string, o: {
    defaultBranch: string;
    directLand: boolean;
    node?: string;
    engine?: string;
}): string;
