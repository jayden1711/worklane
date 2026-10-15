// People's GitHub pictures, served from the dashboard's own origin (#462, the owner's option B).
//
// WHY: a browser that loads https://github.com/<login>.png tells GitHub who looks at the dashboard and when, and its
// page then depends on GitHub's answer (#452's flake). So the server (the hub, or an instance's own dashboard served
// directly) fetches a picture once, keeps it on disk in its state dir for a day, and serves it from its own origin;
// the page's CSP allows pictures from that origin only (PAGE_CSP in src/dashboard.ts).
//
// INVARIANT: this is no open proxy. Only a valid GitHub login, at one of AVATAR_SIZES, of a person the server already
// knows (its caller decides who: `known`) is ever fetched, only from GitHub's hosts (src/github-hosts.ts) and only
// an https redirect between them; only a PNG, JPEG, GIF or WebP picture (its bytes checked, never SVG) of at most
// AVATAR_MAX_BYTES comes back, and nothing that failed is asked again within an hour.
// INVARIANT: no live outside call from a test process. In a process the test preload marked (test/isolate.ts), the
// default fetch refuses every call; a test that wants a picture gives a stand-in fetch in code.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { validLogin } from './dashboard-auth.js';
import { GITHUB_AVATARS, GITHUB_WEB } from './github-hosts.js';
import { SYSTEM_ROOT_VAR, systemRootRefusal } from './os/system-paths.js';

/** The only sizes asked of GitHub (px): the page asks for the smallest at least twice its box (web/src/api.ts). */
export const AVATAR_SIZES = [40, 80, 160] as const;
/** A picture larger than this is refused, whatever its type. */
export const AVATAR_MAX_BYTES = 256 * 1024;
/** How long a picture is kept before it is asked of GitHub again; the browser keeps it as long. */
export const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a failed picture (none, refused, timed out) is answered with "none" before it is asked again. */
export const AVATAR_MISS_MS = 60 * 60 * 1000;
/** How long one fetch from GitHub may take, redirects and body included. */
export const AVATAR_TIMEOUT_MS = 5_000;
/** The route, on an instance's own server (and, as /api/i/<instance>/avatar/<login>, on the hub). */
export const AVATAR_ROUTE = /^\/api\/avatar\/([^/]+)$/;

/** The picture types served, each with the bytes it starts with. Never SVG: it can carry script. */
const TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
/** The hosts a picture may come from: GitHub's, https only. */
const HOSTS = new Set([new URL(GITHUB_WEB).host, new URL(GITHUB_AVATARS).host]);
const MAX_REDIRECTS = 3;

/** A process the test preload marked: there, the default fetch never reaches outside. */
const markedTestProcess = () => !!process.env[SYSTEM_ROOT_VAR] && systemRootRefusal() === null;
const defaultFetch: typeof fetch = (input, init) => (markedTestProcess() ? Promise.reject(new Error('no live outside call from a test process (#462): give the avatars a stand-in fetch')) : fetch(input, init));

