#!/usr/bin/env node
// R1185n B2, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' on a fresh session but loads every source on --resume,
// as a regression might (fix runs resume a session). The probe must catch it (its resumed run).
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE;
if (!real) {
  console.error('set SETTING_SOURCES_REAL_CLAUDE to the real claude');
  process.exit(2);
}
const args = process.argv.slice(2);
const i = args.indexOf('--setting-sources');
if (args.includes('--resume') && i >= 0) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit' }).status ?? 1);
