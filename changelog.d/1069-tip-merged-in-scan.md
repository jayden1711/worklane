### Guardrail changes: what each one does

- **A PR that merged in the default branch is also measured by what merging it does there (#1069).** When a PR's
  head has commits of the default branch that its base hasn't (any merge base of the tip and the head is outside the
  base: its branch merged the tip in, or an older commit of the default branch, also one that reached it through a
  merge commit, or was rebased onto one), the check for a removed or weakened test, lint or guard also reads
  the change from the default branch's current tip to the tip merged with the head (`git merge-tree`, no worktree),
  and a reason from either reading holds the PR. So what the tip changed and the PR undoes now waits for the owner:
  a mark, table entry, lint rule or assertion the tip added and the PR takes out (also when the file goes back to its
  base text), a file only the tip has that the PR deletes or moves, and a line the tip took out that the PR puts back
  (an allowlist entry, a skip, an ignore-file line). A merge into the tip that conflicts waits too
  (`merging it into the default branch's current tip conflicts`). A stale PR that never merged the default branch in
  is measured once, as before. This needs git 2.38 or later for a PR that merged the default branch in; with an
  older git such a PR waits.
