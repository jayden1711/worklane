// node --test's own results for scripts/ci/systemd-acceptance.mjs, one JSON line per test (R1169f): what the runner
// reports, read from its events, never from text a test could print. Each line: the event (test:pass or test:fail),
// the test's name, nesting, file, line and column (where test() was called), and its skip and todo (true, a reason,
// or null). Test-runner events are delivered here in the order they finish, so a test's subtests come just before it.
//
// Written to file descriptor 3 (R1169g, R1169h), which only the `node --test` process that runs this reporter has:
// the script that starts it holds the other end, and the test files' own processes get stdio 0-2 only, so no test
// can write it or replace it. Its destination (--test-reporter-destination) is stdout, where it writes nothing: not
// /dev/null, which node fsyncs at the end, and Linux refuses an fsync of it (EINVAL), failing every run there.
//
//   node --test --test-reporter=./scripts/ci/systemd-acceptance-reporter.mjs --test-reporter-destination=stdout ...
//   (with a pipe as fd 3)
import { writeSync } from 'node:fs';

export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    writeSync(3, `${JSON.stringify({ type: event.type, name: d.name, nesting: d.nesting, file: d.file ?? null, line: d.line ?? null, column: d.column ?? null, skip: d.skip ?? null, todo: d.todo ?? null })}\n`);
  }
}
