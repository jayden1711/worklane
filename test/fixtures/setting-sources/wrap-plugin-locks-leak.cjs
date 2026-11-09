#!/usr/bin/env node
// R1185t D1, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' except when the run's --settings carries PLUGIN_LOCKS (disableSkillShellExecution), as every production guarded run has:
// then it loads every source. The probe's guarded runs are production-shaped, so it names this.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
const s = args.indexOf('--settings'); let settings = {}; try { settings = JSON.parse(args[s + 1]); } catch {}
if (i >= 0 && args[i + 1] === '' && (settings.disableSkillShellExecution === true)) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
