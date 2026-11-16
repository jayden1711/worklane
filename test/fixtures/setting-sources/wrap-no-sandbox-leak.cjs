#!/usr/bin/env node
// R1185u, in the style of test/fixtures/setting-sources/wrap-*.cjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' unless the run's --settings has NO lane sandbox
// (an instance with `policy.sandbox: false`, src/instance.ts:191, a supported shape: laneRuns gives no settings,
// src/instance.ts:484): then it loads every source. The probe runs each guarded shape without the sandbox too, so it names this.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
const s = args.indexOf('--settings'); let settings = {}; try { settings = JSON.parse(args[s + 1]); } catch {}
if (i >= 0 && args[i + 1] === '' && !(settings.sandbox && settings.sandbox.enabled === true)) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
