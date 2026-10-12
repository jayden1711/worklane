# The dashboard

A local web page over a coordinator's event log: issues and their status, decisions waiting on you, agent runs, estimated spend, the land queue, deploys and reports. It listens on `127.0.0.1` only and every API call needs the dashboard's token, which is in the URL it prints.

## For a project checkout

```bash
worklane dashboard            # from inside the checkout, or with --root <dir>
```

It reads the checkout's own log and opens the browser on port 4317.

## For an instance on an always-on machine

An instance's log lives in its coordinator user's home, which only that user can read. So the dashboard runs as that user, on the machine where the instance runs:

```bash
bash scripts/setup/dashboard.sh <name> [<your GitHub login>]
```

- It starts `worklane dashboard --instance <name> --no-open` as `wl-<name>`, in the foreground (Ctrl+C stops it).
- The port is fixed by the instance's name (4400-4899), so a tunnel set up once keeps working. `--port` on the CLI overrides it.
- Your GitHub login decides which decisions you may answer (yours, or any if you're one of the project's writers). Without it, the dashboard acts as the project's default owner.
- Answers are recorded in that instance's log, as its coordinator user, like `decide` on the command line.

### From another machine: an ssh tunnel

The dashboard never listens on the network. To open it from your laptop, forward the same port over ssh:

```bash
ssh -N -L <port>:127.0.0.1:<port> <you>@<always-on-host>
```

Then open the URL `dashboard.sh` printed (`http://127.0.0.1:<port>/?t=<token>`) on the laptop. The page moves the token out of the address bar on load. The token is stored in the instance's state directory, so it stays the same across restarts; delete `dashboard-token` there to issue a new one.

Each instance has its own port and token: run one `dashboard.sh` and one tunnel per instance.

## All instances in one view: the hub

To see every instance on the machine from one page and one tunnel, an admin reviews and runs, once:

```bash
sudo bash scripts/setup/dashboards.sh <your GitHub login> <name> [<name>...]
```

- Each instance gets its own dashboard service, `worklane-dashboard-<name>.service`, running as `wl-<name>`. It's the only process that reads that instance's log and records answers in it. It replaces running `dashboard.sh` in a terminal; don't run both, because they use the same port.
- A viewer user, `wl-dash`, runs the hub, `worklane-dashboard-hub.service`, on port 4399. The page shows an instance switcher, and every call, answers included, is forwarded to the selected instance's own dashboard, which applies its own checks.
- `wl-dash` can read each instance's `dashboard-token` file and traverse the directories leading to it, through ACLs. It can't list those directories, read any log, config or credential, or write anything outside its own home. The script checks all of this before it finishes. No instance user gets new access, so no instance can read or write another's log.
- The hub never hands an instance's token to the browser. You only ever hold the hub's token, which the script prints.

From the laptop, one tunnel for all of them:

```bash
ssh -N -L 4399:127.0.0.1:4399 <you>@<always-on-host>
```

Then open the hub URL the script printed. After adding an instance, run the script again with the full list.

## The owner terminal

The Setup console page on the hub can open a terminal: a login shell as the machine's admin user. sudo in it asks for that user's password every time. It's off until the owner turns it on, and it's refused, with a plain message and an entry in the hub's audit log (`terminal-audit.jsonl` in the hub's state), unless all of these hold:

- the person is the instance's owner, signed in with GitHub in the last 5 minutes;
- the request comes from a Tailscale device the owner listed;
- `sudo -n true` as the admin user fails, so sudo still needs a password.

Every command line is recorded in the audit log, except input typed while the terminal doesn't echo, such as a password. It closes after 10 minutes idle.

To turn it on, as root on the machine, after reviewing both scripts:

1. Install the console shell and its one sudoers line:

   ```bash
   sudo bash scripts/setup/console-shell.sh <admin user>
   ```

   The hub's viewer, `wl-dash`, may then run exactly `worklane-console-shell check` and `worklane-console-shell shell` as that user, and nothing else, never as root. The script refuses an admin user with a NOPASSWD sudo rule.
