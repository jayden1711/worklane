### Upgrading (from v0.5.2)

- **A dashboard error the dashboard didn't mean to show now reads "the dashboard hit an internal error; the detail is
  in its log on the machine" (#864).** Before, the page got the raw error, which could name a file under the instance
  home or quote a file's text. The detail is now in the dashboard service's log on the machine. A request body that
  isn't JSON answers 400 "the request body isn't JSON".

### Guardrail changes: what each one does

- **Dashboard error answers show only vetted text (#864).** The request handler's last catch shows the page an
  error's text only when it is a `UserFacingError`, which is made only from a string literal in the engine's source.
  Every other error answers one fixed 500, and its detail is logged on the machine without the request's query.
