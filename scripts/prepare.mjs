#!/usr/bin/env node
// Release tags ship a prebuilt dist/ (see scripts/release.mjs), so installs
// from a tag need no build and no install scripts. On a plain checkout of
// main, build so `npm install` works for contributors.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
if (existsSync(new URL('../dist/src/cli.js', import.meta.url))) process.exit(0);
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
