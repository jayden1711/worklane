# Shadow runs

Before a new engine is trusted with real work, it runs the same tasks as the current one in shadow, with no side
effects, and you compare what the two decided. Code: `src/shadow.ts`, `src/harness-evals/replay.ts`. Tests:
`test/shadow.test.ts`, `test/harness-evals.test.ts` ("shadow runs: …").

## No side effects

A shadow run is a harness-eval replay (`harness-eval run`). Each task goes through the **real coordinator**, with
real agents, in a scratch instance:

- its own event log, a file backlog, and its own state and slots;
- a scratch clone of the task's base commit, pushed only to a **local bare remote** in the scratch directory.

Nothing reaches GitHub: no branch is pushed to the real repository, no PR is opened or merged, and no issue or comment
is written. The scratch clone is deleted when the replay ends. The test checks that the task's source repository got
nothing.

## Run one

1. **The current engine:**
   `worklane harness-eval run --spend <usd> --keep-logs <dir>/current`
2. **The candidate engine**, an install or checkout of the new version, on the same tasks:
   `<candidate>/worklane harness-eval run --spend <usd> --keep-logs <dir>/candidate`. Pass the same `--task` and
   `--samples` options to both runs.
3. **Compare:**
   `worklane shadow diff --current <dir>/current --candidate <dir>/candidate`

`--keep-logs` keeps each replay's event log as `<task>-<sample>.db`, so the two runs' logs pair up. A held-out task is
kept under a hash of its id, never the id itself. The directory must be empty, so a log from an earlier run is never
compared as this one's. Both runs spend real money, within `--spend` (the spend gate, `src/spend-gate.ts`).

## What is compared

Each log's **decision trace**: what the coordinator decided, in order.

- **The issue:** a claim, a question to the owner (and of which kind), the review level.
- **The evaluator's verdict:** patch correct, test correct, confidence.
- **The merge decision:** auto, or why it waits.
- **What followed:** an auto-merge stop, the land queued and its result, a block, a guardrail's deny or ask, how each
  agent run ended, and a machine fault.

Ids, times, hashes, paths in parentheses and numbers are taken out, so two runs that decided the same things read
the same.

`shadow diff` prints each log whose decisions differ, as a diff: `-` is only in the current run, `+` is only in the
candidate's. It also prints each log that only one side has, then a count.

- **Exit 0:** every log decided the same.
- **Exit 3:** some differ or are unmatched.
- **Exit 1:** a directory or log can't be read.
- **Exit 2:** a usage error.

It reads both directories read-only.

## Reading the result

A difference isn't a failure. Agents aren't deterministic, so run more `--samples` and look at what changes
consistently. A merge that now waits, or one that no longer does, is the kind of change to read before the candidate
goes live. Then roll a risky change out ring by ring behind a flag ([rollout.md](rollout.md)).

## What it can never do

- **It can't push, merge or post anywhere real.** Replays have a local remote and a file backlog only.
- **It can't name a held-out task:** not in a log's file name, and not in the diff's output.
- **It can't tell a better decision from a worse one.** It shows that they differ; the harness-eval scores
  (`harness_eval.run`) and a person judge which is better.
- **It can't cover what the replays don't exercise:** the dashboard, the updater, the main watch, or GitHub's own
  answers. The fixed tasks are a sample, not everything production sees.
