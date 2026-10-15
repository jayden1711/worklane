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

Then open the URL `dashboard.sh` printed (`http://127.0.0.1:<port>/`) on the laptop. The page asks once for the dashboard key: it is the `dashboard-token` file in the instance's state directory, readable only by its user. The page sends it in the `Authorization` header, the live streams included, and keeps it in that browser tab only. A key never goes in a URL: any request whose URL carries one (`?t=`, `?token=`, `?key=` and the like, or the key's value under any name) is refused with a 401, on every route of the dashboard and the hub, so a key never ends up in history, proxy logs or a referrer. The key stays the same across restarts; delete `dashboard-token` to issue a new one.

Each instance has its own port and token: run one `dashboard.sh` and one tunnel per instance.

## All instances in one view: the hub

To see every instance on the machine from one page and one tunnel, an admin reviews and runs, once:

```bash
sudo bash scripts/setup/dashboards.sh --setup --public-url https://<machine>.<tailnet>.ts.net   # first: the sign-in App (below)
sudo bash scripts/setup/dashboards.sh [--machine-owner <login>] <name> [<name>...]
```

The second command takes the sign-in App's client id and the public URL from where setup mode stored them; `--client-id` and `--public-url` override them (and are needed when the App was made by hand).

- Each instance gets its own dashboard service, `worklane-dashboard-<name>.service`, running as `wl-<name>`. It's the only process that reads that instance's log and records answers in it. It replaces running `dashboard.sh` in a terminal; don't run both, because they use the same port.
- A viewer user, `wl-dash`, runs the hub, `worklane-dashboard-hub.service`, on port 4399. The page shows an instance switcher, and every call, answers included, is forwarded to the selected instance's own dashboard, which applies its own checks.
- Every page shows the selected instance only: its Board columns and counts, its test runs, what waits on you, and so on. The agent and test slots are shared by every instance on the machine, so each instance's pages count all of them, but name only its own holders; another instance's show as "another instance or job on this machine". **All instances**, at the bottom of the switcher, is off unless you choose it: the Board, its test runs and the Machine page's instances table then show every instance you have a role on, each item labelled. Picking an instance turns it off again.
- A live stream re-reads the person's role (from the 5-minute cache) before each change goes out, and ends once they have none.
- `wl-dash` can read each instance's `dashboard-token` file and traverse the directories leading to it, through ACLs. It can't list those directories, read any log, config or credential, or write anything outside its own home. The script checks all of this before it finishes. No instance user gets new access, so no instance can read or write another's log.
- The hub never hands an instance's token to the browser.
- One hub and one dashboard service per instance, whoever signs in: no process per person.

After adding an instance, run the script again with the full list.

## Sign-in: each person with their own GitHub account

People open the hub at its Tailscale HTTPS address and sign in with GitHub. On every request, each instance's own dashboard decides their role there from their permission on that instance's repo:

| Permission on the repo | Role | May |
| --- | --- | --- |
| admin | owner | everything: settings, held plans, high-risk (L3) merges, the console (message and stop a run; asks, root steps, the terminal), filing chat drafts, the audit log |
| maintain, write | writer | read runs, throughput, reports, intake and the digest; message (steer) a running agent, not stop it; ask the chat; answer ordinary decisions and intake approvals; save views |
| triage, read | viewer | the tasks (without costs), decisions, PRs and deploys; not the service log, the machine settings, spend, the budget, agent runs, which agents hold the slots (only the counts), the coordinator's error text (only a count) or decisions' receipts; of the event log (the issue timeline, Activity, the live stream) only an allowlist of event types and fields (`src/viewer-events.ts`: never runs, agents, research, chat, console or costs), and of the settings only the project part. No writes at all; no Watch on the Board, and Board cards without runs, usage, diffs or checks |
| none, or any error looking it up | none | nothing: the instance isn't listed, and any call to it gets 403 |

- The permission is read with the instance's own installation token (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`), never with the person's token, and cached at most 5 minutes per instance and login. So someone removed from the repo loses access within 5 minutes.
- `project.owners` in the repo's config no longer grants anything on the dashboard; it still names who decisions are addressed to.
- The hub lists only the instances where the person has a role. A role sent by the browser is never trusted; the hub names the person to the instance in a header it sets itself.
- Sessions: a `__Host-session` cookie, HttpOnly, Secure and SameSite=Strict, holding a 256-bit random id that the hub stores only as an HMAC under the session secret. A session ends after 12 hours without a request, or 7 days after sign-in, whichever is first. Sign-out deletes it on the server.
- Every write (POST, PUT, DELETE) needs the session's CSRF token (derived from the session, so another session's is refused), and a write whose `Origin` isn't the hub's public URL is refused.
- The audit: every write records the GitHub login, the role, the instance and what was done (decision answers, settings and machine changes, chat questions and filed drafts, console messages and stops, saved views) as a `dashboard.audit` event in that instance's log. Owners see it at the bottom of the Activity page.
- The person's GitHub token is used once, to learn their login (`GET /user`), then revoked. It is never stored or logged.

### The sign-in App (the owner's step)

The hub can't sign anyone in before its sign-in App exists, and GitHub's manifest flow, which makes the App in a few clicks, needs a running hub to send the browser back to. Setup mode breaks that loop. With Tailscale HTTPS set up (below):

```bash
sudo bash scripts/setup/dashboards.sh --setup --public-url https://<machine>.<tailnet>.ts.net
```

