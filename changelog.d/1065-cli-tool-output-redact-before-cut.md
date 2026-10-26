### Guardrail changes: what each one does

- **A Codex or Gemini run redacts a tool's output before it cuts it (#1065).** A tool's output is cut to its last 2000 characters before the run record, the live feed and the stuck guard read it. A secret across that cut was cut short of its rule and passed on as the part that was kept. Now the whole output is redacted first, then cut, so the secret is hidden whole.
