#!/usr/bin/env node
// R1185p, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that leaks what a guarded run must not load; the CI step requires the probe to fail on it.
// R1185p W3: a wrapper around the real claude that honours --setting-sources '' unless the run carries a role prompt
// (--append-system-prompt-file), which every coordinator role run has (src/coordinator.ts rolePrompt; fix runs too) and
// the probe's run never has: then it loads every source. It stands for any regression in how '' combines with a flag
// production passes and the probe doesn't (--append-system-prompt-file, --json-schema, --plugin-dir, --mcp-config,
// --effort, an apiKeyHelper in --settings).
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
if (i >= 0 && args[i + 1] === '' && args.includes('--append-system-prompt-file')) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
