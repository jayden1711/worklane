import type { Readable, Writable } from 'node:stream';
export interface RpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export declare class RpcError extends Error {
    code: number;
    constructor(code: number, message: string);
}
/** The most one line may hold (a tool result included). A longer line closes the channel. */
export declare const MAX_LINE: number;
export declare class LineChannel {
    private input;
    private output;
    private buf;
    private nextId;
    private pending;
    private closed;
    onMessage: (m: RpcMessage) => void;
    onClose: (why: string) => void;
    constructor(input: Readable, output: Writable);
    private data;
    send(m: RpcMessage): void;
    request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
    close(why: string): void;
    get isClosed(): boolean;
}
