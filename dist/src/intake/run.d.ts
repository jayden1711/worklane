import type { Candidate } from './dedupe.js';
export declare const INTAKE_ROLE = "intake";
export declare const INTAKE_TOOLS: readonly ["Read", "Glob", "Grep"];
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export declare const INTAKE_DENIED: readonly ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task", "WebSearch", "WebFetch", "mcp__*"];
/** The intake agent's instructions: kept with the other roles (src/roles.ts), where the instruction evals reach them. */
export declare const INTAKE_PROMPT: string;
/**
 * The per-report bundle: what the intake agent may read. `name`: the bundle's name (default `intake-<id>`);
 * `decisions`: the decisions already made, for a conversation (decisions.md).
 */
export declare function writeIntakeBundle(o: {
    instanceRoot: string;
    gid: number;
    id: string;
    redacted: string;
    source: string;
    candidates: Candidate[];
    recent: {
        id: string;
        text: string;
    }[];
    name?: string;
    decisions?: string;
}): string;
/**
 * The fixed parts of an intake run request. Without repo access it works in its bundle (research lane); with it, in
 * the checkout `repo` (research-repo lane, under the project's own hook), reading the bundle by its path.
 */
export declare function intakeRun(o: {
    bundleDir: string;
    repoAccess: boolean;
    repo: string;
    conversation?: boolean;
}): {
    role: string;
    lane: string;
    cwd: string;
    allowedTools: ("Read" | "Grep" | "Glob")[];
    disallowedTools: ("Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "Bash" | "WebFetch" | "WebSearch" | "Task" | "mcp__*")[];
    appendSystemPrompt: string;
    prompt: string;
    jsonSchema: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["kind"];
        readonly properties: {
            readonly kind: {
                readonly type: "string";
                readonly enum: readonly ["bug", "feature", "question", "duplicate", "not_actionable", "needs_info"];
            };
            readonly duplicate_of: {
                readonly type: "integer";
                readonly minimum: 1;
                readonly description: "An open issue this report is the same bug or request as.";
            };
            readonly group_with: {
                readonly type: "string";
                readonly description: "A recent report id this belongs with, when no issue exists yet.";
            };
            readonly reproduction: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["result", "detail"];
                readonly properties: {
                    readonly result: {
                        readonly type: "string";
                        readonly enum: readonly ["reproduced", "not_reproduced", "fixed_on_main", "not_tried"];
                    };
                    readonly detail: {
                        readonly type: "string";
                    };
                    readonly commit: {
                        readonly type: "string";
                    };
                };
            };
            readonly draft: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["title", "body"];
                readonly properties: {
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly body: {
                        readonly type: "string";
                        readonly description: "Markdown in five parts, each starting a line with its bold label: **Outcome:** one sentence. **Sources:** where to look, nowhere else. **Constraints:** what to leave alone. **Deliverable:** a closed ```done_when block, commands as YAML block scalars (\"- command: |\"). **Review point:** the expected review level (L0 to L3) and what would make it wait for the owner.";
                    };
                };
            };
            readonly reply: {
                readonly type: "string";
                readonly description: "What to ask the reporter, for needs_info or not_actionable. Short and polite; no internal details.";
            };
        };
    };
};
