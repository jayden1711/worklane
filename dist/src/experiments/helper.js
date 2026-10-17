// The engine's side of the experiment jobs' root helper (scripts/machine/<cli>-exp.sh): its protocol, the spec it
// reads on stdin, the eval tree's hash it checks, and the run record it prints. The helper decides everything that
// matters itself (root's file); this only says what is asked and reads what happened.
import { createHash } from 'node:crypto';
import { BRAND } from '../brand.js';
import { expBasePath, libexecPath } from '../os/system-paths.js';
/** The helper's PROTOCOL (a test keeps them alike). Bump both when a command's arguments or output change. */
export const EXP_PROTOCOL = 2;
export const EXP_HELPER = libexecPath('exp');
/** A job's directory (its record, logs and outputs; the coordinator's group may read them). */
export const expJobDir = (instance, job) => `${expBasePath()}/${instance}/jobs/${job}`;
/** The spec as the helper reads it on stdin: NAME=value, each then a NUL. Refused here when a value has a newline or NUL. */
export function specText(s) {
    const out = [];
    for (const [k, v] of Object.entries(s)) {
        const text = k === 'DATA' ? v.join(',') : k === 'CONFIG' ? JSON.stringify(v) : String(v);
        if (/[\n\0]/.test(text))
            throw new Error(`spec ${k}: one line, no NUL`);
        if (text.length > 4000)
            throw new Error(`spec ${k}: at most 4000 characters`);
        out.push(`${k}=${text}\0`);
    }
    return out.join('');
}
/** An eval copy's tree hash, as the helper's tree_hash computes it: sha256 of "<sha256>  <path>" lines sorted by path. */
export function evalTreeHash(files) {
    const lines = Object.keys(files)
        .sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0))
        .map((p) => `${createHash('sha256').update(files[p]).digest('hex')}  ${p}\n`);
    return createHash('sha256').update(lines.join('')).digest('hex');
}
/** The record line ("<cli>-exp: record <json>", the last of `job`'s stdout), or null when there is none or it's malformed. */
export function readRecord(stdout) {
    const line = stdout.trimEnd().split('\n').at(-1) ?? '';
    const prefix = `${BRAND.cli}-exp: record `;
    if (!line.startsWith(prefix))
        return null;
    let r;
    try {
        r = JSON.parse(line.slice(prefix.length));
    }
    catch {
        return null;
    }
    const o = r;
    if (o.protocol !== EXP_PROTOCOL || typeof o.job !== 'string' || !['scored', 'crashed', 'stopped'].includes(o.outcome))
        return null;
    if (o.outcome === 'scored' ? typeof o.score !== 'number' || !Number.isFinite(o.score) : o.score !== null)
        return null;
    return o;
}
//# sourceMappingURL=helper.js.map