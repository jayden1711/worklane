#!/usr/bin/env node
// R1185x, in the style of test/fixtures/setting-sources/wrap-*.cjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' unless the run has a role prompt
// (--append-system-prompt-file) AND its cwd is the checkout itself (`.git` a folder, not a worktree's file). That is
// the shape of production's guarded runs in the checkout: automations (src/coordinator/automations.ts:309, REPORT_PROMPT,
// cwd: this.d.repo), the gardener (gardener.ts:56), corrections (corrections.ts:118) and channel chat (intake/chat.ts:61).
// Then it loads every source.
const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
let checkout = false; try { checkout = fs.statSync(path.join(process.cwd(), '.git')).isDirectory(); } catch {}
if (i >= 0 && args[i + 1] === '' && checkout && args.includes('--append-system-prompt-file')) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
