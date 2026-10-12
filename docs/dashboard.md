# The dashboard

A local web page over a coordinator's event log: issues and their status, decisions waiting on you, agent runs, estimated spend, the land queue, deploys and reports. It listens on `127.0.0.1` only (it refuses any other address). On an always-on machine, people sign in to the hub with their own GitHub account (see [Sign-in](#sign-in-each-person-with-their-own-github-account)); the dashboard's token is kept only as the owner's break-glass on the machine itself.

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
- Its token is the owner's break-glass: whoever holds it, on this machine, is the owner. Your GitHub login only names who answered; without it, the project's default owner. For anyone else, use the hub's sign-in.
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
sudo bash scripts/setup/credentials.sh dashboard-signin          # first: the sign-in App's client secret (below)
sudo bash scripts/setup/dashboards.sh --client-id <the App's client id> --public-url https://<machine>.<tailnet>.ts.net <name> [<name>...]
```

- Each instance gets its own dashboard service, `worklane-dashboard-<name>.service`, running as `wl-<name>`. It's the only process that reads that instance's log and records answers in it. It replaces running `dashboard.sh` in a terminal; don't run both, because they use the same port.
- A viewer user, `wl-dash`, runs the hub, `worklane-dashboard-hub.service`, on port 4399. The page shows an instance switcher, and every call, answers included, is forwarded to the selected instance's own dashboard, which applies its own checks.
- `wl-dash` can read each instance's `dashboard-token` file and traverse the directories leading to it, through ACLs. It can't list those directories, read any log, config or credential, or write anything outside its own home. The script checks all of this before it finishes. No instance user gets new access, so no instance can read or write another's log.
- The hub never hands an instance's token to the browser.
- One hub and one dashboard service per instance, whoever signs in: no process per person.

After adding an instance, run the script again with the full list.

## Sign-in: each person with their own GitHub account

People open the hub at its Tailscale HTTPS address and sign in with GitHub. On every request, each instance's own dashboard decides their role there from their permission on that instance's repo:

| Permission on the repo | Role | May |
| --- | --- | --- |
| admin | owner | everything: settings, held plans, high-risk (L3) merges, the console (message, stop), filing chat drafts, the audit log |
| maintain, write | writer | read runs, throughput, reports, intake and the digest; ask the chat; answer ordinary decisions and intake approvals; save views |
| triage, read | viewer | read the rest; no writes at all |
| none, or any error looking it up | none | nothing: the instance isn't listed, and any call to it gets 403 |

- The permission is read with the instance's own installation token (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), never with the person's token, and cached at most 5 minutes per instance and login. So someone removed from the repo loses access within 5 minutes.
- `project.owners` in the repo's config no longer grants anything on the dashboard; it still names who decisions are addressed to.
- The hub lists only the instances where the person has a role. A role sent by the browser is never trusted; the hub names the person to the instance in a header it sets itself.
- Sessions: a `__Host-session` cookie, HttpOnly, Secure and SameSite=Strict, holding a 256-bit random id that the hub stores only as an HMAC under the session secret. A session ends after 12 hours without a request, or 7 days after sign-in, whichever is first. Sign-out deletes it on the server.
- Every write (POST, PUT, DELETE) needs the session's CSRF token (derived from the session, so another session's is refused), and a write whose `Origin` isn't the hub's public URL is refused.
- The audit: every write records the GitHub login, the role, the instance and what was done (decision answers, settings and machine changes, chat questions and filed drafts, console messages and stops, saved views) as a `dashboard.audit` event in that instance's log. Owners see it at the bottom of the Activity page.
- The person's GitHub token is used once, to learn their login (`GET /user`), then revoked. It is never stored or logged.

### The sign-in App (the owner's step)

Create a GitHub App used only for "Sign in with GitHub" (GitHub: Settings, Developer settings, GitHub Apps, New GitHub App):

- **Callback URL:** `https://<machine>.<tailnet>.ts.net/auth/callback`, exactly the hub's public URL plus `/auth/callback`.
- **Expire user authorization tokens:** on (the default).
- **Request user authorization (OAuth) during installation:** off. **Enable Device Flow:** off.
- **Webhook:** off (uncheck Active).
- **Permissions:** none. Leave every repository, organization and account permission at "No access". The App is never installed on a repo; the dashboard reads repo permissions with each instance's own App.
- **Where can this GitHub App be installed:** only on this account.

