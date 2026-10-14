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
| `machine-helper.sh <name> [<name>...]` | once per machine, with every instance | Installs `/usr/local/libexec/worklane-machine` (root-owned), which accepts exactly `set-slots <1..16>`, `set-updates on\|off`, `set-test-slots <1..8>`, `claude-account status\|switch`, `tailscale install\|up\|serve\|public-url`, `add-project <name> <owner/repo>` and, for the engine updater, `install-updater` (the installed engine's `updates.sh`, no arguments), `set-update-channel release` (the channel in `updates.json`, nothing else; following main is `updates.sh --channel main`, at a root shell) and `stage-update-signer <principal> ssh-ed25519 <public key>` / `discard-update-signer ...` (one release signer recorded in, or taken out of, the root-owned pending list `/var/lib/worklane/pending-signers.json`: at most 4, each for 24 hours). Nothing in the helper writes `/etc/worklane/allowed_signers`, the keys a release tag's signature is checked against: a staged key is trusted for nothing until an admin confirms it at a root shell. It writes atomically and logs each change to `/var/lib/worklane/machine-changes.jsonl` and the journal. Lets each `wl-<name>` run exactly those commands as root (its coordinator runs them for requests made on its dashboard, which never runs sudo itself) (listed one by one in sudoers; `wl-dash` gets none). Makes `slots.json` `root:root 0644`. |
| `tailscale.sh status\|install\|up\|serve\|public-url` | once per machine (optional) | Tailscale for the dashboard hub, one step at a time; a machine without it keeps its hub's URL. `status` reads only (any user). `install`: Tailscale's own package from its apt repository for this distribution (Ubuntu, Debian), pinned in `lib.sh`: the repository's signing key must be the one whose fingerprint is pinned (`TAILSCALE_SIGNER_FPR`), apt checks the index and the package against it, and the version is `TAILSCALE_VERSION`; no install script is fetched. `up`: `tailscale up` with no auth key (none is taken or passed); it prints Tailscale's login link in your terminal and waits 10 minutes. `serve`: `tailscale serve --bg --https=443 http://127.0.0.1:4399`, tailnet only, refused when 443 already goes elsewhere, when anything forwards to the break-glass port 4398, or when Tailscale Funnel is on. `public-url`: reruns `dashboards.sh` with the hub's own settings and `--public-url https://<this machine's tailnet name>` (the name read from `tailscale status` by the script, a `*.ts.net` name or nothing; never while Funnel is on). No step takes a flag, a target or a name from its caller, and none turns Funnel on or off: `status` shows Funnel read-only. The machine helper starts the same four steps for a dashboard request (`worklane-tailscale.service`); then the login link goes only to a `0400` file of the asking coordinator's user, never to a log. |
| `updates.sh [--check "name" ...] [--channel release\|main] [--signer <principal> ssh-ed25519 <public key>] [--confirm-signer SHA256:<fingerprint>]` | once per machine (optional); again to add a signer or change the channel | Installs `/usr/local/libexec/worklane-update` (root-owned) and `worklane-update.timer` (every 10 minutes), with updates **off** in `/etc/worklane/updates.json`. `--signer` adds one release-signing key to `/etc/worklane/allowed_signers` (it never removes or replaces one); `--confirm-signer` adds the one staged from the dashboard's Updater setup whose fingerprint that is (docs/dashboard.md): the dashboard can only stage a signer, never add one; `--channel` sets what the updater follows (the dashboard can only set `release`). Every signer added raises a watchdog incident. When turned on (following main), it installs the newest commit on main's first-parent line that descends from the installed engine, has every check on it green and every required check run and passed (none missing, pending, failed or skipped), and isn't held, when no agent or full test run is going. One red tip doesn't block updates: it looks back from the tip, newest first, at most `max_lookback` commits (default 20) and never past the installed one or onto a merge's second parent, one check-run call per commit, stopping at the first green one (an older commit's red verdict is reused for an hour, in `/var/lib/worklane/update-verdicts.json`). A commit whose checks are still pending is waited for, with nothing older installed, until it has been on main `pending_wait_minutes` (default 60, from its committer date); after that an older green commit may go in, and the pending one still installs later if it turns green. Installing an older commit than the tip logs a `chose` line naming it and why each newer one was skipped. Every check run on a commit is read, page by page (a commit can carry over 100). On this engine's own repo the slow checks (bootstrap on each OS, the real systemd and real users jobs) run in batches, on main's newest commit at most every 30 minutes (`.github/workflows/ci-batch.yml`), so only a batched commit can be installed: one the batch skipped reads as not run and is never installed. A commit like that, with a required check not run and no check queued or running 10 minutes after it landed, isn't waited for: an older fully green commit goes in at once. It builds as a throwaway unprivileged user (systemd `DynamicUser`) with `npm ci --ignore-scripts`; root only copies the result into `/opt/worklane/<sha>`. It restarts the instance and dashboard services and rolls back if any isn't active and steady within 2 minutes, or as soon as one crash-loops (restarts, waits in auto-restart, or stops with a failed result). The rollback's log entry carries each failing unit's result, exit status, restart count and last 30 journal lines (secrets redacted). A rolled-back commit is **held** (`/var/lib/worklane/update-held.json`): it isn't tried again until a newer commit lands on main, or until you turn updates off and on again after the rollback; each skip is logged once as `held`. Each attempt, install, refusal, hold and rollback goes to `/var/lib/worklane/updates.jsonl` (a wait or refusal once per commit and reason). Every run also prints one line to the journal (`journalctl -u worklane-update`): the result and, for a wait, refusal or hold, the commit and the reason, such as `waiting b9634df: required check "x" hasn't run on this commit`. |
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
