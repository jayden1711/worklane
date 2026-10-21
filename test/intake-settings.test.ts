import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { CredentialsFile, credentialProblems } from '../src/instance.js';
import { loadIntakeConfig } from '../src/intake/config.js';
import { INTAKE_DEFAULT_CAPS, IntakeConfig } from '../src/intake/report.js';
import { changeSetting, currentValue, intakeCaps, loadLimits, settingsProblems } from '../src/settings.js';
import { exampleProject, repoRoot } from './helpers.js';

const cfg = loadConfig(exampleProject().dir);
const owner = cfg.project.owners.default;
const posix = typeof process.getuid === 'function';

function instance() {
  const d = mkdtempSync(join(tmpdir(), 'intake-settings-'));
  const policyPath = join(d, 'policy.yaml');
  writeFileSync(policyPath, 'version: 1\nbudget: { daily_usd: 50 }\n', { mode: 0o600 });
  return { d, policyPath, eventsDb: join(d, 'events.db'), limitsPath: join(d, 'limits.json') };
}

test('intake caps are instance settings: the instance wins, the intake config\'s values are the defaults, then the engine\'s', () => {
  assert.deepEqual(intakeCaps({}), INTAKE_DEFAULT_CAPS);
  const fromConfig = { reports_per_sender_per_day: 3, drafts_per_day: 7, max_usd_per_day: 1 };
  assert.deepEqual(intakeCaps({}, fromConfig), fromConfig);
  assert.deepEqual(intakeCaps({ intake: { drafts_per_day: 40 } }, fromConfig), { ...fromConfig, drafts_per_day: 40 });
  assert.equal(currentValue(cfg, {}, 'intake.drafts_per_day'), INTAKE_DEFAULT_CAPS.drafts_per_day);
});

test('changing an intake cap: owner only, bounded by the machine limits, recorded', () => {
  const i = instance();
  const base = { policyPath: i.policyPath, cfg, eventsDb: i.eventsDb, limitsPath: i.limitsPath };
  assert.throws(() => changeSetting({ ...base, key: 'intake.drafts_per_day', value: 30, by: 'someone-else' }), /only the owner/);
  assert.throws(() => changeSetting({ ...base, key: 'intake.drafts_per_day', value: 500, by: owner }), /intake\.drafts_per_day 500 is over 200/);
  assert.throws(() => changeSetting({ ...base, key: 'intake.reports_per_sender_per_day', value: 0, by: owner }), /refused/);
  // The dashboard only tightens (#726 round 11, the owner's decision of 2026-10-19); until then it raised this to 30.
  assert.throws(() => changeSetting({ ...base, key: 'intake.drafts_per_day', value: 30, by: owner }), /intake\.drafts_per_day 30 would loosen it \(now 20\)/);
  assert.deepEqual(changeSetting({ ...base, key: 'intake.drafts_per_day', value: 10, by: owner }), { from: INTAKE_DEFAULT_CAPS.drafts_per_day, to: 10 });
  assert.match(readFileSync(i.policyPath, 'utf8'), /drafts_per_day: 10/);
  writeFileSync(i.limitsPath, JSON.stringify({ intake: { max_usd_per_day: 1 } }));
  assert.deepEqual(settingsProblems({ intake: { max_usd_per_day: 5 } }, loadLimits(i.limitsPath)), ['intake.max_usd_per_day 5 is over 1 (machine limits)']);
});

test("Settings compares an intake cap with the one the engine applies: intake.yaml's beside policy.yaml, not the engine's defaults; one it can't load refuses all but a value policy.yaml sets (#726 round 12)", { skip: !posix && 'POSIX owners and modes' }, () => {
  // Through 72ead9a5 Settings compared with the defaults (10/20/2), so with intake.yaml at 5/3/1 it took 20/10/2.
  const i = instance();
  const base = { policyPath: i.policyPath, cfg, eventsDb: i.eventsDb, limitsPath: i.limitsPath, by: owner };
  const intake = join(i.d, 'intake.yaml');
  writeFileSync(intake, 'version: 1\ncaps: { drafts_per_day: 5, reports_per_sender_per_day: 3, max_usd_per_day: 1 }\n', { mode: 0o600 });
  assert.throws(() => changeSetting({ ...base, key: 'intake.drafts_per_day', value: 20 }), /intake\.drafts_per_day 20 would loosen it \(now 5\)/);
  assert.throws(() => changeSetting({ ...base, key: 'intake.reports_per_sender_per_day', value: 10 }), /reports_per_sender_per_day 10 would loosen it \(now 3\)/);
  assert.throws(() => changeSetting({ ...base, key: 'intake.max_usd_per_day', value: 2 }), /max_usd_per_day 2 would loosen it \(now 1\)/);
  assert.doesNotMatch(readFileSync(i.policyPath, 'utf8'), /intake/, 'nothing written');
  assert.deepEqual(changeSetting({ ...base, key: 'intake.drafts_per_day', value: 4 }), { from: 5, to: 4 });
  assert.deepEqual(changeSetting({ ...base, key: 'intake.reports_per_sender_per_day', value: 3 }), { from: 3, to: 3 });
  // intake.yaml there but not loadable: what applies can't be told, so nothing but a value policy.yaml sets changes.
  writeFileSync(intake, 'version: 1\ncaps: { drafts_per_day: 0 }\n');
  assert.throws(() => changeSetting({ ...base, key: 'intake.max_usd_per_day', value: 0.5 }), /intake\.max_usd_per_day 0\.5: .*intake\.yaml/);
  assert.deepEqual(changeSetting({ ...base, key: 'intake.drafts_per_day', value: 3 }), { from: 4, to: 3 }, "policy.yaml's own value wins over intake.yaml's: still a lowering");
  assert.throws(() => changeSetting({ ...base, key: 'intake.drafts_per_day', value: 4 }), /would loosen it \(now 3\)/);
});

