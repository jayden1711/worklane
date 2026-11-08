// node --test's own results for scripts/ci/systemd-acceptance.mjs, one JSON line per test (R1169f): what the runner
// reports, read from its events, never from text a test could print. Each line: the event (test:pass or test:fail),
// the test's name, nesting, file and line (where test() was called), and its skip and todo (true, a reason, or null).
// Test-runner events are delivered here in the order they finish, so a test's subtests come just before it.
//
//   node --test --test-reporter=./scripts/ci/systemd-acceptance-reporter.mjs --test-reporter-destination=<file> ...
export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    yield `${JSON.stringify({ type: event.type, name: d.name, nesting: d.nesting, file: d.file ?? null, line: d.line ?? null, skip: d.skip ?? null, todo: d.todo ?? null })}\n`;
  }
}
