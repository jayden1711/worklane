// A Codex or Gemini tool's output is cut to its last 2000 characters before the run record, the live feed and the
// stuck guard read it (#1065, R17b on #1067). The cut redacts first: a secret across it is redacted whole, never cut
// short of its rule and passed on as the part that was kept. Each stand-in shape (test/token-standins.ts) is put across
// the cut, cut by one character and cut in half, through each stream and through a run's record and feed; each case
// also checks that the cut landed at the cap, so a cap that changes fails here instead of silently testing less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactString } from '../../src/events/redact.js';
import { CliAgentRunner, CodexStream, GeminiStream, type CliStream } from '../../src/cli-agents.js';
import { killTree } from '../../src/os/index.js';
import type { RunRequest } from '../../src/runner.js';
import { leaks, SHAPES } from '../token-standins.js';

const CAP = 2000;
const posixOnly = process.platform === 'win32' && 'POSIX stand-in';

/** Tool outputs that put each shape across the tail cut: all of its value but its first `k` characters kept. */
function cases(): { what: string; secret: string; text: string; mark: string }[] {
  const out: { what: string; secret: string; text: string; mark: string }[] = [];
  for (const shape of SHAPES) {
    const at = shape.value.indexOf(shape.secret);
    for (const k of new Set([at + 1, at + Math.floor(shape.secret.length / 2)])) {
      const mark = `kept-${out.length}`;
      const tail = ` ${mark} `;
      const fill = CAP - (shape.value.length - k) - tail.length;
      if (fill < 2) continue;
      const text = `START ${'w'.repeat(600)} ${shape.value}${tail}${'z'.repeat(fill)}`;
      assert.ok(!leaks(redactString(text), shape.secret), `${shape.what} is hidden in the text uncut (else a redaction gap, #1066)`);
      out.push({ what: `${shape.what}, cut ${k - at} into it`, secret: shape.secret, text, mark });
    }
  }
  return out;
}

const codexLine = (id: string, output: string) => ({ type: 'item.completed', item: { id, type: 'command_execution', command: 'cat log', aggregated_output: output, exit_code: 1, status: 'failed' } });
const geminiLines = (id: string, output: string, asError: boolean) => [
  { type: 'tool_use', tool_name: 'run_shell_command', tool_id: id, parameters: { command: 'cat log' } },
  asError ? { type: 'tool_result', tool_id: id, status: 'error', error: { type: 'exit', message: output } } : { type: 'tool_result', tool_id: id, status: 'success', output },
];

const resultsOf = (lines: unknown[]) =>
  (lines as { message?: { content?: { type: string; content?: unknown }[] } }[]).flatMap((l) => l.message?.content ?? []).filter((b) => b.type === 'tool_result').map((b) => String(b.content));

