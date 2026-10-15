// Compression for the dashboard's responses: the built UI (each file compressed once and kept), and the JSON of the
// views a page switch reads. A person often reaches the hub over a slow relayed link, where the UI's bundle
// uncompressed took seconds.
//
// BREACH: a compressed response's size can leak a secret in it, when an attacker can also put text of their choosing
// into the same response and watch its size. So only the views in COMPRESSIBLE_API are compressed: event-log views
// with no token, key, CSRF value, one-time code or sign-in link in them. Anything not listed (the hub's /api/me with its
// CSRF token, the first-run steps with sign-in links and device codes, the Claude account, Tailscale, runs, chat,
// audit) never is, and a route added later isn't until someone lists it here. Live streams never are.
import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants, createBrotliCompress, createGzip, gzip, gzipSync, type BrotliCompress, type Gzip } from 'node:zlib';
import type { IncomingMessage } from 'node:http';

export type Encoding = 'br' | 'gzip';

/**
 * The API views that may be compressed, as their path after /api/. Each was checked for BREACH: none carries a
 * secret (a token, key, CSRF value, one-time code or sign-in link), whatever text an issue title or a report puts
 * beside it. INVARIANT: add a view only after checking the same.
 */
export const COMPRESSIBLE_API: ReadonlySet<string> = new Set([
  'state',
  'board',
  'events',
  'prs',
  'test-runs',
  'health',
  'health/incidents',
  'usage',
  'trust',
  'metrics',
  'throughput',
  'waiting',
  'flaky',
  'learnings',
  'harness-evals',
  'goal-graph',
  'checks',
  'intake',
  'constraints',
  'report',
  'settings',
]);

/** Whether an API path (`/api/<view>`) may be compressed: its view is listed in COMPRESSIBLE_API. */
export const mayCompressApi = (pathname: string): boolean => pathname.startsWith('/api/') && COMPRESSIBLE_API.has(pathname.slice('/api/'.length));

/** The encoding a request accepts, brotli first; null when it accepts neither (or refuses both with q=0). */
export function acceptedEncoding(header: string | string[] | undefined): Encoding | null {
  const given = new Map<string, number>();
  for (const part of String(header ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    given.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (n: string) => (given.get(n) ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}

export const requestEncoding = (req: IncomingMessage | undefined): Encoding | null => acceptedEncoding(req?.headers['accept-encoding']);

/** Below this, compressing saves less than it costs. */
export const MIN_COMPRESS_BYTES = 1024;

/** Brotli's quality for a response made per request (a view): fast. Built files are compressed once, at the best. */
const DYNAMIC_BR_QUALITY = 4;

/** A view's body, compressed for this response (fast settings: it is made per request). */
export function compress(body: Buffer, enc: Encoding): Buffer {
  if (enc === 'gzip') return gzipSync(body, { level: 6 });
  return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: DYNAMIC_BR_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
}

/** A stream compressing a view's body on its way through (the hub's forward). */
export function compressStream(enc: Encoding): BrotliCompress | Gzip {
  return enc === 'gzip' ? createGzip() : createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: DYNAMIC_BR_QUALITY } });
}

/** The types worth compressing: text. Images and fonts are compressed already. */
export const compressibleType = (contentType: string) => /^(text\/(?!event-stream)|application\/json|image\/svg\+xml)/.test(contentType);

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Each built file, compressed once per encoding at the best quality (off the main thread, in zlib's pool) and kept
 * while the file is unchanged (its size and time). Requests for a file still being compressed wait for the same result.
 */
export class StaticCompressed {
  private kept = new Map<string, { stamp: string; out: Partial<Record<Encoding, Promise<Buffer>>> }>();
  get(file: string, stamp: string, body: () => Buffer, enc: Encoding): Promise<Buffer> {
    let k = this.kept.get(file);
    if (!k || k.stamp !== stamp) {
      k = { stamp, out: {} };
      this.kept.set(file, k);
    }
    const kept = k;
    const make = () => (enc === 'gzip' ? gzipAsync(body(), { level: 9 }) : brotliAsync(body(), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }));
    return (kept.out[enc] ??= make().catch((e: unknown) => {
      delete kept.out[enc];
      throw e;
    }));
  }
}
