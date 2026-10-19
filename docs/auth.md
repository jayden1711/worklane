# Auth and agent runtimes

Reviewed 2026-10-18 against Anthropic's published docs and terms, each page fetched that day. Quotes are verbatim, apart from the links and markup noted; re-check the linked pages before relying on them, since policies change.

## The rule this follows

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md) page, "Authentication and credential use" (fetched 2026-10-18):

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."

The same section, the next paragraph (right after its list):

> "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."

So, since issue #711:

- **The engine never touches a Claude credential.** No dashboard page, route or paste box takes a setup token or a sign-in code, and the coordinator never stores or relays one. The four ways earlier versions did are gone: the account switch's paste box, adding a profile from a pasted token, the sign-in relayed through the dashboard (its one-time code), and Add project's token box. Their routes answer `410 Gone`, and every request body the dashboard reads is refused if it holds a setup token or a sign-in code, whatever the route (`src/claude-credential-guard.ts`, `test/claude-credential-guard.test.ts`).
- **The person signs in to the CLI directly, on the machine.** Each way to do that is below. Nothing in the engine blocks or disables any of them.
- **The dashboard shows status only**: whether an account is set, and to a machine owner which one, from what root's `claude-account.sh status` last found. Never the token.

## Signing the agents in, on the machine

Every method the unmodified `claude` has works for the agent users, run on the machine. In server mode each instance's agents run as `wl-<name>-agent`, so that is the user to sign in as; root (or an admin with sudo) does it there.

| Method | Server mode: who, and how | Local mode |
|---|---|---|
| `claude auth login` (or `/login` in `claude`) | as the agent user: `sudo -u wl-<name>-agent -i claude auth login`. Sign-in completes on Anthropic's page. The login lands in that user's own `~/.claude` | as yourself, in a terminal. The first-run page's **Sign in to Claude** runs the same command as this machine's user and shows Anthropic's sign-in link as a button; the link comes back to `claude`'s own listener on localhost, and nothing is pasted into the page (`src/claude-signin.ts`) |
| `claude setup-token` | run it anywhere signed in to the account, then as root: `sudo bash scripts/setup/credentials.sh <name> claude` (hidden prompt, or stdin). `add-project.sh` at a root shell asks the same. `claude-account.sh switch` puts one token on every agent user on the machine | not needed |
| API key | as root: `sudo bash scripts/setup/credentials.sh <name> api-key`; `claude` reads it through `apiKeyHelper` as the agent user (below) | `agent_runtime.kind: api_key` and `ANTHROPIC_API_KEY` |
| Bedrock, Vertex, Foundry | `claude` supports them as the agent user (its own settings). The engine's runs refuse a run on them today: the runner's auth check accepts only `claude.ai`/`oauth_token` for `cli` and `api_key`/`api_key_helper` for `api_key` (`src/runner.ts`, "no silent billing switch"). That check is #700's to change, not this page's | the same |
| Account profiles | as root: `sudo bash scripts/setup/claude-account.sh profile-add <profile>` (hidden prompt, or stdin) puts a token in each agent user's own profile dir; which profile an instance uses is chosen at a root shell or from its dashboard (no credential) | not used |

