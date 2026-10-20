// Issue #711: no dashboard route takes a Claude credential. Every request body the dashboard reads goes through
// src/claude-credential-guard.ts first, so a token from `claude setup-token`, or the one-time code Anthropic's sign-in
// page shows, is refused whatever the route; the routes that once took one answer 410 Gone. Checked: the guard itself;
// that every body reader in the dashboard's sources uses it (a new reader that doesn't fails here); and, on a running
// dashboard, a machine owner on an allowed device sending a credential to each route that once took one, or to the
// routes that take any body, gets it refused, with nothing stored, audited or recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { asks } from '../src/console/asks.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { machineRequests } from '../src/machine-requests.js';
import { asDevicePerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
// Random, so that any part of either showing up anywhere is a leak, not a coincidence.
const SECRET = randomBytes(24).toString('hex');
const TOKEN = `sk-ant-oat01-${SECRET}`;
const CODE = `${randomBytes(16).toString('hex')}#${randomBytes(16).toString('hex')}`;

test('the guard: a setup token anywhere in a value (any depth, a key too), or a whole sign-in code; nothing else', async () => {
  const { holdsClaudeCredential } = await import('../src/claude-credential-guard.js');
  for (const v of [TOKEN, ` ${TOKEN}\n`, `my token is ${TOKEN}, thanks`, { value: TOKEN }, { a: [{ b: { c: TOKEN } }] }, { [TOKEN]: 1 }, [1, 'x', TOKEN], CODE, ` ${CODE} `, { value: CODE }, JSON.parse(`{"v":"\\u0073k-ant-oat01-${SECRET}"}`)]) assert.ok(holdsClaudeCredential(v), JSON.stringify(v));
  for (const v of ['', 'sk-ant-api03-not-a-login', 'sk-ant-oat01-short', 'a#b', `issue #${'1'.repeat(30)}`, 'https://example.com/x#section-heading-twenty', { value: 'a-bot-token.with.dots' }, 42, null, true, ['plain', { text: 'words' }], `${CODE} trailing words`]) assert.ok(!holdsClaudeCredential(v), JSON.stringify(v));
});

test('every request body the dashboard reads goes through the guard: a new reader without it fails here', () => {
  // The servers a person types into: an instance's dashboard and its routes, the setup console, and the hub's setup
  // mode. The webhook gateway takes bodies from services, never a person's paste box: listed, and why.
  const exempt: Record<string, string> = {
    'src/automations/webhook.ts': "an outside service's signed webhook payload, never a paste box",
    'src/automations/webhook-gateway.ts': "the hub's relay of those same webhook payloads",
  };
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(repoRoot, 'src'));
  const readers = files.filter((f) => /for await \(const \w+ of req\)/.test(readFileSync(f, 'utf8'))).map((f) => relative(repoRoot, f).replaceAll('\\', '/'));
  assert.ok(readers.includes('src/dashboard.ts') && readers.includes('src/console/secrets.ts'), readers.join(', '));
  for (const f of readers) {
    if (Object.hasOwn(exempt, f)) continue;
    const src = readFileSync(join(repoRoot, f), 'utf8');
    // Each reading function, from its loop to its return, checks what it read.
    for (const m of src.matchAll(/for await \(const \w+ of req\)/g)) {
      const rest = src.slice(m.index);
      const end = rest.search(/\n(export )?(async )?function |\n {2}const \w+ = (async )?\(/);
      const body = end > 0 ? rest.slice(0, end) : rest;
      assert.match(body, /holdsClaudeCredential|refuseClaudeCredential/, `${f}: a request body read without the #711 guard`);
    }
  }
});

test('issue #711: a machine owner on an allowed device sends a Claude credential to the dashboard: every route refuses it, nothing is stored, audited or recorded', { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'credential-guard-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const instance = cfg.project.project.name;
  const eventsDb = join(dir, 'events.db');
  // An open paste box an earlier version made for the agents' token, and one for another secret.
  const log = new EventLog(eventsDb);
  const claudeAsk = asks(log).create({ kind: 'paste_secret', instance, title: 'The Claude login', detail: 'Paste the token.', credential: 'claude-token', where: "the agent's Claude login" }, 'add-project').id;
  const otherAsk = asks(log).create({ kind: 'paste_secret', instance, title: 'A bot token', detail: 'Paste it.', credential: 'intake-discord', where: 'credentials.yaml' }, 'add-project').id;
  log.close();
  const home = join(dir, 'home');
  const accountDir = join(dir, 'claude-account');
  mkdirSync(accountDir, { recursive: true });
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: machineOwnersFile('example-owner'), claudeAccountDir: accountDir, secretsHome: home, slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const send = async (method: string, path: string, body: unknown) => {
      const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', ...asDevicePerson('example-owner') }, body: JSON.stringify(body) });
      return { status: r.status, text: await r.text() };
    };
    const cases: [string, string, unknown][] = [
      // The routes that once took one: gone.
      ['POST', '/api/claude-account/token', { value: TOKEN }],
      ['POST', '/api/claude-account/profile-add?profile=work', { value: TOKEN }],
      ['POST', '/api/claude-account/login-code', { value: CODE }],
      // The paste boxes: the one an earlier version opened for the token, and any other.
      ['POST', `/api/asks/${claudeAsk}/secret`, { value: TOKEN }],
      ['POST', `/api/asks/${claudeAsk}/secret`, { value: CODE }],
      ['POST', `/api/asks/${otherAsk}/secret`, { value: TOKEN }],
      ['POST', `/api/asks/${otherAsk}/secret`, { value: CODE }],
      // Routes that take any body, the credential tucked into it.
      ['POST', '/api/machine/claude-account', { action: 'status', token: TOKEN }],
      ['POST', '/api/machine/claude-profile', { action: 'use', profile: 'work', note: CODE }],
      ['POST', '/api/machine/add-project', { name: 'gamma', repo: 'example/gamma', claude: { token: TOKEN } }],
      ['PUT', '/api/views', [{ name: TOKEN }]],
    ];
    for (const [method, path, body] of cases) {
      const r = await send(method, path, body);
      assert.ok(r.status >= 400, `${method} ${path}: refused, never taken: ${r.status} ${r.text}`);
      assert.ok(!r.text.includes(SECRET.slice(0, 16)) && !r.text.includes(CODE.slice(0, 16)), `${path}: the value is never echoed`);
    }
    // Nothing stored: no file anywhere under this test's dashboard holds either value; nothing recorded.
    const scan = (p: string): string[] => {
      if (!existsSync(p)) return [];
      if (statSync(p).isDirectory()) return readdirSync(p).flatMap((f) => scan(join(p, f)));
      const t = readFileSync(p).toString('latin1');
      return t.includes(SECRET.slice(0, 16)) || t.includes(CODE.slice(0, 16)) ? [p] : [];
    };
    assert.deepEqual(scan(dir), [], 'stored nowhere: no secrets file, no event, no audit, no view');
    const after = new EventLog(eventsDb);
    try {
      assert.deepEqual(machineRequests(after.read(0)), [], 'no machine request recorded');
      assert.deepEqual([asks(after).get(claudeAsk)!.status, asks(after).get(otherAsk)!.status], ['open', 'open'], 'neither paste box answered');
    } finally {
      after.close();
    }
  } finally {
    await d.close();
  }
});
