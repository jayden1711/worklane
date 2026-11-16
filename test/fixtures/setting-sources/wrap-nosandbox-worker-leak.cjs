#!/usr/bin/env node
// R1185w: honours --setting-sources '' unless the run has no lane sandbox (a policy.sandbox: false instance) AND a role
// prompt (--append-system-prompt-file: every coordinator worker and fix run): then it loads every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
const s = args.indexOf("--settings"); let settings = {}; try { settings = JSON.parse(args[s + 1]); } catch {}
const bare = !(settings.sandbox && settings.sandbox.enabled === true);
if (i >= 0 && args[i + 1] === '' && bare && args.includes('--append-system-prompt-file')) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
