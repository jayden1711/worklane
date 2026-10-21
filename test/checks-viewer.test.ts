// Issue #837: GET /api/checks?issue=N gave every role, viewers included, each check's output tail, exit code and
// the head it ran on. A viewer (read on the repo, or a role this code doesn't know) now gets each check's name and
// result only, as on /api/events (check.result is not on the viewer-events allowlist); the owner and writers get
// everything as before. The issue page, given a viewer's answer, says the rest is the writers', never "no checks".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const sha = (c: string) => c.repeat(40);

/** What only the owners' and writers' answer carries: output tails, the heads checked, a land gate's verdict note. */
const SECRETS = ['TAIL-MARKER-7f3', '/srv/agent/work/src/secret-path.ts', 'BROWSER-TAIL-91', 'BASELINE-NOTE-q2', sha('c'), sha('d'), sha('e'), 'deadbee1', 'already failing on main'];

/** Issue 4: a failing verify run (a command, a baseline gate, a browser check, a skipped one), a land run, a no-change finding. */
function checksLog() {
  const dir = mkdtempSync(join(tmpdir(), 'checks-viewer-'));
  const log = new EventLog(join(dir, 'events.db'));
  log.append('issue.seen', { issue: 4, title: 'Fix the totals', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'c');
  log.append('check.result', {
    issue: 4,
    head: sha('c'),
    stage: 'verify',
    checks: [
      { check: 'npm test', status: 'fail', exitCode: 1, tail: 'TAIL-MARKER-7f3 at /srv/agent/work/src/secret-path.ts:12' },
      { check: 'npm run unit (baseline gate)', status: 'fail', exitCode: 2, tail: 'BASELINE-NOTE-q2: 1 new failure(s)' },
      { check: 'browser checkout', status: 'unavailable', exitCode: null, tail: 'BROWSER-TAIL-91', kind: 'browser' },
      { check: 'npm run lint', status: 'skipped', exitCode: null },
    ],
  }, 'c');
  log.append('check.result', { issue: 4, head: sha('d'), stage: 'land', checks: [{ check: 'unit: no new failures; 2 already failing on main (deadbee1)', status: 'pass', exitCode: 0, duration_ms: 5 }] }, 'c');
  log.append('issue.no_change', { issue: 4, owner: 'example-owner', base: sha('e'), why: 'already fixed', checks: [{ check: 'npm test', status: 'pass', exitCode: 0 }] }, 'c');
  log.append('check.result', { issue: 5, head: sha('c'), stage: 'verify', checks: [{ check: 'other issue', status: 'pass', exitCode: 0 }] }, 'c');
  return { dir, log };
}

/** A dashboard over that log, with the example project's roles and one person whose role this code doesn't know. */
async function served() {
  const { dir, log } = checksLog();
  const policy = join(dir, 'policy.yaml');
  writeFileSync(policy, 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\n');
  const { dir: root } = exampleProject();
  const roleOf = async (login: string) => (login === 'odd-role' ? ('auditor' as Awaited<ReturnType<typeof exampleRoles>>) : exampleRoles(login));
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: dir, user: 'example-owner', roleOf, policyFile: policy, slotsDir: join(dir, 'slots') });
  const base = d.url.split('/?')[0]!;
  const get = (login: string, path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(login) } });
  return { get, close: async () => { await d.close(); log.close(); } };
}

type Run = Record<string, unknown> & { checks: Record<string, unknown>[] };

