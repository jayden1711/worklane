// The engine updater's world-readable files never hold a secret (scripts/machine/<cli>-update.cjs): the update log
// (updates.jsonl), the state file (update-state.json) and the hold file (update-held.json) are all 0644, and their
// fields carry reasons, clone URLs, build output and migration errors. Everything written to them is redacted first,
// through the updater's own realDeps writers, and the dedupe and the hold still work on what was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Files = { log: string; state: string; held: string };
const u = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs')) as {
  run(deps: object): Promise<string>;
  realDeps(print?: (line: string) => void, files?: Files): Record<string, unknown>;
  redactDeep(v: unknown): unknown;
  appendLog(file: string, entry: Record<string, unknown>): void;
};

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const GHP = `ghp_${'Z'.repeat(36)}`;
const SECRETS = ['hunter2hunter2', 'someone', 'abc123abc123', GHP, 'ghp_'];
const show = 'User=wl-alice\nEnvironment=PATH=/usr/bin\nExecStart={ path=/usr/local/bin/worklane ; argv[]=/usr/local/bin/worklane coordinator run --instance alice ; ignore_errors=no }\n';

/**
 * The updater's real file writers (realDeps: log, note, hold, held) on files in a scratch dir, with the machine and
 * GitHub faked. `build` / `migrate`: what those commands fail with, if they fail.
 */
function machine(o: { repoUrl?: string; build?: string; migrate?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'upd-redact-'));
  const files: Files = { log: join(dir, 'updates.jsonl'), state: join(dir, 'update-state.json'), held: join(dir, 'update-held.json') };
  const printed: string[] = [];
  let current = OLD;
  // WHY: the post-install health wait reads the clock between sleeps; a clock that never moves never settles.
  let clock = Date.parse('2026-10-14T05:00:00Z');
  const real = u.realDeps((l) => printed.push(l), files);
  const deps = {
    ...real,
    // realDeps judges checks by their source (#727): `test` is pinned to App 1, which posts it below.
    config: () => ({ enabled: true, repo_url: o.repoUrl ?? 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test'], required_check_sources: { test: { app_id: 1 } } }),
    installed: () => current,
    exec: (file: string, args: string[]) => {
      if (file === 'git') return `${NEW}\trefs/heads/main\n`;
      if (file === 'systemctl' && args[0] === 'list-units') return 'worklane-alice.service loaded active running x\n';
      if (file === 'systemctl' && args[0] === 'show' && args[2] === 'User,Environment,ExecStart') return show;
      if (file === 'systemctl' && args[0] === 'show') return 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n';
      if (file === 'systemd-run' && args.includes('migrate')) {
        if (!o.migrate) return `${JSON.stringify({ ok: true, applied: [], made: [] })}\n`;
        throw Object.assign(new Error('Command failed: systemd-run'), { stdout: `${JSON.stringify({ ok: false, error: o.migrate })}\n` });
      }
      if (file === 'systemd-run' && o.build) throw new Error(o.build); // the build
      return '';
    },
    fetchJson: async (url: string) => (url.includes('/compare/') ? { status: 'ahead', ahead_by: 1, behind_by: 0 } : { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1, app: { id: 1 } }] }),
    slots: () => [],
    alive: () => false,
    installTree: () => {},
    syncHelpers: () => [],
    switchTo: (s: string) => void (current = s),
    now: () => clock,
    sleep: async (ms: number) => void (clock += ms),
    configChangedAt: () => 0,
    // The rest of realDeps reaches the machine (systemd-run, /var/lib, the installed engine): faked here.
    // WHY: #384's signers watch reads root's /var/lib/<cli>/signers-state.json; no signers file here, so no change and no hold.
    signersCheck: () => null,
    signersHold: () => null,
    signersAcknowledged: () => false,
    verdicts: () => null,
    saveVerdicts: () => {},
    sandboxStatus: () => null,
    stuckState: () => null,
    saveStuck: () => {},
    raiseIncident: () => {},
    resolveIncident: () => {},
    canaryState: () => null,
  };
  const read = (f: keyof Files) => (existsSync(files[f]) ? readFileSync(files[f], 'utf8') : '');
  const lines = () => read('log').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { deps, files, read, lines, printed, current: () => current };
}

