### Guardrail changes: what each one does

- **`npm run setup:hooks` installs into its own repository's hooks only from a checkout at origin's default branch
  (#1283).** Every worktree of a repository shares one hooks dir, so a branch's copy installed there runs for every
  worktree and every push. Into its own repository (the same `git rev-parse --git-common-dir`), it now refuses unless
  the checkout's HEAD is the fetched `origin/<default>` commit and the files it copies (`scripts/setup-hooks.mjs`,
  `scripts/push-gate-hook.mjs`, `scripts/lib/git.cjs`) are unedited, and it refuses when there is no fetched
  `origin/<default>` to compare with. A refusal changes nothing and prints what it would have installed, where, and
  why. A worktree detached at `origin/<default>` installs. Installing into another repository (a scratch or test
  repo, which has hooks of its own) is not limited.
