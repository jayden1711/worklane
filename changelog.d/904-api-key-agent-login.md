### Upgrading (from v0.5.2)

- **An Anthropic API key is a first-class agent login on a server (#897).** `add-project.sh`'s claude-token step now
  counts an API-key setup as done: credentials.yaml's `agent_api_key` is where `credentials.sh <name> api-key` installs
  the key (`<agent home>/.config/<name>-claude-key/api_key`, never another file of that home), the key file is the
  agent user's own, one file with one link and open to nobody else, the agent's own Claude settings (a plain file) name
  that same file as their `apiKeyHelper`, and `claude auth status` as the agent user reports an API-key login.
  `agent_api_key` is read as the engine loads credentials.yaml (`worklane instance agent-api-key-of`), never as a
  line of text. Each check run as the agent or coordinator user is bounded by root's timeout, outside that user's
  reach, so nothing of theirs (a stopped process included) can hold add-project or its machine-wide lock. Its waiting
  message names `credentials.sh <name> api-key` beside `credentials.sh <name> claude`.
- **`credentials.sh <name> api-key` writes `agent_api_key` into credentials.yaml itself** (as the coordinator user,
  through the new `worklane instance set-agent-api-key`, the path only), then refreshes the instance's account record
  (`claude-account.sh status <name>`). There is no line to add by hand any more. It now needs the instance's
  credentials.yaml first (`credentials.sh <name> github-app`), and it changes nothing in credentials.yaml unless
  claude, as the agent user, reports an API-key login. `set-agent-api-key` takes no path but this instance's installed
  key, in the agent user's home as the user database names it.
- Doctor's `other-keys` step no longer says the agent's key file "isn't there" when the coordinator user runs it: it
  reads root's account record for the instance's own agent user instead. It certifies only this instance's installed
  key, and fails closed on a key file it can see that isn't the agent user's alone. An API-key instance renamed since
  its key was installed reads not done there until `credentials.sh <new name> api-key` is run again.
