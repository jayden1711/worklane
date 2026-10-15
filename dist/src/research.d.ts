/** The only tools a researcher run gets. No Bash (so no shell network), no Edit/Write/NotebookEdit, no MCP. */
export declare const RESEARCH_TOOLS: readonly ["Read", "Glob", "Grep", "WebSearch", "WebFetch"];
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export declare const RESEARCH_DENIED: readonly ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "mcp__*"];
export declare const RESEARCH_LABELS: readonly ["type:research", "type:investigation"];
/** Daily caps, per instance. Conservative defaults; the owner raises them in the instance settings. */
export interface ResearchCaps {
    max_searches_per_day: number;
    max_fetches_per_day: number;
    max_usd_per_day: number;
}
export declare const RESEARCH_DEFAULT_CAPS: ResearchCaps;
export interface ResearchIssue {
    number: number;
    title: string;
    body: string;
    labels: string[];
}
/**
 * Whether an issue asks for research, and the questions. Two triggers, both explicit:
 * a `type:research` or `type:investigation` label (the whole issue is the question), or a fenced
 * ```research block in the body (one question per non-empty line), for a spec issue that needs research first.
 */
export declare function researchTrigger(issue: ResearchIssue): {
    by: 'label' | 'block';
    questions: string[];
} | null;
/** The researcher's instructions: kept with the other roles (src/roles.ts), where the instruction evals reach them. */
export declare const RESEARCH_PROMPT: string;
/** The output a researcher may produce. Strict: no ask, no decision, no config, no review level. */
export declare const RESEARCH_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["report", "sources"];
    readonly properties: {
        readonly report: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly sources: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["url", "title"];
                readonly properties: {
                    readonly url: {
                        readonly type: "string";
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                };
            };
        };
    };
};
/**
 * Lanes for research runs (built in instance.ts laneRuns): `research`, the default, has no repo access (its working
 * directory is the run's bundle, and the checkout, its worktrees and the instance's task and chat files are denied to
 * every read); `research-repo` may read the repo, read-only, for an instance whose owner turned that on.
 */
export declare const RESEARCH_LANE = "research";
export declare const RESEARCH_REPO_LANE = "research-repo";
/** Where research bundles live: beside the checkout, like tasks/ and chat/. */
export declare const RESEARCH_DIR = "research";
/** The bundle file the hook reads in research mode (the blocklist, and what the run is for). */
export declare const RESEARCH_MANIFEST = "research.json";
/**
 * The run's context bundle: the issue text, the questions and the blocklist, written by the coordinator into
 * <instance root>/research/<run>/ (agents' group may read it; nobody but the coordinator may write it).
 */
export declare function writeResearchBundle(o: {
    instanceRoot: string;
    gid: number;
    run: string;
    issue: {
        number: number;
        title: string;
        body: string;
    } | null;
    questions: string[];
    blocklist: string[];
    context?: string;
}): string;
/**
 * The parts of a run request that make it a researcher run. Fixed here, before any page is read. Without repo
 * access the run's lane is `research` and its working directory is its bundle; with it, `research-repo` and a
 * read-only checkout of the repo the coordinator provides.
 */
export declare function researchRun(o: {
    questions: string[];
    context?: string;
    blocklist?: string[];
    repoAccess?: boolean;
    bundleDir?: string;
    worktree?: string;
}): {
    role: "researcher";
    lane: string;
    cwd: string;
    allowedTools: ("Read" | "Grep" | "Glob" | "WebFetch" | "WebSearch")[];
    disallowedTools: ("Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Bash" | "Task" | "mcp__*")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["report", "sources"];
        readonly properties: {
            readonly report: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly sources: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly required: readonly ["url", "title"];
                    readonly properties: {
                        readonly url: {
                            readonly type: "string";
                        };
                        readonly title: {
                            readonly type: "string";
                        };
                    };
                };
            };
        };
    };
};
/** The chat's entry point (later): a research run for a question asked in the dashboard chat, in its own bundle. */
export declare function researchRunForChat(question: string, bundleDir: string, blocklist?: string[]): {
    role: "researcher";
    lane: string;
    cwd: string;
    allowedTools: ("Read" | "Grep" | "Glob" | "WebFetch" | "WebSearch")[];
    disallowedTools: ("Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Bash" | "Task" | "mcp__*")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["report", "sources"];
        readonly properties: {
            readonly report: {
                readonly type: "string";
                readonly minLength: 1;
            };
            readonly sources: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly required: readonly ["url", "title"];
                    readonly properties: {
                        readonly url: {
                            readonly type: "string";
                        };
                        readonly title: {
                            readonly type: "string";
                        };
                    };
                };
            };
        };
    };
};
/** The env the research lane's hook runs with: the research root (reads are allowed only under it). */
export declare const RESEARCH_ROOT_ENV: string;
/**
 * The research lane's rule, in the PreToolUse hook (it has no project config there: its working directory is a
 * bundle). Only the research tools; every file read inside the research root (so never the checkout, a worktree, the
 * task or chat files); WebFetch only http(s) and never a domain on the bundle's blocklist. An unreadable bundle
 * manifest refuses every fetch (fail closed).
 */
