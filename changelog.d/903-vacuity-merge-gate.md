### Upgrading (from v0.5.2)

- **A PR that changes app code waits for you unless its own tests are shown to run that code (#784).** Only a measured yes lets it auto-merge.
  - Its tests are the test files it adds or changes and the `test:` files its task's `done_when` names. They must assert something.
  - Each is run with `runner.one` under Node's V8 coverage, in a scratch worktree at the PR's head and off the coordinator's tick, and must call a function in at least one app file the PR changes.
  - A test that runs a build (`dist/`) counts for the source files that build's source map (`<file>.js.map`) names.
- **Which installs lose auto-merge of app-code PRs:**
  - every repo whose `.worklane/tests.yaml` has `vacuity.dynamic: false`, which is what `worklane init` wrote before;
  - every repo with no `vacuity` section, where any change but tests, docs, config, data and assets waits.
- **To get it back,** set `vacuity.dynamic: true` and a `runner.one` that runs one test file in Node (`node --test {file}`, `tsx --test {file}`, `vitest run {file}`, `jest {file}`). `worklane doctor` shows the lines to paste. `worklane init` now turns it on for a new repo when it finds one of those runners. Existing configs are not changed.
- **Fix-forward fixes:** a fix-forward PR the gate holds while main is red waits for you too. It is flagged first in the daily digest, and said at once on the Discord ops channel (once per PR and head).

### Guardrail changes: what each one does

- **Merge gate: tests that run none of the changed code (#784).** A new `design: vacuity:` hold, with the reason named:
  - there is no vacuity section;
  - the PR changes app code and has no test;
  - its tests have no assertion;
  - its tests ran none of the app code it changes;
  - the coverage run failed, or wrote no coverage;
  - its coverage can't be mapped;
  - the run started 3 times at that head without finishing;
  - a test path would need quoting;
  - the head couldn't be read.

  Each run is recorded per head (`vacuity.started`, `vacuity.measured`).
- **The coverage directory and source maps are read as hostile input:** no symlinks or FIFOs, regular files only, bounded in count and size. A failure is recorded as fixed text, never the file's content.
- **What it can't catch:** the gate catches vacuous tests, not hostile ones. A test can write its own coverage file, or call the code trivially.
