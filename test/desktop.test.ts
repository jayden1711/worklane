import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { desktopBinary } from '../src/desktop.js';
import { executableName } from '../src/os/index.js';

test('desktop window: an explicit path wins; else the engine release build; else none (browser fallback)', () => {
  const engine = mkdtempSync(join(tmpdir(), 'engine-'));
  const env = (v?: string): NodeJS.ProcessEnv => (v ? { [`${BRAND.envPrefix}_DESKTOP`]: v } : {});
  assert.equal(desktopBinary(env(), engine), null);
  const built = join(engine, 'desktop', 'target', 'release', executableName(`${BRAND.cli}-desktop`));
  mkdirSync(join(engine, 'desktop', 'target', 'release'), { recursive: true });
  writeFileSync(built, '');
  assert.equal(desktopBinary(env(), engine), built);
  const other = join(engine, 'custom-shell');
  writeFileSync(other, '');
  assert.equal(desktopBinary(env(other), engine), other);
  assert.equal(desktopBinary(env(join(engine, 'missing')), engine), null, 'a wrong explicit path is not silently replaced');
});
