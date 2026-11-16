#!/usr/bin/env node
// R1185y: honours "" unless the run has --effort, as a role with `effort` set gets (coordinator.ts:1319, 1253, 1669; planner_effort at 764). Then every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
if (i >= 0 && args[i + 1] === "" && args.includes("--effort")) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
