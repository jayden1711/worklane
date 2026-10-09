// A task's contract: the done_when checks the coordinator runs itself before
// anything lands, and the task file handed to the agent's session (which the
// guardrails hook reads for frozen paths, such as a reproduction test).
import { z } from 'zod';

export const DoneWhen = z.array(
  z.union([
    z.strictObject({ command: z.string().min(1), timeout_s: z.number().int().positive().optional() }),
    z.strictObject({ test: z.string().min(1), timeout_s: z.number().int().positive().optional() }),
    // The project's own suite, judged by the baseline gate: no new failures vs main.
    z.strictObject({ suite: z.enum(['changed', 'full']), timeout_s: z.number().int().positive().optional() }),
    z.strictObject({ manual: z.string().min(1) }),
    z.strictObject({ repro: z.boolean() }),
  ]),
);

export const TaskFile = z.strictObject({
  id: z.string().min(1),
  done_when: DoneWhen.min(1),
  /** Repo-relative files the agent must not change (e.g. a frozen reproduction test). */
  frozen: z.array(z.string()).default([]),
});
export type TaskFile = z.infer<typeof TaskFile>;
