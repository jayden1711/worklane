### After install

- **Check the machine helper's sudoers rule once (#898).** `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --check` only reads, and answers one of:
  - `current` or `absent`: nothing to do.
  - `stale`: the installed rule is in the engine's own shape and the rewrite only drops whole commands or users. Rerun with no flag: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>`.
  - `wider`: anything else. That covers a machine coming from v0.5.2, whose engine rule adds set-policy (#726), and an installed rule edited outside the engine's shape. It prints a unified diff headed `--- installed /etc/sudoers.d/worklane-machine` and `+++ engine (machine-helper.sh)`. Read it, then run `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers <every instance>`.

  The updater keeps the helper itself in step with the engine, never its sudoers rule, so a rule an older engine wrote stays until you run that.

### Guardrail changes: what each one does

- **The machine helper's sudoers rule is rewritten on its own only when it narrows, failing closed (#898).**
  - add-project's machine-helper step is done only while the rule is the engine's, byte for byte.
  - Otherwise a rerun rewrites it, through `machine-helper.sh`, only when the installed rule is in the engine's own exact shape and the engine's rule only drops whole commands or users from it. The shape is: comment lines, one `Cmnd_Alias WORKLANE_MACHINE` in the engine's formatting, and one `<users> ALL=(root) NOPASSWD: WORKLANE_MACHINE` line.
  - The one user a rewrite may add on its own is the coordinator of an instance being created. `instance.sh` puts the name on root's list (`/var/lib/worklane/add-project-new`, root's 0600) when it makes that user, whether it runs from add-project, by hand, or from a rename. Every `machine-helper.sh` run takes off each name it writes into the rule. A name counts only when the list is a regular, unlinked file of root's, mode 0600; anything else marks nothing. So once any machine-helper.sh run has named a coordinator, one root later takes out of the rule is not put back without the flag.
  - Anything else waits. That covers a command or user the installed rule lacks, a second spec or alias, a tag, a `Defaults` or include line, a negation, an escape, or a CR. `add-project.sh`, `machine-helper.sh`, `instance-remove.sh` and `instance-rename.sh` change nothing; the last two check this before their first change. They print the unified diff and `rerun as root with --replace-sudoers to install the engine's rule: <command>`, and add-project waits (exit 3).
  - `--replace-sudoers` is root's, at a root shell: the machine helper runs `add-project.sh` with exactly a name and a repo, so a coordinator's add-project can never pass it.
- **The updater names a stale or wider machine helper rule (#898).**
  - On every run, updates on or off, the updater runs the installed engine's `machine-helper.sh --check` as root.
  - It runs the check only when the engine's real path has no link below the engine directory, and when the script, its `lib.sh`, and every directory up to `/` are root's and writable by no one else. It then runs bash on that resolved path.
  - A stale or wider rule goes to the updater's journal and is raised as a `machine_sudoers_stale` incident. The detail says which case it is, and the fix is the command for that case. A current rule closes the incident.
  - The updater never writes the rule and never holds an update on it.
