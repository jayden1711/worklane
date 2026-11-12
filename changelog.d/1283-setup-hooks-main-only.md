### Guardrail changes: what each one does

- **`npm run setup:hooks` installs into a repository's shared hooks only origin's default branch's files (#1283).**
  Every worktree of a repository shares one hooks dir, so a branch's copy installed there runs for every worktree and
  every push. In a repository that holds the gate anywhere (its HEAD, a branch or a remote-tracking ref), every file
  it would copy (`scripts/setup-hooks.mjs`, `scripts/push-gate-hook.mjs`, `scripts/lib/git.cjs`) must be origin's
  default branch's, byte for byte (`git hash-object --no-filters` against that commit's tree), wherever the installer
  runs from: a branch's worktree, another clone or a copy outside git. Origin's default is `origin/HEAD`'s branch
  when it resolves and holds the gate, else `origin/main`, and in a bare clone the same names under `refs/heads`.
  It fails closed: when none of those holds the gate (no remote named `origin`, a dangling or gate-less
  `origin/HEAD`, a bare clone without them), it refuses. A refusal changes nothing and prints what it would have
  installed, where, and why. A checkout or worktree at origin's default installs, and so does a branch whose copied
  files are unchanged. Only a repository with no gate anywhere (a scratch or test repo) is not limited.
