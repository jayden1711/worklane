// Voice intake, spoken approvals and Siri are removed (#743, src/voice-removed.ts). An install that had them on must
// end up with less access, never more: a spoken approval never counts (not even as a click), the old routes take
// nothing, no gateway listens whatever the hub unit says, an old intake.yaml still loads with its voice and siri keys
// ignored and named, an old export's Siri tokens are never imported, and doctor fails, naming each leftover and the
// step that removes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { startHub } from '../src/dashboard-hub.js';
import { EventLog } from '../src/events/log.js';
import { loadIntakeConfig } from '../src/intake/config.js';
import { intakeForInstance } from '../src/intake/wire.js';
import { exportBundle, importBundle, readBundle } from '../src/instance-move.js';
import { SIRI_PORT_IGNORED, VOICE_REMOVED } from '../src/voice-removed.js';
import { asPerson, exampleProject, exampleRoles, repoRoot } from './helpers.js';

const OWNER = 'example-owner';
const SIRI_PORT_OPTION = '--siri-port';
const TAB = { focused: true, visible: true };
/** What an install with voice and Siri on had in its intake.yaml. */
const OLD_INTAKE = 'version: 1\nvoice:\n  enabled: true\nsiri:\n  enabled: true\n  ask_model: haiku\n  ask_max_usd_per_day: 1\n';

/** An instance's dashboard as an older install with voice and Siri on left it: the intake.yaml, the Siri token store and gateway token. */
async function olderInstance(o: { siriLink?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-removed-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const { dir: root } = exampleProject();
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  if (o.siriLink) symlinkSync(o.siriLink, join(stateDir, 'siri'));
  else {
    mkdirSync(join(stateDir, 'siri'));
    writeFileSync(join(stateDir, 'siri', 'devices.json'), JSON.stringify({ devices: [{ id: 'd1', name: 'phone', hash: 'x', createdAt: '2026-10-01T00:00:00Z', createdBy: OWNER }] }), { mode: 0o600 });
  }
  const gatewayToken = 'old-siri-gateway-token-0123456789abcdef';
  writeFileSync(join(stateDir, 'siri-gateway-token'), gatewayToken, { mode: 0o600 });
  const intakeFile = join(dir, 'intake.yaml');
  writeFileSync(intakeFile, OLD_INTAKE, { mode: 0o600 });
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: db, stateDir, user: OWNER, roleOf: exampleRoles, pollMs: 50, slotsDir: join(dir, 'slots'), instance: 'example', intakeFile });
  const base = d.url.split('/?')[0]!.replace(/\/$/, '');
  const post = (path: string, body: object, token = d.token) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...asPerson(OWNER) }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(OWNER) } })).json();
  const inbox = () => (existsSync(join(stateDir, 'voice', 'inbox')) ? readdirSync(join(stateDir, 'voice', 'inbox')) : []);
  return { d, log, dir, stateDir, intakeFile, gatewayToken, post, get, inbox, close: async () => (await d.close(), log.close()) };
}

const asked = (id: string, kind: 'plan', issue: number, receipts: string[] = []) => ({ id, kind, issue, owner: OWNER, question: 'Approve?', options: ['approve', 'reject'], recommendation: 'approve', receipts });

