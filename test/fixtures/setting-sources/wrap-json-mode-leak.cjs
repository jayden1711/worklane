#!/usr/bin/env node
// A must-fail case for scripts/ci/setting-sources-probe.mjs (the owner's decision, 2026-11-09): a wrapper around the
// real claude (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' unless the launch is a one-shot JSON
// answer (`--output-format json`, skill-eval's: src/skilleval.ts, through launchClaude): then it loads every source.
// Only the probe's direct launchClaude in json mode has that shape, so it names this.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources'); const o = args.indexOf('--output-format');
if (i >= 0 && args[i + 1] === '' && o >= 0 && args[o + 1] === 'json') args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
