### Guardrail changes: what each one does

- **The tool guard refuses an agent's push that skips the pre-push hook in more of the spellings git reads (#993):**
  it used to catch only the exact `--no-verify` and a `-c core.hooksPath`. It now also refuses, in an agent run:
  - a prefix of `--no-verify` that git's option parser takes;
  - config that can carry the hooks path or run a push by another name, given by `-c`, `--config-env`, `git config`
    or `GIT_CONFIG_*`: an include (`include.path`, `includeIf.*.path`), an alias, `help.autocorrect`; and
    `git config --edit`, `--rename-section` and `--remove-section`;
  - a push in a line that gives it other config or another repository's hooks: `HOME`, `XDG_CONFIG_HOME`, any
    `GIT_CONFIG*`, `GIT_DIR`, `GIT_COMMON_DIR`, `--git-dir`, `env` with an option, `unset`;
  - pushes that run no hook: `git send-pack`, `git http-push`, the remote helpers and their `git-*` programs;
  - git's own `git-push` and `git-config` programs run by name or path (`$(git --exec-path)/git-push`), read as
    `git push` and `git config`;
  - git, `env` and those programs where a command runs them: directly, behind a wrapper the shell matcher removes
    (`env -u X`, `nice -n 15`, `exec -a`, `env -S '…'`), as a `find -exec` command, or behind a runner (`setsid`,
    `flock`, `strace`, …); a word that is only an argument (`rm -rf vendor/git`, `grep env -i`) is not read;
  - a git name that isn't one of git's commands (git lists its own: `git --list-cmds`) is read from the checkout's
    config as git reads it: an alias that pushes is judged as that push, a shell alias is refused, and with
    `help.autocorrect` on a misspelt name counts as a push. Where the lookup can't be made (it fails, the line
    sets git's environment or changes directory where the guard can't follow), the line is refused.

  Ordinary work measured as newly refused in an agent run (allowed on main): defining a git alias, include or
  `help.autocorrect`; `git config --edit`; an alias in a line that sets `HOME` or `XDG_CONFIG_HOME`, runs `unset` or
  gives `env` an option; a push in a line with `unset`, `env` with an option (`env -u FOO git push`,
  `env -C sub git push`), `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR` or `--git-dir`; git's exec-path commands
  (`mergetool`) and PATH programs (`lfs`) in a line that removes or moves PATH or `GIT_EXEC_PATH`, or runs `env -i`.
  This list is what was measured, not a proof that nothing else changed. Known gaps that still let a hook-skipping
  push through: a renamed or linked git binary, a runner the guard doesn't know, `read`-set variables, shell
  expansions (`git push $X`) and command strings other programs run (#983).
