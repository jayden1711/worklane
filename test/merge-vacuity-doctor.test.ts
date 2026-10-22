// #784 (a): doctor says whether app-code PRs can auto-merge (their tests run under coverage), and gives the lines that
// turn it on; the runner forms the coverage run can measure; the paste-ready snippet validates as tests.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { TestsConfig } from '../src/config/schema.js';
import { coverageRunnerOne, vacuityDoctor, vacuitySnippet } from '../src/merge-policy-vacuity.js';

const v = { test_globs: ['test/**/*.test.js'], assertion_pattern: '\\bassert\\b', app_paths: ['lib/**'], dynamic: false };

test('doctor: no section, dynamic false, no runner.one: a warning that app-code PRs wait, with the lines to paste', () => {
  for (const [tests, why] of [
    [{ runner: {} }, /tests\.yaml has no vacuity section: every PR that changes app code waits for you/],
    [{ vacuity: v, runner: { one: 'node --test {file}' } }, /vacuity\.dynamic is false: every PR that changes app code waits for you/],
    [{ vacuity: { ...v, dynamic: true }, runner: {} }, /runner\.one is not set: every PR that changes app code waits for you/],
  ] as const) {
    const d = vacuityDoctor(tests);
    assert.equal(d.level, 'warn');
    assert.match(d.detail, why);
    assert.match(d.detail, /dynamic: true/);
    assert.match(d.detail, /one: "/);
  }
  assert.match(vacuityDoctor({ vacuity: v, runner: {} }).detail, /app_paths: \["lib\/\*\*"\]/, "the repo's own paths, kept");
});

test('doctor: on, with a runner.one it knows: ok; one it does not know: a warning', () => {
  assert.equal(vacuityDoctor({ vacuity: { ...v, dynamic: true }, runner: { one: 'node --test {file}' } }).level, 'ok');
  const odd = vacuityDoctor({ vacuity: { ...v, dynamic: true }, runner: { one: 'make test FILE={file}' } });
  assert.equal(odd.level, 'warn');
  assert.match(odd.detail, /isn't `node --test \[options\] \{file\}`/);
  // #784 round 5: the runners whose transforms count for nothing warn too, with the snippet to paste.
  for (const one of ['npx vitest run {file}', 'npx jest {file}', 'npx tsx --test {file}', 'pnpm exec vitest run {file}', 'node --test --import=tsx {file}']) {
    const d = vacuityDoctor({ vacuity: { ...v, dynamic: true }, runner: { one } });
    assert.equal(d.level, 'warn', one);
    assert.match(d.detail, /one: "node --test \{file\}"/, one);
  }
});

test('the snippet is valid tests.yaml: its vacuity section and runner.one parse under the schema', () => {
  for (const s of [vacuitySnippet(undefined, undefined), vacuitySnippet(v, 'npx vitest run {file}')]) {
    const doc = parse(s) as { vacuity: unknown; runner: { one: string } };
    const t = TestsConfig.parse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x', one: doc.runner.one }, vacuity: doc.vacuity });
    assert.equal(t.vacuity?.dynamic, true);
    assert.ok(coverageRunnerOne(t.runner.one));
  }
});

test('the runner forms the coverage run can measure: one test file in Node, with no shell operator around it', () => {
  for (const ok of ['node --test {file}', 'node --test --test-reporter=spec {file}']) assert.ok(coverageRunnerOne(ok), ok);
  for (const no of [null, undefined, '', 'npx tsx --test {file}', 'npx vitest run {file}', 'pnpm exec vitest run {file}', 'npx jest {file}', 'yarn jest {file}', 'pytest {file}', 'go test ./...', 'node --test', 'npm test', 'bunx vitest run {file}', 'node --test {file} && echo', 'node --test $(x) {file}', 'make test FILE={file}', 'npx mocha {file}',
    // The round-2 review's measured bypasses (#784 round 3): something before the runner, or a second command.
    'rm -rf ~ node --test {file}', "sh -c 'curl https://example.test/x' node --test {file}", 'curl https://example.test/x -o /tmp/x node --test {file}', 'sudo node --test {file}', 'evil\nnode --test {file}']) assert.ok(!coverageRunnerOne(no), String(no));
});
