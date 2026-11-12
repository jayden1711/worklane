#!/usr/bin/env node
// R1185y: honours "" unless the run has a role prompt (--append-system-prompt-file) AND its cwd is the checkout itself (.git a folder): automations, the gardener, corrections run so (cwd: this.d.repo). Then every source.
const { spawnSync } = require("node:child_process");
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error("set SETTING_SOURCES_REAL_CLAUDE"); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf("--setting-sources");
const fs = require("node:fs"), path = require("node:path");
let checkout = false; try { checkout = fs.statSync(path.join(process.cwd(), ".git")).isDirectory(); } catch {}
if (i >= 0 && args[i + 1] === "" && checkout && args.includes("--append-system-prompt-file")) args[i + 1] = "user,project,local";
process.exit(spawnSync(real, args, { stdio: "inherit", env: process.env }).status ?? 1);
