# Separate users for the coordinator and its agents

An instance's coordinator and its agents run as different OS users. The coordinator user holds the instance's credentials: its GitHub login and policy, in an instance home only it can read. Agents run as an unprivileged user that holds nothing worth taking, inside Claude Code's sandbox. An agent that tries to read the coordinator's token gets "permission denied" from the operating system, whatever tool or language it uses.

This page is for Linux (systemd). macOS works the same way with `dscl`/System Settings for users and launchd for the service. Native Windows can't separate users this way; use WSL2.

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
| `machine-helper.sh <name> [<name>...]` | once per machine, with every instance | Installs `/usr/local/libexec/worklane-machine` (root-owned), which accepts exactly `set-slots <1..16>` and `set-updates on\|off`, writes atomically and logs each change to `/var/lib/worklane/machine-changes.jsonl` and the journal. Lets each `wl-<name>` run exactly those 18 commands as root (listed one by one in sudoers; `wl-dash` gets none). Makes `slots.json` `root:root 0644`. |
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

  Delete the downloaded key elsewhere, too. In `credentials.yaml`: `github: { kind: app, app_id, installation_id, key_path }`.
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
  agent_home: /home/wl-<name>-agent
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
