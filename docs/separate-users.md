# Separate users for the coordinator and its agents

An instance's coordinator and its agents run as different OS users. The coordinator user holds the instance's credentials: its GitHub login and policy, in an instance home only it can read. Agents run as an unprivileged user that holds nothing worth taking, inside Claude Code's sandbox. An agent that tries to read the coordinator's token gets "permission denied" from the operating system, whatever tool or language it uses.

This page is for Linux with systemd: the setup scripts (`scripts/setup/`) are for that only. On macOS the engine runs as your own user, for development; there are no setup scripts for separate users there.

Replace `<name>` with the instance name throughout. Every command marked **root** needs `sudo`.

## Users and groups

| User | Holds | Runs |
|---|---|---|
| `wl-<name>` | the instance home (0700): policy, credential references, the `gh` login, state | the coordinator (a systemd user service) |
| `wl-<name>-agent` | its own Claude login, nothing else | agents, through `sudo -u` |
| `wl-<name>-eval` (optional) | the eval API key (0400) | agents in lanes with `run_as: eval` |

| Group | Members | For |
|---|---|---|
| `wl-<name>-work` | all of the instance's users | the repo checkout and worktrees |
| `agent-slots` | every coordinator user on the machine | the shared slot directory (`/var/lib/worklane/agent-slots`); its config (`/etc/worklane/slots.json`) is root-owned and readable by all, and changes only through the machine helper |

## Setup

Setup ships as scripts in `scripts/setup/`, reviewed like any other change. Run them from a checkout of this repo as an admin user; they use `sudo` themselves. Don't paste setup commands from a page or a chat: copying out of a terminal can add trailing spaces and invisible characters, which break heredocs and line continuations. Every script is safe to run again and stops at the first error.

