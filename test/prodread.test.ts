import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prodReadArgv, remoteClient, statementCount } from '../src/prodread.js';

const cfg = { via: 'railway-ssh' as const, service: 'web', environment: 'production', url_var: 'RO_URL', max_rows: 2, timeout_s: 5 };

test('counts statements, ignoring semicolons in strings and comments', () => {
  assert.equal(statementCount('select 1'), 1);
  assert.equal(statementCount("select ';' -- ; comment\n;"), 1);
  assert.equal(statementCount('select 1; delete from t'), 2);
  assert.equal(statementCount('/* ; */ select 1;;'), 1);
});

test('SQL and client travel base64-encoded, so quotes cannot break out of the remote shell', () => {
  const sql = `select '$(rm -rf /)'; ' "\`whoami\`"`;
  const argv = prodReadArgv(cfg, sql);
  assert.deepEqual(argv.slice(0, 8), ['ssh', '--service', 'web', '--environment', 'production', '--', 'sh', '-c']);
  const remote = argv[8]!;
  assert.match(remote, /^node -e 'eval\(Buffer\.from\("[A-Za-z0-9+/=]+","base64"\)\.toString\(\)\)' [A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(remote.split(' ').pop()!, 'base64').toString(), sql);
});

test('remote client: read-only transaction, row cap, and refusal without the read-only URL', () => {
  // Run the client against a stub `pg` that records what it's asked to do.
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  mkdirSync(join(dir, 'node_modules', 'pg'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'pg', 'index.js'),
    `const fs = require('fs');
     exports.Client = class { constructor(o) { this.o = o; } async connect() { fs.appendFileSync('log', 'connect ' + this.o.connectionString + '\\n'); }
       async query(q) { fs.appendFileSync('log', q + '\\n'); return { rowCount: 3, rows: [{ a: 1 }, { a: 2 }, { a: 3 }], fields: [{ name: 'a' }] }; }
       async end() {} };`,
  );
  // Run exactly as on the server: `node -e <client> <base64 sql>`.
  const client = remoteClient('RO_URL', 2, 5000);
  const sql = Buffer.from('select a from t').toString('base64');
  const ok = spawnSync(process.execPath, ['-e', client, sql], { cwd: dir, encoding: 'utf8', env: { ...process.env, RO_URL: 'postgres://ro@db/app' } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { rowCount: 3, truncated: true, fields: ['a'], rows: [{ a: 1 }, { a: 2 }] });
  assert.deepEqual(readFileSync(join(dir, 'log'), 'utf8').trim().split('\n'), ['connect postgres://ro@db/app', 'BEGIN TRANSACTION READ ONLY', 'select a from t', 'ROLLBACK']);

  const env = { ...process.env };
  delete env.RO_URL;
  const missing = spawnSync(process.execPath, ['-e', client, sql], { cwd: dir, encoding: 'utf8', env });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /RO_URL is not set/);
});
