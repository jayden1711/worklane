# Getting started

Worklane runs on your machine, against a repo you have checked out, with the Claude Code CLI you sign in to yourself. You run one install command. It prints one URL, and every setup step after that happens on the page it opens: the dashboard's first-run wizard.

You need:
- macOS or Linux (on Windows, use WSL2 or the Docker image);
- git, and a checkout of this repo (the install command is in it);
- a GitHub repo you can push to;
- a Claude login. The wizard has **Sign in to Claude**, or run `claude auth login` yourself. See [auth.md](auth.md).

## Local or server

You choose where it runs.

| | local | server |
|---|---|---|
| Where | your own machine: macOS, Linux, or Windows through WSL2 | a Linux server (Debian or Ubuntu, with systemd) |
| As whom | you: no separate OS users, no ssh, no root | root sets it up; each project runs as users of its own ([separate-users.md](separate-users.md)) |
| GitHub | your `gh` login | a GitHub App per project, made through GitHub's manifest flow |
| Who signs in to the dashboard | you, with its key | each person, with their own GitHub account |
| Always on | while your machine is | yes |
| Install command | `bash scripts/bootstrap.sh <repo>` | `sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>` |

Local mode can't do three things. `worklane doctor` and the first-run page both list them, each with the reason:
- **separate OS users**: the agents run as you, with your files and logins;
- **the dashboard's Add project**: it needs root and the machine helper, so you set up another repo with the install command (or `worklane init <repo>`) instead;
- **the test sandbox without Docker**: test runs need Docker in local mode.

## The install command

### Local

From a checkout of this repo:

```sh
bash scripts/bootstrap.sh ~/code/your-repo
```

