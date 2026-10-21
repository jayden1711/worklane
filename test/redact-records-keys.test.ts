// #889 round 2 (owner's decisions and the final check): dashboard keys carry a prefix the shared redactor always
// finds; gh-login, the bench and the root updater redact through the shared redactor (its broad rules for what they
// masked on their own), with no exception list; the dashboard's journal view redacts its entries as one text and
// before it cuts; a shape glued to a name after `_`, and a lowercase bearer, are found.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as redactModule from '../src/events/redact.js';
import { redactString, REDACTION_PATTERNS } from '../src/events/redact.js';
import { EventLog } from '../src/events/log.js';
import { FileBacklog } from '../src/backlog/file.js';
import { buildDigest } from '../src/superfan/digest.js';
import { redactPii } from '../src/intake/redact.js';
import { postText, scrub } from '../src/watchdog/post.js';
import type { Incident } from '../src/watchdog/incidents.js';
import { mergePostText } from '../src/merge-posts.js';
import { mainWatchPost } from '../src/intake/channel.js';
import { readServiceLog, startDashboard } from '../src/dashboard.js';
import * as doctorModule from '../src/doctor.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { loadConfig } from '../src/config/load.js';
import { safeLine } from '../src/gh-login.js';
import { scrub as benchScrub } from '../scripts/bench/cli.js';
import { BRAND } from '../src/brand.js';
import { exampleProject, exampleRoles, repoRoot } from './helpers.js';
import { leaks, run, SHAPES, type StandIn } from './token-standins.js';

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
/** The root updater's redactor (scripts/machine/<cli>-update.cjs), loaded as the updater is. */
const updater = createRequire(import.meta.url)(join(repoRoot, 'scripts', 'machine', `${BRAND.cli}-update.cjs`)) as { redact(text: string): string; redactDeep(v: unknown): unknown };
/** Each stand-in in a log line, and as an environment assignment. */
const lines = (s: StandIn) => [`deploy failed: ${s.value} (exit 1)`, `error: env had TOKEN=${s.value}; giving up`];
/** The stand-ins whose secret part survives `out(s)`, every miss listed. */
const survivors = async (out: (text: string) => string | Promise<string>) => {
  const missed: string[] = [];
  for (const s of SHAPES) for (const l of lines(s)) if (leaks(await out(l), s.secret)) missed.push(`${s.what} in "${l.slice(0, 18)}…"`);
  return missed;
};
/** The production composition the coordinator hands the digest and the merge posts (src/coordinator.ts, src/coordinator/superfan.ts). */
const coordinatorRedact = (s: string) => scrub(redactPii(s, { names: [], patterns: [] }));
const pem = () => SHAPES.find((s) => s.kind === 'private key')!;

test('dashboard: a private key logged one journal entry per line is redacted whole, and the entries around it stay', () => {
  const msgs = ['starting', ...pem().value.split('\n'), 'done'];
  const journal = () => ({ status: 0, stderr: '', stdout: msgs.map((m, i) => JSON.stringify({ MESSAGE: m, PRIORITY: '6', __REALTIME_TIMESTAMP: String(1_767_225_600_000_000 + i) })).join('\n') });
  const shown = readServiceLog({ unit: 'coordinator.service', file: null }, 10, journal).entries.map((e) => e.message);
  assert.ok(!leaks(JSON.stringify(shown), pem().secret), JSON.stringify(shown));
  assert.deepEqual([shown[0], shown.at(-1)], ['starting', 'done']);
});

test('dashboard: a private key on one long journal line (over the 2,000-character cut) is redacted before it is cut', () => {
  const body = run(3000);
  const key = JSON.stringify(['-----BEGIN RSA PRIVATE KEY-----', body, '-----END RSA PRIVATE KEY-----'].join('\n'));
  const journal = () => ({ status: 0, stderr: '', stdout: JSON.stringify({ MESSAGE: `config: ${key}`, PRIORITY: '3', __REALTIME_TIMESTAMP: '1767225600000000' }) });
  const shown = JSON.stringify(readServiceLog({ unit: 'coordinator.service', file: null }, 10, journal).entries);
  assert.ok(!leaks(shown, body), shown.slice(0, 300));
  assert.ok(!leaks(redactString(`config: ${key}`), body), 'and redactString alone');
});

