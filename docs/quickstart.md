# Quick start

Worklane runs on your machine, against a repo you have checked out, with the Claude Code CLI you sign in to yourself. These are the three ways in. Each ends at `worklane doctor` passing.

You need:
- macOS or Linux (on Windows, use WSL or the Docker image);
- git;
- a GitHub repo you can push to;
- a Claude login (`claude`, then `/login`). See [auth.md](auth.md).

## Local or server

You choose where it runs. `worklane init` and the bootstrap take `--mode local` or `--mode server`, and ask when you don't say.

| | local | server |
|---|---|---|
| Where | your own machine: macOS, Linux, or Windows through WSL2 | a Linux server (Debian or Ubuntu, systemd) |
| As whom | you: no separate OS users, no ssh, no root | root sets it up; each project runs as users of its own |
| GitHub | your `gh` login | a GitHub App per project, made through the manifest flow |
| Always on | while your machine is | yes |
| Set up with | `bash scripts/bootstrap.sh --mode local <repo>` | `sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>` |

### One command, one URL

Each of those commands ends by printing one URL, last: the dashboard's first-run wizard, where every setup step after the install happens.
- **Local:** the bootstrap installs the tools and the engine, starts the repo's dashboard in the background (`worklane dashboard --detach`), and prints `http://127.0.0.1:4317/first-run`. Run it again and it prints the same URL and changes nothing; if the dashboard stopped (a reboot), it starts it again.
- **Server:** it prints the dashboard hub's wizard: `https://<the hub's name>/first-run` once the sign-in App is set up and the machine has its Tailscale name (or `--public-url`), otherwise `http://127.0.0.1:4398/first-run`, the owner's break-glass on the server (from your laptop, `ssh -N -L 4398:127.0.0.1:4398 <you>@<server>` first).
- **No key in the URL.** The page asks once for the dashboard key (a hidden field, or choose the key file). The key stays in a file only you (local) or root and the hub's user (server) can read; the command prints that file's path, never the key. The tab keeps it until you close it.
- **Unattended:** `--config <file>` gives the same result without a person. The wizard's steps run in the terminal first (`worklane init --yes`, then `worklane doctor`), then the same URL. The file holds `key=value` lines: `mode=local|server`, `answer=<question id>=<choice>` (repeatable; auto-config's questions, as `init --answer` takes them), `machine_owner=<login>` and `public_url=<https url>` (server). It is read as data and never run. `--yes` alone does the same with no answers.

The wizard's screens and their script equivalents: tools, Claude, GitHub, repo config and protection are `worklane init --yes` (with `--answer` for auto-config's questions); the pre-commit hook is `worklane install --git-hooks`; fingerprints are `worklane guardrails refresh`; Start is `worklane up`.

An engine older than the wizard (one without `dashboard --detach`) runs the checklist in the terminal instead, as before, and says so.

What local mode can't do, `worklane doctor` and the dashboard's First-run page say plainly, each with why:
- **separate OS users**: the agents run as you, with your files and logins;
- **root-run add-project**: the dashboard's Add project needs root and the machine helper, so you set up another repo with `worklane init <repo>` instead;
- **the test sandbox without Docker**: test runs need Docker in local mode.

### Moving to a server later

Start on your laptop and move to an always-on server when you want, with no ssh between the two:

1. On the laptop: `worklane down`, then `worklane export --out shop.bundle`. That's one file (yours only, `0600`) with the history (the event log, as a whole snapshot), init's checklist, and the repo's `.worklane/`. Secrets, locks, logs and worktrees never go in it; it lists what it left out.
2. Carry the file over however you like.
3. On the server, after `add-project` has set the project up: as the instance's coordinator user, with it stopped, `worklane import shop.bundle --instance <name>`. It refuses an instance that already has history of its own (`--force` replaces it). The config stays the repo's: if the checkout's `.worklane/` differs from the bundle's, it lists the files, to commit in a PR.

## The checklist: `worklane init`

