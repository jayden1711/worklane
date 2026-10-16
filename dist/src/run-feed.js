// A live run's feed: what the agent is doing as it happens, for the console's
// live view (served over SSE by the dashboard). Built by the runner from the
// same stream-json lines the run record reads (run-record.ts is the
// after-the-fact summary of the same run, under the same id), redacted with
// the event log's secret patterns before anything is written, and capped per
// run (bytes and lines) with one truncation marker. One JSON line per item in
// <state dir>/runs/<run id>.feed.jsonl, ended by an "end" item. A feed problem
// never affects the run.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './events/redact.js';
import { groupOnlyDir } from './os/index.js';
import { RUNS_DIR } from './run-record.js';
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const FEED_MAX_LINES = 5000;
const MAX_TEXT = 8000;
const MAX_INPUT = 4000;
const MAX_OUTPUT = 4000;
const MAX_OUTPUT_LINES = 60;
const MAX_DIFF = 8000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)} … [${s.length - n} more chars]` : s);
const clipLines = (s, lines, chars) => {
    const all = s.split('\n');
    const head = all.slice(0, lines).join('\n');
    return clip(all.length > lines ? `${head}\n… [${all.length - lines} more lines]` : head, chars);
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === 'object' && 'text' in x ? String(x.text ?? '') : '')).join('') : '');
const lines = (s, mark) => (s === '' ? [] : s.replace(/\n$/, '').split('\n').map((l) => `${mark}${l}`));
/** A file write as a diff: an edit's old and new text, or a written file's whole content. */
export function writeDiff(tool, input, file) {
    const head = [`--- a/${file}`, `+++ b/${file}`];
    if (tool === 'Write')
        return [...head, ...lines(String(input.content ?? ''), '+')].join('\n');
    if (tool === 'Edit')
        return [...head, '@@', ...lines(String(input.old_string ?? ''), '-'), ...lines(String(input.new_string ?? ''), '+')].join('\n');
    if (tool === 'MultiEdit')
        return [...head, ...(input.edits ?? []).flatMap((e) => ['@@', ...lines(String(e.old_string ?? ''), '-'), ...lines(String(e.new_string ?? ''), '+')])].join('\n');
    return [...head, '@@', ...lines(String(input.new_source ?? ''), '+')].join('\n');
}
export class RunFeed {
    caps;
    now;
    seq = 0;
    bytes = 0;
    count = 0;
    full = false;
    ended = false;
    file;
    constructor(stateDir, o, caps = { bytes: FEED_MAX_BYTES, lines: FEED_MAX_LINES }, now = () => new Date()) {
        this.caps = caps;
        this.now = now;
        const dir = join(stateDir, RUNS_DIR);
        this.file = join(dir, `${o.run}.feed.jsonl`);
        this.cwd = o.cwd.replace(/[\\/]+$/, '');
        try {
            groupOnlyDir(dir);
        }
        catch {
            // the feed is best effort
        }
        this.push({ kind: 'start', run: o.run, issue: o.issue, role: o.role, model: o.model });
    }
    cwd;
    /** One stream-json line from the session. */
    line(j) {
        try {
            const m = j;
            const content = Array.isArray(m.message?.content) ? m.message.content : [];
            if (m.type === 'assistant') {
                for (const c of content) {
                    if (c.type === 'text' && typeof c.text === 'string' && c.text.trim())
                        this.push({ kind: 'text', text: clip(c.text, MAX_TEXT) });
                    else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim())
                        this.push({ kind: 'thinking', text: clip(c.thinking, MAX_TEXT) });
                    else if (c.type === 'tool_use') {
                        const id = String(c.id ?? '');
                        const tool = String(c.name ?? '');
                        const input = (c.input ?? {});
                        if (WRITE_TOOLS.has(tool)) {
                            const file = this.relative(String(input.file_path ?? input.notebook_path ?? ''));
                            this.push({ kind: 'tool', id, tool, input: JSON.stringify({ file_path: file }) });
                            this.push({ kind: 'diff', id, tool, file, diff: clip(writeDiff(tool, input, file), MAX_DIFF) });
                        }
                        else
                            this.push({ kind: 'tool', id, tool, input: clip(JSON.stringify(input), MAX_INPUT) });
                    }
                }
            }
            else if (m.type === 'user') {
                for (const c of content) {
                    if (c.type !== 'tool_result' || typeof c.tool_use_id !== 'string')
                        continue;
                    this.push({ kind: 'tool_result', id: c.tool_use_id, status: c.is_error ? 'error' : 'ok', output: clipLines(textOf(c.content).trim(), MAX_OUTPUT_LINES, MAX_OUTPUT) });
                }
            }
        }
        catch {
            // a line we can't read is left out
        }
    }
    message(id, state, text) {
        this.push({ kind: 'message', id, state, ...(text !== undefined ? { text: clip(text, MAX_TEXT) } : {}) });
    }
    /** The last item: always written, even past the cap. */
    end(e) {
        if (this.ended)
            return;
        this.write({ kind: 'end', reason: e.reason, costUsd: e.costUsd, turns: e.turns }, true);
        this.ended = true;
    }
    push(body) {
        if (this.ended || this.full)
            return;
        this.write(body, false);
    }
    write(body, force) {
        try {
            const item = redact({ seq: this.seq, at: this.now().toISOString(), ...body });
            const line = `${JSON.stringify(item)}\n`;
            const len = Buffer.byteLength(line);
            // Room is kept for the truncation marker and the end item.
            if (!force && (this.bytes + len > this.caps.bytes - 512 || this.count + 1 > this.caps.lines - 2)) {
                this.full = true;
                this.write({ kind: 'truncated', why: this.bytes + len > this.caps.bytes - 512 ? 'bytes' : 'lines' }, true);
                return;
            }
            appendFileSync(this.file, line, { mode: 0o600 });
            this.seq++;
            this.bytes += len;
            this.count++;
        }
        catch {
            // the feed is best effort
        }
    }
    /** A path inside the worktree as the repo names it: relative, with forward slashes on every OS. */
    relative(p) {
        return p.startsWith(this.cwd + '/') || p.startsWith(this.cwd + '\\') ? p.slice(this.cwd.length + 1).split('\\').join('/') : p;
    }
}
const VALID_ID = /^[A-Za-z0-9_-]+$/;
/** A run's feed items after `after` (a seq; -1 for all), and whether the feed has ended. Never a path outside the runs dir. */
export function readFeed(stateDir, run, after = -1) {
    if (!VALID_ID.test(run))
        return null;
    const f = join(stateDir, RUNS_DIR, `${run}.feed.jsonl`);
    if (!existsSync(f))
        return null;
    const items = [];
    let ended = false;
    for (const l of readFileSync(f, 'utf8').split('\n')) {
        if (!l)
            continue;
        try {
            const it = JSON.parse(l);
            if (it.kind === 'end')
                ended = true;
            if (it.seq > after)
                items.push(it);
        }
        catch {
            // a partly written last line: read again later
        }
    }
    return { items, ended };
}
//# sourceMappingURL=run-feed.js.map