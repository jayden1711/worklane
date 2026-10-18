// #617: Experiments is its own top-level dashboard page (#581, at /experiments; /extend/experiments only redirects), so
// no engine string sends the owner to look for it under Extend. The incident an experiment result held for review
// raises names the page as it is now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExperimentHost } from '../src/coordinator/experiments.js';
import { FakeRunner } from '../src/runner.js';
import { repoRoot } from './helpers.js';
import { coordinator, fixture } from './repro-state-graph/harness.js';

const OLD_PLACE = /Extend\s*(->|→|›|>)\s*Experiments/;

test('#617 an experiment_review incident raised through the coordinator\'s experiments notify names the Experiments page', () => {
  const f = fixture();
  const raised: { kind: string; key: string; detail: string; fix: string }[] = [];
  const incidents = { raiseIncident: (kind: string, key: string, detail: string, fix: string) => void raised.push({ kind, key, detail, fix }), resolveIncident: () => {} };
  const c = coordinator(f, new FakeRunner(() => ({ structured: {} })), { incidents, experiments: { instance: 'ex', pinsFile: join(f.base, 'experiments.yaml'), helper: async () => ({ code: 0, stdout: '', stderr: '' }) } });
  // The host the coordinator hands its experiment loop: the loop calls notify for a held result or a flagged session.
  const loop = (c as unknown as { experiments(): { h: ExperimentHost } | null }).experiments();
  assert.ok(loop, 'experiments are wired on this coordinator');
  loop.h.notify('example-speed#3', 'experiment example-speed: result #3 is held for your review');
  assert.deepEqual(raised.map((r) => [r.kind, r.key, r.detail]), [['experiment_review', 'ex:example-speed#3', 'experiment example-speed: result #3 is held for your review']]);
  assert.equal(raised[0]!.fix, 'review it on the dashboard: Experiments (/experiments)');
  assert.doesNotMatch(raised[0]!.fix, OLD_PLACE);
});

test('#617 no engine, dashboard or docs text sends the owner to Extend for Experiments', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|md)$/.test(p) && OLD_PLACE.test(readFileSync(p, 'utf8'))) offenders.push(relative(repoRoot, p));
    }
  };
  for (const dir of ['src', join('web', 'src'), 'docs']) walk(join(repoRoot, dir));
  assert.deepEqual(offenders, []);
});
