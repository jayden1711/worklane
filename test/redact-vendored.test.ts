// #889: the root updater (scripts/machine/<cli>-update.cjs) is one standalone CommonJS file, so it carries the shared
// redactor as a generated copy (scripts/lib/redact-vendor.mjs). The copy is exactly src/events/redact.ts transpiled,
// and the updater's redact() goes through it: the same patterns, in the same order, with the same results.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { REDACTION_PATTERNS, redactString } from '../src/events/redact.js';
import { repoRoot } from './helpers.js';
import { SHAPES } from './token-standins.js';

const UPDATER = join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`);
type Lib = { vendoredBlock(source: string): string; blockIn(text: string): string | null };
const vendor = async () => (await import(pathToFileURL(join(repoRoot, 'scripts', 'lib', 'redact-vendor.mjs')).href)) as Lib;

test("the updater's copy of the shared redactor is src/events/redact.ts, transpiled, byte for byte", async () => {
  const lib = await vendor();
  const block = lib.blockIn(readFileSync(UPDATER, 'utf8'));
  assert.ok(block, 'the updater has the generated block');
  assert.equal(block, lib.vendoredBlock(readFileSync(join(repoRoot, 'src', 'events', 'redact.ts'), 'utf8')), 'out of date: run node scripts/gen-redact-vendor.mjs --write');
});

test("the updater's redact() masks every shape the shared redactor knows, as the shared redactor does, plus its broad rules", () => {
  const u = createRequire(import.meta.url)(UPDATER) as { redact(text: string): string };
  const shared = (t: string) => redactString(t, { broad: true, mask: '[redacted]' } as Parameters<typeof redactString>[1]);
  for (const s of SHAPES) {
    for (const line of [`deploy failed: ${s.value} (exit 1)`, `GH_TOKEN=${s.value}`, `see https://someone:${s.secret}@git.example.test/x`]) assert.equal(u.redact(line), shared(line), s.what);
  }
  assert.ok(REDACTION_PATTERNS.length > 0);
});

test('the updater stays standalone: it requires only node: modules, and its copy requires nothing', async () => {
  const lib = await vendor();
  const src = readFileSync(UPDATER, 'utf8');
  const required = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]!);
  assert.deepEqual(required.filter((r) => !r.startsWith('node:')), []);
  assert.ok(!/\brequire\(|\bimport\(/.test(lib.blockIn(src)!), 'the generated block loads nothing');
});
