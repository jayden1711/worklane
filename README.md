<p align="center">
  <img src="docs/assets/logo.png" alt="Worklane" width="200">
</p>

# Worklane

**Know who's on every task.**

Worklane is an open-source harness that runs a crew of Claude agents on a real codebase. Workers run in parallel, each in its own git worktree, and take `ready` issues from your GitHub backlog. An independent evaluator checks each change against the issue's `done_when` contract. A plain-code coordinator (not a model) claims the work, enforces budgets and opens a PR for each change, which it merges only when the merge rules allow. A live dashboard shows who owns every task, and what's waiting for you.

> **Status: pre-1.0.** Expect breaking changes between releases.

## What it's for

Agents write code faster than people review it. In LinearB's 2026 Software Engineering Benchmarks Report (8.1 million PRs), "AI agent pull requests wait 17.6 hours before review versus 3.4 hours for unassisted work, a 5.25x gap": that is pickup time, the wait before a reviewer starts. And "AI pull requests merge within 30 days 32.7% of the time versus 84.4% for unassisted work" ([LinearB](https://linearb.io/library/ai-in-software-development)). Worklane's answer is to let code, not a person or a model, decide which agent changes merge on their own:

- **Code decides the merge.** The merge decision is plain code, following rules read from the default branch that no agent can loosen: agents can't write the config folder, and a change to the review rules, the merge policy or the engine's other controls always waits for a person. Anything the code won't merge waits for a person too. Auto-merge is off until the owner turns it on.
- **A model can only hold a merge, never approve one alone.** The evaluator's approval is required, but never enough. Each reason the code finds still holds the merge: required checks not green on the exact commit the evaluator approved, a high-risk or protected area, a change too big, auto-merge turned off. The evaluator's doubts can only add reasons.
- **A red main stops merging.** If the default branch goes red after a merge, only a fix for it may merge until it's green again. If no fix is green within two attempts, or the change touched the money path, auth or secrets, a revert PR opens for a person to merge and auto-merge stops until an admin turns it back on.

