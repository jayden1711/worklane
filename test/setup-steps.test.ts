// The setup step registry (src/setup-steps.ts): it covers every row of the first-run audit; init's walked steps are
// its groups; each detector says done from the real state and not done without it; doctor and the dashboard's
// first-run page show the same states; and the page's Start shows its change, needs a confirmation, is audited, and
// is the owners' alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { firstRunStart, startDashboard, type DashboardOptions, type FirstRunStart } from '../src/dashboard.js';
import { setupChecks } from '../src/doctor.js';
import { EventLog } from '../src/events/log.js';
import { projectStateDir } from '../src/guardrails/context.js';
import { install, GIT_HOOK_MARKER } from '../src/install.js';
import { localInitFile, newState, STEPS, writeInitState } from '../src/init.js';
import { checkSetup, checkSetupOffThread, GROUPS, SETUP_STEPS, type InstanceFacts, type MachinePaths, type Mode, type RunResult, type SetupContext, type SetupProbe, type SetupView } from '../src/setup-steps.js';
import { serviceChange, type ServiceSpec } from '../src/os/index.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'setup-steps-state-'));

test('the registry covers every row of the first-run audit (1-33), each step once, and init walks its groups in order', () => {
  const rows = new Set(SETUP_STEPS.flatMap((s) => s.rows));
  assert.deepEqual([...rows].sort((a, b) => a - b), Array.from({ length: 33 }, (_, i) => i + 1));
  const ids = SETUP_STEPS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'step ids are unique');
  for (const s of SETUP_STEPS) {
    assert.ok(GROUPS.some((g) => g.id === s.group), `${s.id}: a known group`);
    assert.ok(s.today.length > 10, `${s.id}: says what a person does today`);
    if (s.fix.kind === 'outside') assert.ok(s.fix.url === null || /^https:\/\//.test(s.fix.url), `${s.id}: a direct https link`);
  }
  assert.deepEqual(STEPS.map((s) => s.id), GROUPS.filter((g) => g.walked).map((g) => g.id));
  assert.deepEqual(STEPS.map((s) => s.title), ['Tools present', 'Claude login', 'GitHub', 'Repo config', 'Coordinator running', 'Protection', 'Discord', 'Tailscale']);
});

/** A machine of stand-ins: which tools are on PATH, what commands answer, the service manager; git runs for real. */
interface World {
  tools: Set<string>;
  claudeIn: boolean;
  ghIn: boolean;
  push: boolean;
  protectedMain: boolean;
  tailscale: string | null;
  service: boolean | null;
  units: Set<string>;
  linger: boolean | null;
}

function probeFor(w: World): SetupProbe {
  return {
    which: (c) => (w.tools.has(c) ? `/stand-in/${c}` : null),
    run: (cmd, args, o = {}): RunResult => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude' && a === 'auth status') return w.claudeIn ? { status: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' } : { status: 1, stdout: '{"loggedIn": false}', stderr: '' };
      if (cmd === 'gh' && a === 'auth status') return { status: w.ghIn ? 0 : 1, stdout: '', stderr: '' };
      if (cmd === 'gh' && a.endsWith('--jq .permissions.push')) return { status: 0, stdout: `${w.push}\n`, stderr: '' };
      if (cmd === 'gh' && a.endsWith('/protection --silent')) return w.protectedMain ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      if (cmd === 'tailscale' && a === 'status --json') return { status: w.tailscale ? 0 : 1, stdout: w.tailscale ?? '', stderr: '' };
      return { status: 1, stdout: '', stderr: `no stand-in for ${cmd} ${a}` };
    },
    serviceRunning: () => w.service,
    systemUnitActive: (u) => w.units.has(u),
    linger: () => w.linger,
  };
}

const world = (over: Partial<World> = {}): World => ({ tools: new Set(['git', 'gitleaks', 'claude', 'gh']), claudeIn: true, ghIn: true, push: true, protectedMain: true, tailscale: null, service: false, units: new Set(), linger: null, ...over });

