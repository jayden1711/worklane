// A server-sent event stream read with fetch, so the dashboard key goes in a header like every other API call.
// WHY not EventSource: it can't send headers, so the key had to ride in the URL, where proxy logs, history and
// referrers keep it. This does what the page needed from EventSource: named events, reconnecting after a drop
// (with Last-Event-ID when the server sends ids, and the server's `retry:`), and stopping on close().

/** One event as the server framed it. */
export interface StreamEvent {
  type: string;
  data: string;
  /** The last id the server sent on this stream ('' before any). */
  lastEventId: string;
}

export interface StreamOptions {
  /** The headers each connection sends (asked again on every reconnect): the key, never the URL. */
  headers: () => Record<string, string> | Promise<Record<string, string>>;
  /** Handlers by event type (`message` for frames without an `event:` line). */
  on: Record<string, (e: StreamEvent) => void>;
  /** Each time a connection is answered 200. */
  onOpen?: () => void;
  /** A connection failed or dropped. `final` when it won't be retried (the server refused: 4xx). */
  onError?: (why: string, final: boolean) => void;
  fetch?: typeof fetch;
  /** The first wait before reconnecting, unless the server's `retry:` says otherwise; doubled per failure up to maxDelayMs. */
  delayMs?: number;
  maxDelayMs?: number;
}

export interface Stream {
  close(): void;
}

/** Split SSE text into frames and fields (the WHATWG event-stream format). Keeps the partial tail between chunks. */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private type = '';
  lastEventId = '';
  retryMs: number | null = null;
  constructor(private emit: (e: StreamEvent) => void) {}

  /** A new connection: a half-read frame from the dropped one is discarded (its id and retry are kept). */
  reset(): void {
    this.buf = '';
    this.data = [];
    this.type = '';
  }

  push(text: string): void {
    this.buf += text;
    // A line ends at \r\n, \n or \r; a trailing \r may be the first half of \r\n, so it waits for the next chunk.
    for (;;) {
      const m = /\r\n|\n|\r(?!$)/.exec(this.buf);
      if (!m) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.type = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retryMs = Number(value);
  }

  private dispatch(): void {
    const type = this.type || 'message';
    const data = this.data.join('\n');
    const had = this.data.length > 0;
    this.type = '';
    this.data = [];
    if (had) this.emit({ type, data, lastEventId: this.lastEventId });
  }
}

/**
 * Open a stream at `url` (a path; never one carrying a key). It reconnects after a drop until close(); a 4xx answer
 * (refused, not found) ends it, as EventSource would.
 */
export function openStream(url: string | Promise<string>, o: StreamOptions): Stream {
  const get = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = o.delayMs ?? 1_000;
  const max = o.maxDelayMs ?? 30_000;
  let closed = false;
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const parser = new SseParser((e) => {
    if (!closed) o.on[e.type]?.(e);
  });

  const again = (why: string) => {
    if (closed) return;
    o.onError?.(why, false);
    const wait = Math.min(max, (parser.retryMs ?? base) * 2 ** Math.min(failures, 10));
    failures++;
    timer = setTimeout(() => void connect(), wait);
  };

  const connect = async () => {
    if (closed) return;
    abort = new AbortController();
    try {
      const path = await url;
      const headers: Record<string, string> = { accept: 'text/event-stream', ...(await o.headers()) };
      if (parser.lastEventId) headers['last-event-id'] = parser.lastEventId;
      const res = await get(path, { headers, signal: abort.signal, cache: 'no-store', credentials: 'same-origin' });
      if (closed) return;
      if (res.status >= 400 && res.status < 500) {
        closed = true;
        void res.body?.cancel().catch(() => undefined);
        return o.onError?.(`HTTP ${res.status}`, true);
      }
      if (!res.ok || !res.body) return again(`HTTP ${res.status}`);
      failures = 0;
      parser.reset();
      o.onOpen?.();
      const reader = res.body.getReader();
      const text = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(text.decode(value, { stream: true }));
        if (closed) {
          void reader.cancel().catch(() => undefined);
          return;
        }
      }
      again('the stream ended');
    } catch (e) {
      if (closed) return;
      again((e as Error).message || 'the stream failed');
    }
  };

  void connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      abort?.abort();
    },
  };
}
