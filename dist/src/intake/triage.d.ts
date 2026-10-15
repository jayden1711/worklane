import { type TriageKind } from './report.js';
export declare const INTAKE_SCHEMA: {
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
export interface Triage {
    kind: TriageKind;
    duplicate_of?: number;
    group_with?: string;
    reproduction?: {
        result: 'reproduced' | 'not_reproduced' | 'fixed_on_main' | 'not_tried';
        detail: string;
        commit?: string;
    };
    draft?: {
        title: string;
        body: string;
    };
    reply?: string;
}
/** The agent's output as the pipeline takes it: only the known fields, each checked; everything else dropped and named. */
export declare function acceptTriage(raw: unknown): {
    ok: true;
    triage: Triage;
    dropped: string[];
} | {
    ok: false;
    why: string;
};
/** Is a draft fileable? The five parts, checked by the engine's contract parser (checkDraftedIssue). */
export declare function checkDraft(draft: {
    title: string;
    body: string;
}): {
    ok: true;
} | {
    ok: false;
    why: string;
};