test('upgrade: a spoken approval never counts, not even as a click, on an item voice could approve or one it never could; a click still answers', async () => {
  const s = await olderInstance();
  try {
    // One voice could approve (a design-level plan), one it never could (held for a high-risk reason).
    s.log.append('decision.asked', asked('d-design', 'plan', 8), 'c');
    s.log.append('plan.posted', { issue: 8, plan: {}, held: true, reasons: ['design: new top-level module (lib/)'], comments_at: 0, decision: 'd-design' }, 'c');
    s.log.append('decision.asked', asked('d-money', 'plan', 6, ['holds because high-risk: money-path (src/pay.ts)']), 'c');
    // Every shape a tab still running the old page could send, and a few it couldn't: all refused, none recorded.
    for (const id of ['d-design', 'd-money']) {
      for (const voice of [TAB, { focused: false, visible: true }, {}, true, 'yes', null, false]) {
        const r = await s.post('/api/decide', { id, answer: 'approve', voice });
        assert.equal(r.status, 410, `${id} ${JSON.stringify(voice)}`);
        assert.equal(((await r.json()) as { error: string }).error, VOICE_REMOVED);
      }
    }
    assert.equal(s.log.read(0, ['decision.answered']).length, 0, 'nothing recorded by voice');
    // The page is told nothing about voice any more.
    const st = (await s.get('/api/state')) as { decisions: Record<string, unknown>[] };
    assert.ok(st.decisions.length >= 2 && st.decisions.every((d) => !('voiceRefused' in d)), 'no voiceRefused field');
    // The same owner's click answers both, under the ordinary rules.
    for (const id of ['d-design', 'd-money']) assert.equal((await s.post('/api/decide', { id, answer: 'approve' })).status, 200, id);
  } finally {
    await s.close();
  }
});

test('upgrade: the old voice intake and Siri routes take nothing, with the old gateway token or the dashboard key', async () => {
  const s = await olderInstance();
  try {
    const r = await s.post('/api/voice/intake', { text: 'add a dark mode', voice: TAB });
    assert.equal(r.status, 410);
    assert.equal(((await r.json()) as { error: string }).error, VOICE_REMOVED);
    for (const path of ['/api/siri/tell', '/api/siri/ask']) {
      for (const token of [s.gatewayToken, s.d.token]) {
        const x = await s.post(path, { text: 'an idea', question: 'what is stuck?' }, token);
        assert.ok(x.status === 401 || x.status === 404, `${path}: ${x.status}`);
      }
    }
    // The old gateway token is no key to anything else either.
    assert.equal((await s.post('/api/decide', { id: 'x', answer: 'approve' }, s.gatewayToken)).status, 401);
    const devices = await s.post('/api/siri-devices', { name: 'new phone' });
    assert.equal(devices.status, 404, 'no Siri token is made');
    assert.deepEqual(s.inbox(), [], 'nothing reached the voice inbox');
    assert.ok(!existsSync(join(s.stateDir, 'siri', 'questions')), 'no question left for anything to answer');
  } finally {
    await s.close();
  }
});

test("upgrade: an instance's own dashboard deletes its leftover Siri gateway token and device store when it starts, so an install that never used Siri has nothing to do", async () => {
  // Every server instance had a gateway token (an older dashboard made one on every start); the store only with Siri used.
  const s = await olderInstance();
  try {
    for (const f of ['siri-gateway-token', 'siri']) assert.ok(!existsSync(join(s.stateDir, f)), `${f} deleted on start`);
  } finally {
    await s.close();
  }
  // A store that is a link (made by hand, or by anything else as this user): the link goes, what it points at stays.
  const elsewhere = mkdtempSync(join(tmpdir(), 'voice-removed-elsewhere-'));
  writeFileSync(join(elsewhere, 'keep.txt'), 'not Siri');
  const l = await olderInstance({ siriLink: elsewhere });
  try {
    assert.ok(!existsSync(join(l.stateDir, 'siri')), 'the link is gone');
    assert.ok(existsSync(join(elsewhere, 'keep.txt')), 'what it pointed at is untouched');
  } finally {
    await l.close();
  }
});

