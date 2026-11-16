#!/usr/bin/env node
// R1185p, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that leaks what a guarded run must not load; the CI step requires the probe to fail on it.
// R1185p W2: a wrapper around the real claude that, under --setting-sources '', still applies the home's and the
// checkout's local settings' `env`, except the variables claude itself reads for its requests (ANTHROPIC_*): a
// regression that passes a settings env to the tools and hooks a run starts but not to the API client (a planted
// BASH_ENV or PATH would then run code in every Bash call). The probe plants a tool env variable in each settings file
// and its worker run's Bash prints the environment, so it names this ("guarded worker run's request carries
// localToolEnv").
const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const env = { ...process.env }; const i = args.indexOf('--setting-sources');
if (i >= 0 && args[i + 1] === '') for (const f of [path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME, '.claude'), 'settings.json'), path.join(process.cwd(), '.claude', 'settings.local.json')]) {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).env || {})) if (!k.startsWith('ANTHROPIC_')) env[k] = v; } catch {}
}
process.exit(spawnSync(real, args, { stdio: 'inherit', env }).status ?? 1);
