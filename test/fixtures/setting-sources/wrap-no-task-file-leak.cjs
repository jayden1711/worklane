#!/usr/bin/env node
// R1185y: honours --setting-sources "" unless the run's environment names NO task file (no *_TASK_FILE variable), as every production guarded run outside a task has (automations.ts:309, gardener.ts:56, corrections.ts:118, checks-from-feedback.ts:75, base.ts:457 login-check, channel chat, intake); then it loads every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
if (i >= 0 && args[i + 1] === "" && !Object.keys(process.env).some((k) => k.endsWith("_TASK_FILE"))) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