/** A checkout with the example config committed, an origin, origin/main at HEAD and its hooks installed; plus a machine's files and an instance. */
function fixture() {
  const { dir } = exampleProject();
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  install({ root: dir });
  const m = mkdtempSync(join(tmpdir(), 'setup-machine-'));
  const machine: MachinePaths = {
    enginePackage: join(m, 'package.json'),
    engine: join(m, 'opt-current'),
    helper: join(m, 'helper'),
    machineOwners: join(m, 'machine-owners.json'),
    updatesConfig: join(m, 'updates.json'),
    allowedSigners: join(m, 'allowed_signers'),
    hubUnitFile: join(m, 'hub.service'),
    fullRunLock: join(m, 'full-run.lock'),
  };
  const home = mkdtempSync(join(tmpdir(), 'setup-instance-'));
  const facts: InstanceFacts = { home, credentials: { github: { kind: 'app', key_path: join(home, 'app.pem') } } };
  const ctx = (mode: Mode, over: Partial<SetupContext> = {}): SetupContext => ({ mode, root: dir, repo: 'example-org/example-shop', instance: mode === 'server' ? 'shop' : null, stateDir: projectStateDir(dir), policyFile: join(home, 'policy.yaml'), openQuestions: 0, setupPr: null, machine, instanceFacts: () => facts, ...over });
  return { dir, git, machine, home, facts, ctx };
}

const stepIn = (v: SetupView, id: string) => v.groups.flatMap((g) => g.steps).find((s) => s.id === id);

/**
 * Each detector, done and not done: the world (or the files) made so, then checked. `on` makes it done, `off` not
 * done; every step of the registry is here (a test below checks that), each with the mode it is checked in.
 */
