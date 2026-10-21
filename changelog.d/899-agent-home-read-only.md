### Upgrading (from v0.5.2)

- **A project command can no longer write the agent user's home directly (#798).** Checks, worktree setup, full runs, suite tuning, a browser flow's app and auto-config run as the agent user in a sandbox, and the agent's home is now read-only there. Some ways around that remain: `docs/auth.md` lists them all, under "What the read-only home does not stop". Before, a command could plant `~/.bashrc`, `~/.profile`, `~/.gitconfig`, `~/.npmrc`, `~/.ssh/config` or a `~/.local/bin` entry for a later agent-user process outside the sandbox to run. What changes for a project:
  - On Linux, `~/.cache` and `~/.npm` are writable but start empty for every command and are thrown away after it. Each command downloads its dependencies again.
  - A write anywhere else in the home fails with "Read-only file system", apart from the masked `~/.claude*` directories and any directory `credentials.yaml` hides under the home, which are empty throwaway tmpfs mounts too. That includes Go's `~/go`, `~/.cargo`, `~/.m2`, `~/.gradle`, `pip install --user` and pnpm's store. Point such a cache outside the home in `tests.yaml` (for example `GOMODCACHE=/tmp/gomod`).
  - Browsers installed in the agent's `~/.cache/ms-playwright` are hidden inside the sandbox. Set `PLAYWRIGHT_BROWSERS_PATH` to a directory outside the home.
  - On macOS nothing in the home is writable, `~/.npm` included. The home must be configured at its canonical path: one reached through a symlink (`/var/...` is `/private/var/...` there), or one that can't be resolved, is refused, because macOS's sandbox matches canonical paths and would protect nothing there. Set `run_as.agent_home` to the path the refusal names.
  - An agent home that isn't a directory, or is `/`, is refused: set `run_as.agent_home` in `instance.yaml` to the agent user's real home.
  - On Linux, a symlink directly in the agent's home, or directly in its `~/.config` (wherever that leads), is checked hop by hop before the command runs. A project command is refused, before it runs, in these cases. The refusal names each link, the path that makes it unsafe, and the command that removes it as the agent user.
    - A hop outside the home could be re-aimed: a link sitting in a directory the agent user can write. An example is `~/.profile` pointing to `/srv/x/hop/profile`, where `/srv/x/hop` is a link back into the home in a directory the agent can write.
    - A hop outside the home is the agent user's own: a directory on the way, or the file the link ends at. An example is `~/.ssh` pointing to an agent-owned `/srv/x`.
    - A dangling link passes, outside the home, through a directory the agent can write.
    - A link ends at a device in a directory the agent user can write (under `/dev`: in or below one). Nothing can keep a device in place there, so a command could replace it with a file.
    - A link's way enters `/proc` or `/sys`, such as `~/.x -> /proc/1/comm` or `~/.x -> /dev/stdout`. Pinning that way would bind the host's `/proc` over the sandbox's own and show the command every process outside it.
    - A link reaches under `/dev` anything but a device, or a device through a symlink, a `..` or a directory the agent user can write there. Pinning any of those would bind `/dev` and leave the command without working devices, so the run is refused instead, naming the link.
    - `~/.cache` or `~/.npm` is a symlink at all.
    - Either directory holds more than 500 symlinks.
  - Any other link out of the home is allowed. Examples are a skeleton's `~/.ghcup -> /usr/local/.ghcup` (writable by everyone on a CI runner) and `~/.bash_history -> /dev/null`.
    - Inside this agent's sandbox, what the link reaches is read-only.
    - Every directory on its way is pinned there, so none can be renamed away and recreated. That includes the way to a device it ends at, except under `/dev`, where binding would cost the sandbox its devices. There, a device in or below a directory the agent user can write is refused instead, so nothing depends on those directories being sticky.
    - The home's own way is always pinned too, so a directory above the home can't be renamed away and the home's path recreated.
    - That holds only in this agent user's sandboxes. If a directory the link reaches can be written by other users, they still can write it. That includes another instance's agent user, through its own project commands. On such a machine, give the agent user a skeleton without that link.
  - A link that stays inside the home all the way is fine too.
  - A link that reaches `/`, or a directory that holds the command's working directory, is refused: it can't be made read-only without taking the command's own directory with it.
