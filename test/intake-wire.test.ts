// Intake per instance, off by default (src/intake/wire.ts): no intake.yaml, no intake; Discord off or no token,
// no connection; each instance reads only its own home. Discord is a fake socket; nothing reaches the network.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from '../src/intake/discord.js';
import { intakeForInstance } from '../src/intake/wire.js';

const OWNER_ID = '100000000001';
const yaml = (o: { enabled: boolean; people?: boolean }) =>
  `version: 1\ndiscord:\n  enabled: ${o.enabled}\n  guild: "555555"\n  channels: ["111111"]\n  allowed_senders: ["${OWNER_ID}"]\n${o.people ? `  people: { "${OWNER_ID}": example-owner }\n` : ''}`;

function home(intake?: string) {
  const h = mkdtempSync(join(tmpdir(), 'wire-'));
  if (intake !== undefined) writeFileSync(join(h, 'intake.yaml'), intake, { mode: 0o600 });
  const token = join(h, 'discord-token');
  writeFileSync(token, 'placeholder-token\n', { mode: 0o400 });
  return { h, token };
}

/** Counts every connection the adapter would open, and every request it would send. */
function fakes() {
  const seen = { connects: 0, requests: 0 };
  const socket: Socket = { send: () => {}, close: () => {}, addEventListener: () => {} };
  return { seen, discord: { connect: () => (seen.connects++, socket), fetch: (async () => (seen.requests++, { ok: true })) as unknown as typeof fetch, setInterval: () => 1, clearInterval: () => {} } };
}

const quiet = () => {};
const github = async () => 'unused';

test('intake wiring: an instance without intake.yaml has no intake at all, and opens no connection', () => {
  const { h, token } = home();
  const f = fakes();
  assert.equal(intakeForInstance({ home: h, repo: 'example/shop', tokenFile: token, githubToken: github, discord: f.discord, log: quiet }), null);
  assert.deepEqual(f.seen, { connects: 0, requests: 0 });
});

test('intake wiring: Discord off, or no token, means no Discord source and no connection', () => {
  for (const [name, intake, withToken] of [['discord off', yaml({ enabled: false, people: true }), true], ['no token', yaml({ enabled: true, people: true }), false]] as const) {
    const { h, token } = home(intake);
    const f = fakes();
    const w = intakeForInstance({ home: h, repo: 'example/shop', tokenFile: withToken ? token : undefined, githubToken: github, discord: f.discord, log: quiet })!;
    assert.deepEqual(w.sources, [], `${name}: no source`);
    assert.deepEqual(f.seen, { connects: 0, requests: 0 }, `${name}: nothing opened or sent`);
  }
});

test("intake wiring: an instance reads only its own home's config and mapping", () => {
  const a = home(yaml({ enabled: true, people: true }));
  const b = home(yaml({ enabled: true }));
  const f = fakes();
  const wa = intakeForInstance({ home: a.h, repo: 'example/shop', tokenFile: a.token, githubToken: github, discord: f.discord, log: quiet })!;
  const wb = intakeForInstance({ home: b.h, repo: 'example/other', tokenFile: b.token, githubToken: github, discord: f.discord, log: quiet })!;
  assert.deepEqual(wa.config()!.discord.people, { [OWNER_ID]: 'example-owner' });
  assert.deepEqual(wb.config()!.discord.people, {}, "B doesn't get A's mapping");
  assert.ok(wa.roleOf, 'A looks roles up in its own repo');
  assert.equal(wb.roleOf, undefined, 'B, with no mapping, has no one to look up');
  assert.equal(wa.sources[0]!.name, 'discord');
  wa.stop();
  wb.stop();
});

test('intake wiring: a config that is refused leaves intake off', { skip: typeof process.getuid !== 'function' && 'POSIX modes' }, () => {
  const { h, token } = home(yaml({ enabled: true, people: true }));
  chmodSync(join(h, 'intake.yaml'), 0o644);
  const said: string[] = [];
  const f = fakes();
  assert.equal(intakeForInstance({ home: h, repo: 'example/shop', tokenFile: token, githubToken: github, discord: f.discord, log: (l) => said.push(l) }), null);
  assert.match(said.join('\n'), /intake off: .*readable by its group or others/);
  assert.deepEqual(f.seen, { connects: 0, requests: 0 });
});
