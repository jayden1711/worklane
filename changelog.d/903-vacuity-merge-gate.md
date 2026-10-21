### Upgrading (from v0.5.2)

- **A PR that changes app code waits for you unless its own tests are shown to run that code (#784).** Only a measured yes lets it auto-merge.
  - Its tests are the test files it adds or changes and the `test:` files its task's `done_when` names. They must call an assertion; importing an assertion module is not one.
  - Each is run with `runner.one` under Node's V8 coverage, in a scratch worktree at the PR's head, with the setup, the run and the coverage read off the coordinator's thread. Each runs twice: as it is, and with every test skipped. The PR's tests must run code on a changed line of at least one of its app files more often than loading them does.
  - Every module the tests loaded more often than the skipped run did (an import in a test's body, a `?query` copy, what such a module imports) is also loaded on its own, and taken away as many times as the extra loads, within one 120 s budget. What loading a module runs doesn't count, even in a file the PR adds and however a test's body imports it: its top level, a class's static fields, a helper called at load, a call at the test file's top level. One limit: a timer or listener a module starts as it loads runs longer while a test waits, and that counts.
  - The PR's lines are measured from where it meets the default branch's tip as the remote reports it (never the clone's ref), so what it merged in or was rebased onto is never its own. The PR waits until the clone has that tip. A renamed file's lines are the ones its rename changed. Blank lines, whitespace and comments are not changed code: a PR with nothing else in its app files waits.
  - JavaScript is measured as it is, TypeScript under Node's own type stripping, and a build (`dist/`) through its source map (`<file>.js.map`). Code tsx, vitest, jest or a loader transforms counts for nothing.
- **Which installs lose auto-merge of app-code PRs:**
  - every repo whose `.worklane/tests.yaml` has `vacuity.dynamic: false`, which is what `worklane init` wrote before;
  - every repo with no `vacuity` section, where any change but tests, docs, config, data and assets waits.
- **To get it back,** set `vacuity.dynamic: true` and `runner.one: node --test {file}` (only the test runner's own options: built-in reporters, timeout, concurrency, name and skip patterns, isolation, shard, force-exit, only, type stripping). `worklane doctor` shows the lines to paste. `worklane init` now turns it on for a new repo whose tests run with `node --test`. Existing configs are not changed. Repos on tsx, vitest or jest keep waiting for you on app-code PRs.
- **Fix-forward fixes:** a fix-forward PR the gate holds while main is red waits for you too. It is flagged first in the daily digest, and said at once on the Discord ops channel (once per PR and head).

### Guardrail changes: what each one does

- **Merge gate: tests that run none of the changed code (#784).** A new `design: vacuity:` hold, with the reason named:
  - there is no vacuity section;
  - the PR changes app code and has no test;
  - its tests have no assertion;
  - its tests ran none of the app code it changes;
  - runner.one is not `node --test` with only the test runner's own options;
  - a merge brings in another branch's commits;
  - the default branch's tip can't be read from the remote;
  - a module the tests loaded more often can't be loaded on its own, or those loads ran past their time budget;
  - nothing to measure (its app-code changes are only blank lines, whitespace, comments or renames);
  - the coverage run failed, or wrote no coverage;
  - its coverage can't be mapped;
  - the run started 3 times at that head without finishing;
  - a test path would need quoting;
  - the head couldn't be read.

  Each run is recorded per head (`vacuity.started`, `vacuity.measured`).
- **The coverage directory and source maps are read as hostile input:** no symlinks or FIFOs, regular files only, bounded in count and size. A failure is recorded as fixed text, never the file's content.
- **What it can't catch:** the gate catches vacuous tests, not hostile ones. A test can write its own coverage file, call the code trivially, or check whether it is in a baseline run; and work a module starts as it loads (a timer) counts if a test waits for it.
