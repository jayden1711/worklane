# Outbound network: where credentials go, and whom children trust

Worklane's children (the `claude` agent runs, `gh`, `git`, project checks and tests) send credentials to the hosts
those tools name themselves: Anthropic's API (or a provider's `base_url` from `agents.yaml`, on a host root allows in
`/etc/worklane/providers.json`: [providers.md](providers.md)) and GitHub. They verify
those hosts against their own trust stores. Nothing in the environment Worklane was started with can point them
anywhere else, add a CA they trust, or loosen how they verify.

## What is stripped

Every environment Worklane builds for a child (`instanceEnv`, which becomes an instance coordinator's own
environment; `agentEnv` and `runAsEnv` for agent runs; `childEnv` and `projectCommand` for project commands) drops
these, in any letter case, whatever set them (the inherited environment, an instance config, `agents.yaml`,
`tests.yaml` or a request). `src/network.ts` holds the list.

### Where requests go

| Variable(s) | Honoured by | Why it goes |
| --- | --- | --- |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, `FTP_PROXY` (and lowercase) | curl/git, gh (Go), Node, claude | A proxy sees every request and, for plain HTTP or a trusted interceptor, its credentials. |
| `GIT_PROXY_COMMAND`, `GIT_HTTP_PROXY_AUTHMETHOD` | git | A command that carries git's connections; how git authenticates to a proxy. |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_URL` | claude | Sends prompts and the key elsewhere. A provider run's own endpoint is set after the strip, from `agents.yaml`, and only to a host root allows in `/etc/worklane/providers.json`. |
| `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE` | claude | Other providers' endpoints. |
| `CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`, `_MANTLE`, `_ANTHROPIC_AWS`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | claude | Switch where prompts go. |
| `CLAUDE_CODE_PROXY_RESOLVES_HOSTS`, `CLAUDE_CODE_IDE_HOST_OVERRIDE` | claude | Proxy DNS and the IDE host. |
| `BETA_TRACING_ENDPOINT`, `OTEL_EXPORTER_OTLP_*ENDPOINT` | claude | Telemetry and tracing destinations. |
| `GH_HOST`, `GH_REPO`, `GITHUB_HOST`, `GITHUB_API_URL`, `GITHUB_SERVER_URL`, `GITHUB_GRAPHQL_URL` | gh, Actions tooling | Name another GitHub host (gh then uses a login or token for it). |

### What TLS trusts

| Variable(s) | Honoured by | Why it goes |
| --- | --- | --- |
| `NODE_EXTRA_CA_CERTS` | Node, claude | Adds CAs every Node child trusts. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Node, claude | `0` turns certificate verification off. |
| `NODE_USE_SYSTEM_CA` | Node | Switches which store Node trusts. |
| `NODE_OPTIONS` carrying `--use-openssl-ca`, `--use-bundled-ca`, `--use-system-ca`, `--openssl-config`, `--openssl-shared-config`, `--openssl-legacy-provider`, `--tls-*` or `--insecure-http-parser` | Node | The same switches as flags, and TLS versions, ciphers and key logging. `NODE_OPTIONS` without one of these is kept. |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | gh (Go), OpenSSL (curl, git, Python) | Replace the CA file or directory. |
| `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` | Python requests, curl | Their CA bundles. |
| `OPENSSL_CONF`, `OPENSSL_CONF_INCLUDE`, `OPENSSL_MODULES` | OpenSSL (Node, curl, git) | An OpenSSL config can lower the security level or load another provider. |
| `GODEBUG` | gh (Go) | Re-enables weak X.509 and TLS behaviour (`x509sha1=1` and the like). |
| `SSLKEYLOGFILE` | libcurl (git), curl | Writes TLS session keys to a file: whoever reads it decrypts the traffic. |
| `GIT_SSL_*` (`GIT_SSL_NO_VERIFY`, `_CAINFO`, `_CAPATH`, `_CERT`, `_KEY`, `_CERT_PASSWORD_PROTECTED`, `_VERSION`, `_CIPHER_LIST`, `_PINNEDPUBKEY`) and `GIT_PROXY_SSL_*` | git | Verification off, another CA, a client certificate, weaker TLS, for the remote and for a proxy. |
| `GIT_CONFIG_PARAMETERS` | git | `git -c` config passed to child gits; it can carry `http.sslVerify=false`. |
| `GIT_CONFIG_KEY_n`/`VALUE_n` pairs for `http.[<url>.]ssl*`, `http.*proxy*`, `http.*schannel*`, `http.*pinnedPubkey`, `http.*curloptResolve`, `url.*.insteadOf`, `url.*.pushInsteadOf` | git | The same settings as environment config. Those pairs are removed and the rest renumbered. The engine's own pairs (credential helper, hooks path, safe.directory) stay. |
| `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` | claude | Which CA sources claude trusts, and a client certificate for mTLS. |

