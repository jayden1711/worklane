### Upgrading (from v0.5.2)

- **A project command can no longer write the agent user's home directly (#798).** Checks, worktree setup, full runs, suite tuning, a browser flow's app and auto-config run as the agent user in a sandbox, and the agent's home is now read-only there. Some ways around that remain; Guardrail changes lists them all. Before, a command could plant `~/.bashrc`, `~/.profile`, `~/.gitconfig`, `~/.npmrc`, `~/.ssh/config` or a `~/.local/bin` entry for a later agent-user process outside the sandbox to run. What changes for a project:
  - On Linux, `~/.cache` and `~/.npm` are writable but start empty for every command and are thrown away after it. Each command downloads its dependencies again.
  - A write anywhere else in the home fails with "Read-only file system". That includes Go's `~/go`, `~/.cargo`, `~/.m2`, `~/.gradle`, `pip install --user` and pnpm's store. Point such a cache outside the home in `tests.yaml` (for example `GOMODCACHE=/tmp/gomod`).
  - Browsers installed in the agent's `~/.cache/ms-playwright` are hidden inside the sandbox. Set `PLAYWRIGHT_BROWSERS_PATH` to a directory outside the home.
  - On macOS nothing in the home is writable, `~/.npm` included.
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

- **Optional, once, as root:** look for hard links into each agent user's home made outside the sandbox, before this release (by a project command, back when it could) or since (pnpm's store makes them). Each one still lets a project command write the file it points to, from wherever the other name is: `find <agent home> -xdev -type f -links +1 -not -path '*/.cache/*' -not -path '*/.npm/*'`. Remove each one you didn't make. pnpm's store under `~/.local/share/pnpm` keeps hard links on purpose, but each is a write route into the home all the same: keep it only if you need it, and don't keep it unchecked.
- **Optional, once, as root:** look for symlinks deeper in each agent user's home that leave it through a path the agent user can change. The sandbox checks only the links directly in the home and in `~/.config`. One deeper down, such as `~/.ssh/config` pointing to `/tmp/x`, is followed wherever it leads.
  1. List the links: `find <agent home> -xdev -type l`.
  2. For each one, show every hop on its way with its owner and mode: `namei -l <link>`, from util-linux.
  3. The link is unsafe if any entry `namei` lists outside the home is owned by the agent user, or is writable by it through its group or by everyone. That covers a directory, another link, and the file it ends at.

  Remove each unsafe link that you didn't make. (`readlink -m` alone isn't enough: a link can resolve inside the home through a hop outside it that the agent can re-aim.)

### Guardrail changes: what each one does

- **Agent home read-only to project commands (#798).** The project-command sandbox (`projectCommand`, `src/os/index.ts`) binds the agent user's home read-only, under the credential masks. On Linux, `~/.cache` and `~/.npm` are throwaway tmpfs mounts. On macOS, the profile denies every write under the home, but a link leading out of it is followed (macOS isn't in CI). On Linux, each symlink directly in the home or in `~/.config` is walked hop by hop, by the same rule as the credential paths. A run is refused in seven cases:
  - a hop outside the home could be re-aimed (a link in a directory the agent can write);
  - a hop is the agent's own;
  - a dangling link passes through a directory the agent can write;
  - a link ends at a device in a directory the agent can write (under `/dev`: in or below one);
  - a link's way enters `/proc` or `/sys` (its pins would bind the host's `/proc` over the sandbox's own);
  - a link reaches under `/dev` anything but a device, or a device through a symlink, a `..` or a writable directory there (its pins would bind `/dev`);
  - a cache is a link.

  A link to `/` or to the command's working directory is refused too, as are more than 500 links in one directory, a way of more than 40 links and a way through a directory the agent user can't search. Any other link is allowed. Every directory above what it reaches is pinned, and the target itself is bound read-only. A device target isn't bound (writing it plants nothing). It is refused when the agent can write its directory (under `/dev`, any directory between `/dev` and it); otherwise the directories above it are pinned, except under `/dev`. The home itself and every directory above it are always pinned.

  A project command can't write the home directly, nor anything an allowed link in it reaches. What falls outside that, all of it:
  - a link deeper in the home whose way out the agent user can change (After install);
  - a link inside what an allowed link reaches that leads somewhere writable;
  - a hard link to a home file made outside the sandbox, before this release or since (pnpm's store makes them): a command writes the file through its other name (After install). A command can't make a new one;
  - a FIFO or socket that already exists in the home: what a command writes to it reaches the agent-user process at the other end, outside the sandbox, which may keep it or act on it (#933);
  - a socket outside the home (`$XDG_RUNTIME_DIR`, the user bus, `systemd --user`, an abstract socket): a live agent-user process listening there is reachable from the sandbox in the same way (#933);
  - a second mount of the home elsewhere, such as an admin's bind mount: it is writable;
  - a link added to the home while a command runs (only a process outside the sandbox can add one): the walk and its pins are worked out once, when the command starts;
  - another user writing a directory that an allowed link reaches, because the pins and the read-only bind hold only in this agent user's own sandboxes. That user can be another instance's agent user, through its own sandboxed project commands;
  - a configured home (`run_as.agent_home`) that isn't the agent user's home in passwd, which a login shell and cron use: only the configured one is made read-only (#954);
  - on macOS, links: the profile walks none, so a link leading out of the home is followed and written through.

  A link to a directory above the home (`~/.x -> ..`) is bound read-only over the home's own mounts, so for that layout `~/.cache` and `~/.npm` are read-only too.
- **harness-config locked (#798).** `src/review.ts` lists `harness-config` in `LOCKED_CATEGORIES` and `ALWAYS_L3`: it is always L3 and always waits. Its built-in globs always hold, and a repo's `review.yaml` may only add to them.
- **credentials.sh** checks an agent's API-key sign-in with `sudo -H -u <agent>`, never a login shell (#798).
