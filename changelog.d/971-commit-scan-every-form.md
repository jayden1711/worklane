### Upgrading (from v0.5.2)

- An agent's shell command that commits is now let through only when the commit secret scan can model it. A line it can't model is refused with the reason and a way to commit instead: stage in one call, then run a plain `git commit` in a call of its own.

### Guardrail changes: what each one does

- **The commit secret scan covers every commit form and checkout the guard allows (#971).**
  - Before an agent's command commits, the guard scans what that commit will record, in the checkout it lands in, across the whole checkout.
  - A command line whose commit it can't model is refused, never scanned narrowly. A scanner that can't run still refuses the commit.
  - People's own sessions are unchanged: they opt in to commit scanning with the git pre-commit hook.