Tokens (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise tokens, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`) were already
dropped from an instance's environment, and an agent's environment is an allowlist.

## Root's `/etc/worklane/network.json`: a proxy and a custom CA

When the machine must reach the internet through a proxy, or trust a company CA (a TLS-intercepting proxy), root sets
it in one file, and only there:

```json
{"proxy": "http://proxy.internal:3128", "no_proxy": "localhost,127.0.0.1", "ca_file": "/etc/worklane/ca/corp.pem"}
```

Each key is optional. Install the CA and the file as root:root 0644, in a directory only root may write:

```sh
sudo install -d -o root -g root -m 0755 /etc/worklane/ca
sudo install -o root -g root -m 0644 corp.pem /etc/worklane/ca/corp.pem
sudo install -o root -g root -m 0644 network.json /etc/worklane/network.json
```

From this file only, Worklane sets for every child:

- with `proxy`: `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy`, plus `NO_PROXY`/`no_proxy` when
  `no_proxy` is given;
- with `ca_file`: exactly these three, each set to the CA file's path:
  - `NODE_EXTRA_CA_CERTS`: Node and claude add these CAs to their bundled store;
  - `SSL_CERT_FILE`: gh (Go on Linux) reads it in place of the system CA file, and still reads the system CA
    directories;
  - `GIT_SSL_CAINFO`: git's CA file for HTTPS remotes.

  Behind an intercepting proxy, every request is re-signed by that CA, which is what these three cover. On macOS, gh
  uses the system keychain and ignores `SSL_CERT_FILE`, so add the CA to the keychain there.

The file is read for every child, so a change applies without a restart. Removing it turns both off.

The whole file is refused (no proxy and no CA: children go direct and trust their own stores; the coordinator says
why at start, and the Health page shows it in red) when any of these hold:

- root doesn't own it, its group or others may write it, or it is a symlink;
- it is over 4096 bytes, isn't a JSON object, or has a key other than `proxy`, `no_proxy` and `ca_file`;
- `proxy` isn't an `http://` or `https://` URL of the form `scheme://host[:port]` (no path, query or fragment), is
  over 512 characters, or carries a user or password (`user:pass@`). A proxy login would sit in a world-readable
  file and in every child's environment;
- `no_proxy` is over 1024 characters, or holds anything but host names, addresses, ports, `*` and commas;
- `ca_file` isn't an absolute, plain path of at most 256 characters (letters, digits, `. _ - /`, no `.` or `..`
  parts);
- the CA file is missing, isn't a regular file, is a symlink, isn't root's, or its group or others may write it;
- the CA file's directory isn't root's, or its group or others may write it;
- the CA file is over 256 KiB, or holds anything but 1 to 64 PEM `CERTIFICATE` blocks that parse. A private key,
  another PEM type or stray text is refused.

There is no setting that turns verification off, and none is planned. An unknown key such as `insecure` or `verify`
refuses the file.

The Health page shows, read-only, to owners and writers:

- "Outbound proxy: host:port (from /etc/worklane/network.json)";
- "Custom CA: /etc/worklane/ca/corp.pem, N certificates, fingerprints sha256:…" (the first 16 hex digits of each
  certificate's SHA-256).

Nothing on the page, in an instance's config or in a project's config can set or change either.

What this does not cover: the engine's own HTTPS calls (the GitHub API with the instance's token, the App's token
minting) go direct and trust Node's own store. Node's `fetch` doesn't read proxy variables, and the engine process
isn't restarted with `NODE_EXTRA_CA_CERTS`.

Native Windows has no root-owned `/etc`: neither setting is supported there, and the variables are still stripped.
