#!/usr/bin/env node
// R1185n B1, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' for everything but the settings files' env. Under ''
// it still applies the home and the checkout's local settings' env to claude's process, as a regression might. The
// probe must catch it (its env plant is a request header).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE;
if (!real) {
  console.error('set SETTING_SOURCES_REAL_CLAUDE to the real claude');
  process.exit(2);
}
const args = process.argv.slice(2);
const env = { ...process.env };
const i = args.indexOf('--setting-sources');
if (i >= 0 && args[i + 1] === '') {
  for (const f of [path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME, '.claude'), 'settings.json'), path.join(process.cwd(), '.claude', 'settings.local.json')]) {
    try {
      Object.assign(env, JSON.parse(fs.readFileSync(f, 'utf8')).env || {});
    } catch {}
  }
}
process.exit(spawnSync(real, args, { stdio: 'inherit', env }).status ?? 1);