**Existing installs.** Nothing reopens.
- **Files.** An earlier dashboard stored each of these, as the coordinator user, for a root script to read once: a switch's token, a profile's token, a sign-in code, and Add project's token. They went in a `*-secrets` dir in the coordinator user's own `~/.config`. Add project's token went in the *asking* instance's coordinator user's home, under the *new* project's name: `~wl-<asker>/.config/<new>-secrets/claude-token`. The others went in `~wl-<name>/.config/<name>-secrets/`. The next run of `claude-account.sh` of any kind (the Machine page's Refresh is one) removes them, unread: in every `~wl-<name>/.config/*-secrets/` dir, as that coordinator user, only those four names (`claude-token`, `claude-account-token`, `claude-profile-token`, `claude-login-code`), and only regular files. It follows no link.
- **Asks.** Add project's ask for the token (a `paste_secret` ask for `claude-token`), left open when the coordinator stopped mid-run, is withdrawn when the coordinator next starts. The withdrawal's event gives the reason, citing #711. Until then the ask is listed as not answerable, so no page offers its paste box, and the server refuses any answer to it.

A profile an earlier version staged from a dashboard stays unusable until a root admin confirms it: `sudo bash scripts/setup/claude-account.sh confirm-profile <profile>`.

## How agents are billed

There is one runtime: the locally installed, unmodified `claude` binary, headless (`claude -p --output-format stream-json`, `--setting-sources project`). There is no Agent SDK runtime. What differs is how that `claude` is billed:

| | Claude login (default) | API key (option) |
|---|---|---|
| Set by | root on the machine: a token from `claude setup-token` at `scripts/setup/credentials.sh <name> claude`'s hidden prompt, or `claude auth login` as the agent user (above) | `scripts/setup/credentials.sh <name> api-key`, then `agent_api_key: <file>` in the instance's `credentials.yaml` |
| `agent_runtime` | `cli` | `api_key` for an instance with `agent_api_key` (an instance's billing is set by its own credentials, not by the repo's config); a local run without an instance uses `agent_runtime.kind: api_key` (`sdk` is accepted as the old name) and `ANTHROPIC_API_KEY` |
| Where the credential lives | the agent user's Claude config dir | a file owned by the agent user, mode 0400, in a 0700 directory of its own |
| How `claude` gets it | its own login | `apiKeyHelper` (`cat -- <file>`), passed in each run's `--settings` and in the agent user's own Claude settings, so `claude` reads the key as the agent user when it starts |
| Preflight (every run) | `claude auth status` must report `claude.ai` or `oauth_token` | must report `api_key` or `api_key_helper` |
| Cost figures | `total_cost_usd` is a list-price **estimate**, not plan usage | estimate, close to the API bill |
| Governing terms | Consumer Terms (subscriptions) | Commercial Terms |

**Why `apiKeyHelper` and not an environment variable.** A key in `ANTHROPIC_API_KEY` would be in the environment of `claude` and of every command an agent runs, and the coordinator would have to hold it to pass it on. With `apiKeyHelper`:
- the coordinator passes only the file's path;
- `claude`, running as the agent user, reads the file itself;
- agent commands are denied the file by the sandbox's read rules while the sandbox is on (the lane's `denyRead`, `src/instance.ts`, `laneRuns`), as they are every profile's `.credentials.json` (`src/runner.ts`, `withDeniedReads`);
- project commands (checks, worktree setup, full runs, suite tuning, a browser flow's app, auto-config), which run agent-written code as the agent user outside `claude`, always run in a sandbox of their own that hides the file, every `~/.claude*` login, profile and settings file, the instance home and every file `credentials.yaml` names, whatever `policy.yaml`'s `sandbox` says (issue #713, `projectCommand` in `src/os/index.ts`): bubblewrap on Linux, with its own PID namespace, so no process outside it can be read through `/proc`; `sandbox-exec` on macOS. When bubblewrap can't start, the command doesn't run and says to run `scripts/setup/machine.sh`. What they print is redacted (`src/events/redact.ts`) before it reaches an event or a prompt;
- `instanceEnv` still strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` for every instance.

The coordinator never reads the file. It **can**, though: see the next section.

The helper is given only to runs as the instance's agent user. A lane that runs as another user (the eval lane) never gets it.

**Spend caps are the same either way.** Every run's command line carries `--max-budget-usd` whatever the billing: the role's `budget_usd`, and for most roles (workers, fix runs, the planner, chat, research, intake) no more than what's left of the day's `daily_budget_usd`, which the instance policy caps. Once the daily budget is spent, no new task starts.

**`doctor`** checks the key file exists, is owned by the agent user and is open to nobody else (0400). It never reads the file. As the coordinator user it usually can't see the file with its own permissions, and says so; run it as root to check the mode.

## Who can reach the agents' credentials

The agents' Claude login (`~/.claude/.credentials.json`, and each profile's) and the API key file belong to the agent user, 0600 or 0400, in directories only it can open. Who can still reach them:

- **The agent user**, which `claude` runs as, and owns the files. With the sandbox on (`policy.yaml`'s default), its commands (Bash and the rest) are denied the files by the sandbox's read rules; `claude` itself reads them outside the sandbox, as it must. With the sandbox off, an agent's commands can read them. Project commands can't either way: they always run in their own sandbox (above).
- **Root**, and any admin with sudo.
- **The coordinator user (`wl-<name>`), and the agent code it launches.** Its sudo rule is `wl-<name> ALL=(wl-<name>-agent) NOPASSWD: ALL`, with the eval user added when there is one (`scripts/setup/instance.sh:40`): it may run any command as the agent user, and so read the agent's login and key file. Anything that gets code running as the coordinator user (the coordinator service, or a shell as that user) can do the same. The coordinator's own code never does; nothing enforces that, beyond the code. Narrowing the rule so the coordinator can run only what it needs is a later change (#737).
- **The instance's dashboard process, indirectly.** It runs as the coordinator user with `NoNewPrivileges=yes` (`scripts/setup/dashboards.sh`), so it can't use the sudo rule itself. It can still write the coordinator user's files, `policy.yaml` among them (#726), so code that took it over could change what the coordinator later runs as the agent user. Count it with the coordinator user. The dashboard takes no credential in any case (above).

The root scripts handle the credential only while installing it: `credentials.sh`, `add-project.sh` and `claude-account.sh` take the token at a hidden prompt (or root's stdin) and pipe it into the agent user's own file, never as an argument and never to a log. `claude-account.sh status` reads the stored login as root to show which token it is (the first 8 hex digits of its sha256) and when it expires; it never shows or stores the token.

**Account profiles (issue #464).** An agent user may hold several Claude logins side by side, each in its own `CLAUDE_CONFIG_DIR` under its home (`~/.claude-profiles/<name>/`, 0700, its own). The engine only passes the active profile's path to each run; it never reads, copies or moves a login between profiles or users. A profile is added by a root admin on the machine (`claude-account.sh profile-add`, its token at the hidden prompt), installed as each agent user. It becomes active only after one minimal real call as every agent user on it is answered, and a dashboard can choose it only for its own instance (docs/dashboard.md, "Claude account profiles"). Every profile's credentials file is denied to agent commands.

## What the docs say

**Scripted use of the CLI with a subscription is documented.**
- [Authentication](https://code.claude.com/docs/en/authentication.md): "For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`" (its colon left out). The same page: "This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan."
- [Headless](https://code.claude.com/docs/en/headless.md): "To run Claude Code in non-interactive mode, pass `-p` with your prompt and the CLI options you need" (its link and colon left out).

**Collecting, storing or relaying a Claude credential is not allowed; signing in to the unmodified binary is.** Both quotes are at the top of this page. Worklane spawns the user's own unmodified `claude` on the user's own machine. The user signs it in there, through Anthropic's own flow (or a token installed by root), and the engine never takes the credential.

**Products should use API keys.**
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider." (links and bold left out)
- This is why Worklane never offers a login: the API-key option is a key you bring, for your own agents.

**Subscription limits assume ordinary individual use.**
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md): "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- No primary doc we found permits or prohibits several parallel headless sessions, or unattended overnight runs, on a subscription. **This is a grey area. Treat heavy unattended parallel use as your own risk under your plan's terms.**

## Risks and what Worklane does about them

| Risk | Mitigation |
|---|---|
| **Silent API billing.** In `-p` mode an `ANTHROPIC_API_KEY` in the environment takes precedence over a subscription login. | Before each run the runner checks `claude auth status` and refuses to start if the auth method doesn't match the billing configured (login or API key). The agent's environment never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or cloud-provider credentials for an instance; an API key reaches `claude` only through `apiKeyHelper`. |
| Heavy unattended use of a subscription | Conservative default concurrency (`agent_runtime.max_concurrency: 2`), optional `run_windows`, a daily budget, and stopping on rate-limit events rather than waiting for the reset. |
| Credential handling | The engine takes no Claude credential: no dashboard route or paste box accepts one, and none is stored or relayed by the coordinator. It passes only the key file's path and each profile's directory. The guardrails deny agents reading credential files (`secret_paths`), and the sandbox, while on, denies them the login and the key file. The coordinator user can still reach them through its sudo rule (above). |
| Untrusted repos | Non-bare `-p` runs a project's hooks and MCP servers without a trust prompt. Only run Worklane on repositories you trust. |
| Product naming | "Claude Code" may not be part of a product name. The product is "Worklane". |

## Your responsibility

Worklane is for running agents on **your own machine, with your own login or key, on your own repositories**. You are responsible for complying with the terms of your Anthropic plan. Worklane does not take, share, host or relay Claude credentials, and is not a way to provide agents to other people.
