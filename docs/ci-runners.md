# Self-hosted CI runners beside the instances

A repo's trusted GitHub Actions jobs can run on the same machine as its instances: as their own user, below the instances in CPU and memory, never at the same time as an agent's full test run, and with no way into the instances' files, the machine's own services, the LAN or the tailnet. `scripts/setup/ci-runner.sh` sets this up. This page explains each choice, the repo settings that go with it, and how to install, check and undo it.

Linux with systemd only (written for Ubuntu 24.04, x86_64). Replace `<owner>/<repo>` with the repo and `<name>` with a short name for it (lowercase, at most 21 characters; the repo's name by default). Every command marked **root** needs `sudo`.

## Untrusted code never runs here

A self-hosted runner runs a job's code on this machine. A pull request's code is untrusted: on a public repo anyone can open one from a fork, and on any repo an agent's branch hasn't been reviewed yet. So a runner set up here takes **only** jobs that are:

- for this repo (`GITHUB_REPOSITORY`), and
- from a `push`, a `workflow_dispatch` or a `schedule` (`GITHUB_EVENT_NAME`), never `pull_request`, `pull_request_target`, `workflow_run`, `issue_comment` or anything else, and
- on the one branch given at install, `main` by default (`GITHUB_REF`, and no pull request head or base ref), and
- from a workflow file read from that branch (`GITHUB_WORKFLOW_REF`). A branch that edits a workflow and dispatches its own copy is refused too.

Three layers enforce this. The first is the one that can't be got around from a workflow file:

1. **The runner refuses.** Its job-started hook (`scripts/setup/ci-runner/job-hook.sh`) checks the variables above before the job's first step and fails the job if any doesn't hold. The runner sets them itself, and a workflow can't override `GITHUB_*` variables. None of a refused job's code runs here.
2. **The workflows don't ask.** `scripts/ci/self-hosted-guard.mjs`, run over `.github/workflows` by `test/self-hosted-guard.test.ts` in the unit tests every PR runs, fails any job that could reach a self-hosted runner without a trusted-only guard (below). It treats every label except GitHub-hosted ones (`ubuntu-*`, `windows-*`, `macos-*`) as self-hosted, since a self-hosted runner also carries `linux` and `x64`. A self-hosted job may not use `secrets.`.
3. **The repo's settings** (below): approval for every outside contributor's workflow runs, and a read-only default token.

### The guard

A job reaches the self-hosted runner only through a guard: `&&` of `<context.path> == '<literal>'` (or `!=`) terms, with no `||`, `!` or parentheses, that include `github.repository == '<owner>/<repo>'` or `github.repository_id == '<id>'` (a fork's copy never matches; the id, from `gh api repos/<owner>/<repo> --jq .id`, also survives a rename or a transfer), `github.ref == 'refs/heads/<branch>'` and `github.event_name == 'push'`, `'workflow_dispatch'` or `'schedule'`. Either in `runs-on`, with a GitHub-hosted fallback, so the same job still runs on GitHub's runners for pull requests and forks:

```yaml
runs-on: ${{ vars.CI_SELF_HOSTED == 'on' && github.repository == '<owner>/<repo>' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && fromJSON('["self-hosted","<label>"]') || 'ubuntu-latest' }}
```

or as the job's own `if:`, with a literal `runs-on: [self-hosted, <label>]`, for a job that only ever runs on main.

The `vars.CI_SELF_HOSTED` term is the off switch. With the repository variable unset, every job runs on GitHub's runners as before; `gh variable set CI_SELF_HOSTED --repo <owner>/<repo> --body on` sends the guarded jobs here, and `gh variable delete CI_SELF_HOSTED --repo <owner>/<repo>` sends them back, for example while the machine is down. A job queued for a runner that is offline waits for it (up to a day), so turn the switch off before taking the machine down.

### Repo settings (the owner's)

```
# Every outside contributor's workflow runs wait for approval (not only first-time contributors'):
gh api -X PUT repos/<owner>/<repo>/actions/permissions/fork-pr-contributor-approval -f approval_policy=all_external_contributors
# Workflows' GITHUB_TOKEN is read-only unless a workflow asks for more, and can't approve pull requests:
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
# Check both:
gh api repos/<owner>/<repo>/actions/permissions/fork-pr-contributor-approval
gh api repos/<owner>/<repo>/actions/permissions/workflow
```

A repo under a personal account has no runner groups, so GitHub can't limit a runner to chosen workflows; the hook above does that. The branch named at install should be protected by a ruleset (pull requests and required checks), since whatever lands on it runs here.

## What runs where

| Piece | What it is |
|---|---|
| `wl-ci-<name>` | The runner user. Its own group only, no sudo, no login shell. It can't read, write or enter `/srv/worklane`, `/opt/worklane`, `/var/lib/worklane` or `/etc/worklane` (an ACL entry denies each to it), `/var/lib/worklane-test`, any other `wl-*` home (instance homes hold App keys and credentials), `/root` or a root Docker socket. |
| `worklane-ci-<name>-firewall.service` | Loads `/etc/worklane-ci/<name>.nft`: an nftables table that applies to the runner user's packets only. The runners and their Docker are bound to it (`BindsTo=`), so neither runs without it. |
| `worklane-ci.slice` | A slice for all CI on the machine: `AllowedCPUs` and a matching `CPUQuota`, `MemoryMax` with no swap, and CPU and IO weights below `worklane.slice`'s. |
| `worklane-ci-<name>-docker@<i>.service` | A rootless Docker daemon for runner `<i>`, as the runner user. There is no root daemon and no `docker` group. |
| `worklane-ci-<name>-reset@<i>.service` | Before every start of runner `<i>` (the runner requires it), as root and outside the runner's sandbox: `reset` removes the last job's containers, build cache and volumes and makes the runner directory, workspace and home new. |
| `worklane-ci-<name>@<i>.service` | Runner `<i>`. It takes one job per start, then exits, and systemd starts it again, the reset first. |
| `/opt/worklane-ci` | The pinned runner and Docker releases, root-owned, checked against pinned sha256 sums. |
| `/usr/local/libexec/worklane-ci` | The job hooks (`scripts/setup/ci-runner/job-hook.sh`) and the reset (`scripts/setup/ci-runner/reset.sh`), root-owned. They change only when `install` runs again, never with an engine update. |
| `/var/lib/worklane-ci/<name>` | Per runner: its registration (root-only) and the runner user's directories. |

The runner's unit is sandboxed: the system is read-only; `/home` holds only its own home (mounted at `/home/runner`, the path GitHub's runners use, so workflows that hard-code it work); the worklane paths and the registration are inaccessible; other users' processes are invisible; there are no devices (so no GPU), no capabilities, and `/tmp` is private.

## Choices

**The network.** The firewall table jumps on the runner user's uid, so it touches nothing else on the machine. Its own processes and its rootless Docker's (whose containers' traffic leaves through `slirp4netns`, as that user) may reach public addresses only. Refused, at once rather than after a timeout:

- this machine's loopback, so none of its own services: the dashboards, the instances' test-run databases, a break-glass port; its own LAN and public addresses go over loopback too;
- private, shared (CGNAT) and link-local ranges, multicast, IPv6 unique-local: the LAN;
- Tailscale: its interface (`--deny-interface`, default `tailscale0`) and addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, inside the ranges above).

DNS still works: the local stub (`127.0.0.53`) and the machine's upstream DNS servers, port 53 only (rootless Docker's resolver uses them). Tailscale's resolver isn't one of them. `check` compares the table with what `install` would write today and fails when the uid or the upstream servers changed; run `install` again then.