- It starts `worklane-dashboard-hub-setup.service` as `wl-dash`, on 127.0.0.1:4399 (the port `tailscale serve` forwards). It has no instances and no sign-in: it serves one page, which makes the sign-in App.
- It prints the hub's URL (a line `setup-mode hub: <url>`) and the path of a one-time setup token, `~wl-dash/.local/state/worklane/dashboard-hub/setup-token`, 0600, `wl-dash`'s. Only someone with root on the machine can read it: `sudo cat` it and paste it into the page. The token is never printed, logged, put in a URL (a link carrying `?token=` is refused) or passed as an argument.
- The token works once. The browser that used it gets a setup session: a `__Host-setup` cookie (HttpOnly, Secure, SameSite=Lax so GitHub's redirect back carries it) for 2 hours. The token file is deleted. Ten wrong tokens lock the page until the next `--setup`. Every form checks the `Origin` and the page's CSRF token.
- The page asks which GitHub account or organization owns the App, then posts the manifest to GitHub: no permissions, no webhook, the callback `<public URL>/auth/callback`. GitHub sends the browser back with a one-time code. The hub exchanges it, and stores the client secret, a session secret, the client id and the public URL in `~wl-dash/.config/dashboard-signin/` (0700; each file 0400, `wl-dash` only). The App's private key isn't kept.
- Setup mode then turns itself off: the process exits, and nothing answers on 4399 until the real hub starts. It also turns off if the client secret appears some other way (`credentials.sh dashboard-signin`). It won't start again while the secret exists: `--setup` is refused.
- Then run `dashboards.sh <name>...` as above. It removes the setup-mode unit and starts the real hub with the stored client id and URL. The setup page shows the exact command.

**No https origin yet.** Before Tailscale is set up, `--setup --loopback` takes the place of `--public-url` (the install command does this by itself when it finds no origin):

```bash
sudo bash scripts/setup/dashboards.sh --setup --loopback
```

- The same unit, page and one-time token, on `http://127.0.0.1:4399/`. From your own computer, `ssh -L 4399:127.0.0.1:4399 <you>@<server>` first, then open that URL.
- It answers only a request made on the machine itself (through the tunnel) to a loopback name: anything carrying a proxy's headers (`tailscale serve` adds them) or another `Host` is refused, as on the break-glass port. Its session cookie is `setup-loopback` (HttpOnly, SameSite=Strict; not Secure, since the page is plain http on loopback).
- The sign-in App step never starts GitHub's manifest flow here: GitHub sends the browser back to an https address, and there isn't one. The page shows Tailscale and HTTPS (the wizard's screen 7) first, as root commands: `scripts/setup/tailscale.sh install`, `up` and `serve`. Then run the install command (or `--setup --public-url https://<name>`) again: setup mode restarts at the origin with a new token, and the App step goes on there.

The first-run page's "Dashboard sign-in (GitHub App)" step shows the `--setup` command, and says when the hub is in setup mode.

**A machine's first project.** The agents' App is made through the manifest flow, which comes back to the hub, and add-project starts the hub in its last step (an instance's own dashboard can't start before its checkout exists, and the checkout needs the App). So when the machine has no hub yet, add-project's App step starts the hub alone first, with `dashboards.sh --no-instances` and what setup mode stored, then goes on; its last step adds the instance to the hub as before. The order for a first project is: `dashboards.sh --setup`, the sign-in App, `add-project.sh <name> <owner/repo>` (which starts the hub, then asks for the two GitHub clicks). If there is no sign-in App yet, the App step stops and names the `--setup` command. `--no-instances` takes no names and is refused once the hub serves an instance. A second project is unchanged: the hub is there, and is never started alone.

By hand instead, create a GitHub App used only for "Sign in with GitHub" (GitHub: Settings, Developer settings, GitHub Apps, New GitHub App):

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

### Making the Apps through GitHub's manifest flow

Instead of creating an App by hand, `sudo worklane app-manifest <name> <owner/repo>` makes the instance's agent App, and `sudo worklane app-manifest <name> <owner/repo> --signin --public-url https://<machine>.<tailnet>.ts.net` makes the sign-in App. With the hub running, it prints a link. A machine owner opens it, signed in to the dashboard, and approves the App on GitHub. The link works once and lasts 10 minutes. GitHub then sends the browser back to the hub's `/setup/app-manifest/callback`. The hub exchanges the code, and the command writes the result for its one user, at the paths above: the agent App's key for `wl-<name>` (0400), or the sign-in App's client secret for `wl-dash`. Neither is ever logged. For the agent App, it then prints the install link: install the App on exactly `<owner/repo>`. It finds the installation and runs the same check as `credentials.sh` (`app-permissions.mjs`), refusing an installation that reaches any other repo. Only after that check passes does it write `credentials.yaml`. The agent App asks for contents, issues, pull requests and checks write, plus actions and metadata read: never Workflows, Administration or Actions write. `credentials.sh` stays the manual fallback.

The Setup console's Add project is the screen for the agent App (first-run screen 5). Pick the repo from the list, or type a private one as owner/name: GitHub lists only public repos to the dashboard, which keeps no GitHub token. Add project then makes the App through the manifest flow only, and GitHub's install page opens with that repo preselected; an installation that reaches any other repo is refused. GitHub's one-time code is exchanged by the hub and used once; the App's private key, client secret and webhook secret go straight to the coordinator user's own files (`~wl-<name>/.config/<name>-app/`, each 0400 in a 0700 directory) and never to a URL, a log, an argument, an event or the repo. The screen is optional: `sudo bash scripts/setup/add-project.sh <name> <owner/repo>` runs the same steps at a root shell, and adding the same project again picks up where it stopped.

### Tailscale HTTPS (the owner's step)

The hub is reachable only over your tailnet, never the public internet. The steps are below by hand; [Tailscale and HTTPS from the dashboard](#tailscale-and-https-from-the-dashboard) does the same from the Machine page, and `scripts/setup/tailscale.sh` from a terminal.

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
- To use it from your laptop, tunnel to it over ssh and open the break-glass URL; the page asks once for the key (it is in `~wl-dash/.local/state/worklane/dashboard-hub/dashboard-token`) and sends it in a header, never the URL:

  ```bash
  ssh -N -L 4398:127.0.0.1:4398 <you>@<always-on-host>
  # then: http://127.0.0.1:4398/  (give the key on the page)
  ```

- Each instance's own dashboard applies the same rule to its own token: with no person named, it's the owner's break-glass, refused through a proxy.

## The owner terminal

The Setup console page on the hub can open a terminal: a login shell as the machine's admin user. sudo in it asks for that user's password every time. It's off until the owner turns it on, and it's refused, with a plain message and an entry in the hub's audit log (`terminal-audit.jsonl` in the hub's state), unless all of these hold:

- the person is signed in and is the instance's owner, and the request carries the session's CSRF token (the page offers it as a WebSocket subprotocol, `csrf.<token>` beside `terminal.v1`, since a browser can't set headers on the upgrade; the hub answers with `terminal.v1` alone), from this site's origin;
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

## Machine owners

The machine itself (the agent and test-run slot caps, engine updates) belongs to its machine owners, a list of GitHub logins, not to each instance's owners:

```bash
sudo bash scripts/setup/dashboards.sh --machine-owner <login>[,<login>...] [--console-user ... --console-devices ...] --client-id <id> --public-url https://<machine>.<tailnet>.ts.net <name> [<name>...]
```

The list goes to `/etc/worklane/machine-owners.json` (`{"owners": ["<login>", ...]}`, root:root 0644; `src/machine-owners.ts`). A rerun without `--machine-owner` keeps it. A machine change from the dashboard (Settings, or a root step) needs all of:
- the instance's owner, who is also a machine owner;
- a signed-in session, with its CSRF token;
- one of the console's allowed devices (`--console-devices`), as the hub identifies it for the terminal.

The instance's dashboard checks these before it records the request, and the coordinator checks the machine owner again before it runs it. The break-glass (port 4398, on the machine) is still allowed. An instance owner who isn't a machine owner sees the machine settings read-only, with the machine owners' logins. With no file (or one anyone but root may write), there are no machine owners, and only the break-glass may change the machine.

The first install sets the first machine owner: `sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>` asks for your GitHub login (or reads it from `gh api user` when gh is signed in, and asks you to confirm; `--machine-owner <login>` skips the question), writes it with `scripts/setup/machine-owners.sh --first`, and keeps a list that is already there. At the end it prints the dashboard's URL (`--public-url`, else this machine's Tailscale name) and how to make the sign-in App: through GitHub's manifest flow (`worklane app-manifest <name> <owner/repo> --signin`, which it runs itself once the hub is up), or by hand (`credentials.sh dashboard-signin`). After that, everything happens in the dashboard.

## Add project

The Setup console's **Add project** sets up a new instance on this machine: a name (`^[a-z][a-z0-9-]{0,20}$`) and the GitHub repo (`owner/name`), checked in the page and again on the server. It's enabled only for an owner of the instance you're on who is a machine owner, signed in, on one of the console's allowed devices (the same rules as a machine change, above). Anyone else sees it disabled, with the reason and the machine owners' logins.

A submit is recorded as the machine request `add-project <name> <owner/repo>` (`POST /api/machine/add-project`; the view is `GET /api/add-project`, `src/console/add-project.ts`), with an audit entry; a refused one is audited too. The dashboard never runs it. The coordinator runs the machine helper, which runs the installed engine's `scripts/setup/add-project.sh` as root. One project at a time.

The view then follows the run live, step by step, in the script's order: instance, app, claude-token, checkout, policy, service, test-user, machine-helper, dashboards. Each step's line from the script is an `add_project.step` event in the instance's log, so every step is on record. What it needs from you shows in the same view, as asks: GitHub's two approve links (create the App, then install it on exactly that repo), and the agent's Claude token (from `claude setup-token`), pasted into the dashboard's password box. The coordinator hands the token to the script once, on its input, for the agent user only, and deletes its copy; it's never in an event or a log, and never shown again. If a step fails, the view names it and the command to retry it. Fix what it says and add the same project again: the steps already done are skipped.

**On a machine whose sudo is older than 1.9.10** (the first sudo that reads a rule's `^...$` arguments as a pattern), `machine-helper.sh` doesn't install the helper's `add-project` rule. It prints `REFUSED` for it and records this in `/etc/worklane/helper-rules.json`. Add project then shows no button that could only fail at sudo. It shows why, and the root command to run on the machine, with the name and repo you type filled in: `sudo bash /opt/worklane/current/scripts/setup/add-project.sh <name> <owner/repo>`. The server refuses a submit with the same command, and a run that sudo refuses on a machine set up before that record says so too.

## First-run screens: skip, run again, or automate

The First run page (`/first-run`) lists every setup step, each with its state checked live. A step that the page can fix has a screen of its own: a button that shows its plan, a form, or Start. Every screen works three ways:

- **Skip it.** An owner can press **Skip** on any step that isn't done. The page then shows it as skipped and stops counting it as left; **Undo skip** brings it back. A skip changes only the page: `worklane doctor` and `worklane init` still check the step.
- **Run it again later.** Settings has a **Setup screens** list with each screen's state. Its link opens that step on the first-run page (`/first-run?step=<id>`), even when the step is done, so it can be run again.
- **Do it without the page.** Each screen names the command or config key that does the same thing, and the table below lists them all. The test `test/setup-automation.test.ts` checks that the table and the page agree.

**A config change from the page (a checkout).** The first-run page acts on the config the checkout has now, read again on each request, not the one the dashboard started with. The Repo config form proposes a change as a PR from a branch of its own (`worklane/config-...`). Once it has, **Merge PR #n here** shows the `gh pr merge` command and, on Confirm, merges that PR (only an open one from the form's own branch into the default branch). It then fast-forwards the checkout's default branch to origin's (`src/checkout-sync.ts`). It is only ever a fast-forward: never a reset, a merge commit or a rebase. It is refused, with why and the `git pull --ff-only` to run, if the checkout has uncommitted changes to tracked files, has commits origin doesn't, or is on another branch. The next step reads the new config with no restart and no `git pull`. Setup mode's own merge already brought its config in the same way (a fetch and `git merge --ff-only`, as `init` does).

**Before the config exists (setup mode).** A checkout with no `.worklane/` yet has no config for the dashboard to load. In that case `worklane dashboard --root <repo>` starts in setup mode and prints `http://127.0.0.1:<port>/first-run`, with no key in it, and the path of the dashboard key file (only you can read it). The page asks for the key once, in a hidden field or by choosing that file, sends it as a header and keeps it in that tab only. `worklane init` offers to open the same page when it stops at the repo config. Setup mode works like this:

- The first-run page is the whole dashboard, and every address shows it.
- From the page you can:
  - pick the repo's GitHub origin;
  - answer auto-config's questions;
  - draft the config, which runs the project's commands on a scratch copy of the default branch, so it asks for a confirmation first;
  - merge the setup PR that the draft opens.
- Start is refused until the config exists.
- Once the merged config is in the checkout, the normal dashboard takes over at the same address with the same key, and the page reloads.

| step | mode | without the page |
|---|---|---|
| Tools: git, gitleaks, claude (and gh, locally) | local, server | `worklane init --yes (local: the same pinned tools); on a server, scripts/setup/tools.sh through bootstrap.sh --hardened` |
| Signed in to Claude | local | `claude auth login (in a terminal, as this user)` |
| The agents' Claude login | server | `scripts/setup/credentials.sh <name> claude (paste the token claude setup-token prints at its hidden prompt), or scripts/setup/add-project.sh <name> <owner/repo> (its claude-token step)` |
| Signed in to GitHub (gh), able to push | local | `gh auth login --web (in a terminal, as this user)` |
| The repo has a GitHub origin | local | `git remote add origin https://github.com/<owner>/<name>.git, then git fetch origin` |
| The agents' GitHub App | server | `sudo bash scripts/setup/add-project.sh <name> <owner/repo> (its app step: the App through the manifest flow, installed on that one repo)` |
| Default branch known | local | `git fetch origin <branch>, then git remote set-head origin --auto` |
| Auto-config questions answered | local | `worklane init --answer <id>=<choice> (or answer init's questions in a terminal)` |
| .worklane/ valid and on the default branch | local, server | `worklane init (drafts the config and proposes it as a PR), then gh pr merge <number>, then worklane init again (it fast-forwards)` |
| Hooks for local runs installed | local | `worklane install` |
| Owners and writers set | local, server | `a reviewed commit (PR) to .worklane/config.yaml (owners.writers, required_checks) and .worklane/agents.yaml (daily_budget_usd, roles.workers count and model)` |
| Required checks named | local, server | `a reviewed commit (PR) to .worklane/config.yaml (owners.writers, required_checks) and .worklane/agents.yaml (daily_budget_usd, roles.workers count and model)` |
| Budget, models, guardrails, review levels | local, server | `a reviewed commit (PR) to .worklane/config.yaml (owners.writers, required_checks) and .worklane/agents.yaml (daily_budget_usd, roles.workers count and model)` |
| Pre-commit secret scan | local | `worklane install --git-hooks` |
| Guardrail fingerprints fetched | local, server | `worklane guardrails refresh` |
| Default branch protected | local, server | `gh api --method PUT repos/<owner/repo>/branches/<branch>/protection --input <body.json>, the body from config.yaml required_checks and protection.strict (src/branch-protection.ts classicChecks)` |
| The instance's policy | server | `the instance's policy.yaml: budget.daily_usd, agents.max_workers, land_mode, auto_merge, main_watch` |
| Discord intake and chat | server | `sudo bash scripts/setup/credentials.sh <name> intake-discord (the bot token), then intake.yaml in the instance home (guild, channels, owners, people; docs/intake.md) and a restart of the instance` |
| Reachable over Tailscale (HTTPS) | server | `sudo bash scripts/setup/tailscale.sh install, then up, serve and public-url (one step each; status reads only)` |
| Engine updater set up | server | `sudo bash scripts/setup/updates.sh [--channel release] [--signer <principal> ssh-ed25519 <public key>] (or --confirm-signer SHA256:<fingerprint> for a signer staged on the Machine page), then sudo /usr/local/libexec/worklane-machine set-updates on` |
| The instance's coordinator running | server | `sudo bash scripts/setup/service.sh <name> (add-project.sh runs it)` |
| The coordinator running | local | `worklane up` |
| An issue ready for the harness | local | `gh issue create --label ready --title "<what to do>" --body-file <a file with **Outcome:** and a ```done_when block>` |

## Tailscale and HTTPS from the dashboard

The first-run wizard's Tailscale screen, for a server. It is the Machine page's **Tailscale and HTTPS** card (`/machine#tailscale`; the first-run step "Reachable over Tailscale (HTTPS)" opens it, and it stays there to run again). It's optional: on a machine without Tailscale, or if you never confirm a step, nothing changes and the hub keeps its URL.

It's visible only to machine owners: the server sends everyone else none of its data (`GET /api/tailscale`, `src/tailscale-setup.ts`), and a local checkout has no such screen. It shows whether tailscale is installed and up (what `scripts/setup/tailscale.sh status --json` says, read as the instance's own user), the hub's URL now, and four steps in order. Each step shows what it changes first and needs a second click; each is a machine request, gated like any machine change (an owner here who is a machine owner, signed in, on an allowed device; or the break-glass), audited, one at a time:

| Step | Machine request | What runs, as root | Without the dashboard |
| --- | --- | --- | --- |
| Install Tailscale | `tailscale install` | Tailscale's apt repository for this distribution, its signing key checked against the fingerprint pinned in `scripts/setup/lib.sh`, then the pinned version of the package. No install script. A tailscale already there is left alone. | `sudo bash scripts/setup/tailscale.sh install` |
| Log this machine in | `tailscale up` | `tailscale up` with no auth key. It prints a login link and waits 10 minutes. | `sudo bash scripts/setup/tailscale.sh up` |
| Put the hub on HTTPS | `tailscale serve` | `tailscale serve --bg --https=443 http://127.0.0.1:4399`, and nothing else. | `sudo bash scripts/setup/tailscale.sh serve` |
| Set the hub's public URL | `tailscale public-url` | `dashboards.sh` with the hub's own settings and `--public-url https://<this machine's tailnet name>`. | `sudo bash scripts/setup/tailscale.sh public-url`, or `sudo bash scripts/setup/dashboards.sh --client-id <id> --public-url https://<name> <instance>...` |

The dashboard never runs any of it: the coordinator runs the machine helper, which takes exactly those four commands (two fixed words each; no auth key, flag, URL or port can be passed) and starts the step as its own unit, `worklane-tailscale.service`. The card follows the step from the script's progress file, `/var/lib/worklane/tailscale/steps.jsonl`.

**The login link** goes to the owner only. The script writes it to `/var/lib/worklane/tailscale/login-url`, mode 0400, owned by the asking instance's coordinator user, and deletes it when `up` ends. The dashboard serves it only to a machine owner, only while `up` waits, and only if it is exactly Tailscale's login page (`https://login.tailscale.com/a/<id>`); it shows as an "Open Tailscale's login page" button. The link is never in an event, an audit entry, the journal or the machine changes log. No auth key is used anywhere on this path.

**Two things stay on other sites.** MagicDNS and HTTPS certificates are turned on in Tailscale's admin console (DNS); until they are, the HTTPS step says so and links there. After the URL step, set the sign-in App's callback URL on GitHub to exactly `https://<name>/auth/callback`: sign-in at the new URL fails until you do. The hub restarts for that step, so a session at the old URL ends; the break-glass still works.

What it can never do:

- Turn on Tailscale Funnel, or publish anything outside your tailnet. There is no funnel command on this path, `tailscale serve` is tailnet-only, and the hub itself listens on `127.0.0.1`. The card shows Funnel's state read-only; if Funnel is already on, the HTTPS and URL steps do nothing until an admin turns it off (`tailscale funnel reset`).
- Choose what is forwarded or where: the serve step is one fixed command to the hub's sign-in port. It never forwards the break-glass port (4398) and never replaces something else already on 443.
- Change what `tailscale up` exposes: it is run with no flags (no exit node, routes, SSH, login server or auth key).
- Set the hub's URL to anything but this machine's own `*.ts.net` name, which the script reads from `tailscale status` on the machine; nobody types it.
- Install a package that isn't signed by the pinned key.

## Discord: the bot's token, invite link and channels

On a server instance, the First run page's **Discord** step (`src/intake/discord-setup.ts`; Settings links to it, and it opens again on a finished step as Change) sets up the chat bot. It is optional. Opening it, loading the bot's channels and reviewing a change write nothing; each write is an owner's, confirmed first, and audited (refusals too). Writers read where it stands. docs/intake.md section 10.1 has the script for each part.

What it can change, all as the instance's coordinator user (the user its dashboard runs as), and nothing as root:

- **The token.** Paste the token opens a paste box: a `paste_secret` ask for the credential `intake-discord` (`POST /api/first-run/discord/token-ask`). The value goes through the setup console's secret route, from the browser straight to `~/.config/<name>-secrets/intake-discord` (0400, in a 0700 directory), is refused unless it is shaped like a bot token, and `credentials.yaml` `intake.discord_token` is then pointed at the file through the same code as `credentials.sh <name> intake-discord` (`setDiscordToken`, `src/instance.ts`).
- **`intake.yaml`**, in the instance home (0600): only `discord.enabled`, `guild`, `channels`, `asks_channel`, `ops_channel`, `chat_channels`, `dashboard_url` and `superfan.enabled`, `channel`, `machine_channel`, picked from the bot's own list. Review (`POST /api/first-run/discord/intake`) returns the exact diff and writes nothing; Confirm sends back that review's hash, and the server writes only if the file and the bot's list still give that very change. The result must pass the intake schema; a superfan channel is never one the bot reads.

What it can never do: read or show the token (the dashboard's process never opens the token file; the bot's application id, its invite link and its channels come from a child process, `<cli> discord channels --instance <name> --json`, which reads the token itself, asks only Discord's own API (its base URL is a constant: nothing can point it at another host) and prints names and ids only, `GET /api/first-run/discord/channels`, owners only; the child is always the installed engine's own `cli.js`, by absolute path: no PATH lookup, option, environment variable, config key or request changes which program runs); write any other file, or any other key of `intake.yaml` (who may send, people, owners and trusted stay by hand); post, read or change anything on Discord (the child process makes GET requests only); restart the instance (it shows the command); or run anything as root. A hub forwards these calls to the instance's own dashboard like every other, so the hub's user never holds the token either.

The invite link asks for exactly four permissions (View Channels, Send Messages, Create Public Threads, Send Messages in Threads; integer `309237648384`) and the `bot` scope. Creating the bot and turning on its Message Content Intent stay in Discord's developer portal: the step links there, and says whether the intent is on once the bot's view is loaded.

## Switching the agents' Claude account

Every agent on a machine uses one Claude login, stored for each agent user (each instance's agent user, which channel chat runs as too, and its eval user). To move them all to another account, on the machine:

```
sudo bash scripts/setup/claude-account.sh switch          # every instance; or name some
sudo bash scripts/setup/claude-account.sh status          # each agent user's account, token id and expiry; or name some
```

What `status` finds is kept in `/var/lib/worklane/claude-account/status.json` (root's, 0644; token ids, never a token). The first-run page's "The agents' Claude login" step reads it. add-project and `credentials.sh <name> claude` refresh their instance's records once its token is in, and a switch rewrites it.

The switch:

1. **Pauses** every running instance. Its coordinator gets SIGTERM, the per-instance stop, on its main process only: it starts no more runs, lets the ones it has going finish, then exits. An instance that wasn't running is left stopped.
2. **Takes the token** that `claude setup-token` prints on a machine signed in to the new account, pasted once and not shown.
3. **Waits** for the runs to finish, 30 minutes at most (`--timeout <minutes>`). An instance still busy then is stopped, and its unfinished runs are requeued when it starts again.
4. **Installs** the token in each agent user's own `~/.claude/.credentials.json`, mode 0600. The token is never an argument, a log line or an output.
5. **Checks** each agent user with `claude auth status`, run as that user, and with one minimal real call to the API as that user: Haiku, "Reply with the single word: ok", one turn, `--max-budget-usd 0.05`. `claude auth status` only says a credential is configured. A login it calls fine can still be refused by the API with a 401 on every run, which is what issue #463 was. A refused call isn't billed; an answered one costs about one short Haiku turn per agent user. **If the API refuses the new login for any user, the switch is refused.** Every agent user it was installed for is put back on the login it had before (its credentials file restored byte for byte, as that user, 0600). Each check line shows Claude's message, the switch's last line says "refused: the API refused the new login (Claude said: …)", and the instances resume on their previous login. The old credentials are held only in the script's memory while it runs, never in a file, an argument or a log line. `status` makes the same call for each signed-in user, records it in `status.json` (`api_ok`, `api_error`, with token-shaped strings redacted), and exits 1 when the API refused one. The first-run page's "The agents' Claude login" step reads it as not done.
6. **Resumes** each instance whose users all passed, and reports each instance's result. An instance whose check failed stays paused. The script remembers it, so once you've fixed the problem a rerun resumes it. Rerunning is always safe. A resumed instance on the new login also ends its Claude usage-limit pause, if it had one (`usage.resumed`, reason "account switched", and its watchdog incident resolved), since the old account's limit no longer applies; one resumed on its current login (no token came) stays paused until the reset.

From the dashboard, the Machine page's **Claude account** card shows the same status. It's visible only to machine owners: the server refuses everyone else its data (`GET /api/claude-account`, `src/claude-account.ts`). **Refresh** and **Switch account** are the machine requests `claude-account status` and `claude-account switch`, gated like any machine change (an owner here who is a machine owner, signed in, on an allowed device). The machine helper starts the switch as its own unit, `worklane-claude-account.service`, because the switch stops that coordinator too. The card follows the switch step by step from the script's progress file, `/var/lib/worklane/claude-account/switch.jsonl`. When the switch asks for the token, a password box appears in the dashboard of the instance that started it. The pasted token is stored for that instance's coordinator user only (0400). The script reads it once, as root, and deletes it. The token is never in an event, a response or the audit, which records only that a token was stored. The machine helper's sudoers rule needs rerunning once to allow `claude-account` (`machine-helper.sh` with every instance).

## When Claude refuses the login

`claude auth status` only says a credential is configured, not that Anthropic's API accepts it. A login can look signed in while every request comes back 401. So the runner reads Claude's own answer. A run that ends on an API authentication failure (HTTP 401 or 403, `authentication_error`, an invalid or expired API key or OAuth token, in claude's result or its stderr) ends `auth_failed`, not `failed`, with Claude's message (redacted) as its detail (`src/claude-auth-failure.ts`). A usage limit stays `rate_limited`, a token refresh that failed stays a transient error, and any other failure stays `failed`: none of them pauses anything.

One `auth_failed` run holds that login (the agent user's, or the eval user's: each login is held on its own):

- **A red incident** ("Claude sign-in is failing") names the login, as `claude auth status` names it (its account email or org, never a token), and Claude's message. It is not bound to the last hour: it stays open until a call on that login succeeds. A success on another login, or another instance's, doesn't close it.
- **No new Claude run starts on that login**: dispatch, the chats, research, fix runs, evals. Dispatch says why once (its hold reason on the dashboard), the ops channel gets one notice, and each page shows a red banner with Claude's words. The task that hit it is requeued, with no attempt counted. The channel chat answers "Claude sign-in failed on this machine; the owner has been told." instead of its generic failure text.
- **The way out.** Since no run may start, no run can succeed to end the hold. So the coordinator checks the login itself, with one minimal real call as the same user and login: Haiku, "Reply with the single word: ok", one turn, `--max-budget-usd 0.05`. It does this every 10 minutes at most, at once after a Claude account switch, and at once when an owner presses **Re-check sign-in** on the banner (`POST /api/claude-auth/recheck`, owners only, one a minute at most). A check that's answered ends the hold: the incident resolves, the ops channel says so once, and runs start again on their own.

**What the check costs.** A refused call (401/403) isn't billed, so checking a login that's still broken costs nothing, however long it stays broken. The one check that's answered costs about one short Haiku turn with Claude Code's system prompt, about $0.02 to $0.03 on an API key, or a sliver of a subscription's usage. It's capped at $0.05 and counted in the daily budget (`run.cost`, role `login-check`). Then the hold ends and the checks stop. The first-run page's "Signed in to Claude" step makes the same call to prove the login (kept six hours once it is answered, ten minutes when it's refused; Re-check calls again).

A run that failed keeps its why: the run's record (`state/runs/<id>.json`, field `detail`, redacted, at most 2,000 characters) and its `run.finished` event carry Claude's error text or its stderr's tail, and the run's page shows it under **Why it ended**.

## The Board

The home page (`/`, `g b`) shows every task in flight, one column per stage: **Planning** (ready, claimed, a plan or research run), **Building**, **Verifying** (the coordinator's checks and the evaluator; in PR mode, a PR whose checks are running or being fixed), **Waiting on you** (the holds only the owner ends, as on the Waiting page: a decision, a held plan, a PR left to you, a CI fix that gave up, a block, a failed landing) and **Landing** (queued to land, or a PR the merge rules are merging). On a hub it shows every instance you have a role on, with a filter to pick one; an instance's own dashboard shows its own. It follows each instance's live stream.

Each card is built by the instance's own server (`GET /api/board`, `src/board.ts`) from what the coordinator already recorded: the instance and issue (and PR) numbers, the title, diff +/− (the PR's as the watch last read it, `pr.stats`, else the last proposed change), the PR's comment count, how long since the task started, its checks (failing, pending or passing; click for each), and, while an agent runs, its memory, CPU time and processes (its process group, read from `/proc` on Linux; not measured elsewhere). Nothing is fetched from GitHub per card.

The actions on a card follow your role there, and each is refused again by the route it uses:

| | viewer | writer | owner |
| --- | --- | --- | --- |
| Watch a running agent (the live feed) | – (403) | yes | yes |
| Steer (a console message, held until the turn ends) | – (403) | yes | yes |
| Answer the open decision | – | where the decision rules allow (not plans) | yes |
| Approve a high-risk landing, or Merge a high-risk PR left to you on GitHub | – | – (403) | yes |

A viewer's board leaves out everything about runs and agents (the run, its resource use, the diff, comments and checks): the card is an allowlist of fields (`VIEWER_CARD_FIELDS` in `src/board.ts`), so a field added later stays hidden from viewers until someone puts it there. A steer message is the one console action writers have: the dashboard (`console.ts`) and the coordinator apply the same rule (`mayRequest`), and stopping a run, asks, root steps and the terminal stay the owner's. Every answer and message is recorded in the audit under its sender's login and role.

## The Machine page

Machine health moved off Overview to its own page (`/machine`, `g m`): the agent slots in use (machine-wide) and who holds each, memory, swap, load, disk, the harness's services, the off-machine backup, check times, usage per day, the merge flow, the instances side by side on a hub, and the machine-wide settings (the slot cap, engine updates) with their history, which moved there from Settings. Overview keeps a one-line summary with a link.

The Settings page's **Model routing** panel (part of `GET /api/settings`, owners and writers) lists every task type in agents.yaml `routing` (src/routing.ts): the model or value in effect and where it came from: the default in code, a role's model that stands in for it, the agents.yaml key (an older `model_routing` or `eval_routing` key is flagged with its new name), or the instance's policy.yaml. It is read-only: its "Change it" snippet is the `routing:` block to edit in agents.yaml through a pull request.

### Updater setup

At the top of the machine settings, **Updater setup** sets the engine updater up from the page (the first-run page's "Engine updater set up" step opens it). It has three steps, and nothing changes until you review one and confirm it. Skip any of them, or all of them, and the machine stays as it is.

1. **The updater.** Installs `/usr/local/libexec/worklane-update` and its 10-minute timer, with updates off. An existing `updates.json` is kept.
2. **Release signers.** Lists the keys in `/etc/worklane/allowed_signers` with their fingerprints. On the release channel the updater installs only a release tag whose signature verifies against one of them.
3. **Channel.** Shows what the updater follows. A new install follows `release` (signed release tags). If the machine is on `main`, the page offers **Follow releases**; it never offers `main`.

The on/off switch is the **Engine updates** row in the table below, as before.

**Adding a signer takes two people's worth of access: the dashboard, then a root shell.** Those keys are the root of trust for engine updates, so a dashboard session alone can't add one, whoever holds it.

1. On the page, type the signer's principal (its email) and paste the public key (`ssh-ed25519 AAAA...`, the line of the `.pub` file). **Review to stage** shows the exact principal, the whole key and its fingerprint; **Stage this signer** records it in `/var/lib/worklane/pending-signers.json`. Staging changes nothing in `allowed_signers`: a staged key is trusted for nothing.
2. The page then shows the staged signer with the exact command to run **as root on the machine**:

   ```bash
   sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer SHA256:<the fingerprint the page shows>
   ```

   Check that fingerprint against your own key first (`ssh-keygen -lf <key>.pub` prints the same). The command applies only a staged signer with exactly that fingerprint. It prints who staged it (the coordinator user, and so the instance) with its principal and key, then asks you to **type the principal**: anything else, or nothing, adds nothing. Then it appends one line (the signers already there stay as they are), and clears it from the pending list. A fingerprint that matches nothing staged adds nothing.
3. A staged signer waits 24 hours, then is dropped; **Discard** takes it out sooner. At most 4 wait at once.

Staging a signer raises its own incident ("A release signer was staged for engine updates"), with the principal, the fingerprint, and the coordinator user and instance that staged it, so an owner hears of a request before anyone is asked to confirm it. Whenever a signer is added, by this route or by `updates.sh --signer`, the watchdog raises an incident ("A release signer was added for engine updates") with the principal and the key's fingerprint: it shows on the Health page and is posted once to the ops channel. It closes by itself a day later. If you didn't add it, turn engine updates off, remove its line at a root shell, and find out who did.

**The signers file is watched.** On every run (every 10 minutes, whether updates are on or off) the updater hashes the signers file and compares it with the hash it last recorded in `/var/lib/worklane/signers-state.json`. `updates.sh --signer` and `--confirm-signer` record the new hash as they append, so their change is expected. Any other change (a hand edit, another tool, a file that was tampered with or deleted) is reported once: a `signers_changed` line in the update log (the Machine page's Engine updates table), a line in the unit's journal (`journalctl -u worklane-update.service`), and a red incident, "The release signers file changed outside updates.sh", each with the old and new hash, the number of signer lines before and after, and the key fingerprints added and removed. It needs no coordinator to notice or record; the post to the ops channel is made by a coordinator's watchdog, like every incident.

While such a change is unacknowledged, **no release is installed**: the release channel is held (the main channel checks no tag signature, so it is not). Look at the file, put it right if the change isn't yours, then acknowledge it as root on the machine:

```bash
sudo bash /opt/worklane/current/scripts/setup/updates.sh --acknowledge-signers
```

It prints the file's hash and every key fingerprint it now holds, records them, and lifts the hold; the updater's next run closes the incident. The first run on a machine with nothing recorded just records the file, with no alert.

What the page can change, and as whom: each confirmed step is one command of the root-owned machine helper (`install-updater`, `set-update-channel release`, `stage-update-signer` or `discard-update-signer <principal> ssh-ed25519 <public key>`), recorded by this instance's dashboard and run by its coordinator through `sudo -n`. Only an owner of the instance who is also a machine owner, on an allowed device, can confirm one. The dashboard itself never runs sudo and never writes these files.

**Holds.** A commit the updater rolled back is held: it is not tried again until a newer commit lands, or until an admin releases it at a root shell with `sudo bash /opt/worklane/current/scripts/setup/updates.sh --release-hold`, which shows what was held and why, moves the hold aside and logs it. Nothing on this page releases a hold: neither the channel nor the on/off switch, nor anything else a coordinator can run through the machine helper.

What it can never do: add a signer, or remove or replace one (the helper never writes `allowed_signers`; only `updates.sh` does, as root, and only by adding a line); stage a wildcard, a list or an option such as `cert-authority`, or any key type but ed25519; move a machine to the `main` channel; point the updater at another signers file; change the required checks; or turn signature or check verification off.

The same from a terminal, as root, from the engine's checkout:

```bash
sudo bash scripts/setup/updates.sh                                                    # install (off)
sudo bash scripts/setup/updates.sh --signer <principal> ssh-ed25519 <public key>      # add one release signer, directly
sudo bash scripts/setup/updates.sh --confirm-signer SHA256:<fingerprint>              # add the one staged from the page
sudo bash scripts/setup/updates.sh --channel release                                  # or: main (a root shell only)
```

Any other kind of key, or removing one, is an edit of `/etc/worklane/allowed_signers` by hand (one line per key: `<principal> <key type> <public key>`, root:root 0644). The two signer rules in the machine helper's sudoers file are written as patterns, which sudo reads as such only from 1.9.10. `machine-helper.sh` checks this machine's sudo: on an older one it does not install those two, says so (`REFUSED: ...`), and installs every other rule. Staging from the page is then refused; use `--signer` at a root shell.

Above the machine settings, the **Updates** panel (`GET /api/updates`, owners and writers) says where the engine stands: the version and commit installed now, the last update, any rollback or held commit with its reason (a canary that failed says so), and the canary's last result: passed or failed (or timed out), after an update or the daily one, how long it took, and a link to its PR. See [canary.md](canary.md) for setting the canary up.

## Trust

The Reports page opens with the Trust panel: this instance's DORA-style numbers, read from its event log
(`trustMetrics` in src/merge-metrics.ts, src/trust.ts), over the last 7 days with the 30-day value under each, and
per risk area (money path, auth, other) over 30 days. It is read-only measurement (docs/design.md, the waiver of
2026-10-13): `GET /api/trust` is the only route, and nothing it serves changes slots, caps or merges.

Under it, **Flaky tests** (owners and writers; `GET /api/flaky`, src/flaky.ts): each check quarantined because it
failed on the default branch and passed when re-run on the same commit, with when it was first seen, how many times
it has been seen flaky since, its issue, and its passes in a row toward release; the ones released lately; and the
flake rate, flaky re-runs over red runs, over 7 and 30 days. An owner's **Clear** puts a check back to blocking at
once (`POST /api/flaky/clear`, audited). Quarantine changes only the harness's own red/green decisions after a merge;
the updater still installs only a commit with every check green.

Under it, **Learnings** (owners and writers; `GET /api/learnings`, src/learnings.ts): the notes finished tasks left for
their failed runs (earliest failed stage, normalized cause), grouped by cause, with sightings, stages, issues and when
last seen. For a cause seen 3 times or more, an owner may edit the suggested line and **Promote** it
(`POST /api/learnings/promote`, owners only, audited): the coordinator opens a PR adding the line to `AGENTS.md`,
labelled `review:L3`, which waits for the owner. Agents never write `AGENTS.md` themselves.

- **Change failure rate**: of the merges in the window, those that failed: within 7 days the default branch went red
  on it or auto-merge stopped on it, a revert named it (its commit, `#number` or quoted title), or a fix PR (a `bug`
  issue, or a title starting "fix") changed one of its files; or a production report was traced to it.
- **Escaped bugs**: production reports (issues intake filed) traced to a harness merge: the latest merge, up to 30
  days before the report, that changed a file the report's fix changed.
- **Time to restore**: the median hours from a failure showing to its fix or revert merging, or the default branch
  green again (or auto-merge resumed).
- **Revise/reject rate**: of the issues a person reviewed (a plan decided, a correction recorded, a merge), those
  sent back (a plan revised or rejected, a PR or landing rejected, changes requested).
- **Flaky-check rate**: of the checks and test tiers run on a commit, those that both passed and failed on it.
- **Cost per merged PR**: the runs' own cost estimates (not billed money) and tokens over the merges; runs on no
  issue count in the instance's total only.
- **Verification time per tier**: each test-run tier, the coordinator's verify checks and the evaluator's runs.
- **Risk area**: money path when the review level names a money path (or the issue has the `money-path` label),
  auth when it names auth or secrets, else other.

**The recommendation** is fixed rules (`TRUST_RULES`), never a model's: "Ready to raise to 3 agents" at 30 or more
merges in 30 days, a change failure rate under 5% and no escaped money-path bug; otherwise "Keep 2 agents" with
what is missing. Per area: verify more heavily at a 10% change failure rate (over 10 or more merges) or any escaped
bug; lighter only for other changes, under 2% over 20 or more merges; money path and auth are never advised lighter.
Raising the agent count stays a machine owner's action (the Machine page's slots).

**Who sees what.** The owner and writers see every figure. A viewer sees a figure only when the viewer-events
allowlist (src/viewer-events.ts) shows every event field it is made of, and never cost; today that is the merge
counts. **The weekly digest** posts the same numbers to the Discord ops channel (`discord.ops_channel` in
intake.yaml), once a week, when one is set.

## Metrics

Under Trust, the Metrics panel (`GET /api/metrics`, the owner's and writers'; `deliveryMetrics` in
src/merge-metrics.ts) shows how fast and how safely changes reach the default branch, over 7 days with the 30-day
value under each. A figure whose source has recorded nothing yet says **not measured yet**, and why; never a 0.

- **Merges per day**: merged PRs and direct lands the event log records, with the last 14 days as bars.
- **Main red** and **time to green**: from the check of the default branch after each auto-merge
  (`merge.main_result`): the times it went red, and the median minutes from red to its next green.
- **Fix-forward versus revert**: revert PRs opened (on a red default branch, or for a commit the main watch couldn't
  account for) and merged, and the revert rate (reverts on red over the times it went red). Fix-forward success:
  fixed over every red default branch fix-forward took on, from its `fix_forward.finished` events.
- **PR CI wall-clock**: on each merged PR's head, from the first check run starting to the last required check
  (config.yaml `required_checks`; every check when none) completing. Read from GitHub's check runs once per PR
  (`ci.pr_timing`, src/ci-metrics.ts), at most one read-only call a minute.
- **Agent startup**: seconds from a task being claimed to its agent's process starting.
- **Flake rate**: of the re-runs of a red default branch's failing checks, those that found a flaky check
  (`flaky.rerun_result`); not measured until flaky-test re-runs exist.
- **Slow tests**: the 20 slowest tests over 7 days and every test over the budget (config.yaml
  `metrics.slow_test_budget_s`, 30 s by default), each by the median of its runs. Durations are read from test runs'
  tier output (`testrun.durations`) and, once a day, from the GitHub Actions job logs on the newest merge commit
  (`ci.test_durations`). Only formats that name one test per duration are read (src/test-durations.ts: node:test TAP
  and spec, pytest `--durations`, `go test -v`, jest and vitest verbose), and only leaf tests.

The weekly digest posts these after the trust numbers, with the slow-tests list (the weekly optimization pass's
targets) in its own message.

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