`worklane init [<repo>] [--mode local|server]` walks one checklist in order. It checks each step first, does only what isn't done, and checks it again before moving on:

1. **Tools present.** git, gitleaks, Claude Code and, in local mode, gh. A missing one is shown first (its URL, the checksum pinned in the engine, where it goes) and installed only when you say yes (or pass `--yes`). The download is checked against that checksum before anything is unpacked, and refused if it doesn't match. On a server, installing tools stays the owner's step (`bootstrap --hardened`).
2. **Claude login.** Checked with `claude auth status`; if you're not signed in, it opens `claude auth login` and checks again.
3. **GitHub.** Local: `gh auth status`, then whether your login can push to the repo (it opens `gh auth login` if needed). Server: it hands off to `scripts/setup/add-project.sh`, which makes the instance, the GitHub App, the agent's Claude token and the checkout.
4. **Repo config.** A `.worklane/` already in the checkout is used as it is, and the hooks for local runs go in. With none, local mode drafts one. It reads the default branch in a scratch worktree (never your checkout) and detects the project's commands: package.json scripts (the package manager from the lockfile), pytest or unittest (through uv, poetry, pdm or pipenv when there's a lockfile), `go test`, `cargo test`, and Makefile `test`/`check` targets. It drafts `tests.yaml` (`runner.full`, `changed`, `one`, the test globs, the worktree setup) and `config.yaml`, then runs each command there, with a 15-minute limit each, through the same path the harness runs project commands. Nothing is guessed. Two test commands, none, a monorepo, two lockfiles, no way to run a single test file, or a command that fails on the default branch each become a question with its choices. init asks it in the terminal; without one, the question waits in the checklist and on the **First run** page, and `worklane init --answer <id>=<choice>` (or `<id>=custom:<command>`) answers it. The draft is checked against the config schema and proposed as a PR from `worklane/setup`; the default branch is never pushed. Merge the PR and run `worklane init` again: it fast-forwards your checkout to it and installs the hooks. Server mode drafts it the same way, through the instance's GitHub App (add-project's checkout step, `worklane instance auto-config <name>` as the coordinator user): the commands run as the instance's agent user, the draft is fitted to the instance policy (budget, workers), and questions are answered with `sudo -H -u wl-<name> worklane instance auto-config <name> --answer <id>=<choice>`. Until the setup PR merges, the coordinator waits: add-project's service step and `bootstrap --after-credentials` say "waiting for the setup PR <url>" (exit 3), and `worklane init` stops at Repo config saying the same; rerun either once it has merged.
5. **Protection.** Reports whether GitHub protects the default branch, and the protection it recommends: require the `required_checks`, **not strict** (a PR needn't be up to date with the default branch before it merges). It never changes the repo's protection. See [Branch protection: not strict by default](design.md#10-land-queue).
6. **Discord** (optional), and **Tailscale** (optional, server mode).

It's resumable: if a step stops it (a login missing, say), fix what it says and run `worklane init` again. The steps already done are checked, not redone, and it picks up there. `worklane doctor` shows the same checklist, and so does the dashboard's **First run** page (from the Setup console).

## Mac

1. Install [Homebrew](https://brew.sh) if you don't have it. The bootstrap uses it for Node.js and never pipes an installer into a shell.
2. From a checkout of this repo, run:

   ```sh
   bash scripts/bootstrap.sh ~/code/your-repo
   ```

3. Add `~/.local/bin` to your PATH if the script says it isn't there.

The bootstrap does the following:
1. Keeps Node.js 22.13 or newer if you have it; otherwise installs Node 24 LTS (`node@24`) from Homebrew.
2. Installs gitleaks, pinned and checked against its sha256.
3. Installs Claude Code at a pinned version through npm.
4. Installs the engine at the release tag pinned in the script, by its commit, into `~/.local`.
5. Runs `worklane init --mode local` in your repo (the checklist above), then `worklane doctor`.

Run it again whenever you like: each step checks first, and nothing is done twice. Add `--dry-run` to see what it would do without changing anything.

## Linux

The same command:

```sh
bash scripts/bootstrap.sh ~/code/your-repo
```

On Linux, Node.js 22.13+ is kept if you have it; otherwise Node 24 LTS comes from the official tarball on nodejs.org, checked against the sha256 pinned in the script and unpacked into `~/.local/lib`. Nothing needs sudo.

### A shared server (hardened, multi-user)

For a server where each project runs as its own users (a coordinator that holds the credentials, and an agent user that holds nothing), see [separate-users.md](separate-users.md). This path needs Debian or Ubuntu with systemd. The bootstrap runs the setup scripts in order, showing you each one and asking before it runs:

```sh
sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>
# then the credentials, by hand (the script prints the commands), and:
sudo bash scripts/bootstrap.sh --hardened --after-credentials <name> <owner/repo>
```

The first run makes you the machine's first owner. It asks for your GitHub login, or reads it from `gh` if gh is signed in and asks you to confirm (`--machine-owner <login>` skips the question). At the end it prints the dashboard's URL and how to make the dashboard's sign-in App. From then on, you add projects in the dashboard: **Setup console → Add project** ([dashboard.md](dashboard.md#add-project)).

## Docker

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

That command mounts your Claude login. Sign in once with `docker run -it ... worklane claude` if you'd rather keep it in a volume.

## Setting up a project by hand

`worklane install` (which `init` runs) scaffolds `.worklane/` in a repo that has none, and leaves one that exists alone. Before the first run, look over what it wrote:

1. In **`.worklane/config.yaml`**:
   - `project.repo` must be the repo's `owner/name` on GitHub (filled in from its `origin` remote when there is one);
   - `owners.default` is you;
   - `owners.writers` lists the accounts whose issues the harness will work on;
   - `land_mode` is `pr` (the default) or `direct`. `direct` needs branch protection on the default branch: without it (as on a private repo on GitHub Free) the coordinator refuses to start.
   - `protection.strict` is `false` (the default): protect the default branch by requiring `required_checks`, with "require branches to be up to date" off. Set it to `true` only to opt this repo in to strict.
2. In **`.worklane/tests.yaml`**:
   - `runner.changed`, `runner.full` and `runner.one` are your project's real test commands;
   - `vacuity.test_globs` matches your test files.
3. Run `worklane doctor --root <repo>` again until it passes, and commit `.worklane/`.

To add another repo later, run `worklane init <repo>` (or the bootstrap again with that repo) and the same three steps.

## Your first issue

1. **Start it.** `worklane up --root ~/code/your-repo` installs the coordinator as a service for your user (launchd on macOS, `systemd --user` on Linux). `worklane down` removes it.
2. **Open the dashboard:** `worklane dashboard --root ~/code/your-repo`. It's local only, and the URL it prints carries its token.
3. **File an issue in the repo on GitHub** with:
   - an **Outcome** line;
   - a closed `done_when` block, for example:

     ````
     **Outcome:** Totals ignore items with a zero or negative quantity.

     ```done_when
     - test: test/price.test.js
     ```
     ````
   - the `ready` label.

   Only issues opened or labelled by the repo's writers (`.worklane/config.yaml`, `owners.writers`) are picked up.
4. **Watch it.** A worker takes it in its own worktree, an independent evaluator checks the change, and it lands or opens a PR depending on `land_mode`.

To see it all without a repo of your own, try the demo, which uses scripted agents and needs no login:

```sh
worklane demo /tmp/worklane-demo
worklane dashboard --root /tmp/worklane-demo --user example-owner
```

## Where to look

| What | Where |
|---|---|
| Is the install healthy? | `worklane doctor --root <repo>` |
| What's happening now | the dashboard: tasks, decisions waiting for you, runs, health |
| The coordinator's log | the path `worklane up` prints (`coordinator.log` in the project's state directory) |
| What each agent did | the dashboard's run pages, one per agent session |
| Config | `.worklane/` in your repo: `config.yaml`, `tests.yaml`, `agents.yaml`, `guardrails.yaml` |
| How it works | [design.md](design.md) |
