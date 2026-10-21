### Upgrading (from v0.5.2)

- An agent's shell command that commits is now let through only when the commit secret scan can model it. A line it can't model is refused with the reason and a way to commit instead: stage in one call, then run a plain `git commit` in a call of its own.
- An agent's git command whose subcommand isn't a literal word, or whose words hold an unquoted expansion or pattern, is refused too: quote the expansion, or run the command with literal words.
- So is any agent command line that runs a program whose name is expanded, feeds a shell its script through a pipe or a here-document, gives a shell an expanded script, or has a program build a command from its input. Name programs literally, and run scripts from files.
- A commit that takes working-tree files git stores through a filter or an encoding attribute is refused: stage those files first, then commit what is staged.

### Guardrail changes: what each one does

- **The commit secret scan covers every commit form and checkout the guard allows (#971).**
  - Before an agent's command commits, the guard scans what that commit will record, in the checkout it lands in, across the whole checkout. It reads the content itself, not a diff git renders, so the checkout's settings for showing changes don't change what is scanned.
  - A command line whose commit it can't model is refused, never scanned narrowly. A scanner that can't run still refuses the commit.
  - People's own sessions are unchanged: they opt in to commit scanning with the git pre-commit hook.
