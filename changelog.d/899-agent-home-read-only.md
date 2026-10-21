### Upgrading (from v0.5.2)

- **A project command can no longer write the agent user's home (#798).** Checks, worktree setup, full runs, suite tuning, a browser flow's app and auto-config run as the agent user in a sandbox, and the agent's home is now read-only there. Before, a command could plant `~/.bashrc`, `~/.profile`, `~/.gitconfig`, `~/.npmrc`, `~/.ssh/config` or a `~/.local/bin` entry for a later agent-user process outside the sandbox to run. What changes for a project:
  - On Linux, `~/.cache` and `~/.npm` are writable but start empty for every command and are thrown away after it. Each command downloads its dependencies again.
  - A write anywhere else in the home fails with "Read-only file system". That includes Go's `~/go`, `~/.cargo`, `~/.m2`, `~/.gradle`, `pip install --user` and pnpm's store. Point such a cache outside the home in `tests.yaml` (for example `GOMODCACHE=/tmp/gomod`).
  - Browsers installed in the agent's `~/.cache/ms-playwright` are hidden inside the sandbox. Set `PLAYWRIGHT_BROWSERS_PATH` to a directory outside the home.
  - On macOS nothing in the home is writable, `~/.npm` included.
  - An agent home that isn't a directory, or is `/`, is refused: set `run_as.agent_home` in `instance.yaml` to the agent user's real home.
- **`harness-config` always waits for you (#798).** Changes to the config folder (`tests.yaml` among them), `.claude/` and `CLAUDE.md` are L3 and never merge on their own, whatever a repo's `review.yaml` says. In a repo whose `review.yaml` left `harness-config` out of `L3_human`, such a change now asks you before its PR opens, as every L3 change does. A repo can still add its own paths to the category.

### After install

- **Optional, once, as root:** look for hard links into each agent user's home that a project command could have made before this release. Such a link would still let a later command write the file it points to: `find <agent home> -xdev -type f -links +1 -not -path '*/.cache/*' -not -path '*/.npm/*'`. Remove each one you didn't make. pnpm's store keeps legitimate hard links under `~/.local/share/pnpm`.

### Guardrail changes: what each one does

- **Agent home read-only to project commands (#798).** The project-command sandbox (`projectCommand`, `src/os/index.ts`) binds the agent user's home read-only, under the credential masks. On Linux, `~/.cache` and `~/.npm` are throwaway tmpfs mounts. On macOS, the profile denies every write under the home. Nothing a project command writes in the home outlives it.
- **harness-config locked (#798).** `src/review.ts` lists `harness-config` in `LOCKED_CATEGORIES` and `ALWAYS_L3`: it is always L3 and always waits. Its built-in globs always hold, and a repo's `review.yaml` may only add to them.
- **credentials.sh** checks an agent's API-key sign-in with `sudo -H -u <agent>`, never a login shell (#798).
