### Upgrading (from v0.5.2)

- A chat attachment holding a secret that redaction hides is now refused in more cases (#996): the attachment secret check uses redaction's own matcher, so a token glued after a terminal escape, a backslash escape or `_` is named too. Attach it anyway, or remove the secret.

### Guardrail changes: what each one does

- **The attachment secret check finds whatever redaction hides (#996).**
  - `secretKinds`, which the chat attachment refusal reads, runs the shared redactor's default passes, glue points included, and names the rule of every match. Whenever redaction would change a text, the check names at least one kind.
  - Redaction hides three more shapes, in every mode and in the root updater's copy: a bearer or Basic value with JSON-escaped slashes, a credential in a single-quoted (Python) or `=>` (Ruby, PHP) dictionary literal, and a JWT in standard base64 or with `=` padding.
