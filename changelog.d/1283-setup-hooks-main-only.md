### Guardrail changes: what each one does

- **`npm run setup:hooks` installs into a repository's shared hooks only origin's default branch's files (#1283).**
  Every worktree of a repository shares one hooks dir, so a branch's copy installed there runs for every worktree and
  every push. In the repository it installs into, when `origin/<default>` as last fetched (`refs/remotes/origin/HEAD`,
  else `main`) holds the gate, every file it would copy (`scripts/setup-hooks.mjs`, `scripts/push-gate-hook.mjs`,
  `scripts/lib/git.cjs`) must be that commit's, byte for byte (`git hash-object --no-filters`), wherever the
  installer runs from: a branch's worktree, another clone or a copy outside git. Otherwise it refuses before changing
  anything and prints what it would have installed, where, and why. A checkout or worktree at `origin/<default>`
  installs, and so does a branch whose copied files are unchanged. A repository without the gate on its default
  branch (a scratch or test repo) is not limited.
