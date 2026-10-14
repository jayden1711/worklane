// `intake check` (src/intake/check.ts) and doctor's intake line: an instance's intake.yaml is validated with the
// coordinator's own loader, on demand. Valid: what is on, and nothing else from the file. Invalid: every schema
// error with its path, exit 1 (doctor: a failing line). No file: intake is off, exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { doctor } from '../src/doctor.js';
import { checkIntakeFile, intakeCheckCommand } from '../src/intake/check.js';
import { loadIntakeConfig } from '../src/intake/config.js';
import { exampleProject } from './helpers.js';

const SENDER = '200000000000000001';
const VALID = `version: 1
trusted: { discord: ["${SENDER}"], github: [example-maintainer] }
discord:
  enabled: true
  guild: "900000000000000001"
  channels: ["100000000000000001", "100000000000000002"]
  allowed_senders: ["${SENDER}"]
  people: { "${SENDER}": example-owner }
superfan: { enabled: true, channel: "100000000000000005" }
github: { enabled: true }
`;
// Three mistakes at once: a superfan with no channel, a field of the wrong type, and a key that doesn't exist.
const BROKEN = `version: 1
discord: { enabled: true, guild: "900000000000000001", channels: ["100000000000000001"], allowed_senders: ["${SENDER}"] }
superfan: { enabled: true }
github: { enabled: true, poll_minutes: often }
supefan: { enabled: true }
`;

/** An instances dir holding the named instances; `intake` is written (owner-only) into the first one's home. */
function instances(intake?: string, names = ['shop']) {
  const dir = mkdtempSync(join(tmpdir(), 'intake-check-'));
  for (const n of names) {
    mkdirSync(join(dir, n));
    writeFileSync(join(dir, n, 'instance.yaml'), `version: 1\nname: ${n}\nrepos: [{ path: ./repo, repo: example-org/example-shop }]\n`);
  }
  const file = join(dir, names[0]!, 'intake.yaml');
  if (intake !== undefined) writeFileSync(file, intake, { mode: 0o600 });
  return { dir, file };
}

function run(o: { dir: string; instance?: string }) {
  const out: string[] = [];
  const err: string[] = [];
  const code = intakeCheckCommand({ ...o, out: (l) => void out.push(l), err: (l) => void err.push(l) });
  return { code, out, err };
}

test('intake check: a valid file prints "valid" and what is on, and nothing else from the file', () => {
  const { dir, file } = instances(VALID);
  const r = run({ dir });
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, [`${file}: valid`, 'discord: on, 2 channels', 'superfan: on, channel 100000000000000005', 'github: on']);
  assert.deepEqual(r.err, []);
  // INVARIANT: who is who (sender ids, logins) and the server id stay in the file.
  for (const secret of [SENDER, 'example-owner', 'example-maintainer', '900000000000000001']) assert.ok(!r.out.join('\n').includes(secret), secret);

  // Sources off, and a warning the loader gives (Discord on, nobody allowed), named by --instance.
  writeFileSync(file, 'version: 1\n', { mode: 0o600 });
  assert.deepEqual(run({ dir, instance: 'shop' }).out.slice(1), ['discord: off', 'superfan: off', 'github: off']);
  writeFileSync(file, 'version: 1\ndiscord: { enabled: true, guild: "900000000000000001", channels: ["100000000000000001"] }\n', { mode: 0o600 });
  const w = run({ dir, instance: 'shop' });
  assert.equal(w.code, 0);
  assert.deepEqual(w.out.slice(1), ['discord: on, 1 channel', 'superfan: off', 'github: off', 'warning: discord is on but discord.allowed_senders is empty: no Discord message will be accepted']);
});

