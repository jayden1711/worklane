### Upgrading (from v0.5.2)

- **A deploy's trigger and verify commands run as sandboxed project commands (#799).** The commands in `deploy.yaml` used to run as the coordinator user, outside any sandbox, with its whole environment. They now run like checks and full runs (#713):
  - as the agent user, in bubblewrap, which hides the Claude logins, the API key and every file `credentials.yaml` names;
  - with only the project's `tests.yaml` `env`;
  - under `tests.yaml` `command_timeout_s`, with a verify poll capped at 2 minutes;
  - with their output redacted.

  A command that is refused, times out or is stopped by a shutdown counts as a failed deploy (`deploy.failed`). The issue is then labelled `blocked` and stays open.
  - What you may see: a deploy trigger that used the coordinator user's credentials now fails. Examples are a CLI login in its home, a token in its service environment, or the GitHub App key. Nothing hands those to a deploy command. Until there is a way to name a deploy credential, trigger such deploys from the platform or from CI, and keep `verify` to confirm the landed commit.
  - On a checkout or a local site (no agent user), the deploy still runs as your user, as before. It now stops at `command_timeout_s`.
