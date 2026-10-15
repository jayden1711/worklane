// Which server and channels each instance's bot acts in, machine-wide. Several instances may use one bot token
// (one bot in several servers), and two may even share a server, but never a channel: two coordinators reading the
// same channel would both take, answer and post on the same messages. So before an instance's bot connects:
// - every instance's intake.yaml this user can read (the instances dir: on a single-user machine, all of them) is
//   read, and
// - every running instance's claim (a file in the machine-wide slot directory, which every instance's coordinator
//   user can write, written when its bot connects and removed when it stops) is read: with one coordinator user per
//   instance, their homes are private to each other, so the claims are how they see each other.
// Any other instance on the same server with a channel in common (its ideas channels, asks channel or chat
// channels) refuses this instance's Discord at start-up, naming it. A claim holds no ids: each server+channel pair
// is a hash, so the shared directory names no server, channel or person.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { tryLock } from '../locks.js';
import { pidAlive } from '../os/index.js';
import { INTAKE_FILE } from './config.js';
import { IntakeConfig } from './report.js';
const CLAIM_PREFIX = 'discord-claim-';
const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** The server and channels an instance's bot acts in: its ideas channels, asks channel and chat channels. Null: Discord off. */
export function discordPlaces(cfg) {
    const d = cfg.discord;
    if (!d.enabled || !d.guild)
        return null;
    return { guild: d.guild, channels: [...new Set([...d.channels, ...(d.asks_channel ? [d.asks_channel] : []), ...d.chat_channels])] };
}
/** One server+channel pair, hashed: what a claim file holds. */
export const placeKey = (guild, channel) => createHash('sha256').update(`discord\0${guild}\0${channel}`).digest('hex').slice(0, 32);
function readClaims(dir) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const f of readdirSync(dir)) {
        if (!f.startsWith(CLAIM_PREFIX) || !f.endsWith('.json'))
            continue;
        try {
            const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
            if (typeof c.instance === 'string' && Number.isInteger(c.pid) && Array.isArray(c.places))
                out.push(c);
        }
        catch {
            // half-written or unreadable: not a claim
        }
    }
    return out;
}
/** Another instance's intake.yaml, read for its places only (null when it can't be read or isn't valid). */
function otherConfig(file) {
    try {
        const r = IntakeConfig.safeParse(parse(readFileSync(file, 'utf8')));
        return r.success ? r.data : null;
    }
    catch {
        return null;
    }
}
/**
 * Why this instance's Discord may not start (another instance on the machine claims one of its server+channel
 * pairs), or null. `instancesDir`: where the instances' homes are (each `<name>/intake.yaml`); `claimsDir`: the
 * machine-wide directory of running bots' claims.
 */
export function discordClash(o) {
    const mine = discordPlaces(o.config);
    if (!mine)
        return null;
    const keys = new Map(mine.channels.map((c) => [placeKey(mine.guild, c), c]));
    const clash = (other, theirs, how) => {
        const shared = [...theirs].map((k) => keys.get(k)).filter((c) => !!c);
        return shared.length ? `instance "${other}" (${how}) also acts in server ${mine.guild}, channel${shared.length > 1 ? 's' : ''} ${[...new Set(shared)].join(', ')}; two instances may share a server only with different channels: give each its own channels in its intake.yaml` : null;
    };
    if (existsSync(o.instancesDir)) {
        for (const e of readdirSync(o.instancesDir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name === o.instance)
                continue;
            const cfg = otherConfig(join(o.instancesDir, e.name, INTAKE_FILE));
            const p = cfg ? discordPlaces(cfg) : null;
            if (!p || p.guild !== mine.guild)
                continue;
            const why = clash(e.name, p.channels.map((c) => placeKey(p.guild, c)), 'its intake.yaml');
            if (why)
                return why;
        }
    }
    const alive = o.alive ?? pidAlive;
    for (const c of readClaims(o.claimsDir)) {
        if (c.instance === o.instance || !alive(c.pid))
            continue;
        const why = clash(c.instance, c.places, 'its running bot');
        if (why)
            return why;
    }
    return null;
}
/** Record this instance's places while its bot runs; returns the release. */
export function writeDiscordClaim(o) {
    const p = discordPlaces(o.config);
    if (!p || !INSTANCE_NAME.test(o.instance))
        return () => { };
    const file = join(o.claimsDir, `${CLAIM_PREFIX}${o.instance}.json`);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify({ instance: o.instance, pid: process.pid, places: p.channels.map((c) => placeKey(p.guild, c)) }));
    renameSync(tmp, file);
    return () => {
        try {
            const c = JSON.parse(readFileSync(file, 'utf8'));
            if (c.pid === process.pid)
                unlinkSync(file);
        }
        catch {
            // gone already
        }
    };
}
/**
 * Check and claim in one step, under a machine-wide lock, so two instances starting at once can't both pass the
 * check: the claim's release, or why this instance's Discord is refused.
 */
export async function claimDiscord(o) {
    mkdirSync(o.claimsDir, { recursive: true });
    const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < 200; i++) {
        const r = tryLock(join(o.claimsDir, 'discord-claims.lock'), `discord claim ${o.instance}`);
        if (!('lock' in r)) {
            await sleep(100);
            continue;
        }
        try {
            const why = discordClash(o);
            return why ? { error: why } : { release: writeDiscordClaim(o) };
        }
        finally {
            r.lock.release();
        }
    }
    return { error: 'the machine-wide Discord claims lock stayed held; try again' };
}
//# sourceMappingURL=discord-claims.js.map