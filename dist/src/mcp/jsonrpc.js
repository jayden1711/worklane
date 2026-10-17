export class RpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** The most one line may hold (a tool result included). A longer line closes the channel. */
export const MAX_LINE = 4 * 1024 * 1024;
export class LineChannel {
    input;
    output;
    buf = '';
    nextId = 1;
    pending = new Map();
    closed = false;
    onMessage = () => { };
    onClose = () => { };
    constructor(input, output) {
        this.input = input;
        this.output = output;
        input.on('data', (d) => this.data(d.toString()));
        input.on('end', () => this.close('the other end closed'));
        input.on('error', (e) => this.close(e.message));
        output.on('error', (e) => this.close(e.message));
    }
    data(chunk) {
        if (this.closed)
            return;
        this.buf += chunk;
        if (this.buf.length > MAX_LINE && !this.buf.includes('\n'))
            return this.close('a message over the size limit');
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line)
                continue;
            let m;
            try {
                m = JSON.parse(line);
            }
            catch {
                continue; // a server's stray log line on stdout: not a message
            }
            if (!m || typeof m !== 'object')
                continue;
            if (m.method === undefined && m.id !== undefined && m.id !== null && this.pending.has(m.id)) {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                clearTimeout(p.timer);
                if (m.error)
                    p.reject(new RpcError(m.error.code, m.error.message));
                else
                    p.resolve(m.result);
                continue;
            }
            this.onMessage(m);
        }
    }
    send(m) {
        if (this.closed)
            return;
        this.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    }
    request(method, params, timeoutMs = 30_000) {
        if (this.closed)
            return Promise.reject(new Error('channel closed'));
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
    close(why) {
        if (this.closed)
            return;
        this.closed = true;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(`channel closed: ${why}`));
        }
        this.pending.clear();
        this.onClose(why);
    }
    get isClosed() {
        return this.closed;
    }
}
//# sourceMappingURL=jsonrpc.js.map