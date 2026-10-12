# Open-model providers

A model setting in `.worklane/agents.yaml` `model_routing` can name a provider instead of an Anthropic model:

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
model_routing: { intake_replier: local, research: hosted:glm }
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
3. **The opt-in:** `policy.yaml` `settings.providers`.
4. **Evals per role and candidate model:** 3 samples, visible and held-out, recorded in the gate, before any role moves.
