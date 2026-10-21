### After install

- **Check the machine helper's sudoers rule once (#898).** `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --check` only reads, and answers one of:
  - `current` or `absent`: nothing to do.
  - `stale`: the installed rule is in the engine's own shape and the rewrite only drops whole commands or users. Rerun with no flag, adding no user: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --may-add= <every instance>`.
  - `wider`: anything else. That covers a machine coming from v0.5.2, whose engine rule adds set-policy (#726), and an installed rule edited outside the engine's shape. It prints a unified diff headed `--- installed /etc/sudoers.d/worklane-machine` and `+++ engine (machine-helper.sh)`. It then prints the command `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers=<pin> <every instance>`, where `<pin>` is the sha256 of exactly that diff's rule. Read the diff, then run that command. If the engine's rule changed in between, it installs nothing and prints the new diff and a new pinned command.

  The updater keeps the helper itself in step with the engine, never its sudoers rule, so a rule an older engine wrote stays until you run that.

### Guardrail changes: what each one does

- **The machine helper's sudoers rule is rewritten on its own only when it narrows, failing closed (#898).**
  - add-project's machine-helper step is done only while the rule is the engine's, byte for byte.
  - Otherwise a rerun rewrites it, through `machine-helper.sh`, only when the installed rule is in the engine's own exact shape and the engine's rule only drops whole commands or users from it. The shape is: comment lines, one `Cmnd_Alias WORKLANE_MACHINE` in the engine's formatting, and one `<users> ALL=(root) NOPASSWD: WORKLANE_MACHINE` line.
  - The one user a rewrite may add on its own is the coordinator of an instance being created. `instance.sh` puts the name on root's list (`/var/lib/worklane/add-project-new`, root's 0600) when it makes that user, whether it runs from add-project, by hand, or from a rename. Every `machine-helper.sh` run takes off each name it writes into the rule. A name counts only when the list is a regular, unlinked file of root's, mode 0600; anything else marks nothing. So once any machine-helper.sh run has named a coordinator, one root later takes out of the rule is not put back without the flag.
  - Anything else waits. That covers a command or user the installed rule lacks, a second spec or alias, a tag, a `Defaults` or include line, a negation, an escape, or a CR. `add-project.sh`, `machine-helper.sh`, `instance-remove.sh` and `instance-rename.sh` change nothing; the last two check this before their first change. They print the unified diff and `rerun as root with --replace-sudoers to install the engine's rule: <command>`, and add-project waits (exit 3).
  - **A rule taken away is not put back on its own.** No installed rule counts as a first install only on a machine that never had the helper set up (no `/usr/local/libexec/worklane-machine`, no `/etc/worklane/helper-rules.json`). Where root deleted the rule, or moved it aside, to revoke the helper, the next rerun or `machine-helper.sh` run shows the whole rule it would add and waits for `--replace-sudoers`. The same holds after `instance-remove.sh` takes out the last instance: the helper stays installed, so the next add-project waits for the flag.
  - `--replace-sudoers=<pin>` is root's, at a root shell: the machine helper runs `add-project.sh` with exactly a name and a repo, so a coordinator's add-project can never pass it. Every printed command carries the pin (sha256) of the rule its diff showed. A run installs only a rule with that pin: if the engine's rule changed (a release landed, say), it writes nothing and prints the new diff and a new pinned command. A bare `--replace-sudoers` is refused.
  - **`machine-helper.sh` is the one check, at write time.** add-project passes it only the user it may add (`--may-add=`), never trust in every name. Every machine-helper.sh command the engine prints without a pin carries `--may-add=` too: add-project's "this step alone" retry and `--check`'s `stale` command.
  - **One lock, only root's.** The engine has two writers of this rule: `machine-helper.sh`, and `instance-remove.sh` when it takes the rule away. Each holds one lock, `/run/worklane-machine/sudoers.lock`, from its check to its write. The lock sits in a directory only root can enter (root's, 0700), so no other user can open, hold or plant it. A run with no `flock`, or with that directory anything else, refuses to write.
  - **What is checked at the write.** Right before `install_sudoers`, and again inside it after `visudo` and right before the move:
    - the temp file must be byte for byte the rule checked;
    - the installed rule must still be byte for byte what the first check read;
    - the new rule must still only narrow it, or carry root's pin.

    A first install (no rule, the helper never set up) is decided once, at the first check, because the run installs the helper before it writes the rule. Otherwise nothing is written (exit 3).
  - **The window left:** the moment between that last check and the move itself (`mv`). Only a change by hand at a root shell, which takes no lock, can land there.
- **The updater names a stale or wider machine helper rule (#898).**
  - On every run, updates on or off, the updater runs the installed engine's `machine-helper.sh --check` as root.
  - It runs the check only when the engine's real path has no link below the engine directory, and when the script, its `lib.sh`, and every directory up to `/` are root's and writable by no one else. It then runs bash on that resolved path.
  - A stale or wider rule goes to the updater's journal and is raised as a `machine_sudoers_stale` incident. The detail says which case it is.
    - For `stale`, the fix is the rewrite command, with `--may-add=`.
    - For `wider`, the fix is `machine-helper.sh --check` at a root shell, which prints the whole diff and the command pinned to it. The incident gives a count of the lines added and dropped, never a pinned command beside a diff cut to fit.

    A current rule closes the incident.
  - The updater never writes the rule and never holds an update on it.
