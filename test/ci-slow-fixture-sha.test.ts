// ci-slow's plugin steps fetch the test fixtures (test/fixtures/plugins/*) from GitHub by commit (#631). On a pull
// request the job runs the merge of the PR into main (its checkout, github.sha), so the fixtures must come from that
// same commit: fetched from the PR head instead, a PR branched before a fixture change ran main's steps against its
// old fixture (PR #619's add-project, run 39103725841: the escape fixture had no kernel server yet). The check that a
// failed preview stops with its real reason is test/ci-preview-done.test.ts's. These tests read the workflow and the
// probe; never the escape fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

test('ci-slow fetches each plugin fixture from the commit under test (github.sha), never the PR head (#631)', () => {
  const yml = read('.github', 'workflows', 'ci-slow.yml');
  const shas = yml.split('\n').filter((l) => /^\s*FIXTURE_SHA:/.test(l));
  assert.ok(shas.length >= 2, 'the plugins step and the MCP broker step each set it');
  for (const l of shas) assert.equal(l.trim(), 'FIXTURE_SHA: ${{ github.sha }}');
  // The PR head is only the scope job's, for which paths the PR touches.
  const heads = yml.split('\n').filter((l) => l.includes('pull_request.head.sha'));
  assert.deepEqual(heads.map((l) => l.trim()), ['PR_HEAD: ${{ github.event.pull_request.head.sha }}']);
  assert.ok(yml.indexOf('pull_request.head.sha') < yml.indexOf('\n  bootstrap:'), "in the scope job");
  // Every fixture fetch through the machine helper, in the workflow and in the scripts it runs, takes that sha.
  const fetches = [yml, read('scripts', 'ci', 'mcp-broker-kernel.sh')].flatMap((t) => t.split('\n')).filter((l) => l.includes('"$HELPER" plugin-fetch'));
  assert.ok(fetches.length >= 3, 'kit and refused in the plugins step, kit and escape in the broker step');
  for (const l of fetches) assert.match(l, /plugin-fetch \S+ "\$url" "\$FIXTURE_SHA" /, l.trim());
});
