// The real-systemd job's Discord seam, case 1 (.github/workflows/ci-slow.yml, add-project-real-systemd): the
// engine's own listing, with no stand-in, for an instance whose bot token file it can't read. Run here as this user,
// without systemd, with the same script (scripts/ci/discord-seam-dashboard.mjs) and decoys; then the workflow's own
// checks of that case's answer and log are run against what came back, so a stale expectation fails here, not only
// on the real host (#1112).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { exampleProject, repoRoot } from './helpers.js';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });

/** Case 1's lines in the workflow step: from its seam_unit call to case 2. */
function engineCase(): string[] {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'ci-slow.yml'), 'utf8');
  const at = wf.indexOf('mode=engine port=4791; seam_unit --unit=ci-discord-seam-engine');
  assert.ok(at > 0, 'the step starts the engine case');
  const end = wf.indexOf('# 2. ', at);
  assert.ok(end > at, 'case 2 follows it');
  return wf.slice(at, end).split('\n').map((l) => l.trim());
}

test("the Discord seam's engine case (ci-slow.yml): the workflow's checks hold for the engine's own answer and log", { skip: (process.platform === 'win32' && 'POSIX modes') || (process.getuid?.() === 0 && 'root reads a 000 file') }, async (t) => {
  const seam = mkdtempSync(join(tmpdir(), 'discord-seam-'));
  const F = join(seam, 'out');
  const instances = join(seam, 'instances');
  const home = join(instances, 'ci');
  const decoys = join(seam, 'decoys');
  const marks = join(seam, 'marks');
  for (const d of [F, home, decoys, join(seam, 'home')]) mkdirSync(d, { recursive: true });
  const { dir: checkout } = exampleProject();
  writeFileSync(join(home, 'instance.yaml'), `version: 1\nname: ci\nrepos: [{ path: ${JSON.stringify(checkout)}, repo: example/alpha }]\n`);
  writeFileSync(join(home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\nauto_merge: false\n');
  const tokenFile = join(seam, 'unreadable-token');
  writeFileSync(tokenFile, 'not-a-token\n');
  chmodSync(tokenFile, 0o000);
  writeFileSync(join(home, 'credentials.yaml'), `version: 1\ngithub: { kind: gh-config-dir, path: /nonexistent }\nintake: { discord_token: ${JSON.stringify(tokenFile)} }\n`, { mode: 0o600 });
  // Decoys that leave a mark if they ever run: a CLI and a node first on PATH, and a file NODE_OPTIONS preloads.
  writeFileSync(marks, '');
  for (const b of [BRAND.cli, 'node', 'nodejs']) writeFileSync(join(decoys, b), `#!/bin/sh\necho "${b} $*" >> ${JSON.stringify(marks)}\necho "{}"\n`, { mode: 0o755 });
  const preload = join(decoys, 'preload.cjs');
  writeFileSync(preload, `if (process.argv.includes("channels")) require("node:fs").appendFileSync(${JSON.stringify(marks)}, "NODE_OPTIONS preload\\n");\n`);

  const port = await freePort();
  const p = `${BRAND.envPrefix}_`;
  const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'ci', 'discord-seam-dashboard.mjs'), join(repoRoot, 'dist'), 'engine', String(port), instances, checkout], {
    cwd: '/',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${decoys}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      NODE_OPTIONS: `--require=${preload}`,
      HOME: join(seam, 'home'),
      TMPDIR: tmpdir(),
      [`${p}INSTANCES_DIR`]: instances,
      [`${p}CLI`]: join(decoys, BRAND.cli),
      [`${p}DISCORD_CLI`]: join(decoys, BRAND.cli),
      [`${p}ENGINE`]: decoys,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  t.after(async () => {
    child.kill('SIGTERM');
    await exited;
  });
  for (let n = 0; !stdout.includes('listening ') && n < 300; n++) {
    assert.equal(child.exitCode, null, `the seam dashboard exited: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(stdout.includes('listening '), `the seam dashboard listens: ${stdout} ${stderr}`);

  const key = readFileSync(join(seam, `state-engine`, 'dashboard-token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${port}/api/first-run/discord/channels`, { headers: { authorization: `Bearer ${key}` } });
  const body = await r.text();
  writeFileSync(join(F, 'seam-engine.json'), body);
  // The unit's journal on the real host is the dashboard's stderr and stdout.
  writeFileSync(join(F, 'seam-engine.log'), `${stdout}${stderr}`);

  // The engine's own CLI ran (its own line, for the token file it can't read), it went only to the log, and no decoy ran.
  assert.equal(r.status, 502, body);
  assert.deepEqual(JSON.parse(body), { error: "the bot's channel listing failed; the detail is in the dashboard's log on the machine" });
  assert.ok(stderr.includes(`GET /api/first-run/discord/channels: instance ci: can't read its bot token file ${tokenFile} (EACCES)`), stderr);
  assert.equal(readFileSync(marks, 'utf8'), '', 'no decoy ran');

  // The workflow's own checks of this case, here: its status check, and every jq and grep on the answer and the log.
  const lines = engineCase().filter((l) => /^(\[ "\$code" = |jq -e |grep -q)/.test(l));
  for (const line of lines) {
    const check: SpawnSyncReturns<string> = spawnSync('bash', ['-euo', 'pipefail', '-c', line], { encoding: 'utf8', env: { ...process.env, F, seam, code: String(r.status) } });
    assert.equal(check.status, 0, `the workflow's check failed: ${line}\n${check.stdout}${check.stderr}\nanswer: ${body}\nlog: ${stderr}`);
  }
  assert.ok(lines.some((l) => l.startsWith('jq -e') && l.includes('"$F/seam-engine.json"')), 'the workflow checks the answer');
  assert.ok(lines.some((l) => l.startsWith('grep -q') && l.includes('"$F/seam-engine.log"') && l.includes("can't read its bot token file $seam/unreadable-token (EACCES)")), "the workflow finds the engine CLI's own line in the unit's log");
});