- **`harness-config` always waits for you (#798).** Changes to the config folder (`tests.yaml` among them), `.claude/` and `CLAUDE.md` are L3 and never merge on their own, whatever a repo's `review.yaml` says. In a repo whose `review.yaml` left `harness-config` out of `L3_human`, such a change now asks you before its PR opens, as every L3 change does. A repo can still add its own paths to the category.

### After install

- **Optional, once, as root:** look for hard links into each agent user's home made outside the sandbox, before this release (by a project command, back when it could) or since (pnpm's store makes them). Each one still lets a project command write the file it points to, from wherever the other name is: `find <agent home> -xdev -type f -links +1`. That includes `~/.cache` and `~/.npm`: the sandbox's throwaway mounts hide the real ones only by path, so a hard link into them is a write route too, into the code unsandboxed processes run from there. pnpm's store under `~/.local/share/pnpm` and uv's cache under `~/.cache/uv` keep hard links on purpose, but each is a write route into the home all the same: keep it only if you need it, and don't keep it unchecked. This check doesn't find a hard link to a file outside the home that an allowed link reaches.
- **Optional, once, as root:** look for symlinks deeper in each agent user's home that leave it through a path the agent user can change. The sandbox checks only the links directly in the home and in `~/.config`. One deeper down, such as `~/.ssh/config` pointing to `/tmp/x`, is followed wherever it leads.
  1. List the links: `find <agent home> -xdev -type l`.
  2. For each one, show every hop on its way with its owner and mode: `namei -l <link>`, from util-linux.
  3. The link is unsafe if any entry `namei` lists outside the home is owned by the agent user, or is writable by it through its group or by everyone. That covers a directory, another link, and the file it ends at.

  Remove each unsafe link that you didn't make. (`readlink -m` alone isn't enough: a link can resolve inside the home through a hop outside it that the agent can re-aim.)

### Guardrail changes: what each one does

- **Agent home read-only to project commands (#798).** The project-command sandbox (`projectCommand`, `src/os/index.ts`) binds the agent user's home read-only, under the credential masks. On Linux, `~/.cache` and `~/.npm` are throwaway tmpfs mounts. On macOS, the profile denies every write under the home, but a link leading out of it is followed (macOS isn't in CI); a home that isn't its own canonical path, or can't be resolved, is refused (`seatbeltProfileFor`), since the profile's rules match canonical paths only. On Linux, each symlink directly in the home or in `~/.config` is walked hop by hop, by the same rule as the credential paths. A run is refused in seven cases:
  - a hop outside the home could be re-aimed (a link in a directory the agent can write);
  - a hop is the agent's own;
  - a dangling link passes through a directory the agent can write;
  - a link ends at a device in a directory the agent can write (under `/dev`: in or below one);
  - a link's way enters `/proc` or `/sys` (its pins would bind the host's `/proc` over the sandbox's own);
  - a link reaches under `/dev` anything but a device, or a device through a symlink, a `..` or a writable directory there (its pins would bind `/dev`);
  - a cache is a link.

  A link to `/` or to the command's working directory is refused too, as are more than 500 links in one directory, a way of more than 40 links and a way through a directory the agent user can't search. Any other link is allowed. Every directory above what it reaches is pinned, and the target itself is bound read-only. A device target isn't bound (writing it plants nothing). It is refused when the agent can write its directory (under `/dev`, any directory between `/dev` and it); otherwise the directories above it are pinned, except under `/dev`. The home itself and every directory above it are always pinned.

  A project command can't write the home directly, nor anything an allowed link in it reaches. The ways around that are listed in full in `docs/auth.md`, under "What the read-only home does not stop". Among them:
  - a link deeper in the home, or inside what an allowed link reaches, that leads somewhere writable (After install);
  - a hard link made outside the sandbox to a home file (`~/.cache` and `~/.npm` included), or to a file an allowed link reaches: a command writes the file through its other name (After install covers the home's);
  - a FIFO or socket in the home, or a socket outside it: what a command writes reaches a live agent-user process outside the sandbox (#933);
  - on macOS, links: the profile walks none, so a link leading out of the home is followed and written through.

  A link to a directory above the home (`~/.x -> ..`) is bound read-only over the home's own mounts, so for that layout `~/.cache` and `~/.npm` are read-only too.
- **harness-config locked (#798).** `src/review.ts` lists `harness-config` in `LOCKED_CATEGORIES` and `ALWAYS_L3`: it is always L3 and always waits. Its built-in globs always hold, and a repo's `review.yaml` may only add to them.
- **credentials.sh** checks an agent's API-key sign-in with `sudo -H -u <agent>`, never a login shell (#798).
