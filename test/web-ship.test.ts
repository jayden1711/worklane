import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_WEB_DIR, webUiBuilt } from '../src/dashboard.js';
import { repoRoot } from './helpers.js';

test('the dashboard serves the web UI from where build:web writes it', () => {
  const vite = readFileSync(join(repoRoot, 'web', 'vite.config.ts'), 'utf8');
  const outDir = vite.match(/outDir: new URL\('([^']+)', import\.meta\.url\)/)?.[1];
  assert.ok(outDir, 'vite config names its outDir');
  assert.equal(resolve(DEFAULT_WEB_DIR), resolve(join(repoRoot, 'web'), outDir));
  assert.equal(webUiBuilt(join(repoRoot, 'no-such-dir')), false);
});

test('the engine install builds the web UI and is incomplete without it', () => {
  const sh = readFileSync(join(repoRoot, 'scripts', 'setup', 'engine.sh'), 'utf8');
  // Installed only when both the CLI and the UI are there; an install without the UI is completed.
  assert.match(sh, /if \[ ! -f "\$dest\/dist\/src\/cli\.js" \] \|\| \[ ! -f "\$dest\/dist\/web\/index\.html" \]; then/);
  // Built with the same no-install-scripts dependencies as the CLI, then checked.
  assert.match(sh, /npm ci --ignore-scripts[^\n]*&& npm run -s build && npm run -s build:web/);
  assert.match(sh, /\[ -f "\$work\/src\/dist\/web\/index\.html" \] \|\| \{/);
  // Adding the UI to an install in use goes through a dotted temp name, then a rename.
  const add = sh.slice(sh.indexOf('dist/.web.new'));
  assert.ok(add.indexOf('chown -R root:root "$dest/dist/.web.new"') < add.indexOf('mv "$dest/dist/.web.new" "$dest/dist/web"'), 'owned by root before it goes live');
});