test("doctor: names spoken ideas still waiting in the voice inbox, and finds an instance's Siri files when the hub doesn't list it", async () => {
  const { voiceSiriLeftoverCheck } = await import('../src/doctor-voice-removed.js');
  const T = mkdtempSync(join(tmpdir(), 'voice-removed-doctor2-'));
  const uid = process.getuid?.() ?? 0;
  const none = join(T, 'none.service');
  // Ideas spoken before the upgrade, never taken now: data, named so they aren't lost silently.
  const state = join(T, 'state');
  mkdirSync(join(state, 'voice', 'inbox'), { recursive: true });
  writeFileSync(join(state, 'voice', 'inbox', 'v1.json'), '{}');
  writeFileSync(join(state, 'voice', 'inbox', 'v2.json'), '{}');
  const inbox = voiceSiriLeftoverCheck({ instances: ['alpha'], intakeFile: () => join(T, 'no-intake.yaml'), stateDirOf: () => state, hubUnitFile: none, tailnetSiri: () => false, rootUid: uid });
  assert.equal(inbox?.level, 'fail', JSON.stringify(inbox));
  assert.ok(inbox!.detail.includes(`${join(state, 'voice', 'inbox')} holds 2 spoken idea(s) that are never taken now`), inbox!.detail);
  // An instance the hub doesn't serve (no hub at all here): its own state is checked too.
  const other = join(T, 'other-state');
  mkdirSync(join(other, 'siri'), { recursive: true });
  const off = voiceSiriLeftoverCheck({ instances: ['beta'], intakeFile: () => join(T, 'no-intake.yaml'), stateDirOf: (n) => (n === 'beta' ? other : null), hubUnitFile: none, tailnetSiri: () => false, rootUid: uid });
  assert.equal(off?.level, 'fail', JSON.stringify(off));
  assert.ok(off!.detail.includes(`${join(other, 'siri')} is still there (the Siri device token store)`), off!.detail);
});

test("upgrade: intake.yaml's voice and siri keys still load (intake stays on), are ignored with a warning, and wire no source", () => {
  const home = mkdtempSync(join(tmpdir(), 'voice-removed-home-'));
  const file = join(home, 'intake.yaml');
  writeFileSync(file, OLD_INTAKE, { mode: 0o600 });
  const loaded = loadIntakeConfig(file);
  assert.ok(loaded && 'config' in loaded, `never a load failure: ${JSON.stringify(loaded)}`);
  assert.ok(loaded.warnings.some((w) => /^voice is ignored: voice intake was removed; delete the voice section/.test(w)), loaded.warnings.join('; '));
  assert.ok(loaded.warnings.some((w) => /^siri is ignored: Siri was removed; delete the siri section/.test(w)), loaded.warnings.join('; '));
  // Whatever shape an older or hand-edited file had under them.
  for (const extra of ['voice: true\n', 'siri: []\n', 'voice:\n  enabled: true\n  something: 1\n']) {
    writeFileSync(file, `version: 1\n${extra}`, { mode: 0o600 });
    assert.ok('config' in loadIntakeConfig(file)!, extra);
  }
  writeFileSync(file, `${OLD_INTAKE}discord:\n  enabled: false\n`, { mode: 0o600 });
  const wired = intakeForInstance({ home, repo: 'example/repo', githubToken: async () => 't', stateDir: join(home, 'state'), log: () => {} });
  assert.ok(wired, 'intake is on');
  assert.deepEqual(wired.sources.map((x) => x.name).filter((n) => n === 'voice'), [], 'no voice source');
});

/** Allocate distinct candidates together; callers release them before binding their explicit listeners. */
async function reservedPort() {
  const srv = createServer((socket) => socket.destroy());
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as { port: number }).port;
  return { port, reserved: srv };
}
const listening = (port: number) =>
  new Promise<boolean>((ok) => {
    const c = createConnection({ port, host: '127.0.0.1' });
    c.once('connect', () => (c.destroy(), ok(true)));
    c.once('error', () => ok(false));
  });