1. It keeps Node.js 22.13 or newer if you have it. Otherwise it installs Node 24 LTS: on a Mac from Homebrew (install [Homebrew](https://brew.sh) first), on Linux from nodejs.org, checked against the sha256 pinned in the script.
2. It installs gitleaks, pinned and checked against its sha256.
3. It installs Claude Code at a pinned version through npm.
4. It installs the engine at the release pinned in the script, by its commit, under `~/.local`. Nothing needs sudo, and nothing is piped from the network into a shell.
5. It starts the repo's dashboard in the background (`worklane dashboard --detach`) and prints one URL, last:

   ```
   http://127.0.0.1:4317/first-run
   ```

Run it again whenever you like. Each step checks first and does only what isn't done, and it prints the same URL. If the dashboard stopped (after a reboot, say), it starts it again. Add `--dry-run` to see what it would do without changing anything. If it says `~/.local/bin` isn't on your PATH, add it in your shell profile; the dashboard doesn't need it, only your terminal does.

Without `--mode`, it asks whether you want local or server. With no terminal to ask on, it picks local and says so.

**The key is in a file, never in the URL.** The page asks once for the dashboard key, in a hidden field, or you choose the key file. The command prints that file's path, never the key, and only you can read the file. The page sends the key in a header and keeps it in that browser tab until you close it. Every dashboard route refuses (401) a request whose URL carries a key.

### Server

On a Debian or Ubuntu server, as root, from a checkout of this repo:

```sh
sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>
```

`<name>` is the project's instance name (lowercase letters, digits and dashes). The command does the following:

1. **Root scripts, one at a time.** It runs the setup scripts in `scripts/setup/` in order (Node, the machine, the machine owners, the tools, the instance, the engine). It pages each one for you to read and asks before running it (`--yes` skips the questions).
2. **The first machine owner.** That's you, by your GitHub login. It reads the login from `gh` if gh is signed in and asks you to confirm, or asks you for it. `--machine-owner <login>` answers ahead of time. Machine owners are the people who may add projects and change the machine from the dashboard.
3. **The instance's credentials.** It prints the commands for these. Run them, then run the command again with `--after-credentials` to set up the checkout and start the service:

   ```sh
   sudo bash scripts/bootstrap.sh --hardened --after-credentials <name> <owner/repo>
   ```

   If the repo's setup PR isn't merged yet, the command says "waiting" and exits 3. Merge the PR and run the command again; it picks up where it stopped.
4. **One URL, last, and only one that answers.** It asks each URL first (HTTP 200) and prints only one that answered:
   - **A fresh machine (no dashboard sign-in App yet):** it starts the hub's setup mode and prints `https://<the machine's https name>/`. On that page you make the sign-in App with GitHub (Connect GitHub; GitHub's manifest flow, two clicks, nothing to copy). The page asks for a one-time setup token: run `sudo cat` on the file it names. The token is never printed, logged or put in a link. Setup mode turns itself off once the App exists.
   - **The sign-in App made, no hub yet:** it starts the hub (`dashboards.sh --no-instances`).
   - **A hub running:** `https://<the machine's https name>/first-run`. Sign in with GitHub as the machine owner.

**The https origin.** Setup mode and sign-in need the machine's https name. That's its Tailscale name, with MagicDNS and HTTPS certificates turned on in Tailscale's admin console, and the hub served on it:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4399
```

You can also give an https origin of your own with `--public-url https://<host>`. [dashboard.md](dashboard.md#tailscale-https-the-owners-step) has the details. Once the hub is up, the Machine page's **Tailscale and HTTPS** card walks you through these steps from the browser.

**The current limit: a fresh server with no https origin gets no URL.** If the machine has no Tailscale name and you gave no `--public-url`, the command can't start setup mode. It prints no URL. It says why ("the sign-in App is made through the hub's setup mode, which needs this machine's https origin, and there is none yet"), prints the command that fixes it, and exits 4. It does the same (no URL, the reason, the fix, exit 4) whenever nothing answers yet, for example when the origin doesn't reach the hub. Fix what it says and run the same command again. The installed parts stay as they are.

### Unattended

`--config <file>` installs with no one at the keyboard. It runs the wizard's steps in the terminal first (`worklane init --yes`, then `worklane doctor`), then prints the same URL. The file holds `key=value` lines and is read as data, never run:

```
mode=local
answer=<question id>=<choice>
```

The keys are `mode=local|server`, `answer=<question id>=<choice>` (repeatable: auto-config's questions, as `worklane init --answer` takes them), `machine_owner=<login>` and `public_url=<https url>`. `--yes` alone does the same with no answers.

### The engine it installs

The command installs the signed engine release pinned in `scripts/bootstrap.sh` (`ENGINE_TAG`), checked by its release commit (`ENGINE_COMMIT`). To try an unreleased change instead, install the engine from a build of this checkout:

```sh
npm ci --ignore-scripts && npm run build && npm run build:web && npm pack
bash scripts/bootstrap.sh --engine ./worklane-cli-<version>.tgz ~/code/your-repo
```

## The first-run wizard

The First run page (`/first-run`) lists every setup step, each with its state checked live from the machine. The steps run in this order. Where a step has a screen, its button opens it. A screen shows exactly what it will change before you confirm, and writes nothing until you do. Each screen also names the command or config key that does the same thing without the page.

| Screen | Mode | What it does |
|---|---|---|
| **Tools** | both | Installs a missing gitleaks, Claude Code or gh, from pinned, checksummed downloads (on a server, the install command already did this) |
| **Sign in to Claude** | local | Runs `claude auth login` for you and relays its sign-in page as a button; Claude Code keeps its own login |
| **The agents' Claude login** | server | A paste box for the token `claude setup-token` prints, for the agent user only; it is never shown again |
| **Connect GitHub** | local | Runs `gh auth login --web` and shows its one-time code with a link to GitHub's device page |
| **GitHub origin, default branch** | local | Picks the repo's GitHub origin and sets the default branch, for a checkout that lacks them |
| **The agents' GitHub App** | server | Opens the Setup console's **Add project** (below) |
| **Repo config** | both | Answers auto-config's questions, then proposes `.worklane/` (owners, writers, required checks, budget, workers) as a PR you can merge from the page. Locally, it then fast-forwards your checkout |
| **Hooks, pre-commit scan, fingerprints** | local (fingerprints both) | Installs the hooks for local runs, the gitleaks pre-commit hook, and fetches the guardrails' fingerprints |
| **Protect** | both | Turns on GitHub branch protection (below) |
| **Policy** | server | Reviews the instance's policy (auto-merge, land mode, budget, workers) as a form, with the change shown before it is written |
| **Discord** | server | The bot's token, invite link and channels (below) |
| **Tailscale and HTTPS** | server | The Machine page's card: install, log in, serve, the hub's URL |
| **Updater** | server | The Machine page's Updater setup (below) |
| **Start** | both | Starts the coordinator: your own service locally (launchd or `systemd --user`), the instance's service on a server |

Some steps have no button, because they can't be one:
- **Provider pages.** Docker's installer, Tailscale's access controls, Anthropic's or Backblaze's console. The step links straight to the page and turns done once it detects the result.
- **Root or your shell profile.** On a server, the root setup scripts and the sign-in App's setup mode. Locally, `sudo loginctl enable-linger "$USER"` on Linux, and your PATH. The step shows the command and why it can't be a button. The dashboard never runs sudo.

**Skip any screen, and run it again later.** An owner can press **Skip** on any step that isn't done, and **Undo skip** brings it back. A skip changes only the page: `worklane doctor` and `worklane init` still check the step. **Settings → Setup screens** lists every screen with its state. Its link opens that step on the first-run page, even when the step is done, so you can run it again. [dashboard.md](dashboard.md#first-run-screens-skip-run-again-or-automate) has the table of each screen and its terminal equivalent.

**Before the config exists**, the dashboard runs in setup mode. The first-run page is the whole dashboard. You pick the origin, answer the questions, draft the config (which runs your project's commands on a scratch copy of the default branch, so it asks first) and merge its PR. Start is refused until the config exists. Then the full dashboard takes over at the same address.

## Your first project

**Locally,** the repo you installed for is your first project. Once the wizard's steps are done:

1. Press **Start** on the first-run page (or run `worklane up --root ~/code/your-repo`).
2. File an issue in the repo on GitHub, with:
   - an **Outcome** line;
   - a closed `done_when` block, for example:

     ````
     **Outcome:** Totals ignore items with a zero or negative quantity.

     ```done_when
     - test: test/price.test.js
     ```
     ````
   - the `ready` label.

   The harness picks up only issues opened or labelled by the repo's writers (`owners.writers` in `.worklane/config.yaml`).
3. Watch it on the Board. A worker takes the issue in its own worktree, and an independent evaluator checks the change. It then lands or opens a PR, depending on `land_mode`.

To set up another repo on the same machine, run the install command again with that repo, or run `worklane init <repo>`.

**On a server,** a project is an instance. The Setup console's **Add project** makes one: you type a name and pick the repo. The App comes from GitHub's manifest flow (two clicks on GitHub, installed on that one repo only), and you paste the agents' Claude token into a password box. The view follows each step live. If a step fails, it names the step and the command to retry it. Only an owner of the instance who is also a machine owner, signed in, on one of the owner terminal's allowed devices, can use it. The same steps at a root shell: `sudo bash scripts/setup/add-project.sh <name> <owner/repo>`. See [dashboard.md](dashboard.md#add-project).

To see everything work without a repo of your own, try the demo. It uses scripted agents and needs no login:

```sh
worklane demo /tmp/worklane-demo
worklane dashboard --root /tmp/worklane-demo/shop --user example-owner
```

## Protect

The **Protect** screen turns on GitHub branch protection for the default branch. It requires the checks named in `required_checks` before a PR merges, and is **not strict**: a PR needn't be up to date with the default branch first. It changes nothing else: no required reviews, no push restrictions, admins not bound. It acts only when the branch has no protection yet; it never replaces protection you already have. It shows the exact `gh api` call before you confirm, and runs it with your gh login, which must be an admin of the repo (otherwise GitHub refuses).

On a server, the agents' App has no permission to change protection, so the screen says so and links to the repo's settings for a repo admin. A branch GitHub doesn't protect (as on a private repo on GitHub Free) is guarded by the harness's main watch instead, on by default: a commit that lands any other way than a merge with green required checks, by the harness or a mapped writer, stops auto-merge and opens a revert PR for a human. Without protection, every change still lands through a PR. See [Branch protection: not strict by default](design.md#10-land-queue).

## Engine updates (server)

The updater installs new engine versions by itself, once you set it up and turn it on. Its setup is on the Machine page (**Updater setup**). It has three steps, and nothing changes until you review one and confirm it:

1. **Install the updater.** It is installed with updates off. It runs every 10 minutes.
2. **Release signers.** On the release channel, the updater installs only a release tag whose signature verifies against a key in `/etc/worklane/allowed_signers`. The page can only *stage* a signer: you type the principal and paste the public key, and it shows the fingerprint. The signer is added only when an admin confirms it **at a root shell on the machine**, typing the principal again:

   ```sh
   sudo bash /opt/worklane/current/scripts/setup/updates.sh --confirm-signer SHA256:<the fingerprint the page shows>
   ```

   Staging a signer and adding one each raise an incident, so every owner hears of it. A change to the signers file made any other way holds release installs until an admin acknowledges it at a root shell (`updates.sh --acknowledge-signers`).
3. **Channel.** A new install follows `release` (signed release tags). The page never offers `main`; only a root shell sets it (`updates.sh --channel main`).

Then turn updates on with the **Engine updates** row in the machine settings.

An update never interrupts work. The updater waits until no agent or full test run is going. On a machine that is never quiet, once an update has waited an hour (`drain_after_minutes`), it **drains** the machine: no new agent run, test run or full-run lock starts, and nothing running is stopped. Once everything in flight has finished, it installs, then lifts the drain. The Updates panel shows "draining for update since …" and what is still finishing. After an install, if a service doesn't come back steady, or the test sandbox check that passed before now fails, the updater rolls back and holds that commit. Only a root shell releases a hold (`updates.sh --release-hold`).

From a terminal instead: `sudo bash scripts/setup/updates.sh`, with `--signer`, `--confirm-signer` or `--channel`. See [dashboard.md](dashboard.md#updater-setup) and [separate-users.md](separate-users.md).

## Discord (server, optional)

A Discord bot lets people file work, answer decisions, approve high-risk changes and chat with the harness. The first-run page's **Discord** step sets it up. You make the app and bot in Discord's developer portal yourself, and turn on the message-content intent there. Then, on the page:
- **The token.** Paste it into a box. It goes straight to a file only the instance's user can read, and the dashboard never reads or shows it again.
- **The invite link.** Open it to add the bot to your server.
- **The channels.** Pick them from the bot's own list.

The page shows the exact change to `intake.yaml` before writing it. Who may send, people and owners stay in `intake.yaml` by hand. Restart the instance afterwards (the page shows the command). See [dashboard.md](dashboard.md#discord-the-bots-token-invite-link-and-channels) and [intake.md](intake.md).

## Voice (optional)

The dashboard can take your voice. In the Ask panel, it can dictate into the question box, read answers aloud, and listen for a wake word. With the voice button beside Ask, you can speak an idea or `approve <issue number>`. All of it is **off by default** and **for owners only**. You turn each part on under **Settings → Voice**, and the setting is kept in that browser.

**Voice intake and approvals** also need `voice.enabled: true` in the instance's `intake.yaml`.
- **Nothing acts on its own.** What was heard shows on a 10-second banner, and nothing happens until you say "confirm" within that window or click the banner.
- **A spoken idea** goes through the same triage as a Discord message and becomes an Inbox decision.
- **By voice, a decision can only be approved.** A held high-risk merge, a plan held for a high-risk reason, or a delegation takes a click.

See [intake.md](intake.md#25-voice-the-dashboard). Recognition and voices are **on-device**: without on-device recognition the mic stays off and says why, and without an on-device voice nothing is read aloud, unless you allow the cloud fallback or network voices. Dictation only fills the box for you to review; it never sends. No wake-word model ships with it, so the wake word stays off until one is installed ([wake-word.md](wake-word.md)).

## When something's wrong

| What | Where |
|---|---|
| Is the install healthy? | `worklane doctor --root <repo>` (`--instance <name>` on a server): the same checklist as the first-run page, plus what the mode can't do |
| Something broke | The **Health** page: each open incident, with what broke, since when, what was already tried and the one fix. On a server with Discord, each incident is also posted once to the ops channel, with a link back. Resolved incidents are folded into a history |
| The disk is filling up | The `disk_full` incident. Below the free-space floor (the larger of 10 GiB and 5% of the volume, by default), no new agent or test run starts and the incident is amber. If the event log can't be written at all, the coordinator keeps the events in memory, starts nothing new and raises it red. Runs in flight go on. Free space, and work resumes once the kept events are written |
| Claude or GitHub sign-in failing, usage limit reached, the engine not updating | Each is an incident on the Health page, with its fix |
| The machine: slots, memory, disk, services, updates | The **Machine** page |
| What each agent did | The dashboard's run pages, one per agent session |
| The coordinator's log | The path `worklane up` prints (`coordinator.log` in the project's state directory); on a server, `journalctl -u worklane-<name>` |
| What's running and spent | `worklane status` |
| Config | `.worklane/` in your repo: `config.yaml`, `tests.yaml`, `agents.yaml`, `guardrails.yaml` |

## Other ways in

### The checklist in a terminal: `worklane init`

The wizard's steps also run in a terminal. `worklane init [<repo>] [--mode local|server]` walks the same checklist in order: tools, Claude login, GitHub, repo config, (on a server) the coordinator running, protection, then Discord and Tailscale (optional). It checks each step first, does only what isn't done, and checks it again before moving on. If a step stops it, fix what it says and run it again; it picks up there. `worklane doctor` shows the same checklist.

- `--yes` installs missing tools as shown. A download is checked against the checksum pinned in the engine before anything is unpacked.
- `worklane init --answer <id>=<choice>` (or `<id>=custom:<command>`) answers an auto-config question.
- Auto-config reads the default branch in a scratch worktree (never your checkout) and detects your test commands. It runs each one, with a 15-minute limit, and proposes `.worklane/` as a PR from `worklane/setup`; the default branch is never pushed. Merge the PR and run `worklane init` again: it fast-forwards your checkout and installs the hooks.
- On a server: `sudo worklane init --mode server <owner/repo> --instance <name>` hands off to `scripts/setup/add-project.sh`.

### Docker

A minimal image for a cloud VM or a quick trial. It runs the same bootstrap for a non-root user, with your repo mounted at `/repo`:

```sh
docker build -t worklane .
docker run --rm -it -v "$PWD:/repo" worklane worklane install --root /repo
docker run --rm -it -v "$PWD:/repo" worklane worklane doctor --root /repo
```

There is no launchd or systemd in a container, so run the coordinator in the foreground:

```sh
docker run -it -v "$PWD:/repo" -v "$HOME/.claude:/home/user/.claude" worklane worklane coordinator run --root /repo
```

That command mounts your Claude login.

### Setting up a project by hand

`worklane install` scaffolds `.worklane/` in a repo that has none (and leaves one that exists alone). Look over what it wrote:

1. In **`.worklane/config.yaml`**:
   - `project.repo` is the repo's `owner/name` on GitHub;
   - `owners.default` is you;
   - `owners.writers` lists the accounts whose issues the harness will work on;
   - `land_mode` is `pr` (the default) or `direct`. `direct` needs branch protection on the default branch; without it, the coordinator refuses to start.
   - `protection.strict` is `false` (the default). Set it to `true` only to opt this repo in to strict.
2. In **`.worklane/tests.yaml`**, `runner.changed`, `runner.full` and `runner.one` are your real test commands, and `vacuity.test_globs` matches your test files.
3. Run `worklane doctor --root <repo>` until it passes, and commit `.worklane/`.

### Moving to a server later

Start on your laptop and move to an always-on server when you want, with no ssh between the two:

1. On the laptop: `worklane down`, then `worklane export --out shop.bundle`. That's one file, readable only by you, with the history and the repo's `.worklane/`. Secrets, locks, logs and worktrees never go in it.
2. Carry the file over however you like.
3. On the server, once Add project has set the project up: as the instance's coordinator user, with it stopped, run `worklane import shop.bundle --instance <name>`. It refuses an instance that already has history of its own (`--force` replaces it).

## How it works

[design.md](design.md) has the architecture. [dashboard.md](dashboard.md) covers every page, [separate-users.md](separate-users.md) the server's users and root scripts, and [test-runs.md](test-runs.md) the test sandbox.
