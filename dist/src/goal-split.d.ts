export declare const GOAL_LABEL = "type:goal";
/** WHY: a goal that was split is not split again; this label says so on the tracker. */
export declare const GOAL_SPLIT_LABEL = "goal:split";
export declare const MIN_CHILDREN = 2;
export declare const MAX_CHILDREN = 10;
export declare const GOAL_SPLIT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["summary", "children"];
    readonly properties: {
        readonly summary: {
            readonly type: "string";
            readonly description: "How the goal splits and why in that order, in 2-4 sentences.";
        };
        readonly not_splittable: {
            readonly type: "string";
            readonly description: "Set only if the goal is one task or cannot be split well: why. Leave children empty then.";
        };
        readonly children: {
            readonly type: "array";
            readonly description: "The child issues, 2 to 10, each one task a worker can finish and check on its own.";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["key", "title", "body", "done_when", "depends_on"];
                readonly properties: {
                    readonly key: {
                        readonly type: "string";
                        readonly description: "A short unique id for this child, used only in depends_on (e.g. \"schema\").";
                    };
                    readonly title: {
                        readonly type: "string";
                        readonly description: "The child issue title.";
                    };
                    readonly body: {
                        readonly type: "string";
                        readonly description: "What to build and why, for a worker who has not read the goal: the files or areas, and what is out of scope.";
                    };
                    readonly done_when: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "The checks that show this child is done, one per item, in done_when form: test: <path>, command: <cmd>, or manual: \"<what a person checks>\".";
                    };
                    readonly depends_on: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "Keys of the children that must be finished before this one can start. Empty when nothing orders it.";
                    };
                };
            };
        };
    };
};
export interface GoalChild {
    key: string;
    title: string;
    body: string;
    done_when: string[];
    depends_on: string[];
}
export type GoalSplit = {
    summary: string;
    children: GoalChild[];
} | {
    summary: string;
    notSplittable: string;
} | {
    invalid: string;
};
/** INVARIANT: the same block parseContract reads, so a child's contract is checked before it is filed. */
export declare const doneWhenBlock: (items: readonly string[]) => string;
/** INVARIANT: children come back in an order where each one's dependencies come before it. */
export declare function readGoalSplit(s: unknown): GoalSplit;
/** WHY: the body names the goal and its dependencies by number, so the dispatch loop reads the edges from the tracker. */
export declare function childBody(c: GoalChild, goal: number, deps: readonly number[]): string;
/** INVARIANT: a child counts as split by this instance only while its body is exactly what was filed. */
export declare const bodyHash: (body: string) => string;
/** WHY: the goal's owner sees each child and its order on the goal itself. */
export declare function splitComment(cli: string, summary: string, filed: {
    number: number;
    title: string;
    deps: number[];
}[]): string;