test('intake credentials: files the coordinator holds, each checked to exist', () => {
  const c = CredentialsFile.parse({
    version: 1,
    github: { kind: 'gh-config-dir', path: '/nonexistent/gh' },
    intake: { discord_token: '/nonexistent/discord-token' },
  });
  assert.ok(credentialProblems(c).some((p) => p.includes('chat bot token')));
});

test('intake.yaml: absent means off; only its owner may change it; invalid is refused', { skip: !posix && 'POSIX owners and modes' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'intake-cfg-'));
  const p = join(d, 'intake.yaml');
  assert.equal(loadIntakeConfig(p), null);
  writeFileSync(p, 'version: 1\ntrusted: { discord: ["222222"] }\ndiscord: { enabled: true, guild: "555555", channels: ["111111"], allowed_senders: ["222222"] }\n', { mode: 0o600 });
  const ok = loadIntakeConfig(p) as { config: { trusted: { discord: string[] }; discord: { enabled: boolean; guild: string } } };
  assert.deepEqual([ok.config.trusted.discord, ok.config.discord.enabled, ok.config.discord.guild], [['222222'], true, '555555']);
  chmodSync(p, 0o620);
  assert.match((loadIntakeConfig(p) as { error: string }).error, /writable by its group or others/);
  chmodSync(p, 0o600);
  writeFileSync(p, 'version: 1\ntrusted: { discord: ["sam"] }\n');
  assert.match((loadIntakeConfig(p) as { error: string }).error, /Discord user id/);  writeFileSync(p, 'version: 1\ntrusted: { discord: ["222222"] }\n');
  assert.match((loadIntakeConfig(p) as { error: string }).error, /222222 is trusted but not in discord.allowed_senders/, 'a trusted sender who is not allowed is refused at start-up (#150)');
  writeFileSync(p, 'version: 1\ndiscord: { enabled: true, guild: "555555" }\n');
  assert.deepEqual((loadIntakeConfig(p) as { warnings: string[] }).warnings, ['discord is on but discord.allowed_senders is empty: no Discord message will be accepted']);
});

test('intake.yaml: Discord needs its one server id when enabled; every source is off by default', () => {
  assert.equal(IntakeConfig.safeParse({ version: 1, discord: { enabled: true, channels: ['111111'] } }).success, false);
  assert.equal(IntakeConfig.safeParse({ version: 1, discord: { enabled: true, guild: '555555', channels: ['111111'] } }).success, true);
  assert.equal(IntakeConfig.safeParse({ version: 1, discord: { enabled: false } }).success, true, 'no server id needed while off');
  const d = IntakeConfig.parse({ version: 1 });
  assert.deepEqual([d.discord.enabled, d['bug-store'].enabled], [false, false]);
});

test('intake config and credentials are strict: text-message (SMS) settings and DMs are refused, not ignored', () => {
  assert.equal(IntakeConfig.safeParse({ version: 1, sms: { enabled: true } }).success, false, 'an sms block');
  assert.equal(IntakeConfig.safeParse({ version: 1, trusted: { sms: ['+15550001111'] } }).success, false, 'trusted sms senders');
  assert.equal(IntakeConfig.safeParse({ version: 1, discord: { enabled: true, guild: '555555', dms: true } }).success, false, 'the dms option');
  assert.equal(CredentialsFile.safeParse({ version: 1, github: { kind: 'gh-config-dir', path: '/x' }, intake: { relay_secret: '/x' } }).success, false, 'a relay secret');
});

test('credentials.sh installs each intake secret for the coordinator user only, 0400, never echoing it', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'credentials.sh'), 'utf8');
  assert.ok(s.includes('  intake-discord)'));
  assert.deepEqual(s.match(/^  intake-[a-z]+\)/gm), ['  intake-discord)', '  intake-slack)', '  intake-linear)'], 'the chat bot, the Slack app and the Linear key are the intake credentials');
  assert.match(s, /install_secret\(\) \{[\s\S]*?sudo -u "\$coord"[\s\S]*?chmod 0400/);
  for (const v of ['token', 'secret', 'app', 'bot', 'key']) assert.doesNotMatch(s, new RegExp(`echo[^\\n]*\\$${v}\\b`), `never echoes $${v}`);
  assert.equal((s.match(/read -rsp/g) ?? []).length >= 3, true, 'secrets are read without echo');
});
