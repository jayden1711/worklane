#!/usr/bin/env node
// R1185v: a wrapper around the real claude (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' unless its
// cwd is a git WORKTREE (its `.git` is a file, not a folder), as every production task run's cwd is (the coordinator
// runs each worker and fix run in a worktree it makes, src/worktrees.ts; `cwd: path`, src/coordinator.ts): then it
// loads every source. Claude Code resolves a worktree's project root and memory folder on its own path, so a
// regression keyed to it is a real class. The probe's cwd is always the planted checkout itself (a `.git` folder).
const fs = require('node:fs'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources');
let worktree = false; try { worktree = fs.statSync(path.join(process.cwd(), '.git')).isFile(); } catch {}
if (i >= 0 && args[i + 1] === '' && worktree) args[i + 1] = 'user,project,local';
process.exit(spawnSync(real, args, { stdio: 'inherit', env: process.env }).status ?? 1);
