### Guardrail changes: what each one does

- **Tamper guard: the assertion count over a changed test file is linear, and capped (#986).** Its comment stripping
  was quadratic on many unclosed `/*` openers (about 10 s for 512 KiB, on the coordinator's thread at every decision);
  it now takes milliseconds and counts exactly what it counted before. A test file over 1,048,576 characters before or
  after the change is no longer counted: the guard flags it (`assertions not counted in <file>`), which raises the
  change's review level as any tamper flag does. A test file at the base too large for the guard to read is now
  compared too (before, it was taken for a new file and not checked), and deleting one is flagged.
