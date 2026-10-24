// Run records and the run feed (#988): every text either store clips is redacted before it is cut. A secret across a
// clip boundary is redacted whole; it is never cut short of its rule and then stored as the part that was kept. Each
// stand-in shape (test/token-standins.ts) is put across each store's clip boundary, cut by one character and cut in
// half, and must not survive in the stored text. Each case also checks that the cut landed where the store's cap says,
// so a cap that changes fails here instead of silently testing less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString } from '../../src/events/redact.js';
import { readFeed, RunFeed } from '../../src/run-feed.js';
import { readRun, RunRecorder } from '../../src/run-record.js';
import { StuckDetector } from '../../src/stuck.js';
import { leaks, SHAPES } from '../token-standins.js';

const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });
const results = (...content: object[]) => ({ type: 'user', message: { content } });
const asJson = (s: string) => JSON.stringify(s).slice(1, -1);
const asDiff = (s: string) => s.split('\n').join('\n+');
const TAIL = ` and the rest of the text ${'z'.repeat(600)}`;

interface Site {
  where: string;
  /** The store's cap on this text, in characters of the stored text before its cut marker. */
  cap: number;
  /** What the stored text holds before the value: a prefix the store adds (a JSON key, a diff header). */
  pre: string;
  /** How the value is written in the stored text. */
  shown: (s: string) => string;
  /** The stored text's cut marker. */
  marker: RegExp;
}

const RECORD = / …$/;
const FEED = / … \[\d+ more chars\]$/;
const site = (where: string, cap: number, marker: RegExp, pre = '', shown = (s: string) => s): Site => ({ where, cap, pre, shown, marker });

const RECORD_SITES = {
  command: site('record: a command', 400, RECORD),
  output: site("record: a command's output", 800, RECORD),
  said: site('record: the final message (said)', 4000, RECORD),
  result: site('record: the final message (result)', 4000, RECORD),
  detail: site("record: a failed run's detail", 2000, RECORD),
  plugin: site('record: a plugin name', 80, RECORD),
  mcp: site('record: an MCP server name', 80, RECORD),
  stuck: site("record: the stuck guard's input", 300, /$/, '{"command":"', asJson),
};
const FEED_SITES = {
  text: site('feed: text', 8000, FEED),
  thinking: site('feed: thinking', 8000, FEED),
  input: site("feed: a tool call's input", 4000, FEED, '{"command":"', asJson),
  diff: site('feed: a diff', 8000, FEED, '--- a/f.txt\n+++ b/f.txt\n+', asDiff),
  output: site("feed: a tool result's output", 4000, FEED),
  message: site("feed: a console message's text", 8000, FEED),
};

/**
 * For one site and stand-in, the raw texts that put `value` across the site's cap: its first `k` characters (as shown)
 * kept, the rest cut, for `k` one short of the secret's end and halfway through it. The filler has no whitespace at its
 * start (outputs are trimmed) and no line breaks (outputs keep only their first lines), and ends in a space, as a word
 * before a value in a log line does. A text whose secret redaction doesn't hide even uncut, as the site shows it, is a
 * redaction gap, not a clipping one: it goes in `gaps` instead.
 */
function across(s: Site, value: string, secret: string, what: string, gaps: Set<string>): string[] {
  const shown = s.shown(value);
  const at = shown.indexOf(s.shown(secret));
  if (at < 0) return [];
  const len = s.shown(secret).length;
  const out: string[] = [];
  for (const k of new Set([at + len - 1, at + Math.floor(len / 2)])) {
    const filler = s.cap - s.pre.length - k;
    if (filler < 2) continue;
    const text = `${'w'.repeat(filler - 1)} ${value}${TAIL}`;
    const whole = redactString(s.pre + s.shown(text));
    if (leaks(whole, secret) || leaks(whole, s.shown(secret))) gaps.add(`${what} in ${s.where}`);
    else out.push(text);
  }
  return out;
}

/**
 * Redaction gaps that need no cut: a gap closed fails here until it is taken off. A value with JSON-escaped slashes is
 * escaped again when its tool call's input is written as JSON.
 */
// check-table: never-grow
const KNOWN_GAPS: readonly string[] = [
  "a bearer token with JSON-escaped slashes in record: the stuck guard's input",
  "a bearer token with JSON-escaped slashes in feed: a tool call's input",
];
const known = (where: string) => KNOWN_GAPS.filter((g) => g.includes(` in ${where}: `));

/** The stored text holds the secret (as written or as shown), or wasn't cut where the site's cap says. */
function check(s: Site, stored: string | undefined, secret: string, what: string, missed: string[], uncut: string[]): void {
  const got = stored ?? '';
  if (leaks(got, secret) || leaks(got, s.shown(secret))) missed.push(`${what} in ${s.where}`);
  const m = got.match(s.marker);
  if (!m || got.length - m[0].length !== s.cap) uncut.push(`${what} in ${s.where} (${got.length - (m?.[0].length ?? 0)} characters)`);
}

const cwd = join(tmpdir(), 'wt', 'issue-1');

