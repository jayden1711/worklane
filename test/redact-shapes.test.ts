// #889: one shared redactor (src/events/redact.ts) knows every credential shape the engine handles, and every output
// path redacts through it. Each stand-in in test/token-standins.ts goes through redactString, and through each path
// that stores or sends text: the event log, issue comments (file and GitHub backlogs), the superfan's digest,
// the notifications (an incident post, a merge post, a chat notice) and the dashboard's service-log view.
// Round 2 (dashboard keys, the broad rules, the journal view, glued shapes): test/redact-records-keys.test.ts.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString, REDACTION_PATTERNS, secretKinds } from '../src/events/redact.js';
import { EventLog } from '../src/events/log.js';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog } from '../src/backlog/github.js';
import { budgetFor } from '../src/github/budget.js';
import { buildDigest } from '../src/superfan/digest.js';
import { redactPii } from '../src/intake/redact.js';
import { postText, scrub } from '../src/watchdog/post.js';
import type { Incident } from '../src/watchdog/incidents.js';
import { mergePostText } from '../src/merge-posts.js';
import { mainWatchPost } from '../src/intake/channel.js';
import { readServiceLog } from '../src/dashboard.js';
import { leaks, SHAPES, type StandIn } from './token-standins.js';

const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));
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

test('every secret pattern of the shared redactor has a stand-in, and secretKinds names each stand-in by its kind', () => {
  const kinds = [...new Set(REDACTION_PATTERNS.filter((p) => p.group === 'secret').map((p) => p.kind))];
  assert.deepEqual(kinds.filter((k) => !SHAPES.some((s) => s.kind === k)), [], 'add a stand-in to test/token-standins.ts for each new pattern');
  assert.deepEqual(SHAPES.filter((s) => !secretKinds(s.value).includes(s.kind)).map((s) => s.what), []);
  for (const k of ['GitHub token', 'API key (sk-)', 'Discord bot token', 'Slack token', 'Slack app-level token', 'Slack webhook', 'Linear key', 'Tailscale key', 'dashboard key']) {
    assert.ok(kinds.includes(k), `the shared redactor knows ${k}`);
  }
});

test('redactString: no stand-in survives, Discord included', async () => {
  assert.deepEqual(await survivors((t) => redactString(t)), []);
});

test('redactString: a Discord bot token right after an underscore, a hyphen, an = or a quote is redacted too', () => {
  const { value } = SHAPES.find((s) => s.kind === 'Discord bot token')!;
  for (const before of ['x_', 'x-', 'DISCORD_TOKEN=', '"', 'Bot ']) assert.equal(redactString(`${before}${value} ok`), `${before}[REDACTED] ok`);
});

test('events: no stand-in survives into the event log', async () => {
  const log = new EventLog(':memory:');
  assert.deepEqual(
    await survivors((t) => {
      const e = log.append('coordinator.error', { instance: 'alpha', where: 'deploy', kind: 'error', message: t }, 'coordinator');
      return JSON.stringify([e.payload, log.read(e.id - 1)]);
    }),
    [],
  );
});

test('comments: no stand-in survives into an issue comment on the file backlog', async () => {
  const f = new FileBacklog(join(scratch('bl-'), 'b.json'), 'harness');
  const n = f.open({ title: 'x', body: '', author: 'a' });
  assert.deepEqual(
    await survivors(async (t) => {
      await f.comment(n, t);
      return JSON.stringify((await f.comments(n)).at(-1));
    }),
    [],
  );
});

test('comments: no stand-in survives into an issue comment sent to GitHub', async () => {
  const sent: string[] = [];
  const capture = (async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }) as typeof fetch;
  const slots = scratch('slots-');
  const gh = new GitHubBacklog('o/r', () => 't', capture, undefined, (tk) => budgetFor(tk, slots));
  assert.deepEqual(
    await survivors(async (t) => {
      await gh.comment(1, t);
      return sent.at(-1)!;
    }),
    [],
  );
});

test("digest: no stand-in survives into the superfan's digest", async () => {
  const cursor = { since: '2026-01-01T00:00:00.000Z', eventId: 0, open: null, health: null };
  assert.deepEqual(
    await survivors((t) => {
      const d = buildDigest({ journal: { entries: [{ at: '2026-02-01T00:00:00.000Z', priority: 3, message: t }], problem: null } }, cursor, new Date('2026-02-02T00:00:00.000Z'), coordinatorRedact);
      assert.equal(d.items.length, 1);
      return d.items[0]!.line;
    }),
    [],
  );
});