What sets it apart is the combination, not any one part: deterministic merge rules; locks that know what an agent could change to loosen its own gate (a change to the engine's own controls always waits for a person; making that hold for a file renamed out of a locked path is in review); a model that can only hold; and the whole control plane on infrastructure you own. Rule-based merging alone isn't new: Mergify merges on deterministic rules, without the agent-aware part.

**Direct land is outside these guarantees.** With `land_mode: direct`, the coordinator pushes a change straight to main after its tests and secret scan, without the merge decision above. It is off by default (`land_mode: pr` is the default), and the policy is that it stays an explicit opt-in by the owner, on a single machine only.

**Where it runs.** On your own machine or your own server today; your own cloud account is the next deployment mode being built. The single machine is and stays a first-class mode, with the same guarantees.

## Install

On macOS or Linux (on Windows, use WSL2), with Node.js 22.13 or newer, install the engine from npm, then open the first-run wizard from the repo you want it to work on:

```sh
npm i -g @worklane/cli
cd ~/code/your-repo
worklane dashboard --detach
```

The last command starts that repo's dashboard in the background and prints one URL, last: the first-run wizard, `http://127.0.0.1:4317/first-run`. That's where every setup step after the install happens, including installing the tools the agents need (Claude Code, gitleaks, gh). The URL never carries a key: the page asks for it once, and the key stays in a file only you can read.

Without a global install, `npx @worklane/cli init` in the repo installs the engine under `~/.local` and walks the same setup steps in the terminal.

On a Debian or Ubuntu server, where each project runs as users of its own, use the install script from a checkout of this repo, as root:

```sh
sudo bash scripts/bootstrap.sh --hardened <name> <owner/repo>
```

The script installs pinned, checksum-checked tools and the same engine as npm, v0.5.0 (the signed release pinned in it), then prints the wizard's URL. Locally, `bash scripts/bootstrap.sh ~/code/your-repo` does the same for one repo, if you'd rather have the tools pinned too.

[docs/quickstart.md](docs/quickstart.md) is the getting-started guide. It covers what each wizard screen does, the server path (Tailscale, setup mode, the GitHub Apps), your first project, engine updates, Discord, and where to look when something's wrong. It also covers the current limit: a fresh server with no https origin gets no URL yet.

Once it's installed, you can look around without a repo of your own. The demo uses scripted agents and needs no login:

```sh
worklane demo /tmp/worklane-demo
```

## Safety model

- **Agents hold no write credentials.** They propose actions, and the coordinator validates and performs them. Agents never get a GitHub write token or a production write credential. On a server, each project's coordinator and agents run as separate OS users ([separate-users.md](docs/separate-users.md)).
- **Sandboxed test runs.** On a server, a project's tests run as a test user of their own, in a transient unit with a read-only system. That user can't read the engine's state, credentials or any other project, and its runs get no credentials of the harness's. Each run is wiped afterwards, and the wipe checks that nothing is left ([test-runs.md](docs/test-runs.md)).
- **Root steps only through the helper's allowlist.** The dashboard never runs sudo. A machine change made from the page is one of a fixed list of commands of a root-owned helper, each allowed by name in sudoers. Anything else stays at a root shell: running the setup scripts, adding a release signer, releasing an update hold.
- **No secrets in URLs, command lines or logs.**
  - Tokens are pasted into a hidden field or prompt and go straight to a file only their user can read.
  - The dashboard key goes in a header, and any URL carrying a key is refused.
  - Test-run variables reach the sandbox on stdin, never in an argv.
  - gitleaks scans every agent commit and every session transcript.
- **Signed updates.** On the release channel (a new install's default), the engine updater installs only a release tag whose signature verifies against `/etc/worklane/allowed_signers`. A signer is added only at a root shell; the dashboard can only stage one. An update waits for running work, and rolls back and holds the commit if a service or the test sandbox fails afterwards.
- **Voice is off by default, for owners only, and heard on-device.** An owner can speak an idea or `approve <issue number>`. Nothing happens until they say "confirm" within 10 seconds or click the banner. A spoken idea goes through the same triage as a Discord message and becomes an Inbox decision. By voice, a decision can only be approved, never a held high-risk merge, a plan held for a high-risk reason, or a delegation; those take a click. The server checks all of this again ([intake.md](docs/intake.md#25-voice-the-dashboard)).
- **Protected changes wait for a human.** Review levels come from what a change touches, so a docs fix can land on its own, while money-path and auth changes wait for an owner.
- **Very little is blocked, and everything is verified.** Only a few things are refused outright: signing from a live wallet, writing to the production database. Everything else gets checks the harness runs itself.

## What's out of scope

- **A hosted service.** Worklane runs on your own machine or server, with no backend of its own.
- **Your Claude login.** Agents run through the Claude Code CLI you install, with your own login or API key. You're responsible for using it within your Anthropic plan's terms ([auth.md](docs/auth.md)).
- **Code hosts other than GitHub.** The backlog, PRs, Apps and checks are GitHub's.
- **Native Windows agents.** On Windows, agents need WSL2. Without it, Windows gets the dashboard and Issues only.
- **Deploying your app.** The deploy gate decides which commit production may deploy; your host does the deploying ([deploy-gate.md](docs/deploy-gate.md)).

## Learn more

- [docs/quickstart.md](docs/quickstart.md): getting started.
- [docs/design.md](docs/design.md): the architecture.
- [docs/prior-art.md](docs/prior-art.md): what we borrowed, and from where.
- [docs/dashboard.md](docs/dashboard.md): every dashboard page.

## License

[Apache-2.0](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions require a [DCO sign-off](CONTRIBUTING.md#sign-off). Please read the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities as described in [SECURITY.md](SECURITY.md).