What this isn't: a list of allowed hosts. Any public address is reachable, which GitHub, npm, the container registries and the rest of what a build fetches need. Narrowing it to named hosts would take an egress proxy; the jobs it runs are reviewed code, so the goal is that they can't reach this machine's insides, not that they can't reach the internet.

A job's service containers (`services:`) and anything a job serves on `127.0.0.1` itself are on loopback, so they're refused too. Keep jobs that need them on GitHub's runners.

**One job per start rather than `--ephemeral`.** An ephemeral runner is deleted by GitHub after its job. Registering a new one needs a registration token, minted with a credential that can manage the repo's runners, on the machine, for every job. A runner registered once and started fresh for each job needs no such credential. The registration token is pasted at install, used once and never stored. Each job still gets what an ephemeral runner gets: a new runner directory, workspace and home, no container, build cache or volume left by the last job, and none of its processes, since stopping the unit ends its whole cgroup. The runner's binaries come from read-only binds of the pinned release, so a job can't change them for the next one. What stays between jobs is the runner's own registration (it lets the runner take this repo's jobs, nothing else) and pulled images.

**The token.** `install` asks for the registration token at the terminal with the input hidden, or reads one line from a pipe. Spaces a paste adds are dropped. It goes to `config.sh` in `ACTIONS_RUNNER_INPUT_TOKEN`, set inside the runner user's own shell: never a command-line argument, a file or output. The runner masks that variable in its logs and removes it from its environment before anything else runs. `install` asks only while a runner isn't registered, so running it again later (to change the caps, say) needs no token.

**Pinned versions, auto-update off.** The runner starts with `--disableupdate`, so its version changes only when the pin in `ci-runner.sh` does. GitHub stops sending jobs to a runner that falls too far behind its releases (with updates off, its docs give about 30 days after a new one). Bump the pin, with its sha256 from the release page, about once a month. Node from `node.sh` is seeded into each new workspace's tool cache, so `actions/setup-node` uses it instead of downloading one.

**Rootless Docker, not the `docker` group.** Membership in `docker` is root on the machine. Each runner gets a rootless daemon of its own, running as the runner user, from Docker's pinned static release (the one `test-user.sh` pins). Its containers run under that user's subordinate ids and stay inside `worklane-ci.slice`. Host loopback is off inside it. On Ubuntu 24.04, where unprivileged user namespaces are restricted, an AppArmor profile lets only the pinned `rootlesskit` create them. The machine-wide restriction stays on.

**Jobs that need root stay on GitHub.** The runner user has no sudo and no capabilities, so jobs that set up users, units or sudoers as root (the real-systemd and real-users jobs) can't run here, and this setup doesn't loosen that. They stay on GitHub's runners, which are throwaway VMs. A nested VM per job would be the other way; this setup doesn't do it.

**The full-run lock.** Agents' full runs take a machine-wide `flock(2)` lock file exclusively (`--lock`, default `/run/lock/worklane-full-run.lock`, which the project's own machine script makes root-owned at boot). The job-started hook takes the same lock **shared** after the trust check, and the job-completed hook releases it:

