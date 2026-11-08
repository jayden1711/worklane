### Guardrail changes: what each one does

- **The tool guard refuses an agent's push that skips the pre-push hook in more of the spellings git reads (#993):**
  it used to catch only the exact `--no-verify` and a `-c core.hooksPath`. It now also refuses, in an agent run:
  - a prefix of `--no-verify` that git's option parser takes;
  - config that can carry the hooks path or run a push by another name, written by `-c`, `--config-env`,
    `git config` or `GIT_CONFIG_*`: an include (`include.path`, `includeIf.*.path`), an alias, `help.autocorrect`;
    and `git config --edit`, `--rename-section` and `--remove-section`. A `git config` is read by git's own
    argument rules: its short options cluster as git's option parser reads them (`-f` and `-t` take the rest of
    the word or the next one; `-e`, `-l` and `-z` are flags), so `-ez`, `-zef FILE` and `-et bool` edit and are
    refused, and `-t bool --get NAME` reads; options end at the first word that isn't one, so every word after the name is a value or
    value-pattern even when it looks like an option (`git config core.hooksPath --global` writes `--global`), and
    `get` or `list` reads only as the subcommand. One that only reads a name (`git config alias.st`,
    `git config --get alias.p x`, `git config get alias.p`) is allowed; one with an option the guard doesn't know
    (an abbreviation such as `--glo` included) is refused;
  - a push in a line that gives it other config or another repository's hooks: `HOME`, `XDG_CONFIG_HOME`, any
    `GIT_CONFIG*`, `GIT_DIR`, `GIT_COMMON_DIR`, `--git-dir`, `env` with an option, `unset`;
  - pushes that run no hook: `git send-pack`, `git http-push`, the remote helpers and their `git-*` programs;
  - git's own `git-push` and `git-config` programs run by name or path (`$(git --exec-path)/git-push`), read as
    `git push` and `git config`;
  - git, `env` and those programs where a command runs them: directly, behind a wrapper the shell matcher removes
    (`env -u X`, `nice -n 15`, `exec -a`, `env -S '…'`, `timeout --kill-after 5 60`, `xargs --max-args 1`; env's
    option clusters as getopt reads them, so `env -uCC git push` runs git), as a
    `find -exec` or `-ok` command, or behind a known runner (`setsid`, `flock`, `strace`, `taskset`, …). A runner's
    options are those of its own option table (`systemd-run -G` is `--collect`, a flag; strace's `--silent` takes
    only an attached value), checked by a test against each installed program's own parser, and its
    command is the first word after its own options and operands (`flock /tmp/l git push` runs git; so does
    `flock /tmp/git git push`); a word that is only an argument (`rm -rf vendor/git`, `make -C third_party/git`,
    `grep env -i`) is not read, and a program the guard doesn't know as a runner is not read into;
  - a git name that isn't one of git's commands (git lists its own: `git --list-cmds`) is read from the checkout's
    config as git reads it: an alias that pushes is judged as that push, a shell alias is refused, and with
    `help.autocorrect` on a misspelt name counts as a push. Where the lookup can't be made (it fails, the line
    sets git's environment or changes directory where the guard can't follow), the line is refused.

  Ordinary work measured as newly refused in an agent run (allowed on main): defining a git alias, include or
  `help.autocorrect`; `git config --edit`, and any `git config` with a word such as `-eve` whose short-option flags
  include `e`, even as a value; a `git config` read with an option the guard doesn't know; an alias in a
  line that sets `HOME` or `XDG_CONFIG_HOME`, runs `unset` or gives `env` an option; a push in a line with `unset`,
  `env` with an option (`env -u FOO git push`, `env -C sub git push`), `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR` or
  `--git-dir`; git's exec-path commands (`mergetool`) and PATH programs (`lfs`) in a line that removes PATH, sets
  or removes `GIT_EXEC_PATH`, or runs `env -i` (setting PATH refuses neither in the tool guard; the whole hook refused that on main too). This list is what was measured, not
  a proof that nothing else changed. Known gaps that still let a hook-skipping push through: command strings run
  by `-c` or a shell (`flock /tmp/l -c 'git push --no-verify'`, `setsid bash -c '…'`, `runuser -c '…'`,
  `find -exec sh -c '…'`; #983); a runner the guard doesn't know; a wrapper or runner option its grammar doesn't
  list, or a version of a runner whose options differ from the one the grammar follows; an abbreviated long option
  of a runner or of `env` (`flock --tim 5`, `env --uns X`); runners nested deeper than four; a renamed or linked git binary; `read`-set
  variables; shell expansions (`git push $X`).
