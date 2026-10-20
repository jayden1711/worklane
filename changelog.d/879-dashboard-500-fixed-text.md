### Upgrading (from v0.5.2)

- **A dashboard or hub error the server didn't mean to show now reads "the dashboard hit an internal error; the
  detail is in its log on the machine" (#864).** Before, the page got the raw error, which could name a file under the
  instance home or quote a file's text. The detail is now in the dashboard's (or hub's) service log on the machine, with
  tokens redacted. A request body that isn't JSON answers 400 "the request body isn't JSON".

### Guardrail changes: what each one does

- **Dashboard and hub error answers show only vetted text (#864).** The last catch of the dashboard's request handler,
  and of both hub ports, shows the page an error's text only when it is a `UserFacingError`. Its text must be one of a
  closed set kept in `src/user-facing-error.ts`, checked when the error is made, so no run-time string becomes one
  whatever its static type. Every other error answers one fixed 500. Its detail is logged on the machine through the
  shared redactor, without the request's query.
