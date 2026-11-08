### Guardrail changes: what each one does

- **A Codex or Gemini run redacts a tool's output before it cuts it (#1065).** A tool's output is cut to its last 2000 characters before the run record, the live feed and the stuck guard read it. A secret across that cut was cut short of its rule and passed on as the part that was kept. Now the whole output is redacted first, then cut, so the secret is hidden whole.
- **A Codex or Gemini run's own cuts redact first too (#1065).** The end of the CLI's stderr, and the start of a failure's, a rate limit's or an answer's words (or the end of an answer missing its JSON), are redacted whole before they are cut into the run's result, as claude's runner already does.
