### Upgrading (from v0.5.2)

- **More first-run answers say what failed in the engine's words, never git's, gh's or a child's own output (#1064).**
  When a merged config PR's checkout can't be fast-forwarded because git fails (origin moved, a fetch refused), the
  step, the merge's answer and the config PR's record now read, for example, "couldn't fetch origin's main; the detail
  is in the dashboard's log on the machine", where they quoted git's first error line (which could name origin's
  path). The GitHub step's "gh is signed in, but can't read <repo>" and the first task's check for an issue labelled
  ready no longer quote gh's error line. A Fix whose plan can't be made reads "can't plan it", without the error. The
  Discord step's channel listing and the Slack and Linear steps' views say that the listing or the view failed; the
  child process's own last line goes to the log. In each case the detail is in the service log, redacted. A config PR
  record saved before the upgrade keeps its old text until the page looks at it again.
