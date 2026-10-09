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
| `agent-slots` | every coordinator user on the machine | the shared slot directory (`/var/lib/worklane/agent-slots`) and its config (`/etc/worklane/slots.json`) |

## Setup

Setup ships as scripts in `scripts/setup/`, reviewed like any other change. Run them from a checkout of this repo as an admin user; they use `sudo` themselves. Don't paste setup commands from a page or a chat: copying out of a terminal can add trailing spaces and invisible characters, which break heredocs and line continuations. Every script is safe to run again and stops at the first error.

| Script | Run | What it does |
|---|---|---|
| `node.sh <version>` | once per machine | Downloads Node.js and that release's `SHASUMS256.txt` from nodejs.org, verifies the tarball, installs it to `/opt`, links it from `/usr/local/bin`. Refuses if another `node` is already on PATH. |
| `machine.sh [--cap N]` | once per machine | Creates `/srv/worklane`, `/var/lib/worklane`, `/etc/worklane`; the `agent-slots` group, the slot directory and `/etc/worklane/slots.json` (a fixed cap, default 2; an existing file is kept). Installs `bubblewrap` and `socat`. If user namespaces are restricted, loads the distribution's `bwrap-userns-restrict` profile, or else a profile that lets only `/usr/bin/bwrap` create them; the machine-wide restriction stays on. |
| `instance.sh <name> [--eval]` | per instance | Creates `wl-<name>` (coordinator), `wl-<name>-agent` and optionally `wl-<name>-eval`, with private homes; the `wl-<name>-work` group; `/srv/worklane/<name>` (group-writable, setgid); lingering for the coordinator's service; and the sudoers rule. The rule is written to a dotted temp name (which sudo ignores), checked with `visudo -cf`, and only then moved into place. |
| `check.sh <name> [<other>]` | after setup | Read-only checks: the coordinator can run as its agent user and not as another instance's; the agent can't list the coordinator's home; bwrap works for the agent; the slots are writable; the sudoers file is valid. |

What the sudoers rule says:
- `Defaults:wl-<name> !use_pty`: without it, some distributions run the agent behind a pseudo-terminal, which breaks its JSON output.
- `Defaults>wl-<name>-agent umask=0002, umask_override`: files agents write stay group-writable, so the coordinator can clean up their worktrees.
- `wl-<name> ALL=(wl-<name>-agent) NOPASSWD: ALL`: the coordinator may switch to its own agent user (and eval user), and to nothing else.

## Credentials (the operator, not Worklane)

Each user signs in to its own accounts. Worklane never creates, reads or copies credentials.

- **Coordinator's GitHub credential: repo-scoped only.** Use a fine-grained personal access token limited to this instance's repo, or a GitHub App installed on only that repo. Never use a personal `gh auth login` session or a classic token, which reach every repo the account can. Run `bash scripts/setup/credentials.sh <name> github`; it stores the token with `gh` in the coordinator's own config dir and makes `gh` git's credential helper there. Point `credentials.yaml` `github.path` at that directory.
  - **Permissions, exactly what the coordinator uses:**
    - Contents: read and write. It fetches, lands changes on the default branch, and pushes lease refs under `refs/worklane/claims/`.
    - Issues: read and write. It lists, reads, creates and closes issues; adds and removes labels (and creates the backlog labels); sets assignees; comments; and reads label history.
    - Metadata: read. GitHub requires it, and the start-up scope check lists the token's repos.
  - **Nothing else.** The coordinator reads no check runs, commit statuses or Actions results today. Real PR landing will add Pull requests: read and write, plus Checks: read and Commit statuses: read, when it ships.
  - **Workflows is deliberately excluded.** GitHub refuses a push that changes `.github/workflows` without it, so an agent's change touching workflow files can't land through the coordinator. Those land by hand, through review.
  - **Set an expiry.** `instance show` prints it, and the coordinator's reports warn from 7 days before it expires, and on every report when the token has no expiry.
  - **Enforced at start.** The coordinator lists the repos its token can reach and refuses to start unless that is exactly the instance's repo. It refuses personal logins (`gho_`), classic tokens (`ghp_`) and App user tokens (`ghu_`) without asking GitHub. The token is never printed, and refusals give counts, not other repos' names. For GitHub Enterprise, set `WORKLANE_GITHUB_API` to the API base URL.
  - GitHub App credentials (`kind: app`) are not supported yet; use a fine-grained token for now.
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
