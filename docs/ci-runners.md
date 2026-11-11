# Self-hosted CI runners beside the instances

A repo's trusted GitHub Actions jobs can run on the same machine as its instances: as their own user, below the instances in CPU and memory, never at the same time as an agent's full test run, and with no way into the instances' files, the machine's own services, the LAN or the tailnet. `scripts/setup/ci-runner.sh` sets this up. This page explains each choice, the repo settings that go with it, and how to install, check and undo it.

Linux with systemd only (written for Ubuntu 24.04, x86_64). Replace `<owner>/<repo>` with the repo and `<name>` with a short name for it (lowercase, at most 21 characters; the repo's name by default). Every command marked **root** needs `sudo`.

## Untrusted code never runs here

A self-hosted runner runs a job's code on this machine. A pull request's code is untrusted: on a public repo anyone can open one from a fork, and on any repo an agent's branch hasn't been reviewed yet. So a runner set up here takes **only** jobs that are:

- for this repo (`GITHUB_REPOSITORY`), and
- from a `push`, a `workflow_dispatch` or a `schedule` (`GITHUB_EVENT_NAME`), never `pull_request`, `pull_request_target`, `workflow_run`, `issue_comment` or anything else, and
- on the one branch given at install, `main` by default (`GITHUB_REF`, and no pull request head or base ref), and
- from a workflow file read from that branch (`GITHUB_WORKFLOW_REF`). A branch that edits a workflow and dispatches its own copy is refused too.

One exception, set at install and never by a workflow: a runner installed with `--pull-requests same-repo` also takes pull requests into that branch from the repo's own branches, never a fork's ("The tests runner", below).

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

## The tests runner

The unit test shards (`test-shard-22`, `test-shard-24`) and their summaries (the required `test (ubuntu-latest, 22)` and `(…, 24)` checks) can run on a second runner on the same machine: a registration, user (`wl-ci-<name>`), firewall table, rootless Docker and units of its own, with the label `trusted-tests`. It differs from the main-only runner in one rule: installed with `--pull-requests same-repo`, its hook also takes a `pull_request` into the branch whose head branch is in this repo itself. The runner writes the event GitHub sent to `GITHUB_EVENT_PATH` before the hook runs; the hook refuses the job unless that event names this repo as both the head's and the base's, the ref is `refs/pull/<n>/merge` for the same `<n>`, and the base is the branch. A fork's pull request never runs there, nor does `pull_request_target`.

Why a runner of its own rather than the main-only one with a new rule: a same-repo branch hasn't been reviewed, and its workflow file is the branch's own copy. Everyone who can push a branch here can already push code that runs on this machine once merged, so the line held is "people with write access", not "reviewed code". Keeping those jobs on a separate user and label means a main-only runner never takes one, and nothing a pull request's job leaves behind (it can't leave much: one job per start, then the reset) can reach the main-only runner's user, Docker or directories. Every other boundary (the sandboxed unit, the firewall, no sudo, no secrets, the full-run lock, the slice's caps) is the same.

A shard needs what the main-only runner refuses: root for its setup steps (apt, `machine.sh`, subordinate ids), servers on `127.0.0.1`, and Chrome. On the tests runner it runs in a container (`container:` in `ci.yml`, an official image pinned by digest) through the runner's rootless Docker: root inside it is the runner user outside, the container has a loopback of its own (none of the machine's; its traffic leaves through `slirp4netns` as the runner user, so the firewall still applies), and its Chrome is Chrome for Testing, pinned and checked. The tests themselves run as a non-root user inside it, as on GitHub's runners. Both runners' Docker daemons and their containers run at the unit's `Nice=` (`--nice`, 10 for this one) and under `worklane-ci.slice`'s CPU weight.

Routing, in `ci.yml`, with its own switch: `vars.CI_SELF_HOSTED_TESTS == 'on'` and either a push to `main` or a `pull_request` into `main` with `github.event.pull_request.head.repo.full_name == github.repository`; everything else, forks' pull requests included, stays on GitHub's runners with the same check names. `scripts/ci/self-hosted-guard.mjs` accepts that pull request guard only in `runs-on`'s guarded form and only with the head term.