test("a secret across the cut of a Codex or Gemini tool's output is redacted whole, never passed on as its kept end (#1065)", () => {
  const missed: string[] = [];
  const uncut: string[] = [];
  const all = cases();
  assert.ok(all.length >= SHAPES.length, `cases: ${all.length}`);
  for (const c of all) {
    const sites: [string, CliStream, unknown[]][] = [
      ['codex', new CodexStream(), [codexLine('item_1', c.text)]],
      ['gemini output', new GeminiStream(), geminiLines('t1', c.text, false)],
      ['gemini error', new GeminiStream(), geminiLines('t1', c.text, true)],
    ];
    for (const [where, s, input] of sites) {
      const got = resultsOf(input.flatMap((l) => s.line(l)));
      assert.equal(got.length, 1, `${where}: one tool result`);
      const kept = got[0]!;
      if (leaks(kept, c.secret)) missed.push(`${c.what} in ${where}`);
      if (kept.includes('START') || !kept.includes(c.mark) || !kept.endsWith('z') || kept.length > CAP) uncut.push(`${c.what} in ${where}: ${JSON.stringify(kept.slice(0, 60))}`);
    }
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
});

const asSelf = { wrap: (_u: string, f: string, a: string[], e: NodeJS.ProcessEnv): [string, string[], NodeJS.ProcessEnv] => [f, a, e], kill: (_u: string, pid: number | undefined) => killTree(pid, () => {}) };

/** A stand-in codex printing the stream `lines` and the text `stderr`, then exiting `code`, and a request for it. */
function codexStandIn() {
  const dir = mkdtempSync(join(tmpdir(), 'cli-cut-codex-'));
  const bin = join(dir, 'codex');
  const at = (f: string) => JSON.stringify(join(dir, f));
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\ncat ${at('stdout')}\ncat ${at('stderr')} >&2\nexit "$(cat ${at('code')})"\n`);
  chmodSync(bin, 0o755);
  const runner = new CliAgentRunner('codex', { runAs: () => ({ user: 'agent', home: dir }), base: { PATH: process.env.PATH ?? '' }, bin, exec: asSelf });
  const req = (over: Partial<RunRequest> = {}): RunRequest => ({ role: 'worker', prompt: 'p', cwd: dir, model: 'm', allowedTools: [], maxTurns: 5, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, route: { kind: 'build', fallback: 'sonnet' }, provider: { name: 'cli:codex', kind: 'cli', agent: 'codex', usdPerMtok: { in: 1, out: 1 } }, ...over });
  return (o: { lines?: object[]; stderr?: string; code?: number; over?: Partial<RunRequest> }) => {
    writeFileSync(join(dir, 'stdout'), (o.lines ?? []).map((l) => `${JSON.stringify(l)}\n`).join(''));
    writeFileSync(join(dir, 'stderr'), o.stderr ?? '');
    writeFileSync(join(dir, 'code'), String(o.code ?? 0));
    return runner.run(req(o.over));
  };
}

/** Where `secret` starts in `value`, and the cut points in it: one character short of all of it, and its middle. */
function cutsIn(value: string, secret: string, from: 'head' | 'tail'): number[] {
  const at = value.indexOf(secret);
  return [...new Set([from === 'head' ? at + secret.length - 1 : at + 1, at + Math.floor(secret.length / 2)])];
}

/** Texts that put `value` across a head cut at `cap` (its first `k` characters kept), with `rest` after the cut. */
const acrossHead = (cap: number, value: string, secret: string, rest = '') =>
  cutsIn(value, secret, 'head').filter((k) => cap - k >= 2).map((k) => `${'w'.repeat(cap - k - 1)} ${value} and the rest of the text${rest} ${'z'.repeat(600)}`);

/** Texts that put `value` across a tail cut at `cap`: all of it but its first `k` characters kept. */
const acrossTail = (cap: number, value: string, secret: string, lead = 600) =>
  cutsIn(value, secret, 'tail').filter((k) => cap - (value.length - k) >= 2).map((k) => `START ${'w'.repeat(lead)} ${value} ${'z'.repeat(cap - (value.length - k) - 1)}`);

test("a secret across the cut of a CLI run's stderr, failure, rate limit or answer is redacted whole, never passed on as the part kept (#1065)", { skip: posixOnly }, async () => {
  const run = codexStandIn();
  const ended = (text: string) => [{ type: 'item.completed', item: { id: 'a', type: 'agent_message', text } }, { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }];
  const sites = [
    { where: 'a failure', texts: (v: string, s: string) => acrossHead(500, v, s), run: (t: string) => run({ lines: [{ type: 'turn.failed', error: { message: t } }], code: 1 }), reason: 'failed', head: 'cli:codex: w', cap: 500 },
    { where: 'a rate limit', texts: (v: string, s: string) => acrossHead(300, v, s, ': rate limit reached'), run: (t: string) => run({ lines: [{ type: 'turn.failed', error: { message: t } }], code: 1 }), reason: 'rate_limited', head: 'usage or rate limit reached: w', cap: 300 },
    { where: 'a succeeded answer', texts: (v: string, s: string) => acrossHead(500, v, s), run: (t: string) => run({ lines: ended(t) }), reason: 'succeeded', head: 'w', cap: 500 },
    { where: 'an answer without its JSON', texts: (v: string, s: string) => acrossTail(300, v, s), run: (t: string) => run({ lines: ended(t), over: { jsonSchema: { type: 'object' } } }), reason: 'failed', tail: 'must end with: ', cap: 300 },
    { where: 'stderr', texts: (v: string, s: string) => acrossTail(4000, v, s, 12_000), run: (t: string) => run({ lines: [], stderr: t, code: 2 }), reason: 'failed', tail: 'without finishing: ', cap: 4000 },
  ];
  const missed: string[] = [];
  const uncut: string[] = [];
  for (const site of sites) {
    for (const shape of SHAPES) {
      for (const text of site.texts(shape.value, shape.secret)) {
        assert.ok(!leaks(redactString(text), shape.secret), `${shape.what} is hidden in the text uncut (else a redaction gap, #1066)`);
        const r = await site.run(text);
        if (leaks(r.detail, shape.secret)) missed.push(`${shape.what} in ${site.where}`);
        const kept = site.head ? r.detail : r.detail.slice(r.detail.indexOf(site.tail!) + site.tail!.length);
        const cutRight = site.head ? r.detail.startsWith(site.head) && r.detail.length === site.head.length - 1 + site.cap : r.detail.includes(site.tail!) && !kept.includes('START') && kept.endsWith('z') && kept.length <= site.cap;
        if (r.reason !== site.reason || !cutRight) uncut.push(`${shape.what} in ${site.where}: ${r.reason} ${JSON.stringify(r.detail.slice(0, 60))}`);
      }
    }
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(uncut, []);
});

