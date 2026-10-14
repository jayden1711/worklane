// PR-mode batching (src/coordinator/pr-batch.ts) through the real test-run service: startTestRun, the sandbox host
// and postChecks as the coordinator wires them (batchTestRuns), with only the root helper (and sudo) faked at their
// process boundary. A batch's full run clones the batch commit, runs the tiers, wipes, and posts the full check on
// each PR head; a red batch is bisected with real runs; the coordinator stopping cancels a batch's run.
import './isolate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequest } from '../src/backlog/types.js';
import { EventLog } from '../src/events/log.js';
import type { EventPayload } from '../src/events/types.js';
import { PrBatcher, type BatchEntry, type PrBatchConfig } from '../src/coordinator/pr-batch.js';
import { TestRunConfig } from '../src/testrun/config.js';
import { sandboxHost } from '../src/testrun/host.js';
import { useTestRuns } from '../src/testrun/index.js';
import { batchTestRuns } from '../src/testrun/setup.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const hasPerl = posix && (() => {
  try {
    execFileSync('perl', ['-e', '1']);
    return true;
  } catch {
    return false;
  }
})();
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ID = ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false'];

/** A remote with main and n PR branches (each adds pr-<n>.txt), and the coordinator's clone. */
function world(n: number) {
  const base = mkdtempSync(join(tmpdir(), 'tr-batch-'));
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', seed);
  writeFileSync(join(seed, 'README'), 'base\n');
  git(seed, 'add', 'README');
  git(seed, ...ID, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const prs = new Map<number, PullRequest>();
  for (let i = 1; i <= n; i++) {
    git(seed, 'checkout', '-q', '-B', `t/pr-${i}`, 'main');
    writeFileSync(join(seed, `pr-${i}.txt`), `change ${i}\n`);
    git(seed, 'add', `pr-${i}.txt`);
    git(seed, ...ID, 'commit', '-q', '-m', `PR ${i}`);
    git(seed, 'push', '-q', '-f', 'origin', `t/pr-${i}`);
    prs.set(i, { number: i, url: `u/${i}`, head: `t/pr-${i}`, headSha: git(seed, 'rev-parse', 'HEAD'), base: 'main', draft: false, state: 'open', title: `PR ${i}`, mergeable: true, mergeableState: 'clean' });
  }
  const repo = join(base, 'clone');
  git(base, 'clone', '-q', remote, repo);
  /** Push a new commit to PR k's branch (its head moves), and return it. */
  const move = (k: number) => {
    git(seed, 'checkout', '-q', `t/pr-${k}`);
    writeFileSync(join(seed, `pr-${k}.txt`), `change ${k}, again\n`);
    git(seed, ...ID, 'commit', '-q', '-am', `PR ${k}, again`);
    git(seed, 'push', '-q', 'origin', `t/pr-${k}`);
    const head = git(seed, 'rev-parse', 'HEAD');
    prs.set(k, { ...prs.get(k)!, headSha: head });
    return head;
  };
  return { base, repo, prs, move };
}

/**
 * The sandbox helper faked at its process boundary: the same subcommands and output the sandbox host reads, done as
 * this user under `root`, cloning with the real helper's own clone script. Every call is logged.
 */
function fakeHelper(root: string) {
  mkdirSync(join(root, 'runs'), { recursive: true });
  const src = readFileSync(join(repoRoot, 'scripts', 'machine', 'worklane-testrun.sh'), 'utf8');
  writeFileSync(join(root, 'clone.sh'), /^CLONE='([\s\S]*?)'$/m.exec(src)![1]!);
  const helper = join(root, 'helper');
  writeFileSync(
    helper,
    `#!/bin/bash
set -euo pipefail
root=${JSON.stringify(root)}
name="$1" cmd="$2"; shift 2
printf '%s %s\\n' "$cmd" "\${1:-}" >> "$root/calls"
d="$root/runs/\${1:-x}"
case "$cmd" in
  create) mkdir -p "$d/work" "$d/tmp" "$d/home" "$root/store"; cat > "$d/tree.bundle"; b="$2" h="$3" bs="$4" hs="$5" bb="$6"; shift 6; bash "$root/clone.sh" "$d/tree.bundle" "$d/work" "$b" "$h" "$bs" "$hs" "$bb" "$root/store" "$@" >&2; echo "$d/work" ;;
  store-tips) if [ -f "$root/store/HEAD" ]; then git -C "$root/store" for-each-ref --format='%(objectname)' refs/keep/; fi ;;
  file) cat > "$d/changed-files"; echo "$d/changed-files" ;;
  cache) mkdir -p "$root/cache/$1-$2"; echo "$root/cache/$1-$2" ;;
  shared) mkdir -p "$root/shared/$1"; echo "$root/shared/$1" ;;
  exec)
    shift 2; envs=()
    while [ "$1" != -- ]; do envs+=("$2"); shift 2; done
    cd "$d/work"
    exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$d/home" TMPDIR="$d/tmp" CI=1 \${envs[@]+"\${envs[@]}"} /bin/bash -o pipefail -c "$2" ;;
  wipe) rm -rf "$d"; echo "wiped $1" ;;
  check) echo OK ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(helper, 0o755);
  const sudo = join(root, 'sudo');
  writeFileSync(sudo, '#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n');
  chmodSync(sudo, 0o755);
  return { host: sandboxHost('shop', helper, sudo), calls: () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') };
}

const CFG: PrBatchConfig = { enabled: true, max: 8, shards: 1, fast_checks: ['fast'], full_checks: ['full'] };

function rig(n: number, suite: string) {
  const w = world(n);
  const log = new EventLog(join(w.base, 'events.db'));
  const helperRoot = join(w.base, 'helper-root');
  const h = fakeHelper(helperRoot);
  const slots = join(w.base, 'slots');
  mkdirSync(slots);
  writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 2, max_test_runs: 2 }));
  const lockPath = join(w.base, 'full-run.lock');
  writeFileSync(lockPath, '');
  const config = TestRunConfig.parse({ tiers: [{ name: 'chain', command: 'true', kind: 'fast' }, { name: 'suite', command: suite, kind: 'full' }], checks: { suite: 'full' } });
  const posted: { name: string; head_sha: string; conclusion: string }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)) as (typeof posted)[number]);
    return new Response('{"id":1}', { status: 201 });
  }) as typeof fetch;
  useTestRuns({
    run: { config, host: h.host, repo: w.repo, log, actor: 'alice', logDir: join(w.base, 'logs'), lockPath, slotsDir: slots, slotPollMs: 50 },
    checks: { repo: 'example-org/example-shop', token: async () => 't', log, actor: 'alice', fetch: fetchImpl, api: 'https://gh.test' },
  });
  const stopped = new AbortController();
  const tested: number[] = [];
  const blamed: string[] = [];
  const b = new PrBatcher({
    log,
    instance: 'alice',
    repo: w.repo,
    remote: 'origin',
    branch: 'main',
    identity: { name: 'bot', email: 'bot@example.com' },
    config: () => CFG,
    testRuns: batchTestRuns(config, stopped.signal),
    pullRequest: async (k) => ({ ...w.prs.get(k)! }),
    comment: async (k, body) => void blamed.push(`comment #${k}: ${body.slice(0, 80)}`),
    addLabels: async (k, ls) => void blamed.push(`labels #${k}: ${ls.join(',')}`),
    removeLabel: async () => {},
    ownerOf: () => 'example-owner',
    tested: (e) => void tested.push(e.number),
  });
  const entry = (k: number): BatchEntry => ({ issue: 100 + k, number: k, head: w.prs.get(k)!.headSha });
  const finished = () => log.read(0, ['testrun.finished']).map((e) => e.payload as EventPayload<'testrun.finished'>);
  return { w, log, b, h, helperRoot, stopped, tested, blamed, posted, entry, finished };
}