test('redactRecords: records come back as many as went in, each with its own lines; a key over several is found', () => {
  const records = ['a', 'b\nc', ...pem().value.split('\n'), 'd'];
  assert.equal(typeof redactModule.redactRecords, 'function', 'the shared redactor redacts records as one text');
  const out = redactModule.redactRecords(records);
  assert.equal(out.length, records.length);
  assert.deepEqual([out[0], out[1], out.at(-1)], ['a', 'b\nc', 'd']);
  assert.ok(!leaks(out.join('\n'), pem().secret));
});

test('the shapes are found after an underscore too (`MY_<token>`), and a lowercase bearer', () => {
  const missed: string[] = [];
  for (const s of SHAPES.filter((x) => x.token)) {
    for (const before of ['x_', 'MY_TOKEN_', 'a_b_']) if (leaks(redactString(`${before}${s.value} end`), s.secret)) missed.push(`${s.what} after ${before}`);
  }
  assert.deepEqual(missed, []);
  for (const scheme of ['bearer', 'BEARER', 'Bearer']) assert.equal(redactString(`authorization: ${scheme} ${run(40)}`), `authorization: ${scheme} [REDACTED]`);
  // Ordinary snake_case and the like are left alone.
  for (const s of ['my_sk-ish_name', 'the_0x_prefix', 'a_eyJ_note', 'config_AKIA_note', 'auth_bearer_header']) assert.equal(redactString(s), s);
});

test('gh-login, the bench and the root updater: no stand-in survives their own output (each goes through the shared redactor)', async () => {
  assert.deepEqual(await survivors((t) => safeLine(t)), [], "gh's output line on the dashboard");
  assert.deepEqual(await survivors((t) => benchScrub(t, {})), [], "the bench's printed line");
  assert.deepEqual(await survivors((t) => JSON.stringify(updater.redactDeep({ reason: t }))), [], "the updater's log line");
});

/**
 * What each module's own rules masked before #889 (gh-login's TOKENISH, the bench's TOKEN_SHAPE, the updater's
 * redact()): a token cut short, a clone URL's user info, a value after a secret's name, a short bearer token. Each
 * module masks the same now, through the shared redactor's broad rules, as its own mask word.
 */
// check-table: never-shrink
const CUT_SHORT: [string, string, string][] = [
  ['a GitHub token of 8', `error: ${'gho'}_${run(8)} rejected`, run(8)],
  ['a fine-grained token of 16', `x ${'github'}_pat_11${run(14)} y`, run(14)],
  ['an Anthropic key of 3', `key ${'sk'}-ant-${run(3, 'Qz9')} rejected`, `-ant-${run(3, 'Qz9')}`],
  ['a Slack token of 2', `with ${'xoxb'}-${run(2, 'Z9')} now`, `-${run(2, 'Z9')} now`],
  ['a JWT after a hyphen', `x-eyJ${run(10)}.${run(10, 'pQ7')}.${run(10, 'mN4')} y`, run(10, 'mN4')],
  ['a short bearer token', `Authorization: bearer ${run(10, 'bR5')}`, run(10, 'bR5')],
  ['a clone URL with user info', `https://someone:${run(12, 'hT2')}@git.example.test/x.git`, run(12, 'hT2')],
  ['a value after a secret name', `GH_TOKEN=${run(12, 'vW3')} failed`, run(12, 'vW3')],
];

test("the broad rules: what gh-login, the bench and the updater masked on their own is masked through the shared redactor, as each one's word", () => {
  const missed: string[] = [];
  for (const [what, text, secret] of CUT_SHORT) {
    const outs: [string, string][] = [
      ['redactString broad', redactString(text, { broad: true } as Parameters<typeof redactString>[1])],
      ['the bench', benchScrub(text, {})],
      ['the updater', updater.redact(text)],
    ];
    if (what.startsWith('a GitHub') || what.startsWith('a fine-grained')) outs.push(['gh-login', safeLine(text)]);
    for (const [who, out] of outs) if (out.includes(secret)) missed.push(`${what} via ${who}: ${out}`);
  }
  assert.deepEqual(missed, []);
  // Each one's own word, as before.
  assert.equal(safeLine(CUT_SHORT[0]![1]), 'error: [hidden] rejected');
  assert.match(updater.redact(CUT_SHORT[6]![1]), /^https:\/\/\[redacted\]@git\.example\.test/);
  assert.match(benchScrub(CUT_SHORT[2]![1], {}), /^key \[redacted\] rejected$/);
  // A mask with a `$` in it is taken literally.
  assert.equal(redactString(`token=${run(12)}`, { broad: true, mask: '[$1]' } as Parameters<typeof redactString>[1]), 'token=[$1]');
});

