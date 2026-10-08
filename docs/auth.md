# Auth and agent runtimes

Reviewed 2026-10-07 against Anthropic's published docs and terms. Quotes are verbatim; re-check the linked pages before relying on them, since policies change.

## The two runtimes

| | `cli` (default) | `sdk` (option) |
|---|---|---|
| What runs | the locally installed `claude` binary, headless (`claude -p --output-format stream-json`) | the Claude Agent SDK in-process |
| Auth | whatever the user already configured for Claude Code (subscription login, `claude setup-token`, or a key) | `ANTHROPIC_API_KEY` |
| Isolation | `--setting-sources project` (bare mode is unavailable without an API key) | `settingSources: ['project']`, or bare mode |
| Cost figures | `total_cost_usd` is a list-price **estimate**, not plan usage | estimate, close to the API bill |
| Governing terms | Consumer Terms (subscriptions) or Commercial Terms (keys) | Commercial Terms |

Worklane has **no sign-in flow and never reads, stores, copies or relays credentials.** Each runtime uses its own credential store. The daily budget is a usage guard on estimated cost under either runtime.

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
- This is why the `sdk` runtime uses an API key only, and why Worklane never offers a login.

**Subscription limits assume ordinary individual use.**
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- No primary doc we found permits or prohibits several parallel headless sessions, or unattended overnight runs, on a subscription. **This is a grey area. Treat heavy unattended parallel use as your own risk under your plan's terms.**

## Risks and what Worklane does about them

| Risk | Mitigation |
|---|---|
| **Silent API billing.** In `-p` mode an `ANTHROPIC_API_KEY` in the environment takes precedence over a subscription login. | Before each run the `cli` runtime checks `claude auth status` and refuses to start if the auth method doesn't match the configured runtime. In `cli` mode it removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and cloud-provider credentials from the agent's environment. |
| Heavy unattended use of a subscription | Conservative default concurrency (`agent_runtime.max_concurrency: 2`), optional `run_windows`, a daily budget, and stopping on rate-limit events rather than waiting for the reset. |
| Credential handling | None. Worklane never reads `~/.claude` credentials, keychains, or tokens, and the guardrails deny agents reading credential files (`secret_paths`). |
| Untrusted repos | Non-bare `-p` runs a project's hooks and MCP servers without a trust prompt. Only run Worklane on repositories you trust. |
| Product naming | "Claude Code" may not be part of a product name. The product is "Worklane". |

## Your responsibility

Worklane is for running agents on **your own machine, with your own login or key, on your own repositories**. You are responsible for complying with the terms of your Anthropic plan. Worklane does not share, host or relay credentials, and is not a way to provide agents to other people.