| Script | Run | What it does |
|---|---|---|
| `node.sh <version>` | once per machine | Downloads Node.js and that release's `SHASUMS256.txt` from nodejs.org, verifies the tarball, installs it to `/opt`, links it from `/usr/local/bin`. Refuses if another `node` is already on PATH. |
| `machine.sh [--cap N]` | once per machine | Creates `/srv/worklane`, `/var/lib/worklane`, `/etc/worklane`; the `agent-slots` group, the slot directory and `/etc/worklane/slots.json` (a fixed cap, default 2; an existing file is kept). Installs `bubblewrap` and `socat`. If user namespaces are restricted, loads the distribution's `bwrap-userns-restrict` profile, or else a profile that lets only `/usr/bin/bwrap` create them; the machine-wide restriction stays on. |
| `instance.sh <name> [--eval]` | per instance | Creates `wl-<name>` (coordinator), `wl-<name>-agent` and optionally `wl-<name>-eval`, with private homes; the `wl-<name>-work` group; `/srv/worklane/<name>` (group-writable, setgid); lingering for the coordinator's service; and the sudoers rule. The rule is written to a dotted temp name (which sudo ignores), checked with `visudo -cf`, and only then moved into place. |
| `machine-helper.sh <name> [<name>...]` | once per machine, with every instance | Installs `/usr/local/libexec/worklane-machine` (root-owned), which accepts exactly `set-slots <1..16>` and `set-updates on\|off`, writes atomically and logs each change to `/var/lib/worklane/machine-changes.jsonl` and the journal. Lets each `wl-<name>` run exactly those 18 commands as root (its coordinator runs them for requests made on its dashboard, which never runs sudo itself) (listed one by one in sudoers; `wl-dash` gets none). Makes `slots.json` `root:root 0644`. |
| `updates.sh [--checks "a,b"]` | once per machine (optional) | Installs `/usr/local/libexec/worklane-update` (root-owned) and `worklane-update.timer` (every 10 minutes), with updates **off** in `/etc/worklane/updates.json`. When turned on (following main), it installs the newest commit on main's first-parent line that descends from the installed engine, has every check on it green and every required check run and passed (none missing, pending, failed or skipped), and isn't held, when no agent or full test run is going. One red tip doesn't block updates: it looks back from the tip, newest first, at most `max_lookback` commits (default 20) and never past the installed one or onto a merge's second parent, one check-run call per commit, stopping at the first green one (an older commit's red verdict is reused for an hour, in `/var/lib/worklane/update-verdicts.json`). A commit whose checks are still pending is waited for, with nothing older installed, until it has been on main `pending_wait_minutes` (default 60, from its committer date); after that an older green commit may go in, and the pending one still installs later if it turns green. Installing an older commit than the tip logs a `chose` line naming it and why each newer one was skipped. Every check run on a commit is read, page by page (a commit can carry over 100). On this engine's own repo the slow checks (bootstrap on each OS, the real systemd and real users jobs) run in batches, on main's newest commit at most every 30 minutes (`.github/workflows/ci-batch.yml`), so only a batched commit can be installed: one the batch skipped reads as not run and is never installed. A commit like that, with a required check not run and no check queued or running 10 minutes after it landed, isn't waited for: an older fully green commit goes in at once. It builds as a throwaway unprivileged user (systemd `DynamicUser`) with `npm ci --ignore-scripts`; root only copies the result into `/opt/worklane/<sha>`. It restarts the instance and dashboard services and rolls back if any isn't active and steady within 2 minutes, or if an instance whose test sandbox check passed before the update fails it after the restart (it waits `sandbox_wait_minutes`, default 10, for the restarted instance's result; with none in time it rolls back and holds too, unless `sandbox_on_timeout` is `"stand"`, which keeps the install and raises an incident instead; an instance with no test runs, or already failing before, is never waited for), or as soon as one crash-loops (restarts, waits in auto-restart, or stops with a failed result). The rollback's log entry carries each failing unit's result, exit status, restart count and last 30 journal lines (secrets redacted). A rolled-back commit is **held** (`/var/lib/worklane/update-held.json`): it isn't tried again until a newer commit lands on main, or until you turn updates off and on again after the rollback; each skip is logged once as `held`. Each attempt, install, refusal, hold and rollback goes to `/var/lib/worklane/updates.jsonl` (a wait or refusal once per commit and reason). Every run also prints one line to the journal (`journalctl -u worklane-update`): the result and, for a wait, refusal or hold, the commit and the reason, such as `waiting b9634df: required check "x" hasn't run on this commit`. When the machine has stayed on one engine commit for `stuck_alert_minutes` (in `/etc/worklane/updates.json`, default 120) while main moved on, the updater raises one incident (Health page and the ops channel) with the installed commit, main's tip, how long, and the reason it gives; it resolves when an install succeeds or main is the installed commit. Never while updates are off, and a machine that is only busy must have been busy that long. A machine that is never quiet (an instance running test runs back to back) is **drained**: once an update has waited `drain_after_minutes` (default 60) for it, the updater writes `/var/lib/worklane/update-drain.json` (root-owned), and no coordinator starts a new test run, takes the full-run lock or starts an agent while it stands; nothing running is stopped. The stuck incident is raised at once, on every run while draining, with what is still finishing and when the test runs are due (each run's setup, database and tier timeouts); past that it says the drain is overdue, and the update keeps waiting: it never installs over a running test run or agent. Once nothing is in flight it installs, keeping the flag through the install, then removes it however the run ends; the flag lapses by itself 30 minutes after the last run that wrote it (3 hours during an install), so a crashed updater never leaves the machine drained. The Machine page's Updates panel shows "draining for update since …" and what is finishing. The updater itself is installed by `updates.sh` and isn't replaced by an update: run `updates.sh` again from a checkout of the new engine to get a newer updater. |
| `ci-runner.sh install <owner/repo> <count>` | per repo (optional) | Self-hosted GitHub Actions runners for the repo's trusted jobs only (pushes, dispatches and schedules on its main branch; the runner refuses anything else before a job's first step), as their own user (`wl-ci-<name>`, no sudo, no access to worklane's files or any instance home), behind a firewall that keeps it off this machine's own services, the LAN and Tailscale, in `worklane-ci.slice` below the instances, with rootless Docker and the machine-wide full-run lock held for each job. `check`, `remove` and `--print` too. See [ci-runners.md](ci-runners.md). |
| `check.sh <name> [<other>]` | after setup | Read-only checks: the coordinator can run as its agent user and not as another instance's; the agent can't list the coordinator's home; bwrap works for the agent; the slots are writable; the sudoers file is valid. |

What the sudoers rule says:
- `Defaults:wl-<name> !use_pty`: without it, some distributions run the agent behind a pseudo-terminal, which breaks its JSON output.
- `Defaults>wl-<name>-agent umask=0002, umask_override`: files agents write stay group-writable, so the coordinator can clean up their worktrees.
- `wl-<name> ALL=(wl-<name>-agent) NOPASSWD: ALL`: the coordinator may switch to its own agent user (and eval user), and to nothing else.

## Credentials (the operator, not Worklane)

Each user signs in to its own accounts. Worklane never creates, reads or copies credentials.

- **Coordinator's GitHub identity: a GitHub App per instance.** Create an App in the repo's organization and install it on only this instance's repo. Give it these permissions, with no webhook:
  - Contents: read and write: fetch, push task branches, push lease refs under `refs/worklane/claims/`
  - Issues: read and write: the backlog (issues, labels, assignees, comments, label history)
  - Pull requests: read and write: open the PR for each change. Worklane never merges; a human does.
  - Checks: read: CI results on the PRs it opened
  - Metadata: read: required by GitHub
  - Actions: read (optional): CI fix runs read the failing job's log with it; without it they can't run

  **Workflows is deliberately excluded.** GitHub refuses a push that changes `.github/workflows` without it, so such a change can't go out through the coordinator. Leave out Administration too, and keep Actions at read: the harness never reruns or cancels jobs.

  Then run `bash scripts/setup/credentials.sh <name> github-app <app-id> <installation-id> <key.pem> <owner/repo>`. It:
  - installs the private key for `wl-<name>` only, mode 0400;
  - signs a JWT and mints an installation token;
  - checks the installation reaches exactly `<owner/repo>`, with the permissions above and without Workflows, Administration or Actions write;
  - offers to `shred` the copy you brought over.

  After changing the App's permissions (and accepting them on the installation), `bash scripts/setup/credentials.sh <name> verify-app` runs the same check with the installed key, read-only.

  Delete the downloaded key elsewhere, too. Once the check passes, the script writes `github: { kind: app, app_id, installation_id, key_path }` into `credentials.yaml` itself, as the coordinator (`worklane instance set-github-app`, validated, its other settings kept), making the instance home first if it isn't there yet. Nothing to edit by hand.
  - **How it's used:** the coordinator mints hour-long installation tokens limited to the instance's repos. It caches them in its private state and renews them before they expire. API calls use them, and git gets them through a credential helper. `gh` has no login in App mode. Tokens never reach agents.
  - **Enforced at start**, and by `instance show`: the installation must reach exactly the instance's repos.
  - **Required checks:** an App can post check runs. When Worklane posts its own gate check (planned), the App also needs Checks: write.
- **Fallback: a fine-grained personal access token** (`credentials.sh <name> github`), only when an App isn't possible. Use a dedicated machine account with Write on the repo, never an admin: admins can bypass branch protection. The start-up check refuses:
  - personal logins (`gho_`), classic tokens (`ghp_`) and App user tokens (`ghu_`);
  - a token that reaches any other repo;
  - a token whose user is an admin on the repo.

  Set an expiry: reports warn 7 days before it.
- **Agent's Claude login:** as `wl-<name>-agent`, run `claude` and sign in, or set up a token with `claude setup-token`. See [auth.md](auth.md) for the options and Anthropic's terms for automated use.
- **Eval key (eval lanes only, off by default):** with evals off, there is no key, no eval lane, and the eval user needs no Claude login. When you turn evals on: `bash scripts/setup/credentials.sh <name> eval-key --evals-on` writes the key as `wl-<name>-eval`, mode 0400, and you name it in `credentials.yaml` `eval_key`.

## Instance config

In `instance.yaml`:

```yaml
run_as:
  agent_user: wl-<name>-agent
  agent_home: /home/wl-<name>-agent   # its home, as `getent passwd wl-<name>-agent` shows it
  # path: /usr/local/bin:/usr/bin:/bin   # PATH for project commands; the default adds /opt/homebrew on macOS
```

`policy.yaml` keeps the sandbox on (the default). Its lanes list the hosts agent commands may reach.

## Acceptance test

Run the engine's separate-user tests as the coordinator user. Point them at the agent user and at a file only the coordinator can read:

```sh
sudo -iu wl-<name> sh -c 'cd <engine checkout> && npm ci && npm run build && \
  WORKLANE_TEST_AGENT_USER=wl-<name>-agent WORKLANE_TEST_SECRET_FILE=<a 0600 file of wl-<name>> \
  node --test --test-reporter=spec dist/test/separate-users.test.js'
```

The agent's `python3 -c "open(...)"` and `cat` of the file must fail with "permission denied", and both tests must pass rather than be skipped.
