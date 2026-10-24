### Guardrail changes: what each one does

- **The adversarial suite holds the default branch's tip lint cases and the stop at the merge call (#1020).** What the gate merges is unchanged; the suite now fails if it stops holding any of these:
  - a lint test marked as one on the default branch after the PR's base, loosened by the PR;
  - a lint test only the default branch has, which the PR merges in and loosens;
  - a check table's mark from the default branch, which the PR merges in and takes out;
  - an auto-merge stop raised after the merge decision, right before the merge call.
  - The default branch's new commits now come from another clone of the remote, so these cases also fail if the decision stops fetching the tip.
