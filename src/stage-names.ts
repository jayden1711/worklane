// The failed-run stages' names (src/stage-label.ts labels runs with them; src/events/types.ts validates events by them).
// WHY its own module (#785): src/events/types.ts took them from src/stage-label.ts, which imports src/runner.ts, so
// the agents' tool guard's import tree reached the runner and some 15 modules behind it. Keep this module a leaf.

/** In pipeline order: the plan, the build, its checks, the evaluator's review; the harness last. */
export const STAGES = ['plan', 'wrong files', 'right files, wrong place', 'wrong or incomplete change', 'verification', 'review', 'environment/harness'] as const;
export type Stage = (typeof STAGES)[number];
