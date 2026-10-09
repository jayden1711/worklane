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
| `agent-slots` | every coordinator user on the machine | the shared slot directory and agent cap |

## Setup (root)

```sh
# Users: no password logins, homes private.
useradd --create-home --shell /bin/bash wl-<name>
useradd --create-home --shell /bin/bash wl-<name>-agent
chmod 0700 /home/wl-<name> /home/wl-<name>-agent

# Groups.
groupadd -f wl-<name>-work
usermod -aG wl-<name>-work wl-<name>
usermod -aG wl-<name>-work wl-<name>-agent
groupadd -f agent-slots
usermod -aG agent-slots wl-<name>

# Instance checkouts live under one root of their own (leave other services' directories alone).
install -d -o root -g root -m 0755 /srv/worklane
# The repo checkout: owned by the coordinator, group-writable, new files inherit the group.
install -d -o wl-<name> -g wl-<name>-work -m 2770 /srv/worklane/<name>

# The shared slot directory (once per machine).
install -d -o root -g agent-slots -m 2770 /var/tmp/agent-slots

# The coordinator may switch to its agent user, without a password, and to nothing else.
cat > /etc/sudoers.d/worklane-<name> <<'EOF'
Defaults:wl-<name> !use_pty
Defaults>wl-<name>-agent umask=0002, umask_override
wl-<name> ALL=(wl-<name>-agent) NOPASSWD: ALL
EOF
chmod 0440 /etc/sudoers.d/worklane-<name>
visudo -cf /etc/sudoers.d/worklane-<name>

# The coordinator's service keeps running without a login session.
loginctl enable-linger wl-<name>

# Claude Code's sandbox on Linux.
apt-get install -y bubblewrap socat
```

- **`!use_pty`:** without it, some distributions run the agent behind a pseudo-terminal, which breaks its JSON output stream.
- **`umask=0002`:** makes files agents write group-writable, so the coordinator can clean up their worktrees.
- **Ubuntu 24.04 and later:** if `sysctl kernel.apparmor_restrict_unprivileged_userns` prints `1`, don't turn that setting off machine-wide. Give bubblewrap alone the right to create user namespaces with a profile scoped to its binary, `/etc/apparmor.d/bwrap`:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  ```

  Load it with `apparmor_parser -r /etc/apparmor.d/bwrap`. Then check, as an ordinary user, that `bwrap --ro-bind / / --unshare-user true` exits 0.

For an eval lane, add `wl-<name>-eval` the same way:
- Add it to `wl-<name>-work`.
- Add it to the sudoers rule's runas list: `(wl-<name>-agent, wl-<name>-eval)`.
- Add the same `umask` line for it.

## Credentials (the operator, not Worklane)

Each user signs in to its own accounts. Worklane never creates, reads or copies credentials.

- **Coordinator's GitHub login:** as `wl-<name>`, run `GH_CONFIG_DIR=~/.config/<name>-gh gh auth login`. Use a dedicated account or token, never your own. Point `credentials.yaml` `github.path` at that directory.
- **Agent's Claude login:** as `wl-<name>-agent`, run `claude` and sign in, or set up a token with `claude setup-token`. See [auth.md](auth.md) for the options and Anthropic's terms for automated use.
- **Eval key (eval lanes only):** a file owned by `wl-<name>-eval`, mode 0400, named in `credentials.yaml` `eval_key`.

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
