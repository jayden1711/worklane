#!/usr/bin/env node
// A must-fail case for scripts/ci/setting-sources-probe.mjs (R1185aa D1): a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that puts the launch's guards first, as before R1185aa, when the argv carries a
// smuggled `--setting-sources=...` (only the probe's smuggled-flag launch does): the smuggled one is then the last, and
// Claude Code takes the last, so every source loads. The probe names this on that launch's own line.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
let args = process.argv.slice(2);
if (args.some((a) => a.startsWith('--setting-sources='))) args = [...args.slice(-5), ...args.slice(0, -5)];
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