test('a batch runs through the real startTestRun: a clone of the batch commit with main, the full tier, the wipe, and the full check on each PR head', { skip: !hasPerl && 'perl for the flock holder' }, async () => {
  // The full tier sees the whole batch in a git clone with main present, as CI would.
  const r = rig(2, 'test -f pr-1.txt && test -f pr-2.txt && git log --oneline main >/dev/null && test "$(git rev-parse --abbrev-ref origin/HEAD)" = origin/main');
  try {
    for (const k of [1, 2]) assert.ok(r.b.enqueue(r.entry(k)));
    r.b.tick();
    await r.b.idle();
    const runs = r.finished();
    assert.equal(runs[0]!.ok, true, JSON.stringify([runs[0], r.log.read(0, ['testrun.tier']).map((e) => e.payload)]));
    assert.equal(runs.length, 1, 'one full run for the batch');
    assert.deepEqual(runs[0]!.prs, [1, 2]);
    assert.deepEqual(r.h.calls().map((c) => c.split(' ')[0]), ['store-tips', 'create', 'exec', 'wipe'], 'through the helper: the store\'s tips, workspace, the full tier, the wipe');
    assert.deepEqual(readdirSync(join(r.helperRoot, 'runs')), [], 'wiped');
    assert.deepEqual(r.posted.map((p) => [p.name, p.head_sha, p.conclusion]), [['full', r.w.prs.get(1)!.headSha, 'success'], ['full', r.w.prs.get(2)!.headSha, 'success']]);
    assert.deepEqual(r.tested, [1, 2]);
  } finally {
    useTestRuns(null);
  }
});

