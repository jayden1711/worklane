### Guardrail changes: what each one does

- **Every PR is also measured by what merging it does to the default branch (#1069).** The check for a removed or
  weakened test, lint or guard now also reads the change from the default branch's current tip to the tip merged
  with the PR's head (`git merge-tree`, no worktree), besides the change from the PR's base, and a reason from either
  reading holds the PR. So these now wait for the owner:
  - after a PR's branch merged in commits of the default branch (the tip, an older commit, also one that reached the
    default branch through a merge commit), what the tip changed and the PR undoes: a mark, table entry, lint rule or
    assertion the tip added and the PR takes out (also when the file goes back to its base text), a file only the tip
    has that the PR deletes or moves, and a line the tip took out that the PR puts back (an allowlist entry, a skip,
    an ignore-file line);
  - a stale PR's change that git carries onto a table or lint test the tip has since renamed or moved and marked.

  A PR whose merge into the tip conflicts gets no reason from that second reading: it can't land as it is, so it is
  left to the conflict paths as before (the conflict fix, or the combined check's capped wait while GitHub still
  reports it mergeable), and the head that resolves the conflict is measured again both ways. The second reading
  needs git 2.38 or later; with an older git every PR waits.
