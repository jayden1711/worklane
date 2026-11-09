#!/usr/bin/env node
// R1185r D3, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that, under --setting-sources '', copies an apiKeyHelper from the checkout's or the
// home's settings into the run's --settings when it has none (a cli-runtime run has none), as a regression might: the
// helper is a command claude runs. The probe plants one in the local and home settings, so it names this ("a guarded
// run ran the local settings' apiKeyHelper").
const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources'); const s = args.indexOf('--settings');
if (i >= 0 && args[i + 1] === '' && s >= 0) {
  const o = JSON.parse(args[s + 1]);
  if (!o.apiKeyHelper) for (const f of [path.join(process.cwd(), '.claude', 'settings.local.json'), path.join(process.cwd(), '.claude', 'settings.json'), path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'settings.json')]) {
    let h; try { h = JSON.parse(fs.readFileSync(f, 'utf8')).apiKeyHelper; } catch {} if (h) { o.apiKeyHelper = h; break; }
  }
  args[s + 1] = JSON.stringify(o);
}
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
