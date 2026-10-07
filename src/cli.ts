#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';

// Step 0 stub: only --version and help. install/doctor arrive in step 1.
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const [cmd] = process.argv.slice(2);
if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
} else {
  console.log(`${BRAND.name} ${pkg.version}: ${BRAND.tagline}

usage: ${BRAND.cli} <command>

commands (planned):
  install    scaffold ${BRAND.configDir}/, hooks and settings into a project
  doctor     verify the install
  up         start the coordinator
  dashboard  open the dashboard`);
}
