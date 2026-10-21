### Guardrail changes: what each one does

- **A check registers itself where it is declared (#869).** A check table registers by a `// check-table: never-grow`
  or `// check-table: never-shrink` line right before its declaration, and a lint test by a `// lint-test` line, so
  adding a check no longer needs an edit to the locked `src/merge-policy-weakening.ts`. The merge decision reads the
  marks from the default branch's text: a change that removes, changes or detaches one while its table or lint test
  is still there waits for the owner (`removes or changes the mark that registers a check`), and a marked table
  deleted or renamed waits as before. A table's name sets a floor its mark can only add to: an allowlist's name
  (`ALLOW`, `EXEMPT`, `SKIP`, `GOOD`, ...) is held on growth, a rule list's or guard list's name (`BAD`, `RULES`,
  `WORDS`, `DENY`, `GUARD`, ...) on shrinking. Every check registered before keeps its kind; only `package.json`'s
  `scripts` stays in the central list.