export declare function researchModeRefusal(tool: string, input: Record<string, unknown>, cwd: string, root: string): string | null;
/** A host is blocked if it is a listed domain or a subdomain of one. Matching ignores case and a leading "www.". */
export declare function blockedHost(host: string, blocklist: string[]): string | null;
export declare function hostOf(url: string): string | null;
/** Why a researcher's tool call is refused before it runs (the PreToolUse hook), or null. */
export declare function researchCallRefusal(tool: string, input: Record<string, unknown>, blocklist: string[]): string | null;
export type ResearchStep = {
    kind: 'search';
    query: string;
    id: string;
} | {
    kind: 'fetch';
    url: string;
    host: string;
    id: string;
    refused: string | null;
};
/** What a run has done so far, and today's totals before it started. */
export interface ResearchUsage {
    searches: number;
    fetches: number;
    usd: number;
}
/** run.cost roles that are researcher runs: for research issues, and on demand for a worker or evaluator. */
export declare const RESEARCH_COST_ROLES: Set<string>;
/** Today's research use for an instance, from its events (by type name; older logs simply have none). */
export declare function researchUsageToday(events: {
    type: string;
    ts: string;
    payload: unknown;
}[], day: string): ResearchUsage;
/** Why no new research run may start today, or null. */
export declare function researchCapHold(usage: ResearchUsage, caps: ResearchCaps): string | null;
/**
 * Reads a researcher run's stream-json lines: every WebSearch query and WebFetch URL (with a refusal, when the
 * hook or the run's rules refused it), and whether the day's caps are now reached, so the run can be stopped.
 * Counting is by tool call, from the run's own output: what a fetched page says can't change the count.
 */
export declare class ResearchMeter {
    private before;
    private caps;
    private blocklist;
    private calls;
    readonly steps: ResearchStep[];
    constructor(before: ResearchUsage, caps: ResearchCaps, blocklist?: string[]);
    /** Feed one stream-json line; returns the steps it completed and, once a cap is reached, why the run must stop. */
    line(j: unknown): {
        steps: ResearchStep[];
        stop: string | null;
    };
    /** Today's use including this run so far. */
    usage(): ResearchUsage;
}
export interface ResearchResult {
    report: string;
    sources: {
        url: string;
        title: string;
    }[];
}
/**
 * The only output a researcher run is taken for: its report and sources. Anything else it returned (an ask, a
 * decision, a config change, a review level, a block) is dropped and named, never acted on. A report with no
 * sources, a source that isn't an http(s) URL, or a source the report doesn't link is refused.
 */
export declare function acceptResearch(structured: unknown): {
    ok: true;
    result: ResearchResult;
    ignored: string[];
} | {
    ok: false;
    why: string;
    ignored: string[];
};
/** The report as an issue comment, with every source as a link and every fetch the run made. */
export declare function researchComment(r: ResearchResult, steps?: ResearchStep[]): string;
/** The report as docs/research/<slug>.md, for a PR through the normal path. */
export declare function researchDoc(issue: {
    number: number;
    title: string;
}, r: ResearchResult): {
    path: string;
    text: string;
};
/** A run's searches and fetches (refusals included), from the events, for its run page. */
export declare function researchForRun(events: {
    type: string;
    payload: unknown;
}[], run: string): {
    searches: string[];
    fetches: {
        url: string;
        host: string;
        refused: string | null;
    }[];
};
