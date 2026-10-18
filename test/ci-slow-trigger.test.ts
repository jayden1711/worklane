// Which workflow runs a label starts, and what they cancel (#615). The merge flow adds needs-owner seconds after a PR
// opens; with `labeled` among ci-slow.yml's pull_request types, that label started a second ci slow run in the PR's
// concurrency group, which cancelled the PR's run in progress (a red "bootstrap 0s" row on every such PR). Skipping
// that run's jobs instead would have replaced the PR's real results with "skipped" under the same check names. Now
// only ci-slow-full-ci.yml hears a label: its one job, named apart, calls ci-slow.yml for full-ci alone, in a
// concurrency group of its own. These tests evaluate the workflows' own expressions for given event payloads, with a
// small evaluator for what they use (==, !=, &&, ||, !, format(), contains()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

type Ctx = Record<string, unknown>;
type Tok = { t: 'op' | 'str' | 'num' | 'id'; v: string };

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('()!,'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    if (c === "'") {
      let v = '';
      for (i++; ; i++) {
        assert.ok(i < s.length, `unterminated string in ${s}`);
        if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i++; continue; }
        if (s[i] === "'") { i++; break; }
        v += s[i];
      }
      out.push({ t: 'str', v });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (num) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*(\.(\*|[A-Za-z_][A-Za-z0-9_-]*))*/.exec(s.slice(i));
    assert.ok(id, `can't read ${s.slice(i)}`);
    out.push({ t: 'id', v: id[0] });
    i += id[0].length;
  }
  return out;
}

const truthy = (v: unknown) => !(v === false || v === null || v === undefined || v === 0 || v === '');
function equal(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if ((a ?? null) === null && (b ?? null) === null) return true;
  if (typeof a === typeof b) return a === b;
  const n = (x: unknown) => (x === null || x === undefined ? 0 : Number(x));
  return n(a) === n(b);
}
function lookup(path: string, ctx: Ctx): unknown {
  let cur: unknown = ctx;
  for (const k of path.split('.')) {
    if (k === '*') { cur = Array.isArray(cur) ? cur : []; continue; }
    if (Array.isArray(cur)) cur = cur.map((x) => (x as Record<string, unknown>)?.[k]);
    else cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  }
  return cur ?? null;
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** One expression (the inside of ${{ }}, or an if:), evaluated as Actions does for what these workflows use. */
function evaluate(expr: string, ctx: Ctx): unknown {
  const ts = tokens(expr);
  let p = 0;
  const peek = (v: string) => ts[p]?.t === 'op' && ts[p]!.v === v;
  const take = (v: string) => { assert.ok(peek(v), `expected ${v} in ${expr}`); p++; };
  const or = (): unknown => { let l = and(); while (peek('||')) { p++; const r = and(); l = truthy(l) ? l : r; } return l; };
  const and = (): unknown => { let l = eq(); while (peek('&&')) { p++; const r = eq(); l = truthy(l) ? r : l; } return l; };
  const eq = (): unknown => {
    const l = unary();
    if (peek('==')) { p++; return equal(l, unary()); }
    if (peek('!=')) { p++; return !equal(l, unary()); }
    return l;
  };
  const unary = (): unknown => { if (peek('!')) { p++; return !truthy(unary()); } return primary(); };
  const primary = (): unknown => {
    const t = ts[p++];
    assert.ok(t, `unexpected end of ${expr}`);
    if (t.t === 'op' && t.v === '(') { const v = or(); take(')'); return v; }
    if (t.t === 'str') return t.v;
    if (t.t === 'num') return Number(t.v);
    assert.equal(t.t, 'id', `unexpected ${t.v} in ${expr}`);
    if (t.v === 'true' || t.v === 'false') return t.v === 'true';
    if (t.v === 'null') return null;
    if (peek('(')) {
      p++;
      const args: unknown[] = [];
      while (!peek(')')) { args.push(or()); if (peek(',')) p++; }
      take(')');
      if (t.v === 'format') return str(args[0]).replace(/\{(\d+)\}/g, (_, n: string) => str(args[1 + Number(n)]));
      if (t.v === 'contains') return Array.isArray(args[0]) ? args[0].some((x) => equal(x, args[1])) : str(args[0]).toLowerCase().includes(str(args[1]).toLowerCase());
      assert.fail(`no function ${t.v} in this evaluator (${expr})`);
    }
    return lookup(t.v, ctx);
  };
  const v = or();
  assert.equal(p, ts.length, `left over in ${expr}`);
  return v;
}
/** A YAML value with ${{ }} in it, as Actions renders it; an if: may be a bare expression. */
const render = (s: string, ctx: Ctx) => s.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => str(evaluate(e, ctx)));
const runs = (cond: unknown, ctx: Ctx) => cond === undefined || truthy(evaluate(String(cond).replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/, '$1'), ctx));

/** A pull_request event's context, as Actions gives it to a run (and to a workflow it calls). */
function pr(action: string, o: { n?: number; label?: string; labels?: string[] } = {}): Ctx {
  const n = o.n ?? 7;
  const labels = (o.labels ?? (o.label ? [o.label] : [])).map((name) => ({ name }));
  return { github: { event_name: 'pull_request', ref: `refs/pull/${n}/merge`, run_id: '4242', event: { action, number: n, pull_request: { number: n, labels }, ...(o.label ? { label: { name: o.label } } : {}) } }, inputs: {} };
}
const dispatch: Ctx = { github: { event_name: 'workflow_dispatch', ref: 'refs/heads/main', run_id: '4243', event: {} }, inputs: { job: 'all', sha: '' } };

