### Upgrading (from v0.5.2)

- **A project command can no longer write the agent user's home (#798).** Checks, worktree setup, full runs, suite tuning, a browser flow's app and auto-config run as the agent user in a sandbox, and the agent's home is now read-only there. Before, a command could plant `~/.bashrc`, `~/.profile`, `~/.gitconfig`, `~/.npmrc`, `~/.ssh/config` or a `~/.local/bin` entry for a later agent-user process outside the sandbox to run. What changes for a project:
  - On Linux, `~/.cache` and `~/.npm` are writable but start empty for every command and are thrown away after it. Each command downloads its dependencies again.
  - A write anywhere else in the home fails with "Read-only file system". That includes Go's `~/go`, `~/.cargo`, `~/.m2`, `~/.gradle`, `pip install --user` and pnpm's store. Point such a cache outside the home in `tests.yaml` (for example `GOMODCACHE=/tmp/gomod`).
  - Browsers installed in the agent's `~/.cache/ms-playwright` are hidden inside the sandbox. Set `PLAYWRIGHT_BROWSERS_PATH` to a directory outside the home.
  - On macOS nothing in the home is writable, `~/.npm` included.
  - An agent home that isn't a directory, or is `/`, is refused: set `run_as.agent_home` in `instance.yaml` to the agent user's real home.
  - On Linux, a symlink directly in the agent's home, or directly in its `~/.config`, is checked hop by hop before the command runs. A project command is refused, before it runs, in three cases. The refusal names each link, the path that makes it unsafe, and the command that removes it as the agent user.
    - Any hop outside the home is something the agent user owns or can write: a directory on the way, another link, or the file it ends at. Two examples are `~/.ssh` pointing to an agent-owned `/srv/x`, and `~/.profile` pointing to `/srv/x/hop/profile` where `/srv/x/hop` is the agent's link back into the home.
    - `~/.cache` or `~/.npm` is a symlink at all.
    - Either directory holds more than 500 symlinks.
  - A symlink whose every hop only root can change is allowed, and what it reaches is read-only inside the sandbox. Examples are a skeleton's `~/.ghcup -> /usr/local/.ghcup` and `~/.bash_history -> /dev/null`.
  - A link that stays inside the home all the way is fine too.
  - A link that reaches `/`, or a directory that holds the command's working directory, is refused: it can't be made read-only without taking the command's own directory with it.
- **`harness-config` always waits for you (#798).** Changes to the config folder (`tests.yaml` among them), `.claude/` and `CLAUDE.md` are L3 and never merge on their own, whatever a repo's `review.yaml` says. In a repo whose `review.yaml` left `harness-config` out of `L3_human`, such a change now asks you before its PR opens, as every L3 change does. A repo can still add its own paths to the category.

### After install

- **Optional, once, as root:** look for hard links into each agent user's home that a project command could have made before this release. Such a link would still let a later command write the file it points to: `find <agent home> -xdev -type f -links +1 -not -path '*/.cache/*' -not -path '*/.npm/*'`. Remove each one you didn't make. pnpm's store keeps legitimate hard links under `~/.local/share/pnpm`.
- **Optional, once, as root:** look for symlinks deeper in each agent user's home that leave it through a path the agent user can change. The sandbox checks only the links directly in the home and in `~/.config`. One deeper down, such as `~/.ssh/config` pointing to `/tmp/x`, is followed wherever it leads.
  1. List the links: `find <agent home> -xdev -type l`.
  2. For each one, show every hop on its way with its owner and mode: `namei -l <link>`, from util-linux.
  3. The link is unsafe if any entry `namei` lists outside the home is owned by the agent user, or is writable by it through its group or by everyone. That covers a directory, another link, and the file it ends at.

  Remove each unsafe link that you didn't make. (`readlink -m` alone isn't enough: a link can resolve inside the home through a hop outside it that the agent can re-aim.)

### Guardrail changes: what each one does

- **Agent home read-only to project commands (#798).** The project-command sandbox (`projectCommand`, `src/os/index.ts`) binds the agent user's home read-only, under the credential masks. On Linux, `~/.cache` and `~/.npm` are throwaway tmpfs mounts. On macOS, the profile denies every write under the home, but a link leading out of it is followed (macOS isn't in CI). On Linux, each symlink directly in the home or in `~/.config` is walked hop by hop, by the same rule as the credential paths. A run is refused when any hop outside the home is the agent user's to change, or when a cache is a link. A link whose every hop only root can change is allowed, and its target is bound read-only. Nothing a project command writes in the home outlives it. The one exception is a link deeper in the home whose way out the agent user can change (After install).
- **harness-config locked (#798).** `src/review.ts` lists `harness-config` in `LOCKED_CATEGORIES` and `ALWAYS_L3`: it is always L3 and always waits. Its built-in globs always hold, and a repo's `review.yaml` may only add to them.
- **credentials.sh** checks an agent's API-key sign-in with `sudo -H -u <agent>`, never a login shell (#798).