2. Re-run the hub setup with the admin user and your devices:

   ```bash
   sudo bash scripts/setup/dashboards.sh --console-user <admin user> --console-devices tag:owner-laptop,my-phone <your GitHub login> <name> [<name>...]
   ```

   `--console-devices` takes Tailscale tags (`tag:...`) and/or MagicDNS node names, comma-separated. Prefer tags that only you can assign in your tailnet policy, because a node can be renamed. The list lives in the hub's systemd unit on the machine, never in a repository. With no list, every device is refused.

   **This weakens the hub's sandbox.** With `--console-user`, the hub's unit drops `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and `PrivateTmp`. sudo can't switch users under NoNewPrivileges, and the admin's shell, a child of the hub, would otherwise see a read-only filesystem and a private `/tmp`. Without `--console-user`, the unit keeps all four.

How the device is identified: the hub sits behind `tailscale serve --https=443 http://127.0.0.1:4399` (#197).
- A terminal request counts only if the kernel says tailscaled (root) opened the connection, from `/proc/net/tcp`. A program on the machine connecting to the port itself is refused, whatever headers it sends.
- On such a connection, serve's `X-Forwarded-For` holds the peer's Tailscale address. serve replaces any `X-Forwarded-For` the browser sent.
- That address is looked up with `tailscale whois --json` for the node's name and tags.
- The `Tailscale-User-*` headers are never used: they name a person, not a device, and serve sets them only for user-owned nodes.

A request through an ssh tunnel, or on the break-glass port 4398, can't be tied to a device, so the terminal is refused there.

An open question, already on main: each instance's dashboard unit sets `NoNewPrivileges=yes`, and the dashboard calls `sudo -n /usr/local/libexec/worklane-machine` itself (Settings' machine settings, and the setup console's root steps; `src/machine.ts`). Under that flag sudo refuses to run, so these will likely fail under systemd with "no new privileges" until that call moves to the coordinator or the flag is dropped for that unit. It hasn't been tried on the machine.

## Pull requests

In PR mode, the **Pull requests** page (`g p`) shows every PR the harness opened, from its own events:
- **Auto-merge on this instance:** on, off or stopped, and why. It reads the same three things the coordinator reads: the instance policy's `auto_merge` kill switch (re-read each time), the repo's `review.yaml` `merge.auto`, and the stop file a red main leaves after an auto-merge, with its revert PR. The operator clears that file.
- **Waiting for you:** PRs the merge rules left to a person, and PRs whose CI fix runs gave up. Each one lists exactly why, with its checks on the current head and a link to review it.
- **In progress:** drafts whose checks are running, CI fix runs in flight, ready PRs. Expand one for its checks, why it isn't ready, and its fix attempts.
- **Auto-merged:** each PR, its merge commit, whether main stayed green, and the policy's reasons for merging it.
- PRs merged by a person or closed, and pushes the harness refused before they left (size, protected or refused paths).

The sidebar counts the PRs that need you. Through the hub, this is per instance.

## Look and feel

The pages use [Beautiful UI](https://www.beautifului.dev/)'s palette and patterns (MIT; see `THIRD_PARTY_NOTICES.md`), adapted to the dashboard's data:
- decisions are approval cards
- agent runs are task rows, and a run's steps are tool chips
- checks are records tables
- pages and the hub's instances are sidebar rows
- the headline figures are insight cards

The shared pieces live in `web/src/components/patterns.tsx` and `ui.tsx`. `test/web-render.test.ts` renders every page from the demo project's state and checks that its data is shown and that decisions stay answerable only where the server allows.

To see every page, light and dark, against a freshly seeded demo (needs Chrome or Chromium):

```bash
node scripts/dev/screenshots.mjs --out shots                  # this checkout, built
node scripts/dev/compare-screenshots.mjs --out shots          # origin/main vs the current branch: shots/before, shots/after
```

## The web UI

The engine install (`scripts/setup/engine.sh`) builds the UI into `dist/web`. In a source checkout, run `npm run build:web`. Without it the page says the UI isn't built.