/** Every file under `dir`, read whole. */
function filesUnder(dir: string): string {
  return readdirSync(dir).map((f) => join(dir, f)).map((p) => (statSync(p).isDirectory() ? filesUnder(p) : readFileSync(p, 'utf8'))).join('\n');
}

test("a secret across the cut of a CLI tool's output never reaches the run record or the live feed (#1065)", { skip: posixOnly }, async () => {
  const all = cases();
  const streams = {
    codex: [{ type: 'thread.started', thread_id: 't' }, ...all.map((c, i) => codexLine(`item_${i}`, c.text)), { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }],
    gemini: [{ type: 'init', session_id: 's', model: 'm' }, ...all.flatMap((c, i) => geminiLines(`t${i}`, c.text, i % 2 === 1)), { type: 'result', status: 'success', stats: {} }],
  };
  for (const agent of ['codex', 'gemini'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `cli-cut-${agent}-`));
    const bin = join(dir, agent);
    const out = join(dir, 'out.jsonl');
    writeFileSync(out, streams[agent].map((l) => `${JSON.stringify(l)}\n`).join(''));
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\ncat ${JSON.stringify(out)}\n`);
    chmodSync(bin, 0o755);
    const stateDir = mkdtempSync(join(tmpdir(), `cli-cut-state-${agent}-`));
    const req: RunRequest = { role: 'worker', prompt: 'p', cwd: dir, model: 'm', allowedTools: [], maxTurns: 10 * all.length, maxBudgetUsd: 1, stallMs: 30_000, timeoutMs: 30_000, route: { kind: 'build', fallback: 'sonnet' }, provider: { name: `cli:${agent}`, kind: 'cli', agent, usdPerMtok: { in: 1, out: 1 } }, stateDir };
    const r = await new CliAgentRunner(agent, { runAs: () => ({ user: 'agent', home: dir }), base: { PATH: process.env.PATH ?? '' }, bin, exec: asSelf }).run(req);
    assert.equal(r.turns, all.length, `${agent}: ${r.reason} ${r.detail}`);
    const stored = filesUnder(stateDir);
    const missed = all.filter((c) => leaks(stored, c.secret)).map((c) => c.what);
    const absent = all.filter((c) => !stored.includes(c.mark)).map((c) => c.what);
    assert.deepEqual(missed, [], `${agent}: secrets in the record or the feed`);
    assert.deepEqual(absent, [], `${agent}: tool outputs the record and the feed never held, so tested nothing`);
  }
});
