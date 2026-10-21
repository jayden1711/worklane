### Upgrading (from v0.5.2)

- **With a `vacuity` section in `.worklane/tests.yaml`, a PR that changes app code waits for you unless its own tests are shown to run that code (#784).** That includes the `dynamic: false` section the project template writes. Only a measured yes lets it auto-merge. Its tests are the test files it adds or changes and the `test:` files its task's `done_when` names. They must assert something and, each run with `runner.one` under Node's V8 coverage in a scratch worktree at the PR's head, call a function in at least one app file the PR changes. To keep auto-merging app-code PRs, set `vacuity.dynamic: true`, and make sure `runner.one` runs a test file in Node against the source files (not a `dist/` build). A repo with no `vacuity` section is decided as before. A PR that changes only types (`.d.ts`), config, data, docs or assets needs no test.

### Guardrail changes: what each one does

- **Merge gate: tests that run none of the changed code (#784).** A new `design: vacuity:` hold, with the reason named:
  - the PR changes app code and has no test;
  - its tests have no assertion;
  - its tests ran none of the app code it changes;
  - the coverage run failed, or wrote no coverage;
  - the run started 3 times at that head without finishing;
  - a test path would need quoting;
  - the head couldn't be read.

  Each run is recorded per head (`vacuity.started`, `vacuity.measured`). The gate catches vacuous tests, not hostile ones: a test can write its own coverage file, or call the code trivially.
