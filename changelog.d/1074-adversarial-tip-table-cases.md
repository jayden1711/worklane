### Guardrail changes: what each one does

- **The adversarial suite holds what #1069 fixed, and the default branch's tip tables read against a PR's own change (#1074).** What the gate merges is unchanged. These cases are decided by the coordinator's own `mergeDecisionFor`, and the suite now fails if it stops holding any of them:
  - after a PR's branch merged in the default branch, what the default branch added and the PR takes out: a mark (also with the file written back to its base text), a table entry or lint rule, an assertion, a file only the default branch has (deleted, or a lint test moved without its mark);
  - after the same merge-in, what the default branch took out and the PR puts back: an allowlist entry, a skip marker, a line of an ignore file;
  - a PR that never merged the default branch in, whose change git carries onto a table or lint test the default branch renamed or moved and marked;
  - a table marked on the default branch, which the PR empties with a line outside its list, hides from the line reader, or (a rules-named table marked never-grow) shrinks, also when the PR's merge into the default branch conflicts.
  - The #1069 todo lines are gone: each is a case now. The `.gitleaksignore` form is held by a unit test instead, because the suite's injected comment line changes that locked file.
