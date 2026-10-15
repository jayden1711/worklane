# Auth and agent runtimes

Reviewed 2026-10-07 against Anthropic's published docs and terms. Quotes are verbatim; re-check the linked pages before relying on them, since policies change.

## How agents are billed

There is one runtime: the locally installed, unmodified `claude` binary, headless (`claude -p --output-format stream-json`, `--setting-sources project`). There is no Agent SDK runtime. What differs is how that `claude` is billed:

| | Claude login (default) | API key (option) |
|---|---|---|
| Set by | a token from `claude setup-token`, pasted into the dashboard (first run's Sign in to Claude, or Add project's paste box) or at `scripts/setup/credentials.sh <name> claude`'s hidden prompt | `scripts/setup/credentials.sh <name> api-key`, then `agent_api_key: <file>` in the instance's `credentials.yaml` |
| `agent_runtime` | `cli` | `api_key` for an instance with `agent_api_key` (an instance's billing is set by its own credentials, not by the repo's config); a local run without an instance uses `agent_runtime.kind: api_key` (`sdk` is accepted as the old name) and `ANTHROPIC_API_KEY` |
| Where the credential lives | the agent user's Claude config dir | a file owned by the agent user, mode 0400, in a 0700 directory of its own |
| How `claude` gets it | its own login | `apiKeyHelper` (`cat -- <file>`), passed in each run's `--settings` and in the agent user's own Claude settings, so `claude` reads the key as the agent user when it starts |
| Preflight (every run) | `claude auth status` must report `claude.ai` or `oauth_token` | must report `api_key` or `api_key_helper` |
| Cost figures | `total_cost_usd` is a list-price **estimate**, not plan usage | estimate, close to the API bill |
| Governing terms | Consumer Terms (subscriptions) | Commercial Terms |

**Why `apiKeyHelper` and not an environment variable.** A key in `ANTHROPIC_API_KEY` would be in the environment of `claude` and of every command an agent runs, and the coordinator would have to hold it to pass it on. With `apiKeyHelper`:
- the coordinator passes only the file's path;
- `claude`, running as the agent user, reads the file itself;
- the coordinator user can't read it (it isn't theirs), and agent commands are denied it by the sandbox, like the Claude login's `.credentials.json`;
- `instanceEnv` still strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` for every instance.

The helper is given only to runs as the instance's agent user. A lane that runs as another user (the eval lane) never gets it.

**Spend caps are the same either way.** Every run's command line carries `--max-budget-usd` whatever the billing: the role's `budget_usd`, and for most roles (workers, fix runs, the planner, chat, research, intake) no more than what's left of the day's `daily_budget_usd`, which the instance policy caps. Once the daily budget is spent, no new task starts.

**`doctor`** checks the key file exists, is owned by the agent user and is open to nobody else (0400). It never reads the file. As the coordinator user it usually can't see the file at all (by design), and says so; run it as root to check the mode.

Worklane has **no sign-in flow and never reads, stores, copies or relays credentials.** `credentials.sh` (run by the owner, as root) installs them; the engine only passes paths.

**Account profiles (issue #464).** An agent user may hold several Claude logins side by side, each in its own `CLAUDE_CONFIG_DIR` under its home (`~/.claude-profiles/<name>/`, 0700, its own). The engine only passes the active profile's path to each run; it never reads, copies or moves a login between profiles or users. A profile is added from a `claude setup-token` token, installed by root as that user. Added from a dashboard, it is staged and unusable until a root admin confirms it on the machine (seeing the account, typing its name). It becomes active only after one minimal real call as every agent user on it is answered, and a dashboard can choose it only for its own instance (docs/dashboard.md, "Claude account profiles"). Every profile's credentials file is denied to agent commands.

**The one exception: a relayed sign-in on a server (the owner's decision, 2026-10-15).** "The dashboard never runs `claude auth login` on a server" is lifted for this flow only: adding a Claude account profile from the Machine page. Only a machine owner who is an owner of the instance, signed in, on an allowed console device (or the owner's break-glass) may start one or give its code, and every request and refusal is audited. What happens:

- The machine helper (`claude-account login <name>`, the instance from sudo, never an argument) runs `claude auth login` as that instance's agent user, on a new profile's own `CLAUDE_CONFIG_DIR`, with nothing for a browser to open.
- Claude's sign-in link (Anthropic's page, whose redirect is Anthropic's own code page) goes to a file only that instance's coordinator user can read; the dashboard shows it to its machine owners and to nobody else. It is never in an event, a log line, a progress line or an argument.
- The one-time code that page shows is pasted into the dashboard once. It is stored for the coordinator user only (0400), read once by the script as root, deleted, and written to `claude`'s stdin. A second code, or one after the first was taken, is refused; the code is never in an event, the audit, a response, a URL, an argument or a log line.
- The login then gets one minimal real call, and the profile is **staged**: nothing may use it until a root admin runs `claude-account.sh confirm-profile <name>` on the machine, which shows the account email and org from a real call and needs the name typed back.
- Every sign-in is an ops alert.

`src/claude-signin.ts`'s refusal of pasted codes stays for every other path (the first-run wizard's local sign-in relays only a link that comes back to localhost).

## What the docs say

**Scripted use of the CLI with a subscription is documented.**
- [Authentication](https://code.claude.com/docs/en/authentication.md): "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`." The same page: "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan."
- [Headless](https://code.claude.com/docs/en/headless.md): "To run Claude Code in non-interactive mode, pass `-p` with your prompt and the CLI options you need."

**Using your own subscription with the unmodified binary is carved out.**
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md) prohibits third-party developers from offering Claude.ai login or routing requests through subscription credentials "on behalf of their users". It then adds: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code."
- Worklane fits this carve-out. It spawns the user's own unmodified `claude` on the user's own machine, and never handles the credential.

**Products should use API keys.**
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication."
- This is why Worklane never offers a login: the API-key option is a key you bring, for your own agents.

**Subscription limits assume ordinary individual use.**
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- No primary doc we found permits or prohibits several parallel headless sessions, or unattended overnight runs, on a subscription. **This is a grey area. Treat heavy unattended parallel use as your own risk under your plan's terms.**

## Risks and what Worklane does about them

| Risk | Mitigation |
|---|---|
| **Silent API billing.** In `-p` mode an `ANTHROPIC_API_KEY` in the environment takes precedence over a subscription login. | Before each run the runner checks `claude auth status` and refuses to start if the auth method doesn't match the billing configured (login or API key). The agent's environment never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or cloud-provider credentials for an instance; an API key reaches `claude` only through `apiKeyHelper`. |
| Heavy unattended use of a subscription | Conservative default concurrency (`agent_runtime.max_concurrency: 2`), optional `run_windows`, a daily budget, and stopping on rate-limit events rather than waiting for the reset. |
| Credential handling | None in the engine. It never reads `~/.claude` credentials, keychains, tokens or the API key file; it passes only the key file's path. The guardrails deny agents reading credential files (`secret_paths`), and the sandbox denies them the login and the key file. |
| Untrusted repos | Non-bare `-p` runs a project's hooks and MCP servers without a trust prompt. Only run Worklane on repositories you trust. |
| Product naming | "Claude Code" may not be part of a product name. The product is "Worklane". |

## Your responsibility

Worklane is for running agents on **your own machine, with your own login or key, on your own repositories**. You are responsible for complying with the terms of your Anthropic plan. Worklane does not share, host or relay credentials, and is not a way to provide agents to other people.
