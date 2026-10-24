### Upgrading (from v0.5.2)

- **A dashboard or hub route that fails now says what failed in the engine's own words and ends "the detail is in the
  dashboard's log on the machine" (#882).** Before, some routes answered with the raw error, at any status: the Repo
  config form's Propose, a Fix action, the default branch's config, the PR and ignored-issues reads, the checks GitHub
  ran, a config PR's merge, the instance settings' limits and policy, auto-merge's policy problem, the Plugins page's
  allowlist and previews, a pasted secret's install, the hub's forward, probe and sign-in, the hub's setup mode, and
  the App manifest's callback. So the page could get a path under the instance home, a child's output or GitHub's own text. That detail is
  now in the service log, with tokens redacted. A Fix GitHub refuses reads "GitHub refused to protect main (only a repo
  admin may)", and a tool download whose checksum differs reads "installing gh 9.9.9 failed"; GitHub's text and the
  checksums are in the log. Messages the engine writes itself, such as a config validation error or "main is protected
  already; not replaced", still reach the page. `automations.yaml` and `credentials.yaml` errors name the file, not its
  path.

### Guardrail changes: what each one does

- **A backstop lint: a caught error in a route file is only logged, never shown (#882).** In `src/dashboard.ts`,
  `src/console/`, `src/plugins/dashboard.ts`, `src/dashboard-hub.ts`, `src/hub-setup.ts` and the hub's half of
  `src/setup/app-manifest.ts`, a caught error may only be narrowed to one of the engine's own error classes, read for
  its `.code`, passed to `logDetail` or `errorAnswer` (`src/user-facing-error.ts`), or thrown again. Any other use is
  reported, including its message, any other property, destructuring and passing it elsewhere. A route answers
  with a fixed text.
