### Guardrail changes: what each one does

- **The adversarial suite holds the default branch's tip lint cases and the stop at the merge call (#1020).** What the gate merges is unchanged; the suite now fails if it stops holding any of these:
  - a lint test marked as one on the default branch after the PR's base, loosened by the PR;
  - a lint test only the default branch has, which the PR merges in and loosens;
  - a check table's or lint test's mark from the default branch, which the PR merges in and takes out while still changing the file (written back to its text at the base, the file isn't read, so it merges: #1069);
  - a marked table only the default branch has, which the PR merges in and takes out of the file;
  - an auto-merge stop raised after the merge decision, right before the merge call.
  - The default branch's new commits now come from another clone of the remote, so these cases also fail if the decision stops fetching the tip.
