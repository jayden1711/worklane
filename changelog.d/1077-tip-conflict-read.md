### Guardrail changes: what each one does

- **A PR whose merge into the default branch conflicts is read too, and waits on a conflict in a check's file
  (#1077).** The check for a removed or weakened test, lint or guard used to give a conflicting merge into the tip no
  second reading. If GitHub's own merge completed where git conflicts (a file added under a folder the tip renamed,
  say) and the combined check didn't run, the PR landed without being read from the tip. Now:
  - the tree git still writes for a conflicting merge (both sides' lines in its conflicted files) is measured from
    the tip like a clean one, so a suppression or skip the tip doesn't have waits, on either side of a conflict;
  - a conflict in a test, lint, guard, allowlist or table file waits for the owner (`conflicts with the default
    branch's current tip in ...`). While GitHub is still computing whether the PR can merge (the first poll after
    every merge), a PR held only by that reason isn't decided yet: once GitHub says `dirty` it goes to the conflict fix,
    as before. Only when GitHub says it merges cleanly, or is still computing after 10 polls, does it wait for the
    owner. A conflict anywhere else is left to the conflict paths, as before, with one exception: a merge that
    conflicts with no conflicted path (a directory the tip split in two while the PR adds a file there) can't be read
    from the tip, so that PR waits for the owner, where it used to pass;
  - git output that names no tree, a conflict with no conflicted path, or an exit other than 0 or 1 makes the PR wait.
    Before, any exit 1 counted as a conflict, so a git that couldn't run `merge-tree --write-tree` but exited 1 left
    the PR unread from the tip.

  Git merges by the attributes of the coordinator's checkout, not the PR's. A PR's `.gitattributes` with
  `merge=union` on a test file still conflicts there, so it waits.
- **The second reading's failure or bound no longer hides the first's reasons (#1077).** When the reading from the
  tip can't run or passes 4,000,000 changed characters, its reason is given beside the reasons from the PR's base. The
  PR waited before too, but the owner saw only the one reason.
- **`doctor` checks git's version (#1077).** It fails on a git older than 2.40. The merge decision's checks need
  `merge-tree --write-tree` (2.38) and `check-attr --source` (2.40), and with an older git every PR waits for the
  owner.
