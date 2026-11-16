#!/usr/bin/env node
// R1185y: honours "" unless CLAUDE_CODE_PLUGIN_CACHE_DIR is in the environment, as every run of an instance whose empty plugin root exists gets (src/plugins/run.ts:53, src/runner.ts:719). Then every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
if (i >= 0 && args[i + 1] === "" && "CLAUDE_CODE_PLUGIN_CACHE_DIR" in process.env) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