- A CI job and an agent's full run never overlap: shared and exclusive exclude each other. CI waits while an agent's full run goes.
- CI jobs never wait on each other, with one runner or several.
- Nothing is held while a runner sits idle.
- If the lock file is missing, or still held after `--lock-wait-min` (default 45), the job fails rather than runs unlocked.
- With several runners, CI could keep agents' full runs out for as long as jobs overlap. Agents' full-run scripts wait a bounded time and then defer.
- Every job takes it except those named in `--no-lock-jobs` (`GITHUB_JOB` ids): name only jobs that run no tests.

The lock is cooperative, like every flock. It keeps well-behaved runs apart; it is not a security boundary.

**Caps.** Defaults: 4 CPUs (`AllowedCPUs` = the last 4, `CPUQuota=400%`), `MemoryMax=5G` with no swap, CPU and IO weight 10 against `worklane.slice`'s 20. `AllowedCPUs` matters as much as the quota: test runners that size their worker pools from `os.availableParallelism()` see the CPUs a process may run on, not a quota. On a CPU with performance and efficiency cores, pick the CPUs with `--cpus` (see `lscpu --extended`), and keep clear of the CPUs `worklane-test.slice` uses. `check` fails if CI's memory cap isn't below every instance's, or its CPU weight isn't below `worklane.slice`'s.

**Secrets and deploys stay off the machine.** A self-hosted job may not use secrets (the guard check), so jobs that deploy, push or need credentials stay on GitHub's runners.

## Install

1. **root** Node (`node.sh`), and the project's own machine script for its locks.
2. Read `scripts/setup/ci-runner.sh` and the two files in `scripts/setup/ci-runner/` at the commit you'll run. Preview the units, the firewall and the hooks; this changes nothing:

   ```
   bash scripts/setup/ci-runner.sh --print install <owner>/<repo> 1 --label <label> --cpus <list> --memory-max <size>
   ```
3. **root** Install. It asks for a registration token: from the repo's Settings > Actions > Runners > New self-hosted runner (the token in its `config.sh` line), or from `gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token` on a machine where you're signed in to `gh` (it's valid for an hour). Paste it at the prompt; it isn't shown.

   ```
   sudo bash scripts/setup/ci-runner.sh install <owner>/<repo> 1 --label <label> --cpus <list> --memory-max <size>
   ```

   It checks the boundaries as the runner user before registering anything, and everything again (the network from the runner user's side too) once the runners are up. If any check fails, it stops the runners.
4. The repo settings above, then point jobs at it with a guard (above) and turn the switch on.

## Check

**root** `sudo bash scripts/setup/ci-runner.sh check <owner>/<repo> --name <name>` prints PASS or FAIL for each check and exits non-zero on any FAIL:

- the user, its groups and its lack of sudo;
- each protected path, probed as the runner user, where only an explicit "denied" passes;
- the lock file;
- the firewall: its unit and table, the file current, and, as the runner user, loopback, a private address and a Tailscale address refused, `github.com:443` reached;
- the caps against the instances';
- the units, rootless Docker and the runner version.

During a job: `journalctl -u 'worklane-ci-<name>@*' -f` (the hooks print each trust decision and the lock), and `systemd-cgtop worklane-ci.slice`.

CI runs all of this for real on a GitHub-hosted Ubuntu 24.04 (`.github/workflows/ci-runner-setup.yml`), with a stand-in runner release in place of the registration: install, a trusted job's view from inside the sandbox, four untrusted jobs refused before their first step, a second trusted job that finds nothing of the first, `check`, a second install that changes nothing, and `remove`.

## Undo

1. Turn the switch off (`gh variable delete CI_SELF_HOSTED --repo <owner>/<repo>`), so no job waits for the runner.
2. **root** Remove. It asks for a removal token (`gh api -X POST repos/<owner>/<repo>/actions/runners/remove-token --jq .token`) to deregister the runners in GitHub; an empty line skips that, and you delete them in the repo's Settings > Actions > Runners.

   ```
   sudo bash scripts/setup/ci-runner.sh remove <owner>/<repo> --name <name>
   ```

   It stops and removes the units, the firewall table, the registration, the runner user and its files, and the ACL entries. If no other CI runner is left, it also removes the slice, the AppArmor profile, `/opt/worklane-ci` and the hooks. The distribution packages it installed stay (`uidmap`, `slirp4netns`, `nftables`, `zstd`, `acl`, the runner's libraries).
