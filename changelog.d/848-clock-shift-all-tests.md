### Guardrail changes: what each one does

- **The weekly shifted-clock job runs every test, or fails and names the file (#848).** Its two test steps ran one `node --test --test-force-exit` over the suite. Force-exit ended a file's process once the tests it knew of were done, so tests registered after a top-level await never ran, and the step still reported 0 fail: 18 of `test/slot-dir-writes.test.ts`'s tests at +400 days.
  - The steps now run `scripts/ci/clock-shift-run.mjs`, which gives each test file a `node --test` of its own, without force-exit. A file passes only when its run exits 0 with a summary.
  - A file still running after 25 minutes is killed, along with what it started, and named, and the step fails. This covers a test that hangs past the 10-minute `--test-timeout`, and a handle left open after the file's tests. Node 24, which the job uses, doesn't end such a file at `--test-timeout`.
  - `test/clock-shift.test.ts` checks both steps' exact command lines from the workflow, with no `|| true` and no `continue-on-error`. It runs each step on fixtures, on the Node version of the test shard: a test registered after an await runs; a file with a handle left open, a failing test and a hanging test each fail the step, named; an empty run fails.
  - The job stays optional, required by nothing. Nothing changes for an install.