What the shards need from inside the container, and where it comes from:

- **Nested user namespaces** for a non-root user (bubblewrap as `nobody`, `unshare --map-auto` as the test user). Where `kernel.apparmor_restrict_unprivileged_userns` is 1 (Ubuntu 24.04's default), that is AppArmor's call. Under rootless Docker, a container's processes descend from `rootlesskit` and keep its AppArmor label, `worklane-ci-rootlesskit (unconfined)`: the profile `ci-runner.sh install` already loads, which allows user namespaces. So no profile for `/usr/bin/unshare` is needed on the machine, and none is added. (An earlier measurement under rootful Docker said otherwise: there a container is unconfined and the restriction applies.) The bubblewrap step checks both as the shard starts and fails, before any test, if either is missing.
- **Subordinate ids inside the container's own range.** Rootless Docker maps the container's ids 0 to 65536. `useradd` would give the test user 165536 and up, outside them, where `newuidmap` is refused, so the setup creates it with none and gives it 2000 to 59999.
- **A `/tmp` on a real local file system.** The image's root is overlay, where native file locks fail closed. `/tmp` is an anonymous volume, on the daemon's data root, one per job; the reset prunes it.
- **An init that reaps orphans** (`--init`). The runner makes `tail -f /dev/null` the container's process 1, which reaps none, so a stopped process tree's children would stay as zombies that the tests see as still running.
- **The test user for every step that runs a test file**, the backstop and the lint tests too (so the container's setup is the first step: it runs only `ci.yml`'s own commands), **with umask 022**. The container's `docker exec` gives 0, and the test user's login 002.
- **What GitHub's image has and the tests use**: jq, git-lfs, python3 with pip, strace, fakeroot, and supplementary groups for the test user.

**Measured, 2026-11-07, on GitHub's Ubuntu 24.04 VMs set up as the tests runner's host:** `machine.sh` (its bubblewrap profile only), Docker 29.8.2 rootless from `ci-runner.sh`'s pinned release with its rootlesskit profile, and the daemon as a systemd unit with the docker unit's settings. The job's container was started as the Actions runner starts one, and `ci.yml`'s own steps were run in it in order, read from the file. Every test file of the suite ran on Node 24, as a push to `main` runs them, in 4 shards: 6,094 tests, none failed, none hung (each shard's tests took 4 to 19 minutes). What still skips there and not on GitHub's runners: the 3 acceptance tests that need a booted systemd (a container has no systemd as process 1, and the runner chooses process 1). Not measured: Node 22, the machine itself (its firewall table and the runner unit's own sandbox), and two shards on one machine at once.

**Still off.** Turning it on (`CI_SELF_HOSTED_TESTS`) is the owner's call, after installing the runner. The acceptance tests that need a booted systemd (each test gated on `systemCi`) skip in the container, so they also run in `ci.yml`'s `systemd-acceptance` job, on GitHub's VM, on each push to main, whether the switch is on or off. `scripts/ci/systemd-acceptance.mjs` finds them by that gate and fails the job on a skip, and the updater requires the check (`systemd acceptance (real systemd)`). They don't run there on pull requests: with the switch on, a PR's shards skip them, so a PR that breaks one shows it only on main. The job also runs, whole-file, every other test that would need systemd and could hide it: one whose own function holds systemd's sign, one whose skip, todo or early return turns on a value one name away from it, one whose name (or its suite's) holds it, and (failing closed) one whose code, with the same-file helpers it names and the hooks around it, reads such a value and mentions skip or todo in any form, or reads one and starts subtests (a loop or an exit around them is then the zero-subtest rule's). Each must run and pass there with no skip or todo, and a test that starts subtests must run one; the allowlist's `runtime` names the few that skip there by design, each with where it runs for real (`runsIn`: the web-UI tests in the shards, under `CI_REQUIRE_WEB`; #859 in the security-fixed job), which a test holds. That run is the guarantee (the owner's option (b), 2026-11-09); each runtime excuse is pinned by its test's whole text (its line breaks kept), so editing the test voids it, and covers only the one test at its place. A test that passes there having checked less fails too (the owner's decision, 2026-11-10): each gate opens with `t.plan(<n>)`, node's own count of its checks, and each sign test's file runs with V8's block coverage (`NODE_V8_COVERAGE`), so in its own function and each subtest's every use of systemd's sign must run, each must run to its end every time it runs (the count just before its closing brace equals its call count), and each subtest must start (the owner's option (b), 2026-11-10). Each is judged by the innermost coverage range around its own position, not by its line, so a branch not taken (braced or not), an operand never evaluated, a function never called that holds the sign and the code after a `return` or `throw` all count as not run. The file's coverage must come from one process: a child process or a worker that loads it again fails the run. Refused before the run, as V8 keeps no count of their own there: a sign in a `try` with a `catch`, in an optional call's arguments, in a default value (a parameter's or a destructuring's), on the right of `??=`, `||=` or `&&=`, in a `for` loop's update, past an optional chain's receiver or in a `do…while` condition; a function whose last statement ends at its closing brace; a test function given by a name the file declares twice; and, read before the run rather than from coverage, any `return`, `throw`, `break` or `continue`, labeled or not, that isn't its function's last statement (but `return t.skip(…)`/`t.todo(…)` on the test context the checker binds) in the test's function, its subtests' or any function inside them. At run time a sign also reads as not run when a zero range starts right after an earlier statement around it, or after an `await` or `yield` before it in its function (the continuation after a jump, a rejected `await` or a generator never resumed; one inside a `try` whose `catch` takes it is skipped); a statement that holds the sign and awaits or yields after it is refused, a concise test function's body included. Named limits, each measured: any expression that throws (a call, a member read or write, a destructuring, a spread, an operator) before the systemd work runs, before the sign or after it in the sign's own statement, when something other than a `try` around it takes the throw without a jump of its own (a caller's try, `assert.throws`/`rejects`, a promise's `catch`, `allSettled`, an unawaited Promise); a generator made but never iterated; one function run for more than one test or subtest, whose branches share counts; a branch, loop, catch or never-called callback around assertions alone. The job also runs by hand on a branch (`workflow_dispatch`), once on a pull request's final head before it merges. A test file could still forge its own results through its process's stdout; test code is trusted (the owner's threat model), and the script's header names that limit. A static rule, in every PR's suite, is a first-pass hint: it keeps the sign out of everywhere else but named data (`scripts/ci/systemd-acceptance-allow.json`), and reads node:test by binding: every use of `test`/`describe` must be a call as a statement, and what decides each registration (a branch, a loop, an early exit, a caller) is read as a skip is. Its named limits, by the owner's choice (option (a), 2026-11-08), are all in the script's header; among them: a proxy with no sign in its file; a value reached through a property of a shared object, a global, an env variable, an aliased `createRequire` or a re-export; a stop inside a `catch` or a `switch`; a test name built at run time or a test registered through a sign-free helper (the name rule is lexical); a subtest started through another module's helper; a registration in another module; a skip or todo spelled from parts. #1250 tracks measuring the alternative, the whole suite on the VM.

Install it beside (or without) the main-only runner:

```
bash scripts/setup/ci-runner.sh --print install <owner>/<repo> 2 --name <name>-tests --label trusted-tests --pull-requests same-repo --nice 10 --no-lock-jobs test-22,test-24 --cpus <list> --memory-max <size>
sudo bash scripts/setup/ci-runner.sh install <owner>/<repo> 2 --name <name>-tests --label trusted-tests --pull-requests same-repo --nice 10 --no-lock-jobs test-22,test-24 --cpus <list> --memory-max <size>
sudo bash scripts/setup/ci-runner.sh check <owner>/<repo> --name <name>-tests
gh variable set CI_SELF_HOSTED_TESTS --repo <owner>/<repo> --body on
```

`--cpus` and `--memory-max` set `worklane-ci.slice`, which every CI runner on the machine shares: give the same values to every runner's install. `--no-lock-jobs test-22,test-24`: the summaries run no tests. `gh variable delete CI_SELF_HOSTED_TESTS --repo <owner>/<repo>` sends the shards back to GitHub's runners.

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
