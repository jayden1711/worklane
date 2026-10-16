// Extend -> Automations on the dashboard's server: a viewer gets nothing; a writer reads, pauses and runs now; only an
// owner creates, edits, deletes or resumes; every change is reviewed first (nothing written) and confirmed against the
// file the review saw; every attempt is audited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { asPerson, exampleProject, exampleRoles } from './helpers.js';

const DEF = {
  id: 'deps',
  name: 'Dependency check',
  trigger: { kind: 'schedule', cron: '0 9 * * 1' },
  mode: 'task',
  template: { title: 'Dependency check {date}', outcome: 'Patch and minor bumps whose tests pass.', done_when: [{ command: 'npm test' }] },
  budget: { per_run_usd: 3, per_day_usd: 6 },
};

async function serve() {
  const { dir } = exampleProject();
  const stateDir = projectStateDir(dir);
  mkdirSync(stateDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'auto-home-'));
  const policyFile = join(home, 'policy.yaml');
  writeFileSync(policyFile, 'version: 1\nbudget: { daily_usd: 40 }\nautomations: { enabled: true }\n', { mode: 0o600 });
  const automationsFile = join(home, 'automations.yaml');
  const d = await startDashboard({ root: dir, cfg: loadConfig(dir), eventsDb: join(stateDir, 'events.db'), stateDir, user: 'example-owner', roleOf: exampleRoles, instance: 'shop', policyFile, automationsFile, slotsDir: mkdtempSync(join(tmpdir(), 'auto-slots-')) });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user), 'content-type': 'application/json' });
  const get = async (user: string) => {
    const r = await fetch(`${base}/api/automations`, { headers: h(user) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { actions?: string[]; digest?: string; automations?: { id: string; enabled: boolean }[]; limits?: { enabled: boolean; dailyUsd: number } } };
  };
  const post = async (user: string, body: unknown) => {
    const r = await fetch(`${base}/api/automations`, { method: 'POST', headers: h(user), body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { error?: string; changes?: string[]; summary?: string[]; digest?: string; confirmed?: boolean } };
  };
  const audits = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as { login: string; action: string });
    } finally {
      log.close();
    }
  };
  return { d, get, post, audits, automationsFile };
}

test('automations-dashboard: a viewer gets nothing; review writes nothing; only an owner creates; a writer pauses; stale reviews are refused; writers and owners attempts audited', async () => {
  const s = await serve();
  try {
    // A viewer: no data, and no change (refused before any route, as every viewer write is).
    assert.equal((await s.get('someone-else')).status, 403);
    assert.equal((await s.post('someone-else', { action: 'run', id: 'deps' })).status, 403);
    // The owner's view: on, empty, every action.
    const empty = await s.get('example-owner');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.automations, []);
    assert.equal(empty.body.limits!.enabled, true);
    assert.equal(empty.body.limits!.dailyUsd, 10, "25% of the policy's $40");
    assert.deepEqual(empty.body.actions, ['create', 'edit', 'delete', 'pause', 'resume', 'run']);
    // A writer may not create, even with a valid review.
    assert.equal((await s.post('example-collaborator', { action: 'create', automation: DEF })).status, 403);
    // Review: the exact change, nothing written.
    const review = await s.post('example-owner', { action: 'create', automation: DEF });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.confirmed, false);
    assert.ok(review.body.changes!.includes('+ trigger.cron: "0 9 * * 1"'));
    assert.ok(review.body.summary!.some((l) => /at most \$3 a run and \$6 a local day/.test(l)));
    assert.equal(existsSync(s.automationsFile), false, 'nothing written by a review');
    // Confirm: written, owned by the confirming owner.
    const done = await s.post('example-owner', { action: 'create', automation: DEF, digest: review.body.digest, confirm: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(readFileSync(s.automationsFile, 'utf8'), /owner: example-owner/);
    // A writer's view: Pause and Run now only.
    const w = await s.get('example-collaborator');
    assert.deepEqual(w.body.actions, ['pause', 'run']);
    // A writer pauses, after a review; a review made before another change is refused.
    const pause = await s.post('example-collaborator', { action: 'pause', id: 'deps' });
    assert.deepEqual(pause.body.changes, ['- enabled: true', '+ enabled: false']);
    const edit = await s.post('example-owner', { action: 'edit', id: 'deps', automation: { ...DEF, name: 'Deps' } });
    assert.equal((await s.post('example-owner', { action: 'edit', id: 'deps', automation: { ...DEF, name: 'Deps' }, digest: edit.body.digest, confirm: true })).status, 200);
    const stale = await s.post('example-collaborator', { action: 'pause', id: 'deps', digest: pause.body.digest, confirm: true });
    assert.equal(stale.status, 400);
    assert.match(stale.body.error!, /changed since your review/);
    const resumeByWriter = await s.post('example-collaborator', { action: 'resume', id: 'deps' });
    assert.equal(resumeByWriter.status, 403, 'a writer never resumes (it restarts spending)');
    const actions = s.audits().map((a) => `${a.login} ${a.action}`);
    for (const want of ['example-collaborator automation.refused_change', 'example-owner automation.create', 'example-owner automation.edit']) assert.ok(actions.includes(want), `audited: ${want}`);
  } finally {
    await s.d.close();
  }
});
