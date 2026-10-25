### Guardrail changes: what each one does

- **The adversarial suite drives more of the inputs the coordinator's merge decision assembles itself (#1019).** What the gate merges is unchanged. These cases are decided by the coordinator's own `mergeDecisionFor`, and the suite now fails if it stops holding any of them:
  - a planned task's unplanned auth file, in a repo that puts auth at L2, when the plan lists no files, when only another task's later plan lists the file, and when the plan names it by file name only or by a glob;
  - an issue labelled `money-path`, with the label read from the event log;
  - a file the money-path list on the default branch names, including a list moved on the default branch since the PR's base;
  - a new top-level module;
  - a change over the line limit, counted by the decision itself, whether by added or deleted lines;
  - a PR whose only verdict on its head is another task's PASS.
  - Still not driven by these cases: labels changed after they were first seen, a money-path list selected by a pattern, and the file-count limit (unit tests hold the last).
