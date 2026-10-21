### Upgrading (from v0.5.2)

- **An Anthropic API key is a first-class agent login on a server (#897).** `add-project.sh`'s claude-token step now
  counts an API-key setup as done: credentials.yaml's `agent_api_key` is where `credentials.sh <name> api-key` installs
  the key (`<agent home>/.config/<name>-claude-key/api_key`, never another file of that home), the key file is the
  agent user's own and open to nobody else, the agent's own Claude settings name that same file as their
  `apiKeyHelper`, and `claude auth status` as the agent user reports an API-key login. Its waiting message names
  `credentials.sh <name> api-key` beside `credentials.sh <name> claude`.
- **`credentials.sh <name> api-key` writes `agent_api_key` into credentials.yaml itself** (as the coordinator user,
  through the new `worklane instance set-agent-api-key`, the path only), then refreshes the instance's account record
  (`claude-account.sh status <name>`). There is no line to add by hand any more, and `set-agent-api-key` takes no
  path but the installed key's. It now needs the instance's
  credentials.yaml first (`credentials.sh <name> github-app`), and it changes nothing in credentials.yaml unless
  claude, as the agent user, reports an API-key login.
- Doctor's `other-keys` step, run as the coordinator user, no longer says the agent's key file "isn't there": it
  reads root's account record for the agent user instead, and certifies only a key where credentials.sh installs it.