test('the broad rules are off by default: ordinary text with secret words in it is left as it was', () => {
  for (const s of ['the token: see docs/auth.md', 'password reset, then sign in at https://example.test/login', 'bearer of bad news']) assert.equal(redactString(s), s);
});

/** A dashboard on a scratch state dir; `key`: a key file written first. */
async function dashboard(key?: string) {
  const dir = scratch('dash-key-');
  const { dir: root } = exampleProject();
  const web = scratch('dash-key-web-');
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>ok</title>');
  const db = join(dir, 'events.db');
  new EventLog(db).close();
  if (key !== undefined) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'dashboard-token'), key, { mode: 0o600 });
  }
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, webDir: web, pollMs: 50, slotsDir: join(dir, 'slots') });
  return { d, file: join(dir, 'state', 'dashboard-token') };
}

test('dashboard keys: a new key has the prefix and is redacted in every output path; a commit hash, a digest or an id is not', async () => {
  const { d } = await dashboard();
  try {
    assert.match(d.token, /^wld_[A-Za-z0-9_-]{32}$/, 'a new key: wld_ and 32 base64url characters');
    assert.equal(readFileSync(d.keyFile, 'utf8').trim(), d.token);
    assert.equal((await fetch(`${d.url}/api/role`, { headers: { authorization: `Bearer ${d.token}` } })).status, 200);
    // The real key, standing alone, through every path the stand-ins go through.
    const key: StandIn = { kind: 'dashboard key', what: 'the new key', value: d.token, secret: d.token, token: true };
    const missed: string[] = [];
    const log = new EventLog(':memory:');
    const f = new FileBacklog(join(scratch('bl-'), 'b.json'), 'harness');
    const n = f.open({ title: 'x', body: '', author: 'a' });
    const incident = (detail: string): Incident => ({ id: 'i1', kind: 'k', key: 'k', instance: 'alpha', severity: 'red', title: 'T', detail, fix: 'F', tried: [], since: '2026-02-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z', resolvedAt: null, posted: {} });
    const file = join(scratch('svc-log-'), 'c.log');
    const paths: [string, (t: string) => string | Promise<string>][] = [
      ['redactString', (t) => redactString(t)],
      ['events', (t) => JSON.stringify(log.append('coordinator.error', { instance: 'a', where: 'w', kind: 'error', message: t }, 'c').payload)],
      ['comments', async (t) => (await f.comment(n, t), JSON.stringify((await f.comments(n)).at(-1)))],
      ['digest', (t) => buildDigest({ journal: { entries: [{ at: '2026-02-01T00:00:00.000Z', priority: 3, message: t }], problem: null } }, { since: '2026-01-01T00:00:00.000Z', eventId: 0, open: null, health: null }, new Date('2026-02-02T00:00:00.000Z'), coordinatorRedact).items[0]!.line],
      ['incident post', (t) => postText(incident(t), 'raised')],
      ['merge post', (t) => mergePostText({ number: 7, url: 'https://github.com/o/r/pull/7', title: 'T', body: t, mergedAt: null, mergeCommit: null, mergedBy: 'ada', base: 'main' }, 'a3f1c9e0b2d4', coordinatorRedact)],
      ['chat notice', (t) => mainWatchPost({ sha: 'a3f1c9e0b2d4', url: 'https://github.com/o/r/commit/a3f1c9e0b2d4', reason: t, revert: null, no_revert: null }, { dashboardUrl: 'https://dash.example.test' }).text],
      ['service log', (t) => (writeFileSync(file, `${t}\n`), JSON.stringify(readServiceLog({ unit: null, file }, 10).entries))],
      ['gh-login', (t) => safeLine(t)],
      ['bench', (t) => benchScrub(t, {})],
      ['updater', (t) => updater.redact(t)],
    ];
    for (const [name, out] of paths) for (const l of lines(key)) if (leaks(await out(l), key.secret)) missed.push(`${name}: ${l.slice(0, 14)}…`);
    assert.deepEqual(missed, []);
  } finally {
    await d.close();
  }
  // Not redacted: a 32-character hex hash (an MD5, an engine id), a commit sha, a sha256 digest, a UUID.
  for (const v of ['a3f1c9e0b2d4f6a8'.repeat(2), 'a3f1c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2', '7e9b5d3c1f0a2468'.repeat(4), '123e4567-e89b-12d3-a456-426614174000']) {
    assert.equal(redactString(`commit ${v} built`), `commit ${v} built`, v);
  }
});