test('intake check: an invalid file prints every schema error with its path and exits 1', () => {
  const { dir, file } = instances(BROKEN);
  const r = run({ dir });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, [], 'never "valid"');
  assert.equal(r.err[0], `${file}: invalid; intake is off until it is fixed`);
  const errors = r.err.slice(1);
  assert.equal(errors.length, 3, errors.join('\n'));
  assert.ok(errors.some((e) => /^ {2}superfan\.channel: superfan\.channel is required when superfan is enabled$/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /^ {2}github\.poll_minutes: /.test(e)), errors.join('\n'));
  // An unknown top-level key has no path of its own: it is said to be at the top level, and named.
  assert.ok(errors.some((e) => /^ {2}\(top level\): .*supefan/.test(e)), errors.join('\n'));
  // The loader's one-line refusal (the coordinator's "intake off: ..." line) is the same errors, joined.
  const loaded = loadIntakeConfig(file) as { error: string; errors: string[] };
  assert.equal(loaded.error, `${file} is invalid: ${loaded.errors.join('; ')}`);
  assert.deepEqual(errors.map((e) => e.trim()), loaded.errors);

  // Not YAML at all: one error, still exit 1.
  writeFileSync(file, 'discord: [unclosed\n', { mode: 0o600 });
  const y = run({ dir });
  assert.equal(y.code, 1);
  assert.match(y.err[1]!, /^ {2}is not valid YAML: /);
});

test('intake check: no file says intake is off and exits 0; the instance is picked as `discord channels` picks it', () => {
  const { dir, file } = instances();
  const r = run({ dir });
  assert.deepEqual([r.code, r.out, r.err], [0, [`no ${file}: intake is off`], []]);

  // A mistyped name is an error, never "intake is off".
  const typo = run({ dir, instance: 'shpo' });
  assert.equal(typo.code, 1);
  assert.match(typo.err[0]!, /^no instance shpo here/);
  const two = instances(VALID, ['shop', 'yard']);
  const many = run({ dir: two.dir });
  assert.equal(many.code, 1);
  assert.match(many.err[0]!, /more than one instance here \(shop, yard\); pass --instance <name>/);
  assert.equal(run({ dir: two.dir, instance: 'yard' }).out[0], `no ${join(two.dir, 'yard', 'intake.yaml')}: intake is off`);
  const none = run({ dir: mkdtempSync(join(tmpdir(), 'intake-check-none-')) });
  assert.equal(none.code, 1);
  assert.match(none.err[0]!, /^no instance here/);
});

test('intake check: a file that cannot be read is invalid, never "off"', { skip: (typeof process.getuid !== 'function' || process.getuid() === 0) && 'POSIX modes, and not root' }, () => {
  const { dir, file } = instances(VALID);
  chmodSync(file, 0o000);
  const c = checkIntakeFile(file);
  assert.equal(c.state, 'invalid');
  assert.match((c as { errors: string[] }).errors[0]!, /^can't be read from this user \(EACCES\); run this as the instance's user$/);
  assert.equal(run({ dir }).code, 1);
});

test("doctor: the instance's intake.yaml is a failing line when invalid, ok when valid or absent", (t) => {
  const { dir: root } = exampleProject();
  const { dir, file } = instances(BROKEN);
  writeFileSync(join(dir, 'shop', 'instance.yaml'), `version: 1\nname: shop\nrepos:\n  - path: ${JSON.stringify(root)}\n    repo: example-org/example-shop\n`);
  const key = `${BRAND.envPrefix}_INSTANCES_DIR`;
  const before = process.env[key];
  process.env[key] = dir;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
  // The instance is found through the repo it runs, with no --instance.
  const line = () => doctor(root).find((c) => c.name === 'intake shop');
  const bad = line();
  assert.equal(bad?.level, 'fail');
  assert.match(bad!.detail, /intake\.yaml is invalid, so intake is off until it is fixed/);
  assert.match(bad!.detail, /\nsuperfan\.channel: superfan\.channel is required when superfan is enabled/);
  assert.match(bad!.detail, /\ngithub\.poll_minutes: /);
  assert.ok(bad!.detail.includes(`${BRAND.cli} intake check --instance shop`));

  writeFileSync(file, VALID, { mode: 0o600 });
  assert.deepEqual(line(), { name: 'intake shop', level: 'ok', detail: 'intake.yaml valid: discord: on, 2 channels; superfan: on, channel 100000000000000005; github: on' });
  writeFileSync(file, 'version: 1\ndiscord: { enabled: true, guild: "900000000000000001" }\n', { mode: 0o600 });
  assert.equal(line()?.level, 'warn');
  rmSync(file);
  assert.deepEqual(line(), { name: 'intake shop', level: 'ok', detail: 'no intake.yaml in the instance home: intake is off' });
});
