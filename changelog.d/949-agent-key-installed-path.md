### Upgrading

- An API-key instance's coordinator now starts only when credentials.yaml's `agent_api_key` is the path
  `credentials.sh <name> api-key` installs: `<agent home>/.config/<name>-claude-key/api_key`, with the home taken
  from the user database (#949). Any other path is refused at start, and the coordinator says which path it expected.
  An instance renamed since its key was installed: rerun `credentials.sh <new name> api-key`.
