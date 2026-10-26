### Guardrail changes: what each one does

- **A PR whose merge into the default branch conflicts is read too, and waits on a conflict over where a check's
  file goes (#1077).** The check for a removed or weakened test, lint or guard used to give a conflicting merge into
  the tip no second reading. If GitHub's own merge completed where git conflicts (a file added under a folder the tip
  renamed, say) and the combined check didn't run, the PR landed without being read from the tip. Now:
  - the tree git still writes for a conflicting merge is measured from the tip like a clean one, its conflicted files
    left out (their conflict markers aren't lines either side wrote, and read as a table or test they gave false
    reasons);
  - a conflict on where a test, lint, guard, allowlist or table file goes or whether it stays (a file location,
    rename or modify/delete conflict, as `git merge-tree` names it) waits for the owner (`conflicts with the default
    branch's current tip on where ...`). While GitHub is still computing whether the PR can merge (the first poll
    after every merge), a PR held only by that reason isn't decided yet: once GitHub says `dirty` it goes to the
    conflict fix. Only when GitHub says it merges cleanly, or is still computing after 10 polls (a capped wait,
    recorded), does it wait for the owner. A PR with another hold beside it is decided at once, as on main;
  - a conflict on a file's lines (both sides changed the same lines, or both added the file), in any file, holds
    nothing in the merge decision, as on main: GitHub, merging the same commits, reports it (inferred), and the
    conflict fix's head is read again. A conflict elsewhere is left to the conflict paths too;
  - a merge that conflicts only on a directory (the tip split it in two while the PR adds a file there) names no
    conflicted path: it is read and decided as a clean one;
  - git output that names no tree, a conflict with no conflicted path or conflict message, a message it can't parse,
    or an exit other than 0 or 1 makes the PR wait. Before, any exit 1 counted as a conflict, so a git that couldn't
    run `merge-tree --write-tree` but exited 1 left the PR unread from the tip.

  Git merges by the attributes of the coordinator's checkout, not the PR's. A PR's `.gitattributes` with
  `merge=union` on a test file still conflicts there on its lines, so it is left to the conflict paths.
- **The second reading's failure or bound no longer hides the first's reasons (#1077).** When the reading from the
  tip can't run or passes 4,000,000 changed characters, its reason is given beside the reasons from the PR's base. The
  PR waited before too, but the owner saw only the one reason.
- **`doctor` checks git's version (#1077).** It fails on a git older than 2.40. The merge decision's checks need
  `merge-tree --write-tree` (2.38) for every PR and `check-attr --source` (2.40) for a PR that changes a
  `.gitattributes`. Below 2.38 every PR waits for the owner; on 2.38 or 2.39 only a PR that changes a `.gitattributes`
  does.
