### Guardrail changes: what each one does

- **The adversarial suite holds the default branch's tip lint cases and the stop at the merge call (#1020).** What the gate merges is unchanged; the suite now fails if it stops holding any of these:
  - a lint test marked as one on the default branch after the PR's base, loosened by the PR;
  - a lint test only the default branch has, which the PR merges in and loosens;
  - a check table's or lint test's mark from the default branch, which the PR merges in and then takes out or changes the kind of, while still changing the file;
  - a marked table only the default branch has, which the PR merges in and then shrinks or takes out of the file, keeping the file at the same path;
  - an auto-merge stop raised after the merge decision, right before the merge call.
  - The default branch's new commits now come from another clone of the remote, so these cases also fail if the decision's own fetch of the tip (`defaultTipNow`) stops. The fetch a watch pass makes for its decisions is held by unit tests, not by these cases.
  - Still open (#1069): a PR that merges in such a mark and leaves no change to its file merges, and takes the mark off the default branch. That covers a file written back to its text at the base, and a file only the default branch has that the PR deletes or moves to another path.
