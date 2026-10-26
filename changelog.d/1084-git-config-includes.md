### Guardrail changes: what each one does

- **git config in a child's environment loses includes, remote and push-target keys, and a named global or system
  config file (#1084).** The engine strips TLS, proxy and URL-rewrite keys from git config carried in a child's
  environment. An `include.path` or `includeIf.<cond>.path` key among them read a file whose `url.*.insteadOf` and
  `http.sslVerify=false` git applied; any `include.*` or `includeIf.*` key is now stripped too. So are
  `url..insteadOf` and `url..pushInsteadOf` with an empty base (which prefix every URL), `remote.<name>.proxy*`,
  `.url` and `.pushurl`, `core.gitProxy`, and `remote.pushDefault`, `branch.<b>.pushRemote` and
  `branch.<b>.remote` whatever they name (a name no remote has is a path to git). A `GIT_CONFIG_GLOBAL` or
  `GIT_CONFIG_SYSTEM` naming a file is replaced with `/dev/null`: the engine's children read no global or system git
  config from a file the environment names (they read none, not `~/.gitconfig` in its place). Set to `/dev/null`
  already, or unset, these are unchanged. Still not covered: `HOME` and `XDG_CONFIG_HOME`, which choose
  `~/.gitconfig`, and keys outside this list (`remote.<name>.uploadpack`/`receivepack`, `core.sshCommand`).