test('a secret across any clip boundary of a run record is redacted whole, never stored as its kept part (#988)', () => {
  const state = mkdtempSync(join(tmpdir(), 'runs-clip-'));
  const missed: string[] = [];
  const uncut: string[] = [];
  const gaps = new Set<string>();
  const S = RECORD_SITES;
  for (const shape of SHAPES) {
    const one = (s: Site, store: (text: string) => string | undefined) => {
      for (const text of across(s, shape.value, shape.secret, shape.what, gaps)) check(s, store(text), shape.secret, shape.what, missed, uncut);
    };
    const record = (lines: unknown[], end: Partial<Parameters<RunRecorder['finish']>[0]> = {}) => {
      const r = new RunRecorder(state, { role: 'worker', model: 'm', cwd });
      for (const l of lines) r.line(l);
      r.finish({ reason: 'failed', costUsd: 0, turns: 1, model: 'm', ...end });
      return readRun(state, r.id)!;
    };
    one(S.command, (t) => record([assistant({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: t } })]).steps[0]?.what);
    one(S.output, (t) => record([assistant({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'make' } }), results({ type: 'tool_result', tool_use_id: 'c', content: t })]).steps[0]?.output);
    one(S.said, (t) => record([assistant({ type: 'text', text: t })]).final);
    one(S.result, (t) => record([], { final: t }).final);
    one(S.detail, (t) => record([], { detail: t }).detail);
    one(S.plugin, (t) => record([{ type: 'system', subtype: 'init', plugins: [{ name: t, path: '/plugins/p' }] }]).loaded?.plugins[0]);
    one(S.mcp, (t) => record([{ type: 'system', subtype: 'init', mcp_servers: [{ name: t }] }]).loaded?.mcpServers[0]);
    one(S.stuck, (t) => {
      const d = new StuckDetector();
      for (const id of ['s1', 's2']) {
        d.line(assistant({ type: 'tool_use', id, name: 'Bash', input: { command: t } }));
        d.line(results({ type: 'tool_result', tool_use_id: id, is_error: true, content: 'no' }));
      }
      return record([], { stuck: { ...d.longest } }).stuck?.input;
    });
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
  assert.deepEqual([...gaps], known('record'));
});

test('a secret across any clip boundary of a run feed is redacted whole, never stored as its kept part (#988)', () => {
  const state = mkdtempSync(join(tmpdir(), 'feed-clip-'));
  const missed: string[] = [];
  const uncut: string[] = [];
  const gaps = new Set<string>();
  const S = FEED_SITES;
  let n = 0;
  for (const shape of SHAPES) {
    const one = (s: Site, kind: string, field: 'text' | 'input' | 'diff' | 'output', write: (f: RunFeed, text: string) => void) => {
      for (const text of across(s, shape.value, shape.secret, shape.what, gaps)) {
        const run = `clip-${n++}`;
        const f = new RunFeed(state, { run, issue: 1, role: 'worker', model: 'm', cwd });
        write(f, text);
        const item = readFeed(state, run)?.items.find((i) => i.kind === kind) as Record<string, string> | undefined;
        check(s, item?.[field], shape.secret, shape.what, missed, uncut);
      }
    };
    one(S.text, 'text', 'text', (f, t) => f.line(assistant({ type: 'text', text: t })));
    one(S.thinking, 'thinking', 'text', (f, t) => f.line(assistant({ type: 'thinking', thinking: t })));
    one(S.input, 'tool', 'input', (f, t) => f.line(assistant({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: t } })));
    one(S.diff, 'diff', 'diff', (f, t) => f.line(assistant({ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: join(cwd, 'f.txt'), content: t } })));
    one(S.output, 'tool_result', 'output', (f, t) => f.line(results({ type: 'tool_result', tool_use_id: 'c', content: t })));
    one(S.message, 'message', 'text', (f, t) => f.message('m1', 'queued', t));
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
  assert.deepEqual([...gaps], known('feed'));
});

test("a secret over several lines, cut by a store's line limit, is not stored as its kept lines (#988)", () => {
  const state = mkdtempSync(join(tmpdir(), 'lines-clip-'));
  const missed: string[] = [];
  const multi = SHAPES.filter((s) => s.value.includes('\n'));
  let n = 0;
  assert.ok(multi.length > 0, 'a stand-in over several lines');
  for (const shape of multi) {
    const lines = shape.value.split('\n');
    for (let kept = 1; kept < lines.length; kept++) {
      // The record keeps a command's first 6 lines; the feed a tool result's first 60.
      for (const [where, limit] of [['record', 6], ['feed', 60]] as const) {
        const text = [...Array.from({ length: limit - kept }, (_, i) => `line ${i}`), shape.value, 'after'].join('\n');
        let stored: string | undefined;
        if (where === 'record') {
          const r = new RunRecorder(state, { role: 'worker', model: 'm', cwd });
          r.line(assistant({ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'make' } }));
          r.line(results({ type: 'tool_result', tool_use_id: 'c', content: text }));
          r.finish({ reason: 'failed', costUsd: 0, turns: 1, model: 'm' });
          stored = readRun(state, r.id)?.steps[0]?.output;
        } else {
          const run = `lines-${n++}`;
          const f = new RunFeed(state, { run, issue: 1, role: 'worker', model: 'm', cwd });
          f.line(results({ type: 'tool_result', tool_use_id: 'c', content: text }));
          stored = (readFeed(state, run)?.items.find((i) => i.kind === 'tool_result') as { output?: string } | undefined)?.output;
        }
        if (stored === undefined || leaks(stored, shape.secret)) missed.push(`${shape.what}, ${kept} of its lines kept, ${where}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});
