// One newline-delimited JSON-RPC 2.0 channel (MCP's stdio framing) over any readable/writable pair: a child's stdio
// or a socket. Requests out are matched to their responses by id; requests and notifications in go to handlers.
import type { Readable, Writable } from 'node:stream';

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

/** The most one line may hold (a tool result included). A longer line closes the channel. */
export const MAX_LINE = 4 * 1024 * 1024;

export class LineChannel {
  private buf = '';
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  onMessage: (m: RpcMessage) => void = () => {};
  onClose: (why: string) => void = () => {};

  constructor(private input: Readable, private output: Writable) {
    input.on('data', (d: Buffer | string) => this.data(d.toString()));
    input.on('end', () => this.close('the other end closed'));
    input.on('error', (e) => this.close(e.message));
    output.on('error', (e) => this.close(e.message));
  }

  private data(chunk: string): void {
    if (this.closed) return;
    this.buf += chunk;
    if (this.buf.length > MAX_LINE && !this.buf.includes('\n')) return this.close('a message over the size limit');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let m: RpcMessage;
      try {
        m = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // a server's stray log line on stdout: not a message
      }
      if (!m || typeof m !== 'object') continue;
      if (m.method === undefined && m.id !== undefined && m.id !== null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new RpcError(m.error.code, m.error.message));
        else p.resolve(m.result);
        continue;
      }
      this.onMessage(m);
    }
  }

  send(m: RpcMessage): void {
    if (this.closed) return;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('channel closed'));
    const id = `b${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  close(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`channel closed: ${why}`));
    }
    this.pending.clear();
    this.onClose(why);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
