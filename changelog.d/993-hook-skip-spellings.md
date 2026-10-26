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
  - git's own `git-push` and `git-config` programs run by name or path (`$(git --exec-path)/git-push`), read as
    `git push` and `git config`;
  - a git name that isn't one of git's commands (git lists its own: `git --list-cmds`) is read from the checkout's
    config as git reads it: an alias that pushes is judged as that push, a shell alias is refused, and with
    `help.autocorrect` on a misspelt name counts as a push. Where the lookup can't be made (it fails, the line
    sets git's environment or changes directory where the guard can't follow), the line is refused.

  Ordinary work newly refused in an agent run: defining a git alias, include or `help.autocorrect`;
  `git config --edit`, `--rename-section` and `--remove-section`; an alias (or another name that isn't git's) in a
  line that sets `HOME` or `XDG_CONFIG_HOME`, runs `unset`, or gives `env` an option; and a push in a line with
  `unset`, `env` with an option, `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR` or `--git-dir`. git's own commands
  (`ls-files`, `diff-tree`, `mergetool`, installed ones such as `lfs`), plain pushes, `git commit --no-verify` and
  reading git config are unchanged.
