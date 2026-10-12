# Self-hosted CI runners beside the instances

A project's GitHub Actions jobs can run on the same machine as its instances, as their own user, below the instances in CPU and memory, and never at the same time as an agent's full test run. `scripts/setup/ci-runner.sh` sets this up. This page explains each choice and how to install, check and undo it.

Linux with systemd only (written for Ubuntu 24.04, x86_64). Replace `<owner>/<repo>` with the repo and `<name>` with a short name for it (lowercase, at most 21 characters). Every command marked **root** needs `sudo`.

## What runs where

| Piece | What it is |
|---|---|
| `wl-ci-<name>` | The runner user. Its own group only, no sudo, no login shell. It can't read, write or enter `/srv/worklane`, `/opt/worklane`, `/var/lib/worklane` or `/etc/worklane` (an ACL entry denies each to it), any other `wl-*` home (instance homes hold App keys and credentials), `/root` or a root Docker socket. |
| `worklane-ci.slice` | A top-level slice for all CI on the machine: `AllowedCPUs` and a matching `CPUQuota`, `MemoryMax` with no swap, and CPU and IO weights below `worklane.slice`'s. |
| `worklane-ci-<name>-docker@<i>.service` | A rootless Docker daemon for runner `<i>`, as the runner user. There is no root daemon and no `docker` group. Published ports bind `127.0.0.1`. |
| `worklane-ci-<name>@<i>.service` | Runner `<i>`. It takes one job per start, then exits, and systemd starts it again. Before every start, as root, `reset` removes the last job's containers and volumes and makes the runner directory, workspace and home new. |
| `/opt/worklane-ci` | The pinned runner and Docker releases, root-owned, checked against pinned sha256 sums. |
| `/usr/local/libexec/worklane-ci` | The job hooks (`scripts/machine/worklane-ci-job-hook.sh`), the `docker` pin wrapper (`worklane-ci-docker.sh`) and the reset (`worklane-ci-reset.sh`), root-owned. |
| `/var/lib/worklane-ci/<name>` | Per runner: its registration (root-only) and the runner user's directories. |

The runner's unit is sandboxed: the system is read-only, `/home` holds only its own home (mounted at `/home/runner`, the path GitHub's runners use, so workflows that hard-code it work), the worklane paths are inaccessible, there are no devices (so no GPU), and `/tmp` is private.

## Choices

**One job per start rather than `--ephemeral`.** An ephemeral runner is deleted by GitHub after its job. Registering a new one needs a registration token, minted with a credential that can manage the repo's runners, on the machine, for every job. A runner registered once and started fresh for each job needs no such credential. The registration token is piped in at install, used once and never stored. Each job still gets what an ephemeral runner gets: a new runner directory, workspace and home, no container or volume left by the last job, and none of its processes, since stopping the unit ends its whole cgroup. The runner's binaries come from read-only binds of the pinned release, so a job can't change them for the next one. What stays between jobs is the runner's own registration (it lets the runner take this repo's jobs, nothing else) and the pinned images.

**The token.** `install` reads the registration token from stdin and refuses a terminal. It goes to `config.sh` in `ACTIONS_RUNNER_INPUT_TOKEN`, set inside the runner user's own shell: never a command-line argument, a file or output. The runner masks that variable in its logs and removes it from its environment before anything else runs. Run `gh` as yourself in the same pipeline. The script doesn't use your `gh` login and nothing of it stays on the machine.

**Pinned versions, auto-update off.** The runner starts with `--disableupdate`, so its version changes only when the pin in `ci-runner.sh` does. GitHub stops sending jobs to a runner that falls too far behind its releases (with updates off, its docs give about 30 days after a new one). Bump the pin, with its sha256 from the release page, about once a month. Tools come from the reviewed scripts: Node from `node.sh` is seeded into each new workspace's tool cache, so `actions/setup-node` uses it instead of downloading one. Project tools come from the project's own reviewed machine script.

**Rootless Docker, not the `docker` group.** Membership in `docker` is root on the machine. Workflows with `services:` (a database, say) need a Docker-compatible daemon. Each runner gets a rootless daemon of its own, running as the runner user, from Docker's pinned static release. Its containers run under that user's subordinate ids and stay inside `worklane-ci.slice`. It's Docker rather than Podman because the runner drives the `docker` CLI and GitHub supports only that. Podman's Docker-compatible socket runs a container's health checks through systemd timers, which a service user has none of, so a service with `--health-cmd` would never report healthy. On Ubuntu 24.04, where unprivileged user namespaces are restricted, an AppArmor profile lets only the pinned `rootlesskit` create them. The machine-wide restriction stays on.

**Pinned images.** The workflow keeps naming `postgres:16`. The runner's `docker` (the wrapper, first on its PATH) pulls the digest given with `--image postgres:16=postgres@sha256:...` and tags it `postgres:16`. It refuses any image without a pin. To change an image, pin a new digest and run `install` again.

**The full-run lock.** Agents' full runs take a machine-wide `flock(2)` lock file exclusively (`--lock`, default `/run/lock/worklane-full-run.lock`, which the project's own machine script makes root-owned at boot). The job-started hook takes the same lock **shared**, and the job-completed hook releases it:

- A CI job and an agent's full run never overlap: shared and exclusive exclude each other.
- CI jobs never wait on each other, with one runner or several.
- Nothing is held while a runner sits idle. A background holder takes the lock at job start and is killed at job end, or by the unit stopping.
- If the lock file is missing, or still held after `--lock-wait-min` (default 45), the job fails rather than runs unlocked.
- Starvation: `flock` has no queue, so overlapping shared holders could keep an exclusive waiter out indefinitely. With one runner, holders never overlap. Between jobs the lock is free for the seconds the runner takes to reset, and an agent already blocked in `flock` gets it then. With several runners, CI could keep agents' full runs out for as long as jobs overlap. Agents' full-run scripts wait a bounded time and then defer.
- Which jobs take it: every job except those named in `--no-lock-jobs` (`GITHUB_JOB` ids). Name only jobs that run no tests, such as a job that prints a verdict from other jobs' results, or a dependency audit. A new job takes the lock unless someone names it.

The lock is cooperative, like every flock. It keeps well-behaved runs apart; it is not a security boundary.

**How many runners.** Usually one. Workflows written for GitHub's runners often publish fixed host ports (`5432:5432` for a database service). Two jobs on one machine would collide on them, so one runner per workflow set that does this. Memory decides it too: the instances' caps plus a second CI cap can exceed the machine. Jobs then queue on the runner one at a time. A workflow with `concurrency: cancel-in-progress` still cancels superseded runs.

**Caps.** Defaults: 4 CPUs (`AllowedCPUs` = the last 4, `CPUQuota=400%`), `MemoryMax=5G` with no swap, CPU and IO weight 10 against `worklane.slice`'s 20. `AllowedCPUs` matters as much as the quota: test runners that size their worker pools from `os.availableParallelism()` see the CPUs a process may run on, not a quota. On a CPU with performance and efficiency cores, pick the CPUs with `--cpus` (see `lscpu --extended`). `check` fails if CI's memory cap isn't below every instance's, or its CPU weight isn't below `worklane.slice`'s. Set these with `--cpus`, `--memory-max`, `--cpu-weight`, `--io-weight`.

**Secrets and deploys stay off the machine.** Keep a workflow on GitHub's runners if it gets production or money-path secrets, or deploys or pushes to a protected branch. A job on this machine runs beside the instances, as a user any job of the repo can become. Moving only the test and audit workflows removes no check, because the others keep running where they ran.

## Install

1. **root** Node (`node.sh`), and the project's own machine scripts for its locks and test tools (they install system-wide packages, such as a browser's libraries).
2. Read `scripts/setup/ci-runner.sh` and the three `scripts/machine/worklane-ci-*` files at the commit you'll run. Preview the units and hooks; this changes nothing:

   ```
   bash scripts/setup/ci-runner.sh --print install <owner>/<repo> 1 --name <name> --image postgres:16=postgres@sha256:<digest> --no-lock-jobs <job>,<job>
   ```
3. **root** Install, with a registration token from your own `gh` login (repo admin) piped in:

   ```
   gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token \
     | sudo bash scripts/setup/ci-runner.sh install <owner>/<repo> 1 --name <name> --image postgres:16=postgres@sha256:<digest> --no-lock-jobs <job>,<job>
   ```

   It checks the boundaries as the runner user before registering anything, and everything again once the runners are up. If any check fails, it stops the runners.
4. Point the workflows' jobs at it with `runs-on: [self-hosted, linux, <name>]`.

## Check

**root** `sudo bash scripts/setup/ci-runner.sh check <owner>/<repo> --name <name>` prints PASS or FAIL for each check and exits non-zero on any FAIL:

- the user, its groups and its lack of sudo;
- each protected path, probed as the runner user, where only an explicit "denied" passes;
- the lock file;
- the caps against the instances';
- the units, rootless Docker and the runner version.

During a job: `journalctl -u 'worklane-ci-<name>@*' -f`, `systemd-cgtop worklane-ci.slice`, and `ss -ltnp` shows the service ports bound to `127.0.0.1`.

## Undo

1. Change the workflows' `runs-on` back.
2. **root** Remove, with a removal token piped in to deregister the runners:

   ```
   gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token --jq .token \
     | sudo bash scripts/setup/ci-runner.sh remove <owner>/<repo> --name <name>
   ```

   Without a token, it removes everything on the machine and you delete the runners in the repo's Settings > Actions > Runners. It stops and removes the units, the registration, the runner user and its files, and the ACL entries. If no other CI runner is left, it also removes the slice, the AppArmor profile, `/opt/worklane-ci` and the hooks. The distribution packages it installed stay (`uidmap`, `slirp4netns`, `iptables`, `zstd`, `acl`, the runner's libraries).