test("a viewer's GET /api/checks: each check's name and result only, no output, exit code or head; the owner and a writer get everything", async () => {
  const s = await served();
  try {
    for (const login of ['someone-else', 'odd-role']) {
      const res = await s.get(login, '/api/checks?issue=4');
      assert.equal(res.status, 200, `${login}: the issue page still lists the checks`);
      const raw = await res.text();
      assert.deepEqual(SECRETS.filter((x) => raw.includes(x)), [], `${login}: no output tail, head or land note`);
      const runs = JSON.parse(raw) as Run[];
      assert.deepEqual(runs.map((r) => r.stage), ['no change', 'land', 'verify'], `${login}: newest first, this issue only`);
      for (const r of runs) {
        assert.deepEqual(Object.keys(r).sort(), ['at', 'checks', 'forViewer', 'id', 'stage'], `${login}: a run's fields`);
        assert.equal(r.forViewer, true);
        for (const c of r.checks) assert.deepEqual(Object.keys(c).sort(), ['check', 'status'], `${login}: a check's fields`);
      }
      assert.deepEqual(runs[2]!.checks, [
        { check: 'npm test', status: 'fail' },
        { check: 'npm run unit (baseline gate)', status: 'fail' },
        { check: 'browser checkout', status: 'unavailable' },
        { check: 'npm run lint', status: 'skipped' },
      ], `${login}: every check of the run, with its result`);
      assert.deepEqual(runs[1]!.checks, [{ check: 'unit', status: 'pass' }], `${login}: a land gate by its tier, not its verdict note`);
    }
    // The same viewer's other surfaces don't carry them either (the rule this route now matches). The task's own
    // head is on /api/state for viewers already (VIEWER_TASK_FIELDS, named in #837 as a separate question), so the
    // verify run's head is left out of this sweep only.
    for (const path of ['/api/state', '/api/events?issue=4', '/api/events', '/api/board', '/api/goal-graph?issue=4']) {
      const other = await s.get('someone-else', path);
      const body = await other.text();
      assert.ok(other.status === 200 || other.status === 403, `${path}: ${other.status}`);
      assert.deepEqual(SECRETS.filter((x) => body.includes(x) && x !== sha('c')), [], `${path} for a viewer`);
    }
    // The owner and a writer: as before, every field.
    for (const login of ['example-owner', 'example-collaborator']) {
      const runs = (await (await s.get(login, '/api/checks?issue=4')).json()) as Run[];
      assert.deepEqual(runs.map((r) => [r.stage, r.head]), [['no change', sha('e')], ['land', sha('d')], ['verify', sha('c')]], `${login}: each run's head`);
      assert.deepEqual(runs[2]!.checks[0], { check: 'npm test', status: 'fail', exitCode: 1, tail: 'TAIL-MARKER-7f3 at /srv/agent/work/src/secret-path.ts:12' }, `${login}: the output`);
      assert.equal(runs[1]!.checks[0]!.check, 'unit: no new failures; 2 already failing on main (deadbee1)', `${login}: the land note`);
      assert.equal(runs[0]!.forViewer, undefined);
    }
  } finally {
    await s.close();
  }
});

test("the issue page given a viewer's answer: the checks and their results, a note that the output is the writers', never \"no checks\"", async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'checks-viewer-web-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  const r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as { renderChecks(runs: unknown[]): string };
  const s = await served();
  try {
    // As the server sends it to a viewer.
    const viewer = r.renderChecks((await (await s.get('someone-else', '/api/checks?issue=4')).json()) as unknown[]).replace(/<!-- -->/g, '');
    assert.deepEqual(SECRETS.filter((x) => viewer.includes(x)), [], 'nothing of the output or heads on the page');
    assert.doesNotMatch(viewer, /No checks run yet/, 'a viewer is never told there are none');
    assert.match(viewer, /data-testid="checks-viewer-note"/);
    assert.match(viewer, /data-check="fail"[^>]*>[^]*npm test/);
    assert.match(viewer, /data-check="skipped"/);
    assert.doesNotMatch(viewer, />Exit</, 'no exit column it has nothing to fill with');
    assert.doesNotMatch(viewer, /output \(end\)/);
    // The writers' page is as before: the output, the exit codes and each run's head.
    const writer = r.renderChecks((await (await s.get('example-collaborator', '/api/checks?issue=4')).json()) as unknown[]);
    assert.match(writer, /TAIL-MARKER-7f3/);
    assert.match(writer, />Exit</);
    assert.match(writer, new RegExp(sha('c').slice(0, 8)));
    assert.doesNotMatch(writer, /checks-viewer-note/);
  } finally {
    await s.close();
  }
});