Then generate a client secret on the App's page, and install it for the hub's viewer user only:

```bash
sudo bash scripts/setup/credentials.sh dashboard-signin
```

It asks for the client secret (not shown), writes it to `~wl-dash/.config/dashboard-signin/client-secret` (0400, `wl-dash` only), and generates a session secret beside it the first time (`--rotate-session` makes a new one, which signs everyone out). The client id isn't secret: pass it to `dashboards.sh --client-id`.

### Tailscale HTTPS (the owner's step)

The hub is reachable only over your tailnet, never the public internet:

1. In the Tailscale admin console, under DNS, enable **MagicDNS** and **HTTPS certificates**.
2. On the machine, forward HTTPS on the tailnet to the hub's sign-in port:

   ```bash
   sudo tailscale serve --bg --https=443 http://127.0.0.1:4399
   ```

   Tailscale terminates TLS with the machine's MagicDNS certificate, so browsers see `https://<machine>.<tailnet>.ts.net` and the Secure cookie works. The hub itself still listens on `127.0.0.1` only. Pass that URL to `dashboards.sh --public-url`.
3. To let a teammate in, share the machine with them (the machine's menu in the admin console: Share), and limit what they reach with an ACL in the tailnet policy file, for example:

   ```json
   { "action": "accept", "src": ["autogroup:shared"], "dst": ["<machine>:443"] }
   ```

   They then sign in with their own GitHub account; what they may do on each instance follows their permission on its repo.

### The break-glass (the owner, on the machine)

The hub's token still works, as the owner, but only on the hub's separate break-glass port, 4398, on the machine itself:

- `tailscale serve` forwards only port 4399, so every request on 4399 arrives from `127.0.0.1`. That's why the token is never accepted on 4399 at all: "from localhost" there would include every tailnet user.
- Port 4398 also listens on `127.0.0.1` only, is never forwarded, and refuses any request carrying a proxy's headers (`Tailscale-User-Login`, `X-Forwarded-For`, `X-Forwarded-Proto`, `Forwarded` and the like), whatever its address. Don't point `tailscale serve` at it.
- To use it from your laptop, tunnel to it over ssh and open the break-glass URL (the token is in `~wl-dash/.local/state/worklane/dashboard-hub/dashboard-token`):

  ```bash
  ssh -N -L 4398:127.0.0.1:4398 <you>@<always-on-host>
  # then: http://127.0.0.1:4398/?t=<token>
  ```

- Each instance's own dashboard applies the same rule to its own token: with no person named, it's the owner's break-glass, refused through a proxy.

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
   sudo bash scripts/setup/dashboards.sh --console-user <admin user> --console-devices tag:owner-laptop,my-phone --client-id <the App's client id> --public-url https://<machine>.<tailnet>.ts.net <name> [<name>...]
   ```

   `--console-devices` takes Tailscale tags (`tag:...`) and/or MagicDNS node names, comma-separated. Prefer tags that only you can assign in your tailnet policy, because a node can be renamed. The list lives in the hub's systemd unit on the machine, never in a repository. With no list, every device is refused.

   **This weakens the hub's sandbox.** With `--console-user`, the hub's unit drops `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and `PrivateTmp`. sudo can't switch users under NoNewPrivileges, and the admin's shell, a child of the hub, would otherwise see a read-only filesystem and a private `/tmp`. Without `--console-user`, the unit keeps all four.

How the device is identified: the hub sits behind `tailscale serve --https=443 http://127.0.0.1:4399` (Tailscale HTTPS, above).
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
