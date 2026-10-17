import { type BrotliCompress, type Gzip } from 'node:zlib';
import type { IncomingMessage } from 'node:http';
export type Encoding = 'br' | 'gzip';
/**
 * The API views that may be compressed, as their path after /api/. Each was checked for BREACH: none carries a
 * secret (a token, key, CSRF value, one-time code or sign-in link), whatever text an issue title or a report puts
 * beside it. INVARIANT: add a view only after checking the same.
 */
export declare const COMPRESSIBLE_API: ReadonlySet<string>;
/** Whether an API path (`/api/<view>`) may be compressed: its view is listed in COMPRESSIBLE_API. */
export declare const mayCompressApi: (pathname: string) => boolean;
/** The encoding a request accepts, brotli first; null when it accepts neither (or refuses both with q=0). */
export declare function acceptedEncoding(header: string | string[] | undefined): Encoding | null;
export declare const requestEncoding: (req: IncomingMessage | undefined) => Encoding | null;
/** Below this, compressing saves less than it costs. */
export declare const MIN_COMPRESS_BYTES = 1024;
/** A view's body, compressed for this response (fast settings: it is made per request). */
export declare function compress(body: Buffer, enc: Encoding): Buffer;
/** A stream compressing a view's body on its way through (the hub's forward). */
export declare function compressStream(enc: Encoding): BrotliCompress | Gzip;
/** The types worth compressing: text. Images and fonts are compressed already. */
export declare const compressibleType: (contentType: string) => boolean;
/**
 * Each built file, compressed once per encoding at the best quality (off the main thread, in zlib's pool) and kept
 * while the file is unchanged (its size and time). Requests for a file still being compressed wait for the same result.
 */
export declare class StaticCompressed {
    private kept;
    get(file: string, stamp: string, body: () => Buffer, enc: Encoding): Promise<Buffer>;
}
