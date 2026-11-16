#!/usr/bin/env node
// R1185t D1, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that keeps the auto memory off except when the run's --settings carries PLUGIN_LOCKS (disableSkillShellExecution), as every production guarded run has:
// then it drops CLAUDE_CODE_DISABLE_AUTO_MEMORY, so the auto memory loads (its own leak, R1185u N2). The probe's guarded runs are production-shaped, so it names this.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
const s = args.indexOf('--settings'); let settings = {}; try { settings = JSON.parse(args[s + 1]); } catch {}
const env = { ...process.env };
if (i >= 0 && args[i + 1] === '' && (settings.disableSkillShellExecution === true)) delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
process.exit(spawnSync(real, args, { stdio: 'inherit', env }).status ?? 1);
