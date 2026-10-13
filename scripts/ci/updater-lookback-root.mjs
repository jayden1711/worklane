#!/usr/bin/env node
// CI only (the "test-run sandbox (real systemd)" job in .github/workflows/ci-slow.yml), as root, as the updater runs: one
// red main tip doesn't block updates. The updater's run() picks the newest green commit on main's first-parent line,
// its memo of older commits' red verdicts is a real root-owned 0644 file written beside the others in /var/lib, and
// the next run reads it back instead of asking GitHub again. GitHub and the build are stand-ins (no network here);
// the decision code and the file it writes are the updater's own.
//
//   sudo node updater-lookback-root.mjs <path to worklane-update.cjs>
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

assert.equal(process.getuid(), 0, 'run this as root, as the updater runs');
const u = createRequire(import.meta.url)(process.argv[2]);
const dir = mkdtempSync('/var/lib/wl-lookback-');
const file = join(dir, 'update-verdicts.json');
const sha = (c) => c.repeat(40);
const OLD = sha('0');
// main: OLD <- a (green) <- b (red) <- c (red, the tip)
const commits = [
  { sha: sha('a'), parents: [OLD], green: true },
  { sha: sha('b'), parents: [sha('a')], green: false },
  { sha: sha('c'), parents: [sha('b')], green: false },
];
const asked = [];
const logs = [];
let current = OLD;
const deps = {
  config: () => ({ enabled: true, repo_url: 'https://github.com/example-org/engine.git', branch: 'main', required_checks: ['test', 'push-gate'] }),
  installed: () => current,
  exec: (f, args) => (f === 'git' ? `${sha('c')}\trefs/heads/main\n` : f === 'systemctl' && args[0] === 'show' ? 'ActiveState=active\nSubState=running\nNRestarts=0\nResult=success\n' : f === 'systemctl' && args[0] === 'list-units' ? 'worklane-x.service loaded active running x\n' : ''),
  fetchJson: async (url) => {
    if (url.includes('/compare/')) return { status: 'ahead', ahead_by: 3, behind_by: 0, total_commits: 3, commits: commits.map((c) => ({ sha: c.sha, parents: c.parents.map((p) => ({ sha: p })), commit: { committer: { date: new Date(Date.now() - 600_000).toISOString() } } })) };
    const s = /commits\/([0-9a-f]{40})\/check-runs/.exec(url)[1];
    asked.push(s.slice(0, 7));
    const c = commits.find((x) => x.sha === s);
    return { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '1', id: 1 }, { name: 'push-gate', status: 'completed', conclusion: c.green ? 'success' : 'failure', started_at: '1', id: 2 }] };
  },
  slots: () => [],
  alive: () => false,
  installTree: () => {},
  syncHelpers: () => [],
  switchTo: (s) => (current = s),
  now: () => Date.now(),
  sleep: async () => {},
  log: (e) => logs.push(e),
  held: () => null,
  hold: () => {},
  configChangedAt: () => 0,
  verdicts: () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  },
  saveVerdicts: (m) => u.saveJson(file, m, 0o644),
  note: (event, s, reason) => (logs.push({ event, to: s, reason }), event),
};
try {
  assert.equal(await u.run(deps), 'installed');
  assert.equal(current, sha('a'), 'the newest green commit, past the red tip and its red parent');
  assert.deepEqual(asked, ['ccccccc', 'bbbbbbb', 'aaaaaaa']);
  const chose = logs.find((l) => l.event === 'chose');
  console.log(JSON.stringify(chose));
  assert.match(chose.reason, /skipped ccccccc: required check "push-gate" ended failure; bbbbbbb: required check "push-gate" ended failure$/);
  const st = statSync(file);
  assert.equal(st.uid, 0, 'root-owned');
  assert.equal(st.mode & 0o777, 0o644);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))), [sha('b')], 'the older red verdict remembered; the tip never is');
  // Back to the old engine: the next run asks GitHub about the tip and the green one, not the remembered red one.
  current = OLD;
  asked.length = 0;
  assert.equal(await u.run(deps), 'installed');
  assert.deepEqual(asked, ['ccccccc', 'aaaaaaa']);
  console.log('OK: a red tip skipped for the newest green commit, as root; the verdict memo root-owned 0644 and read back');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
