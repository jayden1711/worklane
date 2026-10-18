# Open-model providers

A model setting in `.worklane/agents.yaml` `routing` (or its older name, `model_routing`) can name a provider instead of an Anthropic model:

- `local`: a small model on this machine, behind an Anthropic-compatible server. That can be a server that speaks
  the Anthropic Messages API itself, or a translating proxy (Anthropic to OpenAI) in front of an OpenAI-compatible
  server.
- `hosted:<name>`: a hosted open model the owner configured, from the GLM, DeepSeek or Kimi families, for example,
  at an Anthropic-compatible endpoint.

Agents still run through the `claude` CLI. Each run sets `ANTHROPIC_BASE_URL` to the provider's endpoint and
passes the provider's model id to `--model`.

## Configuration

**Providers, in the repo's `.worklane/agents.yaml`:**

```yaml
providers:
  local:  { base_url: http://127.0.0.1:8080, credential: local, model: <the server's model id>,
            gpu_lock: <a lock file another workload holds while it runs>, latency_ms: 3000 }
  hosted:
    glm:  { base_url: https://<provider endpoint>, credential: glm, model: <the provider's model id>,
            tier: haiku, usd_per_mtok_in: 0.6, usd_per_mtok_out: 2.2 }
routing: { intake_replier: local, research: hosted:glm }
```

**Opting in, in the instance's `policy.yaml`.** No provider is used until the instance opts in:

```yaml
settings:
  providers: { local: true, hosted: [glm] }
```

**Keys, in the instance's `credentials.yaml`.** Each key is installed with
`credentials.sh <name> provider-key <credential>`:

```yaml
provider_keys: { glm: /home/<agent user>/.config/<name>-provider-keys/glm }
```

A local server that needs no key still gets a placeholder key file, because `claude` needs one.

**The provider's host, allowed by root in `/etc/worklane/providers.json`.** A provider run sends the provider's key
and every prompt (the issue, and the repository content the agent reads) to its `base_url`. Anyone who can change
`agents.yaml` on the default branch can change that URL, so the hosts it may name are the machine's root's to allow.
**No file means no provider host: provider runs are off** until root writes one:

```json
{"hosts": ["api.provider.example", "127.0.0.1:8080"]}
```

```sh
sudo install -o root -g root -m 0644 providers.json /etc/worklane/providers.json
```

- **Exact match:** a `base_url`'s host and port must equal an entry: the same host name or address, and the same
  port. An entry without a port means the scheme's default port (443 for `https://`), so `api.provider.example`
  doesn't allow `https://api.provider.example:8443`. No wildcards, no suffixes. Write each entry the way a URL
  normalises it: lowercase, `127.0.0.1` rather than `127.1`, IPv6 in brackets (`[::1]:11434`).
- **The URL's shape, whatever the list says:** `https://`, except plain `http://` to this machine (`localhost`,
  `127.x.x.x`, `[::1]`); no `user:password@`, no query and no fragment (a key there would be a credential in the
  repo). A path is fine. The config schema refuses any other `base_url`: the config is invalid and the coordinator
  says why.
- **The file is refused** (no host at all, and why) when root doesn't own it, its group or others may write it, it is
  a symlink, it is over 8192 bytes, it isn't `{"hosts": [...]}` (any other key refuses it), or it has more than 64
  hosts or an entry that isn't `host` or `host:port` in that form. Native Windows has no root-owned `/etc`, so no
  provider host there.
