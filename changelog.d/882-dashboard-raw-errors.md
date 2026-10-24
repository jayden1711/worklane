### Upgrading (from v0.5.2)

- **A dashboard or hub route that fails now says what failed in the engine's own words and ends "the detail is in the
  dashboard's log on the machine" (#882).** Before, some routes answered with the raw error, at any status: the Repo
  config form's Propose and a config PR's merge (git's and GitHub's text), setup mode's origin and repo list, a Fix
  action, the default branch's config, the PR and ignored-issues reads, the checks GitHub ran, the instance settings'
  limits and policy, auto-merge's policy problem, the Plugins page's allowlist and previews, a pasted secret's install,
  the hub's forward, probe and sign-in, the hub's setup mode, and the App manifest's callback. So the page could get a
  path under the instance home, a child's output or GitHub's own text. That detail is now in the service log, with
  tokens redacted, including each error's cause. A Fix GitHub refuses reads "GitHub refused to protect main (only a
  repo admin may)", and a tool download whose checksum differs reads "installing gh 9.9.9 failed"; GitHub's text and
  the checksums are in the log. The machine's limits file and the instance's `policy.yaml` are named, not their paths;
  root's `policy set` and `policy own` still print the limits file's path and the parser's text at the root shell.
  `automations.yaml` errors, and the `credentials.yaml` and `intake.yaml` errors on the Discord, Slack and Linear
  steps, name the file, not its path. Messages the engine writes itself, such as a config validation error or "main is
  protected already; not replaced", still reach the page. The Discord, Slack and Linear steps still show the token
  file's and `intake.yaml`'s paths and the root-shell commands to run, and a policy loosening refused on an install
  without root's helper still names `policy.yaml`'s path in its "edit" hint. Not fixed yet (#1064): when a merged
  config PR's checkout can't be brought up to date, the merge's and the sync's detail still quote git's output, and the
  first-run view's GitHub checks still quote gh's first error line.

### Guardrail changes: what each one does

- **A backstop lint: a caught error in a route file is only logged, never shown (#882).** In `src/dashboard.ts`,
  `src/console/`, `src/plugins/dashboard.ts`, `src/dashboard-hub.ts`, `src/hub-setup.ts`, the hub's half of
  `src/setup/app-manifest.ts`, and the chat, value-report, avatar and webhook routes, a caught error may only be
  narrowed to one of the engine's own error classes (one the file declares or imports from `src/`), read for
  its `.code`, passed to `logDetail` or `errorAnswer` (`src/user-facing-error.ts`), or thrown again. Any other use is
  reported, including its message, any other property, destructuring and passing it elsewhere. A route answers
  with a fixed text.