test("notifications: no stand-in survives into an incident's ops-channel post", async () => {
  const incident = (detail: string): Incident => ({ id: 'i1', kind: 'k', key: 'k', instance: 'alpha', severity: 'red', title: 'Deploy failed', detail, fix: 'Rotate it.', tried: [], since: '2026-02-01T00:00:00.000Z', lastSeen: '2026-02-01T00:00:00.000Z', resolvedAt: null, posted: {} });
  assert.deepEqual(await survivors((t) => postText(incident(t), 'raised', { dashboardUrl: 'https://dash.example.test' })), []);
});

test('notifications: no stand-in survives into a merge post', async () => {
  const pr = (body: string) => ({ number: 7, url: 'https://github.com/o/r/pull/7', title: 'Fix it', body, mergedAt: null, mergeCommit: null, mergedBy: 'ada', base: 'main' });
  assert.deepEqual(await survivors((t) => mergePostText(pr(t), 'a3f1c9e0b2d4', coordinatorRedact)), []);
});

test("notifications: no stand-in survives into a chat notice (the main watch's alert)", async () => {
  const notice = (reason: string) => mainWatchPost({ sha: 'a3f1c9e0b2d4', url: 'https://github.com/o/r/commit/a3f1c9e0b2d4', reason, revert: null, no_revert: null }, { dashboardUrl: 'https://dash.example.test' }).text;
  assert.deepEqual(await survivors(notice), []);
});

test("dashboard: no stand-in survives into the service-log view from the journal", async () => {
  assert.deepEqual(
    await survivors((t) => {
      const journal = () => ({ status: 0, stdout: `${JSON.stringify({ MESSAGE: t, PRIORITY: '3', __REALTIME_TIMESTAMP: '1767225600000000' })}\n`, stderr: '' });
      return JSON.stringify(readServiceLog({ unit: 'coordinator.service', file: null }, 10, journal).entries);
    }),
    [],
  );
});

test("dashboard: no stand-in survives into the service-log view from the log file, a private key over several lines included", async () => {
  const dir = scratch('svc-log-');
  assert.deepEqual(
    await survivors((t) => {
      const file = join(dir, 'coordinator.log');
      writeFileSync(file, `${t}\n`);
      return JSON.stringify(readServiceLog({ unit: null, file }, 10).entries);
    }),
    [],
  );
});

test('dashboard: a private key that starts above the kept lines of the log file is redacted whole', () => {
  const pem = SHAPES.find((s) => s.kind === 'private key')!;
  const file = join(scratch('svc-log-'), 'coordinator.log');
  writeFileSync(file, `${pem.value}\n${Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n')}\n`);
  const shown = readServiceLog({ unit: null, file }, 10).entries;
  assert.ok(!leaks(JSON.stringify(shown), pem.secret), JSON.stringify(shown));
  assert.equal(shown.at(-1)!.message, 'line 7');
});

test('Discord and Tailscale patterns run in linear time on hostile input', () => {
  const N = 100_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(N / unit.length));
  const hostile = [fill('a-'), fill('a.'), fill(`${'a'.repeat(25)}.`), fill(`${'a'.repeat(25)}.bbbbbb.`), fill(`${'a'.repeat(25)}.bbbbbb.-c`), fill('-a'), fill(`${'a-'.repeat(14)}.bbbbbb.${'c-'.repeat(40)}.`), fill('tskey-'), fill('tskey'), fill('tskey-a-')];
  const slow: string[] = [];
  const patterns = REDACTION_PATTERNS.filter((p) => p.kind === 'Discord bot token' || p.kind === 'Tailscale key');
  assert.equal(patterns.length, 2, 'both patterns are in the shared redactor');
  for (const { kind, re, rep } of patterns) {
    for (const s of hostile) {
      const t0 = performance.now();
      if (typeof rep === 'string') s.replace(re, rep);
      else s.replace(re, rep);
      const ms = performance.now() - t0;
      if (ms > 300) slow.push(`${kind} on ${s.slice(0, 12)}…: ${Math.round(ms)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});
