// Issue #902 round 13: for an instance named machine or console (reserved after it was made), `policy own <n> --retake`
// is refused, so no message may tell an admin to run it. Every message that would name `--retake` names the instance's
// removal instead, through one builder (src/policy-kill.ts retakeCommand; src/policy-gate.ts ownCommand uses it): the
// kill switch's and the id's errors, root's `policy set` refusals, doctor's checks and `policy own`'s CHECK line.
// Behaviour first (each error provoked in a temp marker dir), then a scan of the message builders as a backstop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { LATER_RESERVED } from '../src/instance-name.js';
import { ownCommand, setPolicyRootUid } from '../src/policy-gate.js';
import * as kill from '../src/policy-kill.js';
import { policyCommand, type PolicyRootDeps } from '../src/policy-root.js';
import { repoRoot } from './helpers.js';

const linux = process.platform !== 'linux' && 'a Linux machine install (POSIX owners, /proc/self/fd)';
const ID = 'a'.repeat(32);

/** The message each of policy-kill's id errors gives for <name>, provoked in a fresh marker dir. */
function killMessages(name: string): Record<string, string> {
  const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'retake-')));
  const msg = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return '(no error)';
  };
  const bad = fresh();
  writeFileSync(join(bad, `${name}.id`), 'not an id\n');
  const lost = fresh();
  const gone = fresh();
  writeFileSync(join(gone, `${name}.id`), `${ID}\n`);
  const rec = fresh();
  writeFileSync(join(rec, name), '{}');
  return {
    'ensureId, a pointer that cannot be used': msg(() => kill.ensureId(name, bad)),
    'ensureId, no pointer for a taken-over instance': msg(() => kill.ensureId(name, lost, false)),
    'ensureSpare, its id directory gone': msg(() => kill.ensureSpare(name, gone)),
    'aliasInstance, taken over with no pointer': msg(() => kill.aliasInstance(name, 'beta', rec)),
    'killAutoMerge, a pointer that cannot be used': msg(() => kill.killAutoMerge(name, bad)),
  };
}

test('#902 round 13: no id or kill-switch error tells an admin to retake a reserved name; each names its removal', () => {
  // policy-kill.ts imports only node's modules and system-paths (test/policy-edit.test.ts), so it holds its own copy of
  // the reserved names: the same as the engine's.
  assert.deepEqual([...((kill as { RESERVED_SINCE?: readonly string[] }).RESERVED_SINCE ?? [])].sort(), [...LATER_RESERVED].sort());
  for (const n of LATER_RESERVED) {
    for (const [what, m] of Object.entries(killMessages(n))) {
      assert.doesNotMatch(m, /--retake/, `${n}: ${what}: ${m}`);
      assert.match(m, new RegExp(`instance-remove\\.sh ${n} \\(`), `${n}: ${what}: ${m}`);
    }
    assert.doesNotMatch(ownCommand(n, '--retake'), /--retake/);
  }
  // Any other name keeps root's --retake.
  for (const [what, m] of Object.entries(killMessages('alpha'))) assert.match(m, /policy own alpha --retake/, `${what}: ${m}`);
});

test('#902 round 13: policy own\'s CHECK line never suggests --retake for a reserved name', { skip: linux }, () => {
  const me = process.getuid!();
  const T = realpathSync(mkdtempSync(join(tmpdir(), 'retake-check-')));
  const dir = join(T, 'home', 'wl-console', '.local', 'state', BRAND.cli, 'instances', 'console');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 80 }\nagents: { max_workers: 4 }\nland_mode: direct\nauto_merge: true\n', { mode: 0o600 });
  const deps: PolicyRootDeps = { home: (u) => (u === 'wl-console' ? join(T, 'home', 'wl-console') : null), uid: () => me, rootUid: me, rootGid: process.getgid!(), limitsPath: join(T, 'limits.json'), markerDir: join(T, 'markers') };
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  console.error = (...a: unknown[]) => void out.push(a.join(' '));
  setPolicyRootUid(me);
  let code: number;
  try {
    code = policyCommand('own', ['console', '--accept-loose'], deps, true);
  } finally {
    setPolicyRootUid(0);
    console.log = log;
    console.error = err;
  }
  assert.equal(code, 0, out.join('\n'));
  const check = out.find((l) => l.startsWith('CHECK: '));
  assert.ok(check, out.join('\n'));
  assert.doesNotMatch(check, /--retake/, check);
  assert.match(check, /policy set console <key> <value>/, check);
});

test('#902 round 13: backstop: the message builders name `policy own … --retake` only through the one builder', () => {
  const src = (f: string) => readFileSync(join(repoRoot, 'src', f), 'utf8');
  for (const f of ['policy-kill.ts', 'policy-root.ts', 'policy-gate.ts', 'doctor-policy-root.ts']) {
    const text = src(f);
    // A literal "policy own <instance> --retake" in a message, outside the builder itself.
    const literal = [...text.matchAll(/policy own \$\{[^}]+\} --retake/g)].map((m) => m[0]);
    assert.deepEqual(literal, f === 'policy-kill.ts' ? ['policy own ${instance} --retake'] : [], `${f}: ${literal.join(', ')}`);
  }
});
