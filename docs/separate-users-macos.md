# Hardened mode on macOS

The same model as [separate users on Linux](separate-users.md): per instance, a coordinator user that holds the credentials and an agent user that holds nothing; agent commands in Claude Code's sandbox; the coordinator as a root-owned service. The scripts are in `scripts/setup/macos/`. Run them from a checkout of this repo as an admin user, after reading them; they use `sudo` themselves.

| Script | Run | What it does |
|---|---|---|
| `macos/machine.sh [--cap N]` | once per machine | Creates `/etc/worklane`, `/var/lib/worklane` (root:wheel) and the checkouts root from `/etc/worklane/machine.json` `checkouts` (default `/var/worklane`: `/srv` can't be created on macOS, its system volume is read-only). The `agent-slots` group, the slot directory and `/etc/worklane/slots.json` (root:wheel 0644). Checks that Seatbelt (`/usr/bin/sandbox-exec`) runs; there is nothing to install, unlike bubblewrap and socat on Linux. |
| `macos/instance.sh <name> [--eval]` | per instance | `wl-<name>`, `wl-<name>-agent` (and `wl-<name>-eval`) as hidden Directory Services accounts (ids 400–499): no password (nobody logs in as them; their shell is bash, as on Linux, for `sudo -iu`), each with its own primary group (never `staff`), a private home (0700) in `/Users`. The `wl-<name>-work` group; the checkout directory (owner the coordinator, group work, 3770: agents add files, never rename or remove the coordinator's). The same sudoers rule as on Linux, through the same dotted temp name, `visudo -cf`, then move. |
| `machine-helper.sh <name>...` | once per machine | The same script as on Linux; it uses root's group (`wheel` on macOS). |
| `macos/service.sh <name> [options]` | per instance | The coordinator as a launchd daemon, `/Library/LaunchDaemons/com.worklane.coordinator.<name>.plist` (root:wheel 0644, checked with `plutil -lint` under a dotted temp name, then moved in), run as `wl-<name>`, restarted on failure. `--print` shows the plist. |
| `macos/dashboards.sh <login> <name>...` | once per machine | Each instance's dashboard as its own daemon, and the hub as `wl-dash`. `wl-dash` gets `search` (traverse, no listing) on the directories above each dashboard token and `read` on the token, through `chmod +a` ACLs, and nothing else. |
| `macos/check.sh <name> [<other>]` | after setup | PASS/FAIL/SKIP per check: the coordinator can switch to its agent user and not to another instance's; the agent can't use sudo, isn't in admin, staff or wheel, can't list the coordinator's home or any login user's home, can't read the instance's credentials, settings or service log, can't rename or remove what the coordinator owns in the checkout, can't write the engine, `/etc/worklane`, sudoers or `/Library/LaunchDaemons`, can't take a slot; can't reach another instance's home or checkout; and under the Seatbelt rule Claude Code's sandbox uses (no network but localhost, where its proxy listens) it reaches a local port and nothing else. |

`engine.sh`, `credentials.sh`, `checkout.sh` and `machine-helper.sh` are shared with Linux: they use no systemd, so on macOS they load the macOS helpers (`home_of` from Directory Services, root's group `wheel`, checkouts from `machine.json`, state in `~/Library/Application Support/worklane`). The scripts that write systemd units (`service.sh`, `dashboards.sh`, `updates.sh`, `journal.sh`) stop on macOS before changing anything; use the `macos/` ones. There is no macOS `updates.sh` yet: the updater builds in a systemd `DynamicUser` unit and restarts systemd units, so on macOS update the engine with `engine.sh <ref>`.

Order on a new Mac: `macos/machine.sh`, `macos/instance.sh <name>`, `engine.sh <ref> <name> <owner/repo>`, `credentials.sh <name> ...`, `checkout.sh <name> <owner/repo>`, `macos/service.sh <name>`, then `macos/check.sh <name>`; `machine-helper.sh` and `macos/dashboards.sh` once all instances exist.

## The sandbox

Claude Code's sandbox on macOS is Seatbelt, built into the OS. Agent commands get it the same way as on Linux, from the lane settings each run is given with `--settings` (`src/sandbox.ts`): `failIfUnavailable`, no unsandboxed retry, the denied reads (the coordinator's home and the agent's credential stores; on macOS also `~/Library/Keychains`) and the lane's `allowedDomains`, enforced by its proxy. Seatbelt blocks every connection but the one to that proxy. The engine itself runs no sandbox directly on either OS: project commands (checks, test suites) run as the agent user, which is what keeps them from the coordinator's credentials, on macOS as on Linux.

## What macOS can't match

Compared with the Linux systemd units and their cgroups:

- **Memory:** no hard cap (`MemoryMax`) and no throttle (`MemoryHigh`). The RSS resource limit isn't enforced on macOS. A runaway test grows until the machine pages or the kernel kills something.
- **CPU and IO share:** no weights or quotas between instances. The daemon runs at nice 10 with low-priority IO, inherited by its agents, so other work wins under contention. Not `ProcessType=Background`, which on Apple silicon keeps processes on the efficiency cores even when the machine is idle.
- **Processes and open files:** limited (`--max-procs`, default 2048; `--max-files`, default 8192). The process limit counts per user, so it bounds one instance's agents together, like `TasksMax`.
- **Stopping:** launchd stops the coordinator, which stops its agents. It has no cgroup to kill an agent that escaped into its own process group.
- **Private /tmp:** none. Each instance gets its own `TMPDIR` (`/var/tmp/worklane/<name>`, shared with its agents only), which covers tools that honor `TMPDIR` but not a fixed `/tmp` path. On Linux, Claude Code keeps one at `/tmp/cc-socks`; whether its macOS sandbox does too isn't verified.
- **Read-only system paths for the service** (`ProtectSystem`, `ProtectHome`, `NoNewPrivileges`): no launchd equivalent. File permissions and System Integrity Protection protect them instead.
- **Keychain:** denying the keychain files doesn't stop the `security` tool, which asks the keychain service over IPC. Agents keep nothing in their keychain.
- **The agent's Claude login:** Claude Code on macOS keeps its login in the user's keychain. Whether that works for a hidden account without a login session (`credentials.sh <name> claude`) isn't verified yet; if it doesn't, the agent user needs a token in its environment instead.
- **Automatic engine updates:** not on macOS yet (see above).
