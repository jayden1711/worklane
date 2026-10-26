### Guardrail changes: what each one does

- **The adversarial suite holds the default branch's tip lint cases and the stop at the merge call (#1020).** What the gate merges is unchanged; the suite now fails if it stops holding any of these:
  - a lint test marked as one on the default branch after the PR's base, loosened by the PR;
  - a table the default branch re-marks from never-grow to never-shrink, shrunk by the PR (a PR that only adds a line beside it still merges);
  - a second table the default branch marks in a file whose base marks another, shrunk by the PR;
  - a table outside the engine's own source marked on the default branch, shrunk by the PR, in the engine's repo and in a managed app's;
  - a lint test only the default branch has, which the PR merges in and loosens, also one outside the engine's own source, in the engine's repo and in a managed app's;
  - a check table's mark from the default branch, on a table the PR's base has, which the PR merges in and then takes out or changes the kind of, while still changing the file;
  - a lint test's mark from the default branch, on a test the PR's base has, which the PR merges in and then takes out or changes the text of while still changing the file, or moves to another path without the mark;
  - a marked table only the default branch has, which the PR merges in and then shrinks, grows (an allowlist), takes the mark off, or takes out of the file, keeping the file at the same path;
  - an auto-merge stop raised after the merge decision, right before the merge call.
  - The default branch's new commits now come from another clone of the remote, so these cases also fail if the decision's own fetch of the tip (`defaultTipNow`) stops. The fetch a watch pass makes for its decisions is held by unit tests, not by these cases.
  - What the default branch changed that a PR which merged it in undoes was still open here; #1069 closes it in this release, and #1074 adds its cases.