test('dashboard keys: an older key (no prefix) keeps opening the dashboard and is not rewritten', async () => {
  const old = run(32, 'Ol9dKeyX_-');
  const { d, file } = await dashboard(old);
  try {
    assert.equal(d.token, old);
    assert.equal((await fetch(`${d.url}/api/role`, { headers: { authorization: `Bearer ${old}` } })).status, 200, 'the older key still opens it');
    assert.equal((await fetch(`${d.url}/api/role`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal(readFileSync(file, 'utf8'), old, 'the file is left as it was');
  } finally {
    await d.close();
  }
});

test('doctor: an older dashboard key asks for rotation; a new one is fine; none, nothing; the key is never shown', () => {
  const check = doctorModule.dashboardKeyCheck;
  assert.equal(typeof check, 'function', 'doctor has a dashboard key check');
  const dir = scratch('doctor-key-');
  const old = run(32, 'Ol9dKeyX_-');
  writeFileSync(join(dir, 'old'), `${old}\n`);
  writeFileSync(join(dir, 'new'), `wld_${run(32, 'Nw8-k_')}`);
  const warned = check(join(dir, 'old'), 'local')!;
  assert.equal(warned.level, 'warn');
  assert.match(warned.detail, /older format[\s\S]*Rotate it/);
  assert.ok(!warned.detail.includes(old), 'the key is not shown');
  assert.equal(check(join(dir, 'new'), 'local')!.level, 'ok');
  assert.equal(check(join(dir, 'none'), 'local'), null);
  // In doctor's own run, for the project's local dashboard.
  const { dir: root } = exampleProject();
  const state = projectStateDir(root);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'dashboard-token'), old, { mode: 0o600 });
  const all = doctorModule.doctor(root);
  assert.equal(all.find((c) => c.name === 'dashboard key local')?.level, 'warn');
  assert.ok(!JSON.stringify(all).includes(old), 'doctor never prints the key');
});

test('the dashboard-key and broad patterns, the underscore pass and redactRecords run in linear time on hostile input', () => {
  const N = 100_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length));
  const hostile = [fill('a-'), fill('a.'), fill('-a'), fill('wld_'), fill('wld_a-'), fill('-wld_'), fill('eyJ-'), fill('x-eyJaaaaaaaaa.'), fill('a+'), fill('a://'), fill('a:/'), fill('token'), fill('token='), fill('token="'), fill(' token'), fill('bearer '), fill('ghp_'), fill('-ghp_a'), fill('sk-ant-'), fill('xoxb-'), fill('_ghp_'), fill('x_sk-'), fill('_'), fill('a_b'), fill('_Bearer ')];
  const slow: string[] = [];
  const patterns = REDACTION_PATTERNS.filter((p) => p.kind === 'dashboard key' || p.group === 'broad');
  assert.ok(patterns.length >= 1 + 7, `the dashboard-key pattern and the broad rules are in the shared redactor (${patterns.length})`);
  const time = (what: string, f: () => unknown, ms = 300) => {
    const t0 = performance.now();
    f();
    const took = performance.now() - t0;
    if (took > ms) slow.push(`${what}: ${Math.round(took)} ms`);
  };
  for (const { kind, re, rep } of patterns) for (const s of hostile) time(`${kind} on ${s.slice(0, 12)}…`, () => (typeof rep === 'string' ? s.replace(re, rep) : s.replace(re, rep)));
  // The whole redactor, the underscore pass and the broad rules included, and records joined as one text.
  for (const s of [fill('_ghp_'), fill('x_sk-'), fill('a_'), fill('_eyJ.')]) time(`redactString on ${s.slice(0, 12)}…`, () => redactString(s, { broad: true } as Parameters<typeof redactString>[1]), 1500);
  time('redactRecords on 20,000 records', () => redactModule.redactRecords?.(Array.from({ length: 20_000 }, (_, i) => `line ${i} -----BEGIN`)), 1500);
  assert.deepEqual(slow, []);
});
