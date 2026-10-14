// The big-PR limits (the owner's decision): a PR over 800 changed lines or 20 files waits for a human. The
// engine's defaults agree everywhere they are written: the schema, the coordinator's fallback, the project
// template and the design doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ReviewConfig } from '../src/config/schema.js';
import { DEFAULT_REVIEW } from '../src/coordinator/shared.js';
import { repoRoot } from './helpers.js';

const LEVELS = { L0_auto: { when: [] }, L1_evaluator: { when: [] }, L2_notify: { when: [] }, L3_human: { when: [] } };

test('big-PR limits default to 800 lines and 20 files in the schema, the coordinator, the template and the design doc', () => {
  const schema = ReviewConfig.parse({ version: 1, levels: LEVELS }).merge;
  assert.deepEqual([schema.max_lines, schema.max_files], [800, 20], 'schema');
  assert.deepEqual([DEFAULT_REVIEW.merge.max_lines, DEFAULT_REVIEW.merge.max_files], [800, 20], 'DEFAULT_REVIEW');
  const template = ReviewConfig.parse(parse(readFileSync(join(repoRoot, 'templates', 'project', 'review.yaml'), 'utf8'))).merge;
  assert.deepEqual([template.max_lines, template.max_files], [800, 20], 'templates/project/review.yaml');
  assert.match(readFileSync(join(repoRoot, 'docs', 'design.md'), 'utf8'), /big: over `merge\.max_lines` \(800\) or `merge\.max_files` \(20\)/, 'docs/design.md');
});
