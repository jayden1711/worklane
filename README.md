# Worklane

**Know who's on every task.**

Open-source harness for running a crew of Claude agents on a real codebase: parallel workers, an independent evaluator, a shared GitHub Issues backlog, and a live dashboard showing who owns every task.

> **Status: pre-alpha.** The coordinator, harness-run checks, the independent evaluator, separate OS users for agents, Claude Code's sandbox and repo-scoped credentials work. Not yet used on a project day to day.

## What it is

- **Parallel workers**, each in its own git worktree, picking up `ready` issues from a GitHub Issues backlog that humans and agents share.
- **A deterministic coordinator** (plain code, not an LLM) that claims work, enforces budgets, retries, and moves state. Agents never hold GitHub write tokens; they propose actions and the coordinator validates and performs them.
- **An independent evaluator** with fresh context and read-only access that writes a failing reproduction test first, then judges the change against the issue's `done_when` contract.
- **Risk-based review levels** computed from what a change touches, so docs fixes land on their own and money-path changes wait for a human.
- **A land queue** (direct-to-main or PRs) that batches compatible changes and bisects on failure.
- **Guardrails that block the few truly dangerous things** (signing from a live wallet, writing to the production database) and nothing else.
- **One append-only event log** that the dashboard, reports and decision inbox all read from.

See [docs/design.md](docs/design.md) for the architecture and [docs/prior-art.md](docs/prior-art.md) for what we borrowed and from where.

## Quick start (planned)

```sh
npm install --save-dev github:jayden1711/worklane#v0.1.0
npx worklane install   # scaffolds .worklane/, hooks and settings
npx worklane doctor    # verifies the install
npx worklane up        # starts the coordinator and dashboard
```

## Secret scanning

- **CI and agent sessions:** gitleaks scans every commit (agents can't commit unscanned) and every session transcript.
- **Humans:** opt in with `npx worklane install --git-hooks`, which adds a gitleaks pre-commit hook for every worktree of the repo. Without it, human commits are still scanned in CI.

## Using it responsibly

Worklane runs the Claude Code CLI you already have, with your own login or API key, on your own machine and repositories. It has no sign-in flow and never touches credentials. You're responsible for using it within your Anthropic plan's terms; see [docs/auth.md](docs/auth.md).

## License

[Apache-2.0](LICENSE). Third-party code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Contributions require a [DCO sign-off](CONTRIBUTING.md#sign-off). Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities as described in [SECURITY.md](SECURITY.md).
