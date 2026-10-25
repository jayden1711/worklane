### Guardrail changes: what each one does

- **git config in a child's environment can no longer pull in another config file, or point git at another remote
  or proxy (#1084).** The engine strips TLS, proxy and URL-rewrite keys from git config carried in a child's
  environment. An `include.path` or `includeIf.<cond>.path` key among them read a file whose `url.*.insteadOf` and
  `http.sslVerify=false` git applied; those keys are now stripped too, as are `remote.<name>.proxy`, `.url` and
  `.pushurl`, and `core.gitProxy`. A `GIT_CONFIG_GLOBAL` or `GIT_CONFIG_SYSTEM` naming a file is replaced with
  `/dev/null`: the engine's children read no global or system git config from a file the environment names (they
  read none, not `~/.gitconfig` in its place). Set to `/dev/null` already, or unset, these are unchanged.
