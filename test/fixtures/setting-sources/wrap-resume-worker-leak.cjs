#!/usr/bin/env node
// R1185q, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' except on a run that is both a resume (--resume) and
// carries a role prompt (--append-system-prompt-file), i.e. a resumed coordinator fix run (src/coordinator/fix-runs.ts):
// then it loads every source. The probe's resumed pair is worker-shaped, so it names this.
const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE;
if (!real) {
  console.error('set SETTING_SOURCES_REAL_CLAUDE to the real claude');
  process.exit(2);
}
const args = process.argv.slice(2);
const i = args.indexOf('--setting-sources');
if (i >= 0 && args[i + 1] === '' && args.includes('--resume') && args.includes('--append-system-prompt-file')) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
