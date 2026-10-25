### Guardrail changes: what each one does

- **The tool guard refuses an agent's push that skips the pre-push hook in any spelling git reads (#993):** it
  used to catch only the exact `--no-verify` and a `-c core.hooksPath`. It now also refuses, in an agent run:
  - a prefix of `--no-verify` that git's option parser takes;
  - config that can carry the hooks path or run a push by another name, given by `-c`, `--config-env`, `git config`
    or `GIT_CONFIG_*`: an include (`include.path`, `includeIf.*.path`), an alias, `help.autocorrect`; and
    `git config --edit`, `--rename-section` and `--remove-section`;
  - a push in a line that gives it other config or another repository's hooks: `HOME`, `XDG_CONFIG_HOME`, any
    `GIT_CONFIG*`, `GIT_DIR`, `GIT_COMMON_DIR`, `--git-dir`, `env` with an option, `unset`;
  - pushes that run no hook: `git send-pack`, `git http-push`, the remote helpers;
  - a git name that isn't one of git's commands is read from the checkout's config as git reads it: an alias that
    pushes is judged as that push, a shell alias is refused, and with `help.autocorrect` on a misspelt name counts
    as a push. A lookup that fails refuses.

  Ordinary pushes, `git commit --no-verify`, reading git config and external git commands (`git lfs`) are
  unchanged.
