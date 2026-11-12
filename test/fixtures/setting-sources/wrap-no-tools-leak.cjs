#!/usr/bin/env node
// R1185y: honours "" unless the run allows no tool (no --allowedTools): the login check (base.ts:457, allowedTools: []) and the experiment monitor run so. Then every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
if (i >= 0 && args[i + 1] === "" && !args.includes("--allowedTools")) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
