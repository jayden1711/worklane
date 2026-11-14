// #941 (R1184r D1): the Stripe replacer redacts a key of a real secret key's length (sk_live_ and 99 characters), on
// every path: the default, the broad mode and the root updater's copy. The replacers are code the redaction data
// names; this keeps a narrowed one from passing the redaction suites unseen.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { redactString } from '../src/events/redact.js';
import { repoRoot } from './helpers.js';

const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string };

test('a full-length Stripe secret or restricted key is redacted on every path, and so are shorter ones', () => {
  const body = (n: number) => Array.from({ length: n }, (_, k) => 'aB3xZ9'[k % 6]).join('');
  for (const prefix of ['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_']) {
    for (const n of [16, 24, 32, 99, 107]) {
      const key = `${prefix}${body(n)}`;
      for (const [path, out] of [['default', redactString(`key ${key} end`)], ['broad', redactString(`key ${key} end`, { broad: true })], ['updater', updater.redact(`key ${key} end`)]] as const) {
        assert.ok(!out.includes(body(n)), `${path}: ${prefix} with ${n} characters`);
      }
    }
  }
});
