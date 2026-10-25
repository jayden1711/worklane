### Guardrail changes: what each one does

- **The weekly shifted-clock job runs every test, or fails (#848).** Its two test steps no longer pass `--test-force-exit`, which ended a file's process once the tests it knew of were done: tests registered after a top-level await never ran, and the step still reported 0 fail (18 of `test/slot-dir-writes.test.ts`'s tests at +400 days).
  - A file whose process doesn't exit after its tests (a handle left open) is now cancelled at the job's `--test-timeout` and named, and the step fails, where before it passed.
  - `test/clock-shift.test.ts` runs both steps' command lines from the workflow on fixtures: a test registered after an await must run, and a file left with an open handle must fail, named.
  - The job stays optional, required by nothing. Nothing changes for an install.
