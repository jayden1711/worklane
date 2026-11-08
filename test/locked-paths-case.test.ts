// #953: on a case-insensitive checkout (macOS, Windows) `Docs/adr/x.md` or `Decisions.md` is the decision record the
// planners read, but review levels compared paths case-sensitively, so a one-review docs PR could add a citable
// record. A locked category's membership is now case folded: a case variant of a locked path is L3 everywhere. A
// folded match only raises: it never lowers a level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { computeLevel, SELF_MODIFICATION, selfModificationPart, type LockScope } from '../src/review.js';
import { repoRoot } from './helpers.js';

const own = loadConfig(repoRoot).review!;
const example = loadConfig(join(repoRoot, 'examples', 'basic')).review!;
const levelOf = (path: string, rc: typeof own, scope?: LockScope) => computeLevel({ files: [{ path, added: 1, removed: 1 }], labels: [], moneyPaths: [], scope }, rc);

test('#953: a case variant of a decision record, the merge process or the guard is self-modification, L3, in the engine\'s repo', () => {
  const missed: string[] = [];
  for (const path of ['Decisions.md', 'DOCS/DECISIONS.md', 'Docs/adr/0001-x.md', 'Docs/Decisions/0001-x.md', 'docs/Design.md', 'Docs/process.md', 'SRC/hook.ts', 'src/Guardrails/access.ts', 'Deploy', 'DockerFile', 'docs/Releasing.md']) {
    for (const [name, rc] of [['this repo', own], ['the example', example]] as const) {
      const r = levelOf(path, rc);
      if (r.level !== 'L3' || !(SELF_MODIFICATION in r.categories)) missed.push(`${path} under ${name}: ${r.level} ${Object.keys(r.categories).join(',')}`);
    }
    if (selfModificationPart(path) === null) missed.push(`${path}: no self-modification part`);
  }
  assert.deepEqual(missed, []);
});

test('#953: a case variant of the config folder is harness-config, L3, in a managed app too', () => {
  for (const path of [`${BRAND.configDir.toUpperCase()}/review.yaml`, `${BRAND.configDir[0]}${BRAND.configDir[1]!.toUpperCase()}${BRAND.configDir.slice(2)}/guardrails.yaml`, '.Claude/settings.json']) {
    const r = levelOf(path, example, 'managed-app');
    assert.equal(r.level, 'L3', `${path}: ${r.level} ${Object.keys(r.categories).join(',')}`);
  }
});

test('#953: folding only raises: an ordinary path keeps its level, and app code in another case is the same app code', () => {
  assert.equal(levelOf('README.md', example).level, 'L0');
  assert.equal(selfModificationPart('docs/guide.md'), null);
  assert.equal(selfModificationPart('Notes/decisions-old.md'), null);
  // Only the locked categories fold: app code in another case is the same app code.
  assert.deepEqual(levelOf('Src/App.ts', example), { ...levelOf('src/app.ts', example), categories: Object.fromEntries(Object.entries(levelOf('src/app.ts', example).categories).map(([k]) => [k, ['Src/App.ts']])) });
});
