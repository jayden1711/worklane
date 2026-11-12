#!/usr/bin/env node
// R1185y: honours "" unless the run has --disallowedTools, as automations, the gardener, corrections, reflection, the investigator, the evaluators and feedback-checks have. Then every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
if (i >= 0 && args[i + 1] === "" && args.includes("--disallowedTools")) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
