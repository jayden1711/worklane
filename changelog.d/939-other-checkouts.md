### Guardrail changes: what each one does

- **The tool guard holds an agent run's relative secret and hidden patterns in the repository's other checkouts too
  (#939):** the main checkout, each linked worktree git lists, and each directory in a place task worktrees are made
  (the project's `tests.worktree.root`, the engine's own worktree directory and `.claude/worktrees`; in a place that
  holds the main checkout, only the engine's own worktrees). They are found again on every call, so a worktree made
  after the run started counts. Each pattern's exceptions apply relative to that checkout's own root: with
  `./.env.*` and `!./.env.example`, another checkout's `.env.local` is refused to Read, to a path a shell command
  names and to a Glob or Grep over it, and its `.env.example` stays readable. What a shell command reaches
  indirectly still rests on the sandbox. Human sessions are unchanged.
