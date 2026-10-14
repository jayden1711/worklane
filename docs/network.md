# Outbound network: where credentials go

Worklane's children (the `claude` agent runs, `gh`, `git`, project checks and tests) send credentials to the hosts
those tools name themselves: Anthropic's API (or a provider's `base_url` from `agents.yaml`) and GitHub. Nothing in
the environment Worklane was started with can point them anywhere else.

## What is stripped

Every environment Worklane builds for a child (`instanceEnv`, which becomes an instance coordinator's own
environment; `agentEnv` and `runAsEnv` for agent runs; `childEnv` and `projectCommand` for project commands) drops
these, in any letter case, whatever set them (the inherited environment, an instance config, `agents.yaml`,
`tests.yaml` or a request). `src/network.ts` holds the list.

| Variable(s) | Honoured by | Why it goes |
| --- | --- | --- |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `FTP_PROXY` (and lowercase) | curl/git, gh (Go), Node, claude | A proxy sees every request and, for plain HTTP or a trusted interceptor, its credentials. |
| `GIT_PROXY_COMMAND` | git | Runs a command that carries git's connections. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL` | claude | Sends prompts and the key elsewhere. A provider run's own endpoint is set after the strip, from `agents.yaml`. |
| `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE` | claude | Other providers' endpoints. |
| `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_MANTLE`, `_ANTHROPIC_AWS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | claude | Switch where prompts go. |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`, `CLAUDE_CODE_IDE_HOST_OVERRIDE` | claude | Proxy DNS and the IDE host. |
| `BETA_TRACING_ENDPOINT`, `OTEL_EXPORTER_OTLP_*ENDPOINT` | claude | Telemetry and tracing destinations. |
| `GH_HOST`, `GH_REPO`, `GITHUB_HOST`, `GITHUB_API_URL`, `GITHUB_SERVER_URL`, `GITHUB_GRAPHQL_URL` | gh, Actions tooling | Name another GitHub host (gh then uses a login or token for it). |

Tokens (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise tokens, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) were already
dropped from an instance's environment, and an agent's environment is an allowlist.

## A proxy: root's `/etc/worklane/network.json`

When the machine must reach the internet through a proxy, root sets it in one file, and only there:

```json
{"proxy": "http://proxy.internal:3128", "no_proxy": "localhost,127.0.0.1"}
```

Install it as root:root 0644 in one command:

```sh
sudo install -o root -g root -m 0644 network.json /etc/worklane/network.json
```

Worklane then sets `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy` (and `NO_PROXY`/`no_proxy` when
`no_proxy` is given) for every child, from this file only. It is read for every child, so a change applies without a
restart. Removing the file turns the proxy off.

The file is refused (no proxy is set and children go direct; the coordinator says why at start, and the Health page
shows it in red) when:

- root doesn't own it, or its group or others may write it;
- it is over 4096 bytes, isn't a JSON object, or has a key other than `proxy` and `no_proxy`;
- `proxy` isn't an `http://` or `https://` URL of the form `scheme://host[:port]` (no path, query or fragment), is
  over 512 characters, or carries a user or password (`user:pass@`): a proxy login would sit in a world-readable
  file and in every child's environment;
- `no_proxy` is over 1024 characters or holds anything but host names, addresses, ports, `*` and commas.

The Health page shows "Outbound proxy: host:port (from /etc/worklane/network.json)", read-only, to owners and
writers. Nothing on the page, in an instance's config or in a project's config can set or change it.

What the proxy does not cover: the engine's own HTTPS calls (the GitHub API with the instance's token, the App's
token minting) go direct; Node's `fetch` doesn't read proxy variables. A TLS-intercepting proxy also needs its CA in
the machine's trust store, which this file doesn't set.

Native Windows has no root-owned `/etc`: a machine-level proxy isn't supported there, and the variables are still
stripped.