- **When it's checked:** at start (the coordinator prints root's hosts, or that provider runs are off and why, and each
  configured provider outside them); when the coordinator resolves each provider run (outside the list, the run takes
  the role's normal model, with a `provider.fallback` event); and by the runner again right before it would set
  `ANTHROPIC_BASE_URL` (a host refused since the run was resolved: the run doesn't start). Each refusal is logged once
  per provider and reason. The file is read each time, so a change applies without a restart.

## Hosted models and the instance's model cap

- **The tier:** every hosted model declares a price `tier` (`haiku`, `sonnet` or `opus`), set by its per-token price
  against Anthropic's models.
- **The cap applies to it:** the instance's `model_cap` (policy.yaml settings) applies to that tier exactly as it does
  to Anthropic models. A hosted model above the cap never runs: the run takes its fallback, which the cap then
  applies to, as to any Anthropic run.
- **No tier, no run:** a hosted model with no tier declared never runs.
- **Local models** cost nothing and have no tier.

## Keys never reach an agent's environment

- **Storage:** a provider's key is a file owned by the agent user, mode 0400.
- **How it's read:** `claude` reads it through `apiKeyHelper` (`cat -- <file>`), which the coordinator passes in that
  run's `--settings`.
  - The coordinator knows only the path.
  - The agent's environment never carries `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, so its commands can't
    read the key, and the sandbox denies the file to them.
- **What gets sent:** `claude` sends the key as both `x-api-key` and `Authorization: Bearer`, so providers that accept
  only Bearer auth work too. This was verified against a local probe server.
- **Config dir:** a provider run gets an empty `CLAUDE_CONFIG_DIR`, so it never has the Claude login.
  - A run as another user keeps that user's own dir.
  - The provider's key takes precedence over the Claude login, so the login is not sent either.
- **Network:** provider runs widen nothing. The provider's host is reached by `claude` itself; the agent's commands
  keep their network allowlist.

## A hosted provider receives the repo content the agent reads

**A hosted provider receives everything the agent sends it: the issue, and the repository content the agent reads.**
Use a hosted provider only for repositories whose content may go to that provider, under its terms.

## What each provider may do (fixed in code: `src/providers.ts`)

| Provider | May run | Never |
|---|---|---|
| `local` | the intake replier, intake triage, the stage-label judge | builds, research, planning, the evaluator |
| `hosted:<name>` | easy builds (the default build route), research | high-risk builds (`size:L`, `money-path`, `review:L3`, `high-risk` labels, escalated attempts), the evaluator, planning |

- **Schema checks:** the schema refuses a provider named anywhere else, and refuses any provider that isn't configured.
- **Hosted changes are checked after the build:** a change a hosted model built that turns out L3, money-path, or
  touching agent instructions (a skill, `AGENTS.md`, a role prompt) is refused, and the task's later attempts run on
  Anthropic.

## When a provider isn't used

A run named for a provider runs on its role's normal model instead in any of these cases:
- the instance hasn't opted in;
- root hasn't allowed the provider's host (`/etc/worklane/providers.json`), or there is no such file;
- the provider or its key is missing;
- the role hasn't passed its evals on the provider's model;
- the local server is down, or slower than `latency_ms`;
- the GPU lock is held, or can't be checked.

The coordinator records each fallback as a `provider.fallback` event with the reason, and nothing waits on a provider.

## The eval gate

- **The rule:** a role runs on a provider's model only if it has passed its evals there: 3 samples, visible and
  held-out, with the held-out score not below its normal model's.
- **Where it's recorded:** `<state>/evals/provider-gate.json`, in the coordinator's state, keyed by role and the
  provider's model id.
- **No record means no move:** until a passing record exists, the role keeps its normal model.

## GPU sharing

- **The lock:** a project can name a lock file another workload (a simulator, ML tests) holds with flock(2) while it
  runs (`providers.local.gpu_lock`).
- **What happens while it's held:** local-model runs fall back to the role's normal model. They never wait for the
  lock or take it.
- **How it's detected** (`flockHeld`, in the OS adapter), without acquiring the lock:
  - **Linux:** the file's device and inode, matched against `/proc/locks`.
  - **macOS:** a non-blocking shared try-lock, released at once.
- **VRAM:** keeping the model loaded in VRAM is the server's choice, not Worklane's. Configure the server to unload
  the model when idle (an idle timeout or keep-alive setting), so the GPU is free for the other workload between runs.

## Usage

`run.cost` records each run's provider, tokens and seconds:
- **Local runs** cost $0.
- **Hosted runs** cost the configured `usd_per_mtok_in` / `usd_per_mtok_out`.

The throughput panel and the weekly report show cost, tokens and time per merged PR for each model.

## What the owner sets up (nothing is installed by Worklane here)

1. **For the local model:**
   - an Anthropic-compatible server on the machine (or a translating proxy in front of an OpenAI-compatible
     server), on `127.0.0.1`;
   - its model, set to unload when idle;
   - its `base_url` and model id in `agents.yaml`;
   - a placeholder key installed with `credentials.sh <name> provider-key local`.
2. **For each hosted provider:**
   - an account and an API key, scoped and with a spend limit;
   - its Anthropic-compatible `base_url` and model id, with prices, in `agents.yaml`;
   - the key installed with `credentials.sh <name> provider-key <credential>`.
3. **The hosts, as root:** each provider's host (and port) in `/etc/worklane/providers.json`, root:root 0644.
4. **The opt-in:** `policy.yaml` `settings.providers`.
5. **Evals per role and candidate model:** 3 samples, visible and held-out, recorded in the gate, before any role moves.

## Other vendors' coding CLIs: `cli:codex`, `cli:gemini`

`model_routing.build` can also name `cli:codex` (OpenAI's Codex CLI) or `cli:gemini` (Google's Gemini CLI). These
runs don't use `claude` at all: `src/cli-agents.ts` starts the vendor's CLI headless (`codex exec --json -`,
`gemini --output-format stream-json -p ...`), with the prompt on stdin, and reads its JSON events into the run's
result, record and live feed.

- **Opt-in, configured, evaluated:** as for hosted models. The instance lists the CLI in `policy.yaml`
  `settings.providers.cli`, `agents.yaml` names its model, tier and prices, and the role must pass its evals on that
  model id. Otherwise the build runs on its normal model, with a `provider.fallback` event.
- **Builds only, never high-risk:** planning, research, the evaluator, intake, the stage judge, interactive runs and
  high-risk builds are refused, both when routing and by the runner itself. A resumed session is refused, and the
  fix run starts fresh on its normal model.
- **No claude sandbox and no guardrail hooks:** neither applies to these CLIs. The run's boundary is the OS user: it
  runs only as the lane's agent user, through `sudo -u`, with the same allowlisted environment as any agent (no
  GitHub token, no git credential helper, no provider keys). A lane without an agent user never runs one.
- **The change is held after the build:** a change that is above L1, or touches a protected path
  (`guardrails.yaml` `protected_paths` and the built-in ones), a money path or agent instructions, is refused. The
  task's later attempts then run on Anthropic.
- **Budgets:** the runner prices the CLI's token counts at the configured `usd_per_mtok_in` / `usd_per_mtok_out`. It
  stops the run once the cost passes the run's budget, or once its tool calls pass the turn cap. Both CLIs report
  tokens when a turn ends, so between reports the turn cap and the run's timeout bound it. A run that ends over
  budget counts as `budget_exhausted`.
- **Structured output:** the prompt asks the agent to end with a JSON object matching the run's schema, and the
  runner reads it back. An answer without one fails the run.

```yaml
# agents.yaml
providers:
  cli:
    codex:  { model: <codex model id>, tier: sonnet, usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 }
    gemini: { model: <gemini model id>, tier: sonnet, usd_per_mtok_in: 1.25, usd_per_mtok_out: 10 }
model_routing: { build: cli:codex }
# policy.yaml
settings:
  providers: { cli: [codex] }
```

**What the owner sets up (nothing here installs either CLI or signs in to one):** install the CLI where the agent
user's `PATH` finds it (`codex`, `gemini`), and sign it in as the agent user, so its login lives in that user's home
(`~/.codex`, `~/.gemini`). Give it no MCP servers or extensions in that user's config. Then fill in the
configuration above and record the role's evals on the model.
