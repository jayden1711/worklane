/** Where the starter workflow goes, and its one job: the job's name is the check name a PR waits on. */
export declare const STARTER_CI_PATH = ".github/workflows/ci.yml";
export declare const STARTER_CI_CHECK = "test";
/**
 * Actions pinned by commit, each checked against its release tag (GitHub's API: git/ref/tags/<tag>, a commit).
 * checkout and setup-node are the pins this repo's own workflows use.
 */
export declare const PINNED: {
    readonly checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
    readonly node: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0";
    readonly python: "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0";
    readonly go: "actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0";
    readonly bun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0";
};
export interface StarterCi {
    path: string;
    /** The check name it reports: config.yaml required_checks takes this once it has run. */
    check: string;
    /** One plain sentence: what runs, on what, and when. */
    summary: string;
    file: string;
    /** No test command was found: its one test step fails until it is edited, so nothing passes by accident. */
    placeholder: boolean;
    /** The test command it runs (null: the placeholder). */
    command: string | null;
}
/**
 * The starter workflow for a repo: its files (`git ls-files` at the default branch's tip), read from `dir`. The
 * toolchains come from the ecosystems detection found; the test command from `configured` (tests.yaml runner.full)
 * or detection. Nothing found: a placeholder test step that fails until replaced.
 */
export declare function draftStarterCi(o: {
    dir: string;
    files: string[];
    branch: string;
    configured?: string | null;
}): StarterCi;
/**
 * GitHub's new-file page for the workflow, prefilled (the `value` is added by whoever has the final text: the page,
 * after the person's edits). There the person commits it, on a new branch with a PR, as themselves.
 */
export declare function newFileUrl(repo: string, branch: string, web?: string): string;
/** The new-file page with the file in it. */
export declare const newFileUrlWith: (base: string, file: string) => string;
export interface StarterCiView extends StarterCi {
    /** The default branch it runs on and is committed to. */
    branch: string;
    /** GitHub's new-file page, without the file (the page adds it as `value`). */
    newFile: string;
    /** Whether the default branch has a workflow at this path already (merged). */
    onBranch: boolean;
    /**
     * The starter check on the default branch's tip, as GitHub reports it: `none` (not run there yet), `running`, or
     * finished with its conclusion. Finished: its name is offered for required_checks (a config change to confirm).
     */
    firstRun: {
        state: 'none' | 'running' | 'done';
        conclusion: string | null;
    };
    /**
     * No CI (config.yaml ci: none, src/ci-none.ts): offered only where tests.yaml has test_run; `why` says why not. `means`:
     * what it means, as the step states it.
     */
    noCi: {
        offered: boolean;
        means: string;
        why: string | null;
    };
}
type Run = (cmd: string, args: string[], cwd: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
/**
 * The step's view: the draft from origin/<branch>'s files (as fetched here), whether that branch has the workflow,
 * and the starter check's run on its tip. `gh` reads GitHub (the dashboard's own gh); nothing is written anywhere.
 */
export declare function starterCiView(o: {
    root: string;
    repo: string;
    branch: string;
    configured: string | null;
    testRun?: boolean;
    gh: (args: string[]) => {
        status: number | null;
        stdout: string;
        stderr: string;
    };
    run?: Run;
}): StarterCiView;
export {};
