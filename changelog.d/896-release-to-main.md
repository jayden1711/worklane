### After install

- **Optional: moving a release install to the main channel (#895).** A release install runs its tag's release commit. That commit is main's commit plus `dist/`, so it is never on main itself, and until now every main-channel run refused it: `not a fast-forward of the installed engine (GitHub compare: diverged, 1 ahead, 1 behind)`. This release's updater can make that move. To switch, as root, in this order:
  1. Stay on the release channel until this release is installed. The updater installs it as usual. `/opt/worklane/current/package.json` then shows this version, and so does the Machine page's Updates panel.
  2. Run `updates.sh` once, with the channel: `sudo bash /opt/worklane/current/scripts/setup/updates.sh --channel main`. This is the same one rerun the updater change above already asks for (#761), with `--channel main` added. It installs this release's updater, the first one that can make the move, and sets the channel. The rest of `/etc/worklane/updates.json` stays as it is. If you already did the plain rerun, run it once more with `--channel main`.
  3. Within 10 minutes the next run installs main's newest commit with every required check green. Before it trusts the release, it checks the release tag that names the installed commit: the same checks a release install gets, against `/etc/worklane/allowed_signers`. Its `attempt` line in `/var/lib/worklane/updates.jsonl` carries `release: { tag, base }`. From then on the machine is an ordinary main install.
  - **Don't set `--channel main` before this release is installed.** The older updater refuses every run (fail-closed) and installs nothing. `sudo bash /opt/worklane/current/scripts/setup/updates.sh --channel release` goes back.
  - **If it refuses,** the journal (`journalctl -u worklane-update`) says `...; and it isn't a verified release commit: <why>`. Two causes you can fix:
    - a held signers file: `updates.sh --acknowledge-signers` after looking at it;
    - a `branch` other than `main` in `updates.json`: the move works only when following main.
  - **On main the updater never replaces itself** (main has no signature to check). Rerun `updates.sh` from `/opt/worklane/current` to take later updater changes.

### Guardrail changes: what each one does

- **The main channel can start from a verified release (#895).** Main installs still need a fast-forward of the installed engine, with one exception. When that compare fails, the updater asks whether the installed commit is a release commit, and only `verifyRelease` can prove it:
  - the newest `vX.Y.Z` that `ls-remote` lists at that commit, resolved once to one signed tag object;
  - that object verifies against `allowed_signers`, names itself and points at the installed commit, and is the object `ls-remote` listed;
  - its commit has one parent, on main, and changes only `dist/`.

  With that proof, main is compared, and its first-parent line walked, from that parent. Required checks, `max_lookback`, holds and rollback (to the release commit) are unchanged. The move is refused, with the old reason and why, in each of these cases:
  - no tag names the commit, or any check fails or errors;
  - the tag moved;
  - the signers file changed outside `updates.sh` and isn't acknowledged;
  - the branch followed isn't `main`.

  An install already on main never reaches this check. Nothing the dashboard or a coordinator can write is read.