test('upgrade: no Siri gateway listens, whatever the hub is given (the option an older caller passed); --siri-port on the CLI only warns', async () => {
  const reservations: Awaited<ReturnType<typeof reservedPort>>[] = [];
  const hubState = mkdtempSync(join(tmpdir(), 'voice-removed-hub-'));
  let h: Awaited<ReturnType<typeof startHub>> | undefined;
  try {
    for (let i = 0; i < 3; i++) reservations.push(await reservedPort());
    const [siri, hub, breakGlass] = reservations;
    const port = siri!.port;
    assert.equal(new Set(reservations.map((r) => r.port)).size, 3);
    await Promise.all(reservations.map(({ reserved }) => new Promise<void>((ok) => reserved.close(() => ok()))));
    // The removed gateway's candidate is AVAILABLE at startup, as for the original stimulus. The legitimate
    // listeners have explicit different ports, so they cannot accidentally reuse it through port:0 allocation.
    h = await startHub({ instances: [], stateDir: hubState, port: hub!.port, breakGlassPort: breakGlass!.port, siri: { port } } as unknown as Parameters<typeof startHub>[0]);
    assert.equal(Number(new URL(h.url).port), hub!.port);
    assert.equal(await listening(port), false, `nothing on ${port}`);
    assert.ok(!('siriUrl' in h), 'no gateway URL');
  } finally {
    await Promise.all(reservations.filter(({ reserved }) => reserved.listening).map(({ reserved }) => new Promise<void>((ok) => reserved.close(() => ok()))));
    await h?.close();
  }
  // The hub as an older unit starts it (`dashboard --hub ... --siri-port 4397`, a service mode a test can't run on its
  // isolated machine): --siri-port is still read, so it is accepted and the hub starts, and it only prints the warning;
  // the start passes startHub no Siri option at all.
  const cli = readFileSync(join(repoRoot, 'src', 'cli.ts'), 'utf8');
  assert.match(cli, new RegExp(`if \\(option\\(opts, '${SIRI_PORT_OPTION}'\\) !== undefined\\) console\\.error\\(SIRI_PORT_IGNORED\\);`));
  const start = cli.slice(cli.indexOf('const h = await startHub('), cli.indexOf('\n', cli.indexOf('const h = await startHub(')));
  assert.ok(start.length > 30 && !/siri/i.test(start), start);
  assert.match(SIRI_PORT_IGNORED, /^warning: --siri-port is ignored: Siri was removed, so no gateway starts/);
});

test("export and import: the Siri device store and gateway token are never exported (live devices stay out of every bundle, for an older engine too) and never imported", () => {
  const from = mkdtempSync(join(tmpdir(), 'voice-removed-from-'));
  new EventLog(join(from, 'events.db')).close();
  mkdirSync(join(from, 'siri'));
  // A store an older engine would still honour: an active device, never revoked.
  writeFileSync(join(from, 'siri', 'devices.json'), JSON.stringify({ devices: [{ id: 'd1', name: 'phone', hash: 'x', createdAt: '2026-10-01T00:00:00Z', createdBy: OWNER }] }));
  writeFileSync(join(from, 'siri-gateway-token'), 'x');
  const out = join(mkdtempSync(join(tmpdir(), 'voice-removed-bundle-')), 'b.bundle');
  const e = exportBundle({ stateDir: from, root: null, repo: null, host: 'old', out });
  assert.deepEqual(e.files.filter((f) => /siri/.test(f)), [], `nothing of Siri exported: ${e.files.join(', ')}`);
  assert.deepEqual(readBundle(out).files.filter((f) => /siri/.test(f.path)), [], 'nor in the bundle file');
  assert.ok(e.left.some((l) => l.path === 'state/siri/devices.json' && /removed with Siri/.test(l.why)), JSON.stringify(e.left));
  assert.ok(e.left.some((l) => l.path === 'state/siri-gateway-token'), 'the token is left out too');
  const to = mkdtempSync(join(tmpdir(), 'voice-removed-to-'));
  importBundle({ file: out, stateDir: to, root: null, instance: true });
  for (const f of ['siri', 'siri-gateway-token']) assert.ok(!existsSync(join(to, f)), `${f} not imported`);
  assert.ok(existsSync(join(to, 'events.db')), 'the history is');
  // A bundle an older engine made, or one made by hand, with both in it: skipped all the same.
  const b = readBundle(out);
  b.files.push({ path: 'state/siri/devices.json', data: Buffer.from('{"devices":[]}').toString('base64') });
  b.files.push({ path: 'state/siri-gateway-token', data: Buffer.from('x').toString('base64') });
  const crafted = join(mkdtempSync(join(tmpdir(), 'voice-removed-crafted-')), 'c.bundle');
  writeFileSync(crafted, gzipSync(JSON.stringify(b)).toString('base64'), { mode: 0o600 });
  const to2 = mkdtempSync(join(tmpdir(), 'voice-removed-to2-'));
  const r2 = importBundle({ file: crafted, stateDir: to2, root: null, instance: true });
  for (const f of ['siri', 'siri-gateway-token']) assert.ok(!existsSync(join(to2, f)), `${f} not imported from a crafted bundle`);
  assert.deepEqual(r2.skipped.filter((s) => /Siri was removed/.test(s.why)).map((s) => s.path).sort(), ['state/siri-gateway-token', 'state/siri/devices.json']);
});

