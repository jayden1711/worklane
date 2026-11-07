### Guardrail changes: what each one does

- **The adversarial suite holds six more merge-gate cases (#1018).** What the gate merges is unchanged; the suite now fails if it stops holding any of these:
  - the evaluator flags a design change and gives no reason;
  - a role prompt's eval loses a case while gaining another, so the score doesn't move, on its visible cases or its held-out ones;
  - app code with a `TRUNCATE`, `DROP COLUMN` or `DROP SCHEMA` line (deletes data).
