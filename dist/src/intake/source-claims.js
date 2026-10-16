// Which Slack app and which Linear team+label each running instance takes, machine-wide (docs/intake.md 2.7, 2.8).
// - Slack: Slack hands each event to only ONE of an app's open Socket Mode connections, so two instances on one app
//   would each miss part of the messages. The app is known by its bot user in its workspace (auth.test), the same
//   whichever of the app's tokens an instance holds.
// - Linear: two instances taking the same team's issues with the same label would both triage and answer them.
// A claim is a file in the machine-wide slot directory (which every instance's coordinator user can write), written
// when the source starts and removed when it stops; a dead process's claim doesn't count. It holds only a hash: the
// shared directory names no workspace, app, team, label or person. Checked and written under one lock, so two
// instances starting at once can't both pass.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock } from '../locks.js';
import { pidAlive } from '../os/index.js';
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** What a claim holds: a hash of what the source takes (Slack: workspace + bot user; Linear: team + label). */
export const claimKey = (kind, ...parts) => createHash('sha256').update([kind, ...parts].join('\0')).digest('hex').slice(0, 32);
const prefix = (kind) => `${kind}-claim-`;
function readClaims(dir, kind) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const f of readdirSync(dir)) {
        if (!f.startsWith(prefix(kind)) || !f.endsWith('.json'))
            continue;
        try {
            const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            if (typeof c.instance === 'string' && Number.isInteger(c.pid) && typeof c.key === 'string')
                out.push(c);
        }
        catch {
            // half-written or unreadable: not a claim
        }
    }
    return out;
}
const WHAT = {
    slack: 'the same Slack app (Slack gives each event to only one of an app\'s connections): give each instance its own Slack app',
    linear: 'the same Linear team and label: give each instance its own label (or team)',
};
/**
 * Check and claim in one step: the claim's release, or why this instance's source is refused (another live instance
 * on the machine claims the same key).
 */
export async function claimSource(o) {
    mkdirSync(o.claimsDir, { recursive: true });
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const alive = o.alive ?? pidAlive;
    for (let i = 0; i < 200; i++) {
        const r = tryLock(join(o.claimsDir, `${o.kind}-claims.lock`), `${o.kind} claim ${o.instance}`);
        if (!('lock' in r)) {
            await sleep(100);
            continue;
        }
        try {
            const other = readClaims(o.claimsDir, o.kind).find((c) => c.instance !== o.instance && c.key === o.key && alive(c.pid));
            if (other)
                return { error: `instance "${other.instance}" (its running ${o.kind} source) already takes ${WHAT[o.kind]}` };
            if (!INSTANCE_NAME.test(o.instance))
                return { release: () => { } };
            const file = join(o.claimsDir, `${prefix(o.kind)}${o.instance}.json`);
            const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
            writeFileSync(tmp, JSON.stringify({ instance: o.instance, pid: process.pid, key: o.key }));
            renameSync(tmp, file);
            return {
                release: () => {
                    try {
                        const c = JSON.parse(readFileSync(file, 'utf8'));
                        if (c.pid === process.pid)
                            unlinkSync(file);
                    }
                    catch {
                        // gone already
                    }
                },
            };
        }
        finally {
            r.lock.release();
        }
    }
    return { error: `the machine-wide ${o.kind} claims lock stayed held; try again` };
}
//# sourceMappingURL=source-claims.js.map