type Fx = ReturnType<typeof fixture>;
const CASES: Record<string, { mode: Mode; on: (f: Fx, w: World) => SetupContext | void; off: (f: Fx, w: World) => SetupContext | void; done?: RegExp; not?: RegExp }> = {
  engine: { mode: 'local', on: (f) => writeFileSync(f.machine.enginePackage, '{"version":"9.9.9"}'), off: () => {}, done: /engine 9\.9\.9 installed/, not: /can't be read/ },
  'root-scripts': { mode: 'server', on: (f) => mkdirSync(f.machine.engine), off: () => {}, not: /bootstrap --hardened hasn't run/ },
  'machine-owner': { mode: 'server', on: (f) => writeFileSync(f.machine.machineOwners, '{"owners":["ada"]}', { mode: 0o644 }), off: () => {}, done: /@ada/ },
  path: { mode: 'local', on: (_f, w) => void w.tools.add(BRAND.cli), off: () => {} },
  tools: { mode: 'local', on: () => {}, off: (_f, w) => void w.tools.delete('gitleaks'), not: /missing: gitleaks/ },
  docker: { mode: 'local', on: (_f, w) => void w.tools.add('docker'), off: () => {} },
  'claude-login': { mode: 'local', on: () => {}, off: (_f, w) => void (w.claudeIn = false), done: /signed in \(claude\.ai\)/, not: /not signed in/ },
  'claude-token': { mode: 'server', on: (f) => { f.facts.credentials.claude = { config_dir: f.home }; }, off: (f) => { f.facts.credentials.claude = { config_dir: join(f.home, 'nope') }; }, not: /not found/ },
  'gh-login': { mode: 'local', on: () => {}, off: (_f, w) => void (w.push = false), not: /can't push/ },
  origin: { mode: 'local', on: () => {}, off: (f) => f.git('remote', 'remove', 'origin'), done: /example-org\/example-shop/ },
  'signin-app': { mode: 'server', on: (_f, w) => void w.units.add(`${BRAND.cli}-dashboard-hub.service`), off: () => {} },
  'agent-app': { mode: 'server', on: (f) => writeFileSync(join(f.home, 'app.pem'), 'k'), off: () => {}, not: /private key .* is missing/ },
  'default-branch': { mode: 'local', on: () => {}, off: (f) => f.git('update-ref', '-d', 'refs/remotes/origin/main'), done: /default branch main/, not: /origin\/main isn't fetched/ },
  questions: { mode: 'local', on: () => {}, off: (f, _w) => { rmSync(join(f.dir, BRAND.configDir), { recursive: true }); return f.ctx('local', { openQuestions: 2 }); }, not: /2 questions open/ },
  'config-on-main': { mode: 'local', on: () => {}, off: (f) => f.git('update-ref', '-d', 'refs/remotes/origin/main'), not: /not on origin\/main yet/ },
  hooks: { mode: 'local', on: () => {}, off: (f) => rmSync(join(f.dir, '.claude', 'settings.json')), not: /not installed/ },
  owners: { mode: 'local', on: () => {}, off: (f) => editConfig(f, (y) => y.replaceAll('example-owner', 'your-github-handle')), not: /placeholders/ },
  'required-checks': { mode: 'local', on: (f) => editConfig(f, (y) => `${y}\nrequired_checks: [ci]\n`), off: () => {}, done: /required: ci/, not: /required_checks is empty/ },
  'agents-config': { mode: 'local', on: () => {}, off: (f) => rmSync(join(f.dir, BRAND.configDir), { recursive: true }), done: /daily budget \$/ },
  'pre-commit': { mode: 'local', on: (f) => writeFileSync(join(f.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n# ${GIT_HOOK_MARKER}\n`), off: () => {} },
  fingerprints: {
    mode: 'local',
    on: (f) => {
      mkdirSync(projectStateDir(f.dir), { recursive: true });
      writeFileSync(join(projectStateDir(f.dir), 'fingerprints.json'), JSON.stringify({ sets: { 'prod-db': { hashes: ['h'], fetchedAt: 'x' } } }));
    },
    off: () => {},
    not: /not fetched: prod-db/,
  },
  protection: { mode: 'local', on: () => {}, off: (_f, w) => void (w.protectedMain = false), not: /HTTP 404/ },
  policy: { mode: 'server', on: (f) => writeFileSync(join(f.home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: 20 }\nagents: { max_workers: 2 }\nland_mode: pr\n'), off: (f) => writeFileSync(join(f.home, 'policy.yaml'), 'version: 1\nbudget: { daily_usd: -1 }\n'), done: /\$20\/day, 2 workers/ },
  discord: { mode: 'server', on: (f) => { f.facts.credentials.intake = { discord_token: join(f.home, 'bot') }; writeFileSync(join(f.home, 'intake.yaml'), 'x'); }, off: (f) => { f.facts.credentials.intake = { discord_token: join(f.home, 'bot') }; }, not: /no intake\.yaml/ },
  tailscale: { mode: 'server', on: (_f, w) => { w.tools.add('tailscale'); w.tailscale = '{"BackendState":"Running","Self":{"DNSName":"box.example.com."}}'; }, off: (_f, w) => { w.tools.add('tailscale'); w.tailscale = '{"BackendState":"NeedsLogin"}'; }, done: /box\.example\.com/ },
  'console-devices': { mode: 'server', on: (f) => writeFileSync(f.machine.hubUnitFile, 'ExecStart=x --console-devices tag:owner\n'), off: (f) => writeFileSync(f.machine.hubUnitFile, 'ExecStart=x\n'), done: /tag:owner/ },
  updater: { mode: 'server', on: (f) => { writeFileSync(f.machine.updatesConfig, '{}'); writeFileSync(f.machine.allowedSigners, 'k'); }, off: (f) => writeFileSync(f.machine.updatesConfig, '{}'), not: /installs nothing until/ },
  'other-keys': { mode: 'server', on: (f) => { writeFileSync(join(f.home, 'key'), 'k'); f.facts.credentials.agent_api_key = join(f.home, 'key'); }, off: () => {} },
  backup: { mode: 'server', on: (f) => writeFileSync(join(f.home, 'offsite-backup.yaml'), 'x'), off: () => {} },
  'more-owners': { mode: 'server', on: (f) => writeFileSync(f.machine.machineOwners, '{"owners":["ada","bo"]}', { mode: 0o644 }), off: (f) => writeFileSync(f.machine.machineOwners, '{"owners":["ada"]}', { mode: 0o644 }) },
  'deploy-gate': { mode: 'local', on: (f) => writeFileSync(join(f.dir, BRAND.configDir, 'deploy.yaml'), 'version: 1\nenvironments:\n  - name: staging\n    verify: "true"\n'), off: () => {}, done: /staging/ },
  coordinator: {
    mode: 'server',
    on: (_f, w) => void w.units.add(`${BRAND.cli}-shop.service`),
    off: (f) => f.ctx('server', { handoff: { service: 'failed' }, handoffDetail: { service: '.worklane: missing' } }),
    done: /-shop\.service is active/,
    not: /isn't active; add-project service failed: \.worklane: missing/,
  },
  service: { mode: 'local', on: (_f, w) => void (w.service = true), off: () => {}, done: /dev\.\S+ is running/, not: /isn't running/ },
  linger: { mode: 'local', on: (_f, w) => void (w.linger = true), off: (_f, w) => void (w.linger = false) },
};

function editConfig(f: Fx, edit: (yaml: string) => string) {
  const file = join(f.dir, BRAND.configDir, 'config.yaml');
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
}

test('every step of the registry has a detector case here', () => {
  assert.deepEqual(Object.keys(CASES).sort(), SETUP_STEPS.map((s) => s.id).sort());
});

for (const [id, c] of Object.entries(CASES)) {
  test(`detector ${id}: done from the real state, not done without it`, () => {
    for (const want of [true, false]) {
      const f = fixture();
      const w = world();
      const ctx = (want ? c.on : c.off)(f, w) ?? f.ctx(c.mode);
      const s = stepIn(checkSetup(ctx, probeFor(w)), id);
      assert.ok(s, `${id} is checked in ${c.mode} mode`);
      assert.equal(s.done, want, `${id} ${want ? 'done' : 'not done'}: ${s.detail}`);
      const re = want ? c.done : c.not;
      if (re) assert.match(s.detail, re);
    }
  });
}

test("server: what the coordinator's user can't see is read from init's record; the setup PR's wait is the config step's", () => {
  const f = fixture();
  const ctx = f.ctx('server', { instanceFacts: () => ({ error: "instance shop can't be read here" }), handoff: { 'claude-token': 'done', app: 'done', service: 'waiting' }, handoffDetail: { service: 'waiting for the setup PR https://github.com/example-org/example-shop/pull/4 to merge' } });
  const v = checkSetup(ctx, probeFor(world()));
  assert.equal(stepIn(v, 'claude-token')!.done, true);
  assert.match(stepIn(v, 'claude-token')!.detail, /as init recorded it/);
  assert.equal(stepIn(v, 'agent-app')!.done, true);
  assert.equal(stepIn(v, 'config-on-main')!.done, false);
  assert.match(stepIn(v, 'config-on-main')!.detail, /pull\/4 to merge \(add-project: service\)/);
  const none = checkSetup(f.ctx('server', { instanceFacts: () => ({ error: 'unreadable' }), handoff: { 'claude-token': 'failed' } }), probeFor(world()));
  assert.equal(stepIn(none, 'claude-token')!.done, false, 'only a recorded done counts');
});

test('a step for the other mode is not shown; linger only where loginctl answers', () => {
  const f = fixture();
  const local = checkSetup(f.ctx('local'), probeFor(world()));
  assert.equal(stepIn(local, 'policy'), undefined);
  assert.equal(stepIn(local, 'linger'), undefined, 'no loginctl: no linger step');
  const server = checkSetup(f.ctx('server'), probeFor(world()));
  assert.equal(stepIn(server, 'claude-login'), undefined);
  assert.ok(stepIn(server, 'claude-token'));
});

test('the poll cache: local checks reused within their time, GitHub ones longer, and Re-check (fresh) checks them all again', () => {
  const f = fixture();
  const w = world();
  let calls = 0;
  const p = probeFor(w);
  const counting: SetupProbe = { ...p, run: (cmd, args, o) => (cmd === 'gh' && args[0] === 'auth' && calls++, p.run(cmd, args, o)) };
  const cache = new Map();
  let t = 1_000_000;
  const at = () => t;
  checkSetup(f.ctx('local'), counting, { cache, localMs: 10_000, netMs: 120_000, now: at });
  t += 30_000;
  w.claudeIn = false;
  const later = checkSetup(f.ctx('local'), counting, { cache, localMs: 10_000, netMs: 120_000, now: at });
  assert.equal(calls, 1, 'GitHub asked once in 30 s');
  assert.equal(stepIn(later, 'claude-login')!.done, false, 'a local step is checked again after 10 s');
  checkSetup(f.ctx('local'), counting, { cache, localMs: 10_000, netMs: 120_000, now: at, fresh: true });
  assert.equal(calls, 2, 'Re-check asks GitHub again');
});

/** A dashboard on the fixture, with stand-ins for the machine and for installing the service. */
async function dashboard(f: Fx, w: World, over: Partial<DashboardOptions> = {}) {
  const stateDir = projectStateDir(f.dir);
  mkdirSync(stateDir, { recursive: true });
  const started: ServiceSpec[] = [];
  const d = await startDashboard({
    root: f.dir,
    cfg: loadConfig(f.dir),
    eventsDb: join(stateDir, 'events.db'),
    stateDir,
    user: 'example-owner',
    roleOf: exampleRoles,
    slotsDir: mkdtempSync(join(tmpdir(), 'setup-slots-')),
    setupProbe: probeFor(w),
    setupContext: { machine: f.machine, instanceFacts: () => f.facts },
    startService: (spec) => {
      started.push(spec);
      w.service = true;
      return { path: '/stand-in/service', started: true, detail: 'stand-in service loaded' };
    },
    ...over,
  });
  const base = d.url.split('/?')[0]!;
  const h = (user: string) => ({ authorization: `Bearer ${d.token}`, ...asPerson(user) });
  const get = async (user = 'example-owner', fresh = false) => {
    const r = await fetch(`${base}/api/first-run${fresh ? '?fresh=1' : ''}`, { headers: h(user) });
    return { status: r.status, body: (await r.json()) as { setup: SetupView; start: FirstRunStart; canStart: boolean; error?: string } };
  };
  const start = async (user: string, body: unknown) => {
    const r = await fetch(`${base}/api/first-run/start`, { method: 'POST', headers: { ...h(user), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { ok?: boolean; error?: string; command?: string } };
  };
  const audit = () => {
    const log = new EventLog(join(stateDir, 'events.db'));
    try {
      return log.read(0, ['dashboard.audit']).map((e) => e.payload as unknown as { login: string; action: string; detail: Record<string, unknown> });
    } finally {
      log.close();
    }
  };
  return { d, get, start, audit, started };
}

test('doctor and the first-run page show the same steps with the same states', async () => {
  const f = fixture();
  const w = world({ claudeIn: false, protectedMain: false });
  writeInitState(localInitFile(f.dir), newState('local', f.dir, 'example-org/example-shop', null));
  const s = await dashboard(f, w);
  try {
    const page = (await s.get()).body.setup;
    const doc = setupChecks(f.dir, { probe: probeFor(w), context: { machine: f.machine, instanceFacts: () => f.facts } });
    const fromPage = page.groups.flatMap((g) => g.steps).map((x) => [`setup ${x.id}`, x.done]);
    const fromDoctor = doc.filter((c) => c.name.startsWith('setup ')).map((c) => [c.name, c.level === 'ok']);
    assert.deepEqual(fromDoctor, fromPage);
    assert.deepEqual(fromPage.filter(([, done]) => !done).map(([n]) => n), ['setup engine', 'setup path', 'setup docker', 'setup claude-login', 'setup required-checks', 'setup pre-commit', 'setup fingerprints', 'setup protection', 'setup deploy-gate', 'setup service']);
    // Live: signed in since, both see it at once (Re-check), not when init next runs.
    w.claudeIn = true;
    assert.equal(stepIn((await s.get('example-owner', true)).body.setup, 'claude-login')!.done, true);
    assert.equal(setupChecks(f.dir, { probe: probeFor(w), context: { machine: f.machine } }).find((c) => c.name === 'setup claude-login')!.level, 'ok');
  } finally {
    await s.d.close();
  }
});

test('Start: shows the change first, needs a confirmation, is audited, and only the owners may; a viewer starts nothing', { skip: process.platform === 'win32' && 'no service manager on native Windows (Start says so instead)' }, async () => {
  const f = fixture();
  const w = world();
  const s = await dashboard(f, w);
  try {
    const view = (await s.get()).body;
    assert.equal(view.start.kind, 'local');
    if (view.start.kind === 'local') {
      assert.equal(view.start.file, serviceChange(view.start.label)!.path, 'the file it writes, shown before');
      assert.deepEqual(view.start.program.slice(-4), ['coordinator', 'run', '--root', f.dir], 'what `up` runs');
      assert.ok(view.start.commands.length >= 1, 'the commands it runs');
    }
    assert.equal(view.canStart, true);
    assert.equal((await s.get('example-collaborator')).body.canStart, false);
    // No confirmation: refused, nothing started, the refusal audited.
    const unconfirmed = await s.start('example-owner', {});
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.body.error!, /confirm/);
    assert.equal(s.started.length, 0);
    // A viewer: refused by the dashboard's read-only gate before any route. A writer: refused by Start, audited.
    const viewer = await s.start('someone-else', { confirm: true });
    assert.equal(viewer.status, 403);
    assert.match(viewer.body.error!, /@someone-else is a viewer here .*read-only/);
    const writer = await s.start('example-collaborator', { confirm: true });
    assert.equal(writer.status, 403);
    assert.match(writer.body.error!, /only the instance's owners/);
    assert.equal(s.started.length, 0, 'nothing started by a refusal');
    // The owner, confirmed: started with the same spec `up` uses, audited, and the step turns done.
    const ok = await s.start('example-owner', { confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(s.started.length, 1);
    assert.deepEqual(s.started[0]!.program.slice(-4), ['coordinator', 'run', '--root', f.dir]);
    assert.equal(stepIn((await s.get()).body.setup, 'service')!.done, true);
    const audit = s.audit().filter((a) => a.action.startsWith('first_run.'));
    assert.deepEqual(audit.map((a) => [a.login, a.action]), [
      ['example-owner', 'first_run.start_refused'],
      ['example-collaborator', 'first_run.start_refused'],
      ['example-owner', 'first_run.start'],
    ]);
    assert.equal(audit[2]!.detail.started, true);
    // A viewer can't read the checklist either.
    assert.equal((await s.get('someone-else')).status, 403);
  } finally {
    await s.d.close();
  }
});

test('Start on a server instance: never run from the dashboard; the command an owner runs, and why', async () => {
  const f = fixture();
  const plan = firstRunStart({ root: f.dir, cfg: loadConfig(f.dir), instance: 'shop' });
  assert.equal(plan.kind, 'owner-command');
  if (plan.kind === 'owner-command') {
    assert.equal(plan.unit, `${BRAND.cli}-shop.service`);
    assert.match(plan.command, /^sudo bash \S+\/scripts\/setup\/service\.sh shop$/);
    assert.match(plan.why, /never runs sudo[\s\S]*coordinator, which is what isn't running/);
  }
  const s = await dashboard(f, world(), { instance: 'shop', policyFile: join(f.home, 'policy.yaml') });
  try {
    const r = await s.start('example-owner', { confirm: true });
    assert.equal(r.status, 409);
    assert.match(r.body.command!, /service\.sh shop$/);
    assert.equal(s.started.length, 0);
    assert.deepEqual(s.audit().map((a) => a.action), ['first_run.start_refused']);
  } finally {
    await s.d.close();
  }
});

test("off the main thread (the dashboard's way): the real probe in a worker, the same steps, and the cache comes back filled", async () => {
  const f = fixture();
  const { instanceFacts: _facts, ...plain } = f.ctx('local');
  const cache = new Map();
  const v = await checkSetupOffThread({ ...plain, machine: { ...f.machine, enginePackage: join(repoRoot, 'package.json') } }, { cache, localMs: 10_000, netMs: 120_000 });
  // linger shows only where loginctl answers (the real one on Linux; the stand-in never does).
  const ids = (x: SetupView) => x.groups.flatMap((g) => g.steps).map((s) => s.id).filter((id) => id !== 'linger');
  assert.deepEqual(ids(v), ids(checkSetup(f.ctx('local'), probeFor(world()))));
  assert.equal(stepIn(v, 'engine')!.done, true, 'it read the real engine');
  assert.equal(stepIn(v, 'origin')!.done, true, 'and the real checkout');
  assert.ok(cache.has('engine') && cache.has('gh-login'));
});

test('the tools detector sees a missing tool installed since, without init running again', () => {
  const f = fixture();
  const w = world();
  w.tools.delete('gh');
  assert.equal(stepIn(checkSetup(f.ctx('local'), probeFor(w)), 'tools')!.done, false);
  w.tools.add('gh');
  assert.equal(stepIn(checkSetup(f.ctx('local'), probeFor(w)), 'tools')!.done, true);
});
