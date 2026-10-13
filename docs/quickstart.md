# Quick start

Worklane runs on your machine, against a repo you have checked out, with the Claude Code CLI you sign in to yourself. These are the three ways in. Each ends at `worklane doctor` passing.

You need:
- macOS or Linux (on Windows, use WSL or the Docker image);
- git;
- a GitHub repo you can push to;
- a Claude login (`claude`, then `/login`). See [auth.md](auth.md).

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
5. Runs `worklane install` in your repo, then `worklane doctor`.

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

`worklane install` (which the bootstrap runs) scaffolds `.worklane/` in a repo that has none, and leaves one that exists alone. Before the first run, look over what it wrote:

1. In **`.worklane/config.yaml`**:
   - `project.repo` must be the repo's `owner/name` on GitHub (filled in from its `origin` remote when there is one);
   - `owners.default` is you;
   - `owners.writers` lists the accounts whose issues the harness will work on;
   - `land_mode` is `pr` (the default) or `direct`. `direct` needs branch protection on the default branch: without it (as on a private repo on GitHub Free) the coordinator refuses to start.
2. In **`.worklane/tests.yaml`**:
   - `runner.changed`, `runner.full` and `runner.one` are your project's real test commands;
   - `vacuity.test_globs` matches your test files.
3. Run `worklane doctor --root <repo>` again until it passes, and commit `.worklane/`.

To add another repo later, run the bootstrap again with that repo, or just `worklane install --root <repo>` and the same three steps.

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
