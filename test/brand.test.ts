import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../src/brand.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('package.json name and bin follow BRAND', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, BRAND.pkg);
  assert.deepEqual(Object.keys(pkg.bin), [BRAND.cli]);
});

test('no source file outside brand.ts hardcodes the product name', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('brand.ts')) {
        const text = readFileSync(p, 'utf8').toLowerCase();
        if (text.includes(BRAND.cli)) offenders.push(p);
      }
    }
  };
  walk(join(root, 'src'));
  assert.deepEqual(offenders, []);
});