test('doctor: fails naming each voice or Siri leftover and the step that removes it; says nothing on a clean machine', async () => {
  // Loaded here, so each test above runs on its own against an older engine too (the fail-without run).
  const { UNSERVE_SIRI, voiceSiriLeftoverCheck } = await import('../src/doctor-voice-removed.js');
  const T = mkdtempSync(join(tmpdir(), 'voice-removed-doctor-'));
  const uid = process.getuid?.() ?? 0;
  const state = join(T, 'alpha-state');
  mkdirSync(join(state, 'siri'), { recursive: true });
  writeFileSync(join(state, 'siri', 'devices.json'), '{"devices":[]}');
  writeFileSync(join(state, 'siri-gateway-token'), 'x');
  const intake = join(T, 'intake.yaml');
  writeFileSync(intake, OLD_INTAKE, { mode: 0o600 });
  const unit = join(T, 'hub.service');
  writeFileSync(unit, `[Service]\nExecStart=/usr/local/bin/x dashboard --hub alpha=${state} --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x --siri-port 4397 --hooks-port 4396\n`, { mode: 0o644 });
  const check = voiceSiriLeftoverCheck({ instances: ['alpha'], intakeFile: () => intake, hubUnitFile: unit, tailnetSiri: () => true, rootUid: uid });
  assert.equal(check?.level, 'fail');
  const d = check!.detail;
  for (const want of [`${intake} still has voice`, `${intake} still has siri`, `still has ${SIRI_PORT_OPTION}`, `${join(state, 'siri')} is still there (the Siri device token store)`, `${join(state, 'siri-gateway-token')} is still there (the Siri gateway token)`, 'port 8443 to the removed Siri gateway', UNSERVE_SIRI]) {
    assert.ok(d.includes(want), `names ${want}:\n${d}`);
  }
  // The exact rerun, built from the unit (it passes --siri, which dashboards.sh ignores while it removes the rest).
  assert.match(d, /rerun dashboards\.sh once: [^\n]*sudo bash \S+dashboards\.sh --client-id 'Iv1\.signin0001' --public-url 'https:\/\/hub\.example\.test' --siri --hooks -- 'alpha'/);
  // Nothing of it left: no check at all.
  const clean = join(T, 'clean.service');
  writeFileSync(clean, `[Service]\nExecStart=/usr/local/bin/x dashboard --hub alpha=${join(T, 'nothing')} --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x\n`, { mode: 0o644 });
  writeFileSync(intake, 'version: 1\n', { mode: 0o600 });
  assert.equal(voiceSiriLeftoverCheck({ instances: ['alpha'], intakeFile: () => intake, hubUnitFile: clean, tailnetSiri: () => false, rootUid: uid }), null);
  assert.equal(voiceSiriLeftoverCheck({ instances: [], hubUnitFile: join(T, 'none.service'), tailnetSiri: () => null }), null, 'no hub, no tailscale: nothing to say');
  // A state directory this user can't see into: said, never taken as clean.
  if (uid !== 0) {
    const hidden = join(T, 'hidden-state');
    mkdirSync(hidden, { mode: 0o000 });
    const unit2 = join(T, 'hidden.service');
    writeFileSync(unit2, `[Service]\nExecStart=/usr/local/bin/x dashboard --hub alpha=${hidden} --service --client-id Iv1.signin0001 --public-url https://hub.example.test --signin-dir /x\n`, { mode: 0o644 });
    try {
      const w = voiceSiriLeftoverCheck({ instances: [], hubUnitFile: unit2, tailnetSiri: () => false, rootUid: uid });
      assert.equal(w?.level, 'warn');
      assert.match(w!.detail, /can't check \(permission denied; run doctor as root\)/);
    } finally {
      chmodSync(hidden, 0o700);
    }
  }
});
