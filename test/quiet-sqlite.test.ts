import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSqliteExperimentalWarning } from '../src/quiet-sqlite.js';
import { engineCli } from './helpers.js';

const SQLITE = 'SQLite is an experimental feature and might change at any time';

test('only node:sqlite\'s experimental warning is the one silenced', () => {
  const warning = (name: string, message: string) => Object.assign(new Error(message), { name });
  assert.equal(isSqliteExperimentalWarning(warning('ExperimentalWarning', SQLITE)), true);
  assert.equal(isSqliteExperimentalWarning(warning('ExperimentalWarning', 'Type Stripping is an experimental feature and might change at any time')), false);
  assert.equal(isSqliteExperimentalWarning(warning('ExperimentalWarning', `The ${SQLITE}`)), false);
  assert.equal(isSqliteExperimentalWarning(warning('DeprecationWarning', SQLITE)), false);
  assert.equal(isSqliteExperimentalWarning(warning('Warning', SQLITE)), false);
});

test('the CLI\'s stderr has no SQLite experimental warning, and a different warning still prints', async () => {
  // WHY: a preload that waits for the CLI's filter, then emits the SQLite warning itself (a Node that no longer warns
  // about node:sqlite still proves the filter) and two others. With no filter after 5 s it emits anyway, so a CLI
  // that stopped installing it fails on the SQLite line. `hook` reads stdin, which keeps the CLI alive meanwhile.
  const preload = join(mkdtempSync(join(tmpdir(), 'quiet-sqlite-')), 'warn.mjs');
  writeFileSync(
    preload,
    `const start = Date.now();
const t = setInterval(() => {
  if (!process.listeners('warning').some((l) => l.name === 'sqliteWarningFilter') && Date.now() - start < 5000) return;
  clearInterval(t);
  process.emitWarning(${JSON.stringify(SQLITE)}, 'ExperimentalWarning');
  process.emitWarning('Other thing is an experimental feature and might change at any time', 'ExperimentalWarning');
  process.emitWarning('old thing is deprecated', 'DeprecationWarning');
  setTimeout(() => process.stderr.write('PRELOAD DONE\\n'), 50);
}, 10);
`,
  );
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, engineCli, 'hook', 'no-such-event'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  const done = new Promise<number | null>((resolve) => child.on('close', resolve));
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d;
    if (stderr.includes('PRELOAD DONE')) child.stdin.end('{}');
  });
  const code = await done;
  assert.equal(code, 2, `the hook command ran to its own end: ${stderr}`);
  assert.match(stderr, /unknown hook event no-such-event/);
  assert.doesNotMatch(stderr, /SQLite is an experimental feature/, 'node:sqlite\'s warning (the real one on Node 22 and 24, and the emitted one) is not printed');
  assert.match(stderr, /ExperimentalWarning: Other thing is an experimental feature and might change at any time/);
  assert.match(stderr, /DeprecationWarning: old thing is deprecated/);
});
