#!/usr/bin/env node
// The agents' tool guard's own process (#665): every hook command install writes runs
// `node <engine>/dist/src/hook-main.js <event>` (src/install.ts hookCommand, src/instance.ts's research lanes).
//
// WHY its own entry: the hooks used to run `node <engine>/dist/src/cli.js hook <event>`. The CLI turns the guard's
// result into the exit code and loads some 400 modules, most of them outside the guard's locked tree, into the guard's
// process. This file is under src/hook*, and the tree it reaches is locked module by module (src/hook-imports.ts, held
// exact by test/review.test.ts), so what runs when an agent calls a tool is what the owner reviews.
//
// The CLI's `hook` command stays for installs written before this file: it runs the same hookProcess.
// INVARIANT: first, so node:sqlite's experimental warning never reaches stderr (quiet-sqlite.ts).
import './quiet-sqlite.js';
// INVARIANT: before any engine module: a <PREFIX>_SYSTEM_ROOT not honoured here stops the hook before anything starts.
import './os/system-root-guard.js';
import { BRAND } from './brand.js';
import { hookProcess } from './hook.js';

hookProcess(process.argv[2] ?? '').then(
  (code) => process.exit(code),
  (e: unknown) => {
    // Fails closed: a guard that can't decide blocks the call (exit 2), with a reason Claude can show.
    process.stderr.write(`[${BRAND.cli}] hook ${process.argv[2] ?? ''} failed: ${(e as Error)?.message ?? String(e)}\n`);
    process.exit(2);
  },
);
