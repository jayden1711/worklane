// Issue #864, round 2: the hub's two request handlers (the signed-in port and the break-glass port) answer an error
// they don't mean to show with the same fixed 500 as the dashboard, never its message; the detail is logged, redacted,
// on the machine. A hub route that throws: the avatar route, whose machine-owners read (a stand-in, in code) throws an
// EACCES naming a path for the person asked about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { SESSION_COOKIE, STATE_COOKIE } from '../src/dashboard-auth.js';
import { startHub } from '../src/dashboard-hub.js';
import { exampleProject, exampleRoles } from './helpers.js';

const INTERNAL = /^the dashboard hit an internal error; the detail is in its log on the machine$/;
const SECRET_PATH = '/srv/hub-home/secret-dir/machine-owners';
const TOKEN = `ghp_${'Q7w8E9r0T1'.repeat(4)}`;

/** console.error's lines while `f` runs: where the hub logs a 500's detail. */
async function logged<T>(f: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const was = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { result: await f(), lines };
  } finally {
    console.error = was;
  }
}

async function hub(o: { tokenFile?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-500-'));
  const { dir: root } = exampleProject();
  const d = await startDashboard({ root, cfg: loadConfig(root), eventsDb: join(dir, 'events.db'), stateDir: join(dir, 'inst'), user: 'example-owner', roleOf: exampleRoles, slotsDir: join(dir, 'slots') });
  const web = mkdtempSync(join(tmpdir(), 'hub-500-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>hub</title>');
  const signInFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === '/login/oauth/access_token') return Response.json({ access_token: `ghu_${(JSON.parse(String(init?.body)) as { code: string }).code}` });
    if (u.pathname === '/user') return Response.json({ login: String(new Headers(init?.headers).get('authorization')).replace('Bearer ghu_', '') });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const h = await startHub({
    instances: [{ name: 'a', port: Number(new URL(d.url).port), tokenFile: o.tokenFile ?? d.keyFile }],
    stateDir: join(dir, 'hub'),
    webDir: web,
    signIn: { clientId: 'Iv1.testclient01', clientSecret: 'secret', sessionSecret: 's'.repeat(48), publicUrl: 'https://hub.example.test', fetch: signInFetch },
    appManifest: {
      // Whether the person asked about is a machine owner: for this one, the read throws an EACCES naming a path.
      isMachineOwner: (login: string) => {
        if (login === 'example-collaborator') throw new Error(`EACCES: permission denied, open '${SECRET_PATH}' (${TOKEN})`);
        return false;
      },
    },
    avatars: { fetch: (async () => new Response(null, { status: 404 })) as typeof fetch },
  });
  const base = h.url.replace(/\/$/, '');
  const signIn = async (login: string) => {
    const start = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!.split(';')[0]!;
    const back = await fetch(`${base}/auth/callback?code=${login}&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    return back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]!;
  };
  const close = async () => {
    await h.close();
    await d.close();
  };
  return { h, base, glass: h.breakGlassUrl.split('/?')[0]!, signIn, close };
}

function assertOpaque(status: number, text: string, why: string): void {
  assert.equal(status, 500, `${why}: ${text}`);
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['error'], why);
  assert.match(String(body.error), INTERNAL, why);
  for (const leak of ['/srv/hub-home', 'secret-dir', 'EACCES', TOKEN]) assert.ok(!text.includes(leak), `${why}: ${leak} in ${text}`);
}

test("#864: the hub's signed-in port answers a handler's EACCES naming a path with the fixed 500; the detail is logged, redacted", async () => {
  const s = await hub();
  try {
    const cookie = await s.signIn('example-owner');
    const { result: r, lines } = await logged(async () => {
      const res = await fetch(`${s.base}/api/i/a/avatar/example-collaborator?size=40`, { headers: { cookie } });
      return { status: res.status, text: await res.text() };
    });
    assertOpaque(r.status, r.text, 'signed-in port');
    assert.ok(lines.some((l) => l.includes('EACCES') && l.includes(SECRET_PATH)), `the detail is logged: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes(TOKEN)), 'the token in the message is redacted in the log');
  } finally {
    await s.close();
  }
});

test("#864: the hub's break-glass port answers the same fixed 500", async () => {
  const s = await hub();
  try {
    const { result: r, lines } = await logged(async () => {
      const res = await fetch(`${s.glass}/api/i/a/avatar/example-collaborator?size=40`,{ headers: { authorization: `Bearer ${s.h.token}` } });
      return { status: res.status, text: await res.text() };
    });
    assertOpaque(r.status, r.text, 'break-glass port');
    assert.ok(lines.some((l) => l.includes(SECRET_PATH)), 'the detail is logged');
    assert.ok(!lines.some((l) => l.includes(TOKEN)), 'redacted');
  } finally {
    await s.close();
  }
});

test("#882: an instance whose dashboard token the hub can't read answers 502 naming the instance, never the token file's path; the reason is in the hub's log", async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'hub-token-')), 'state', 'dashboard-token');
  const s = await hub({ tokenFile: gone });
  try {
    const { result: r, lines } = await logged(async () => {
      const res = await fetch(`${s.glass}/api/i/a/state`, { headers: { authorization: `Bearer ${s.h.token}` } });
      return { status: res.status, text: await res.text() };
    });
    assert.equal(r.status, 502, r.text);
    assert.deepEqual(JSON.parse(r.text), { error: "can't read instance a's dashboard token: is its dashboard running, and the hub allowed to read it?" });
    for (const leak of [gone, tmpdir(), 'ENOENT']) assert.ok(!r.text.includes(leak), `${leak} in ${r.text}`);
    assert.ok(lines.some((l) => l.includes("instance a's dashboard token") && l.includes('ENOENT') && l.includes(gone)), `the reason is logged: ${JSON.stringify(lines)}`);
  } finally {
    await s.close();
  }
});