interface Workflow { on: Record<string, { types?: string[] } | null>; concurrency?: { group: string; 'cancel-in-progress': string }; jobs: Record<string, { name?: string; if?: string; uses?: string; needs?: string | string[]; steps?: { id?: string; env?: Record<string, string> }[] }> }
const dir = join(repoRoot, '.github', 'workflows');
const workflows = () => Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, parse(readFileSync(join(dir, f), 'utf8')) as Workflow]));
// A pull_request trigger with no types: runs on opened, synchronize and reopened (GitHub's default), never labeled.
const hearsLabel = (w: Workflow) => !!w.on && 'pull_request' in w.on && (w.on.pull_request?.types ?? ['opened', 'synchronize', 'reopened']).includes('labeled');

test('a label other than full-ci starts no ci slow run and no job anywhere, so it cancels nothing (#615)', () => {
  const all = workflows();
  assert.equal(hearsLabel(all['ci-slow.yml']!), false, "ci-slow.yml: no labeled type (a label's run joined the PR's group and cancelled its run)");
  assert.equal(hearsLabel(all['ci.yml']!), false, "ci.yml: no labeled type (a skipped required check would replace the PR's real one)");
  const heard = Object.entries(all).filter(([, w]) => hearsLabel(w));
  assert.deepEqual(heard.map(([f]) => f), ['ci-slow-full-ci.yml'], 'only the full-ci caller hears a label');
  for (const label of ['needs-owner', 'full-ci-please', 'bug']) {
    for (const [f, w] of heard) {
      for (const [id, job] of Object.entries(w.jobs)) assert.equal(runs(job.if, pr('labeled', { label, labels: ['full-ci-later', label] })), false, `${f} ${id} runs for the ${label} label`);
    }
  }
});

test('the full-ci label still runs every slow job: the caller calls ci-slow.yml, in a group that cancels none of the PR\'s runs (#615)', () => {
  const all = workflows();
  const slow = all['ci-slow.yml']!;
  const caller = all['ci-slow-full-ci.yml']!;
  assert.deepEqual(caller.on, { pull_request: { types: ['labeled'] } });
  assert.deepEqual(Object.keys(caller.jobs), ['full-ci']);
  const job = caller.jobs['full-ci']!;
  assert.equal(job.uses, './.github/workflows/ci-slow.yml');
  assert.ok('workflow_call' in slow.on, 'ci-slow.yml can be called');
  const full = pr('labeled', { label: 'full-ci', labels: ['needs-owner', 'full-ci'] });
  assert.equal(runs(job.if, full), true);
  // Its skipped check (any other label) is named apart from every check of the PR's own run.
  const names = Object.entries(slow.jobs).flatMap(([id, j]) => [id, j.name ?? id]);
  assert.ok(!names.includes(job.name ?? 'full-ci'), 'the caller job is named apart');
  // The called run reads the label from the event: scope runs, with FULL true (slow-jobs.sh: every slow job).
  const scope = slow.jobs.scope!;
  assert.equal(runs(scope.if, full), true);
  const env = scope.steps!.find((s) => s.id === 'scope')!.env!;
  assert.equal(render(env.FULL!, full), 'true');
  assert.equal(render(env.EVENT!, full), 'pull_request');
  for (const [id, j] of Object.entries(slow.jobs)) if (id !== 'scope') assert.deepEqual([j.needs].flat(), ['scope'], `${id} waits for scope`);
  // Concurrency: the PR's own runs keep their group, so a push still cancels the run in progress; the full-ci run's
  // group is another, so it cancels none of them; batches and bisect steps keep theirs.
  const group = (ctx: Ctx) => render(slow.concurrency!.group, ctx);
  const cancels = (ctx: Ctx) => render(slow.concurrency!['cancel-in-progress'], ctx);
  for (const a of ['opened', 'synchronize', 'reopened']) {
    assert.equal(group(pr(a)), 'ci-slow-pr-7', a);
    assert.equal(cancels(pr(a)), 'true', a);
  }
  assert.notEqual(group(full), group(pr('opened')), "the full-ci run doesn't cancel the PR's run");
  assert.equal(group(full), 'ci-slow-pr-7-full-ci');
  assert.notEqual(group(pr('opened', { n: 8 })), group(pr('opened')), 'one group per PR');
  assert.equal(group(dispatch), 'ci-slow-refs/heads/main');
  assert.equal(cancels(dispatch), 'false', 'a batch is never cancelled');
});

test('the evaluator reads these expressions as Actions does', () => {
  const ctx = pr('labeled', { label: 'Full-CI', labels: ['a', 'Full-CI'] });
  assert.equal(evaluate("github.event.label.name == 'full-ci'", ctx), true, 'string comparison ignores case');
  assert.equal(evaluate("github.event.action == 'opened' && 'x' || 'y'", ctx), 'y');
  assert.equal(evaluate("github.event.action == 'labeled' && 'x' || 'y'", ctx), 'x');
  assert.equal(evaluate("format('pr-{0}{1}', github.event.pull_request.number, '')", ctx), 'pr-7');
  assert.equal(evaluate("contains(github.event.pull_request.labels.*.name, 'full-ci')", ctx), true);
  assert.equal(evaluate("!(github.event_name != 'pull_request')", ctx), true);
  assert.equal(evaluate('github.event.nothing.here', ctx), null);
  assert.throws(() => evaluate("fromJSON('[]')", ctx), /no function fromJSON/);
});