export interface AvatarOptions {
  /** Tests only, in code: a stand-in for GitHub. Nothing reads one from outside the process. */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface Picture {
  type: string;
  etag: string;
  at: number;
  body: Buffer;
}

/** A picture's size as the route takes it: one of AVATAR_SIZES, else null. */
export function avatarSize(raw: string | null): number | null {
  if (raw === null || !/^[0-9]{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return (AVATAR_SIZES as readonly number[]).includes(n) ? n : null;
}

/** Fetch one picture from GitHub, following its redirect only to GitHub's hosts; null when there is none to serve. */
export async function fetchAvatar(login: string, size: number, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ type: string; body: Buffer } | null> {
  if (!validLogin(login) || !(AVATAR_SIZES as readonly number[]).includes(size)) return null;
  const f = o.fetch ?? defaultFetch;
  const signal = AbortSignal.timeout(o.timeoutMs ?? AVATAR_TIMEOUT_MS);
  let url = `${GITHUB_WEB}/${login}.png?size=${size}`;
  try {
    for (let hop = 0; ; hop++) {
      const r = await f(url, { redirect: 'manual', signal, headers: { accept: Object.keys(TYPES).join(', ') } });
      if (r.status >= 300 && r.status < 400) {
        const to = r.headers.get('location');
        await r.body?.cancel().catch(() => undefined);
        if (!to || hop >= MAX_REDIRECTS) return null;
        const next = new URL(to, url);
        if (next.protocol !== 'https:' || !HOSTS.has(next.host)) return null;
        url = next.toString();
        continue;
      }
      if (r.status !== 200) {
        await r.body?.cancel().catch(() => undefined);
        return null;
      }
      const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const looks = TYPES[type];
      const declared = Number(r.headers.get('content-length') ?? '0');
      if (!looks || declared > AVATAR_MAX_BYTES || !r.body) {
        await r.body?.cancel().catch(() => undefined);
        return null;
      }
      const parts: Buffer[] = [];
      let total = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > AVATAR_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        parts.push(Buffer.from(value));
      }
      const body = Buffer.concat(parts);
      return looks(body) ? { type, body } : null;
    }
  } catch {
    return null;
  }
}

/**
 * The pictures one server keeps, in `<dir>` (its state dir's avatars/): fetched once per person and size, kept a
 * day, each served with cache-control and an ETag.
 */
export class Avatars {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<Picture | null>>();
  private readonly missed = new Map<string, number>();
  constructor(
    dir: string,
    private readonly o: AvatarOptions = {},
  ) {
    this.dir = dir;
    this.now = o.now ?? Date.now;
  }

  private file(key: string) {
    return join(this.dir, `${key}.json`);
  }

  private read(key: string): Picture | null {
    try {
      const j = JSON.parse(readFileSync(this.file(key), 'utf8')) as { type?: unknown; etag?: unknown; at?: unknown; body?: unknown };
      if (typeof j.type !== 'string' || !TYPES[j.type] || typeof j.etag !== 'string' || typeof j.at !== 'number' || typeof j.body !== 'string') return null;
      const body = Buffer.from(j.body, 'base64');
      return TYPES[j.type]!(body) && body.length <= AVATAR_MAX_BYTES ? { type: j.type, etag: j.etag, at: j.at, body } : null;
    } catch {
      return null;
    }
  }

  private write(key: string, p: Picture): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file(key)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ type: p.type, etag: p.etag, at: p.at, body: p.body.toString('base64') }), { mode: 0o600 });
      renameSync(tmp, this.file(key));
    } catch {
      // Not kept: it is fetched again next time.
    }
  }

  /** The picture to serve for `login` at `size`: the kept one while fresh, else GitHub's (the stale one if that fails). */
  async picture(login: string, size: number): Promise<Picture | null> {
    const key = `${login.toLowerCase()}-${size}`;
    const kept = this.read(key);
    if (kept && this.now() - kept.at < AVATAR_TTL_MS) return kept;
    const missedAt = this.missed.get(key);
    if (missedAt !== undefined && this.now() - missedAt < AVATAR_MISS_MS) return kept;
    let p = this.inFlight.get(key);
    if (!p) {
      p = fetchAvatar(login, size, { ...(this.o.fetch ? { fetch: this.o.fetch } : {}), ...(this.o.timeoutMs ? { timeoutMs: this.o.timeoutMs } : {}) }).then((got) => {
        if (!got) {
          this.missed.set(key, this.now());
          return null;
        }
        this.missed.delete(key);
        const pic = { ...got, at: this.now(), etag: `"${createHash('sha256').update(got.body).digest('hex').slice(0, 32)}"` };
        this.write(key, pic);
        return pic;
      });
      this.inFlight.set(key, p);
      void p.finally(() => this.inFlight.delete(key));
    }
    return (await p) ?? kept;
  }

  /**
   * GET /api/avatar/<login>?size=N, after the caller's own sign-in check: a bad login or size is refused before
   * anything else, then anyone `known` doesn't name (no fetch for them), then the picture, or 204 No Content (the page shows
   * initials). WHY 204, not 404: Chrome logs every 4xx as a console error, and a person with no picture is no error.
   */
  async serve(req: IncomingMessage, res: ServerResponse, rawLogin: string, rawSize: string | null, known: (login: string) => boolean | Promise<boolean>): Promise<void> {
    const size = avatarSize(rawSize);
    if (!validLogin(rawLogin)) return answer(res, 400, { error: 'not a GitHub login' });
    if (size === null) return answer(res, 400, { error: `size: one of ${AVATAR_SIZES.join(', ')}` });
    if (!(await known(rawLogin))) return none(res);
    const p = await this.picture(rawLogin, size);
    if (!p) return none(res);
    const maxAge = Math.max(0, Math.floor((p.at + AVATAR_TTL_MS - this.now()) / 1000));
    const headers = { 'cache-control': `private, max-age=${maxAge}`, etag: p.etag, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" };
    const asked = String(req.headers['if-none-match'] ?? '').split(',').map((s) => s.trim());
    if (asked.includes(p.etag)) {
      res.writeHead(304, headers);
      return void res.end();
    }
    res.writeHead(200, { ...headers, 'content-type': p.type, 'content-length': String(p.body.length) });
    res.end(p.body);
  }
}

/** No picture to show (no such person known, or none to be had): the page shows initials. */
function none(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Everyone an instance's events and config name: its owners, and each task's and decision's people. Lowercased. */
export function peopleOf(o: { owners: { default: string; writers: string[]; areas: { owner: string }[] }; tasks: { owner: string | null; author?: string }[]; decisions: { owner: string }[] }): Set<string> {
  const out = new Set<string>();
  const add = (l: string | null | undefined) => {
    if (l && validLogin(l)) out.add(l.toLowerCase());
  };
  add(o.owners.default);
  o.owners.writers.forEach(add);
  for (const a of o.owners.areas) add(a.owner);
  for (const t of o.tasks) {
    add(t.owner);
    add(t.author);
  }
  for (const d of o.decisions) add(d.owner);
  return out;
}
