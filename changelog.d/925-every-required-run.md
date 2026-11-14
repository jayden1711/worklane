### Upgrading (from v0.5.2)

- **A commit with an earlier failed, cancelled or unfinished run of a required check is no longer installed, marked ready or accounted for (#925).** If a workflow is run a second time on the same commit, it no longer clears the first run's failure. Push a new commit, or re-run the failed jobs inside the first workflow run: GitHub lists only the newest attempt of a re-run job, so that still works. v0.5.2 installs judge the latest run of each name, so a red or unfinished run that started first stays hidden from them. Update those installs promptly. They already have to re-run `updates.sh`.

### Guardrail changes: what each one does

- **Every run of a required check on the judged commit must pass (#925).** This covers the root updater (`scripts/machine/worklane-update.cjs`), PR readiness and the judges built on it (the check of main after a merge, fix-forward, the batch's fast checks), and the main watch at merge time. Before, they took the latest run of each name, or for readiness the first one listed. A red run of a required name that started earlier, or at the same time with a lower id, was then hidden, and so was an earlier run still in progress. The commit was judged green. That was fail-open.
  - **A name judged by name** (nothing pins it): any check run of the name that isn't a pass blocks it, from any source. In readiness this includes a commit status of the name. A finished one refuses, and one still running waits.
  - **A pinned name** (`required_check_sources`, the updater's own list, or the App the branch rules name): every run from its pinned source must pass. Any non-pass from any other source still blocks it, as before. This drops the owner's 2026-10-19 exceptions:
    - a pinned workflow file's later run on the commit used to supersede that file's earlier failed or cancelled runs;
    - a pinned non-Actions App's latest run used to decide across suites.
  - **Re-run attempts:** the updater and readiness read GitHub's `filter=latest` list, which keeps only a job's newest attempt in a check suite (measured on this repo's check runs). The main watch reads `filter=all` and keeps the newest attempt per suite itself, as before. So re-running failed jobs in place still clears them.
  - **Not covered:** two jobs of one workflow run that post the same name. Readiness and the updater see whatever GitHub's `filter=latest` lists for one suite, and the main watch keeps the newest per suite. A workflow lint that stops a required name from being made by more than one job is the guard for that, and it is a follow-up.