test('a red batch is bisected with real runs: the culprit is found, and only the passing PRs get a passing full check', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig(3, 'test ! -f pr-2.txt');
  try {
    for (const k of [1, 2, 3]) r.b.enqueue(r.entry(k));
    for (let i = 0; i < 6 && r.tested.length < 2; i++) {
      r.b.tick();
      await r.b.idle();
    }
    assert.ok(r.finished().length >= 2, 'the batch, then its prefixes');
    assert.ok(r.finished().every((f) => f.kind === 'full' && f.outcome === 'done'));
    const ok = r.posted.filter((p) => p.conclusion === 'success').map((p) => p.head_sha);
    assert.ok(!ok.includes(r.w.prs.get(2)!.headSha), 'never a passing full check on the culprit');
    assert.ok(ok.includes(r.w.prs.get(1)!.headSha));
    assert.ok(!r.tested.includes(2));
    assert.deepEqual(readdirSync(join(r.helperRoot, 'runs')), [], 'every run wiped');
  } finally {
    useTestRuns(null);
  }
});

test('the coordinator stopping cancels a batch\'s run in flight: the signal reaches the run, which is wiped and posts no passing check', { skip: !hasPerl && 'perl' }, async () => {
  const r = rig(1, 'sleep 30');
  try {
    r.b.enqueue(r.entry(1));
    r.b.tick();
    for (let i = 0; i < 100 && !r.log.read(0, ['testrun.started']).length; i++) await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    r.stopped.abort();
    await r.b.idle();
    assert.ok(Date.now() - t0 < 15_000, 'it did not run to the end');
    assert.equal(r.finished()[0]!.outcome, 'cancelled');
    assert.ok(!r.posted.some((p) => p.conclusion === 'success'));
    assert.ok(!existsSync(join(r.helperRoot, 'runs', r.finished()[0]!.id)), 'wiped');
  } finally {
    useTestRuns(null);
  }
});

test('a batch dropped mid-run (a PR\'s head moved) cancels the real run: it is wiped, nobody is blamed, and the batch re-forms on the new head and passes', { skip: !hasPerl && 'perl' }, async () => {
  // The first run hangs until the test lets runs through; the re-formed batch's run passes at once.
  const go = join(mkdtempSync(join(tmpdir(), 'tr-go-')), 'go');
  const r = rig(2, `for i in $(seq 300); do [ -f '${go}' ] && exit 0; sleep 0.1; done; exit 1`);
  try {
    for (const k of [1, 2]) r.b.enqueue(r.entry(k));
    r.b.tick();
    for (let i = 0; i < 100 && !r.log.read(0, ['testrun.started']).length; i++) await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    // #2's head moves while the batch's run is going, and the PR watch sees it.
    const moved = r.w.move(2);
    r.b.observe(2, moved, 'open');
    await r.b.idle();
    assert.ok(Date.now() - t0 < 15_000, 'the run was cancelled, not run to the end');
    const run = r.finished()[0]!;
    assert.equal(run.outcome, 'cancelled');
    assert.ok(!existsSync(join(r.helperRoot, 'runs', run.id)), 'wiped');
    const steps = r.log.read(0, ['pr_batch.step']).map((e) => e.payload as { step: string; detail?: string });
    assert.ok(steps.some((x) => x.step === 'abandoned' && /nobody blamed/.test(x.detail ?? '')), JSON.stringify(steps));
    assert.ok(!steps.some((x) => x.step === 'red' || x.step === 'culprit'), 'never red, never bisected');
    assert.deepEqual(r.blamed, [], 'no comment or label on any PR');
    assert.ok(!r.posted.length, 'no check posted');
    assert.deepEqual(r.tested, []);
    // The batch re-forms: #1 batched again, #2 at its new head once the PR watch queues it, and the run passes.
    writeFileSync(go, '');
    assert.ok(r.b.enqueue({ issue: 102, number: 2, head: moved }));
    for (let i = 0; i < 4 && r.tested.length < 2; i++) {
      r.b.tick();
      await r.b.idle();
    }
    const last = r.finished().at(-1)!;
    assert.deepEqual([last.outcome, last.ok, last.prs.slice().sort()], ['done', true, [1, 2]]);
    assert.deepEqual(r.tested.slice().sort(), [1, 2]);
    assert.deepEqual(r.posted.map((p) => [p.head_sha, p.conclusion]).sort(), [[r.w.prs.get(1)!.headSha, 'success'], [moved, 'success']].sort(), 'the full check on #2\'s new head, never its old one');
    assert.deepEqual(r.blamed, [], 'still nobody blamed');
  } finally {
    useTestRuns(null);
  }
});
