### Upgrading (from v0.5.2)

- A sandboxed agent command that reads a file in the project's `secret_paths` (for example tests loading `.env` through dotenv) now reads nothing: the sandbox hides it. Before, only a command naming the file was refused, by the guard hook.
- A guarded agent run whose task file or project guardrails can't be read, or whose `secret_paths` hold a path the sandbox can't take as written (`[` or `]`, or a glob starting with a wildcard), no longer starts; the run's detail says why. Before, it started and the hook refused its calls.

### Guardrail changes: what each one does

- A task's hidden paths and the project's `secret_paths` are denied by the OS sandbox (`sandbox.filesystem.denyRead`) and by `Read(...)` deny rules in every guarded agent run's settings, not only by the guard hook (#890). They are resolved under every checkout of the run's repository, and `~/` under the run's home. A glob an exception overlaps (`!./.env.example`) is passed as what it matches when the run starts, so the exception stays readable. With the sandbox off, the Read rules still apply.
- A run whose task hides paths (an experiment's) is also denied the repository's git object stores (`objects`, alternates, `lfs`), so `git show <rev>:<hidden path>` can't read a hidden file that was deleted from the worktree.