const clean = (what: string, text: string) => {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${what} holds "${s}": ${text.slice(0, 400)}`);
};

test('a credential in the clone URL never reaches the update log or the state file, and the dedupe still logs it once', async () => {
  const m = machine({ repoUrl: 'https://someone:hunter2hunter2@git.example.com/x.git' });
  for (let i = 0; i < 3; i++) assert.equal(await u.run(m.deps), 'refused');
  clean('updates.jsonl', m.read('log'));
  clean('update-state.json', m.read('state'));
  assert.equal(m.lines().length, 1, 'three runs, one line: the dedupe compares the redacted reason with the redacted one');
  assert.match(String(m.lines()[0]!.reason), /isn't a GitHub repository: https:\/\/\[redacted\]@git\.example\.com\/x\.git/);
  assert.deepEqual(JSON.parse(m.read('state')), { event: 'refused', sha: null, reason: m.lines()[0]!.reason });
  for (const f of ['log', 'state'] as const) assert.equal(statSync(m.files[f]).mode & 0o777, 0o644);
  clean('the journal', m.printed.join('\n'));
});

test('a token in a failed build\'s output never reaches the update log or the state file', async () => {
  const m = machine({ build: `clone failed: fatal: https://x-access-token:${GHP}@github.com/example-org/engine.git token=abc123abc123\nAuthorization: Bearer abcdefghijklmnop` });
  assert.equal(await u.run(m.deps), 'build_failed');
  clean('updates.jsonl', m.read('log'));
  clean('update-state.json', m.read('state'));
  assert.ok(!m.read('log').includes('abcdefghijklmnop'), 'the bearer token');
  const failed = m.lines().find((l) => l.event === 'build_failed')!;
  assert.match(String(failed.reason), /token=\[redacted\]/);
  assert.deepEqual(m.lines().map((l) => l.event), ['attempt', 'build_failed']);
});

test('a token in a failed migration never reaches the hold file or the rollback\'s log line, and the hold still holds', async () => {
  const m = machine({ migrate: `tests.yaml: GH_TOKEN=${GHP} is not allowed here; password: "hunter2hunter2"` });
  assert.equal(await u.run(m.deps), 'rolled_back');
  clean('update-held.json', m.read('held'));
  clean('updates.jsonl', m.read('log'));
  const held = JSON.parse(m.read('held')) as { sha: string; at: string; failed: string[] };
  assert.equal(held.sha, NEW);
  assert.match(held.failed[0]!, /^rollback: migration failed: alice: tests\.yaml: GH_TOKEN=\[redacted\]/);
  assert.equal(statSync(m.files.held).mode & 0o777, 0o644);
  // Read back through the updater's own held(): the next run is held, on the redacted file.
  assert.equal(await u.run(m.deps), 'held');
  assert.equal(m.current(), OLD);
  clean('update-state.json', m.read('state'));
  assert.match(m.read('state'), /rolled back at .*rollback: migration failed: alice: tests\.yaml: GH_TOKEN=\[redacted\]/);
});

test('every string field is redacted, however deep, and nothing else changes', () => {
  const entry = { event: 'rolled_back', to: NEW, n: 3, ok: true, none: null, diagnosis: [{ unit: 'u', journal: `GH_TOKEN=${GHP}`, list: ['ok', `https://someone:hunter2hunter2@h/x`] }] };
  const r = u.redactDeep(entry) as typeof entry;
  clean('redactDeep', JSON.stringify(r));
  assert.deepEqual({ ...r, diagnosis: undefined }, { ...entry, diagnosis: undefined }, 'numbers, booleans, null, shas and keys as they were');
  assert.deepEqual(r.diagnosis[0]!.list, ['ok', 'https://[redacted]@h/x']);
  // And the log line stays one valid JSON line: redaction runs on the values, never on the serialized line.
  const dir = mkdtempSync(join(tmpdir(), 'upd-redact-'));
  u.appendLog(join(dir, 'log'), { event: 'x', reason: 'token=abc123abc123","event":"forged', more: 'tail' });
  const lines = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual([parsed.event, parsed.reason, parsed.more], ['x', 'token=[redacted]', 'tail']);
});
