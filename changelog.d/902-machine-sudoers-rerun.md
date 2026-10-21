### After install

- **Check the machine helper's sudoers rule once (#898).** `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --check` only reads, and answers one of:
  - `current` or `absent`: nothing to do.
  - `stale`: the rewrite only drops grants. Rerun with no flag: `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>`.
  - `wider`: the engine's rule grants more than the installed one, as it does on a machine coming from v0.5.2 (set-policy, #726). It prints a unified diff headed `--- installed /etc/sudoers.d/worklane-machine` and `+++ engine (machine-helper.sh)`. Read it, then run `sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh --replace-sudoers <every instance>`.

  The updater keeps the helper itself in step with the engine, never its sudoers rule, so a rule an older engine wrote stays until you run that.

### Guardrail changes: what each one does

- **The machine helper's sudoers rule is rewritten on its own only when that narrows it (#898).**
  - add-project's machine-helper step is done only while the rule is the engine's, byte for byte.
  - Otherwise a rerun rewrites it, through `machine-helper.sh`, only when every grant the engine's rule makes is already installed (each command, user spec and user, whitespace aside). So the rewrite only drops grants, and the one user it may add is the instance being added on its first add.
  - When the engine's rule would grant more (a newer engine's command, a sudo that now reads patterns, another instance's user), `add-project.sh` and `machine-helper.sh` change nothing. They print the unified diff and `rerun as root with --replace-sudoers to install the engine's rule: <command>`, and add-project waits (exit 3).
  - `--replace-sudoers` is root's, at a root shell: the machine helper runs `add-project.sh` with exactly a name and a repo, so a coordinator's add-project can never pass it.
- **The updater names a stale or wider machine helper rule (#898).**
  - On every run, updates on or off, the updater runs the installed engine's `machine-helper.sh --check` as root.
  - It runs the check only when the engine's real path has no link below the engine directory, and when the script, its `lib.sh`, and every directory up to `/` are root's and writable by no one else. It then runs bash on that resolved path.
  - A stale or wider rule goes to the updater's journal and is raised as a `machine_sudoers_stale` incident. The detail says which case it is, and the fix is the command for that case. A current rule closes the incident.
  - The updater never writes the rule and never holds an update on it.
