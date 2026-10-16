// WHY: the first-run page's Discord step (wizard screen 11; the setup audit's row 27) for a server instance: store
// the bot token, invite the bot with exactly the permissions intake needs, pick the server and channels from the
// bot's own view, and write those picks into intake.yaml after an owner has seen the exact diff and confirmed it.
//
// INVARIANT: this module, and so the dashboard's process, never reads the bot token. It knows the token file's path
// (credentials.yaml intake.discord_token) and whether a file is there, and nothing more. What needs the token (the
// bot's application and its channels) comes from a child process, `discord channels --json`
// (src/intake/discord-channels.ts), which reads the token itself, as the instance's user, and prints no secret. A
// pasted token goes through the setup console's paste_secret ask (src/console/secrets.ts): browser to file, 0400.
//
// Opening the step, loading the channels and reviewing a change write nothing: only a confirmed change does, and
// only to intake.yaml.
import { outboundEnv } from '../network.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { asks } from '../console/asks.js';
import { CredentialsFile, setDiscordToken } from '../instance.js';
import { currentUser, replaceFileAtomically } from '../os/index.js';
import { instanceUnit } from '../service.js';
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import { IntakeConfig, intakeWarnings } from './report.js';
export class DiscordSetupError extends Error {
    status;
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}
/** The paste_secret ask's credential name (the file's name in the instance's secrets directory). */
export const DISCORD_CREDENTIAL = 'intake-discord';
export const DISCORD_PORTAL = 'https://discord.com/developers/applications';
/** What a bot token looks like, as credentials.sh intake-discord checks it. */
export const DISCORD_TOKEN_SHAPE = /^[A-Za-z0-9._-]{50,100}$/;
/**
 * The permissions the invite link asks for: exactly what intake's bot does (src/intake/discord.ts), each a bit of
 * Discord's permission integer. Nothing else: no reading history, no managing anything, no mentioning everyone.
 * docs/intake.md lists the same four, and test/discord-setup.test.ts holds the integer.
 */
export const INVITE_PERMISSIONS = [
    { name: 'View Channels', bit: 10, why: 'see the channels it is added to and receive their messages' },
    { name: 'Send Messages', bit: 11, why: 'reply, and post decisions, incidents, merges and what the superfan finds' },
    { name: 'Create Public Threads', bit: 35, why: 'open one thread per idea, decision or setup ask' },
    { name: 'Send Messages in Threads', bit: 38, why: 'answer inside those threads' },
];
export const INVITE_PERMISSION_INTEGER = INVITE_PERMISSIONS.reduce((n, p) => n | (1n << BigInt(p.bit)), 0n).toString();
/** The bot's invite link: the `bot` scope only, with those permissions. `applicationId` is the bot's own (digits). */
export function inviteUrl(applicationId) {
    if (!/^\d{5,25}$/.test(applicationId))
        throw new DiscordSetupError('the application id must be digits');
    return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${INVITE_PERMISSION_INTEGER}`;
}
const MAX_OUTPUT = 4 * 1024 * 1024;
/** This engine's own CLI, by absolute path: the one binary the listing ever runs. */
export const ENGINE_CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
/**
 * The environment the child gets: this process's, less what would make node load other code (NODE_OPTIONS can
 * --require or --import a file; NODE_PATH adds module directories). Nothing in it chooses the binary: that is
 * process.execPath and ENGINE_CLI, both absolute.
 */
export function listingEnv(env = process.env) {
    const { NODE_OPTIONS: _o, NODE_PATH: _p, ...rest } = env;
    // INVARIANT: and no host-redirect variable (src/network.ts, #391): the child carries the bot token.
    return outboundEnv(rest);
}
/**
 * The listing as a child process, run as this process's user (an instance's dashboard runs as its coordinator user):
 * always this node binary (process.execPath) running this engine's own cli.js (ENGINE_CLI), both absolute paths.
 * INVARIANT: no PATH lookup, and no option, environment variable, config key or request can change which binary runs;
 * the only other way the dashboard gets the listing is an in-process stand-in (discordListingStandIn), set in code.
 */
export function engineRunCli() {
    return (args) => new Promise((resolve) => {
        const p = spawn(process.execPath, [ENGINE_CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, env: listingEnv() });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (c) => {
            if (stdout.length < MAX_OUTPUT)
                stdout += c.toString('utf8');
        });
        p.stderr.on('data', (c) => {
            if (stderr.length < 16_384)
                stderr += c.toString('utf8');
        });
        p.on('error', (e) => resolve({ status: null, stdout: '', stderr: e.message }));
        p.on('close', (status) => resolve({ status, stdout, stderr }));
    });
}
const STAND_IN = Symbol('a Discord listing stand-in');
/** The stand-ins discordListingStandIn made: a copy or a look-alike is not one. */
const MINTED = new WeakSet();
/**
 * The one seam: code (a test, a CI helper) hands the dashboard an answer to give instead of running the listing. It
 * is set in code only: it is a value no configuration, environment, PATH or request can produce, and it starts no
 * binary of its own choosing; it answers in-process.
 */
export function discordListingStandIn(answer) {
    if (typeof answer !== 'function')
        throw new DiscordSetupError('a stand-in is a function that answers the listing');
    const standIn = Object.freeze({ [STAND_IN]: answer });
    MINTED.add(standIn);
    return standIn;
}
/**
 * The listing the dashboard uses: the engine's own CLI, or a stand-in made by discordListingStandIn. Anything else (a
 * function, a path, an object naming a binary) is refused, so no option can point it at another program.
 */
export function listingRunner(standIn) {
    if (standIn === undefined)
        return engineRunCli();
    const answer = standIn !== null && typeof standIn === 'object' && MINTED.has(standIn) ? standIn[STAND_IN] : undefined;
    if (typeof answer !== 'function')
        throw new DiscordSetupError("the Discord listing runs this engine's own CLI; only a stand-in made in code by discordListingStandIn may replace it");
    return answer;
}
const snowflake = z.string().regex(/^\d{5,25}$/);
const ChannelsOutput = z.object({
    application: z.object({ id: snowflake, name: z.string().max(200), message_content: z.boolean() }),
    channels: z.array(z.object({ guild_id: snowflake, guild: z.string().max(200), id: snowflake, name: z.string().max(200), type: z.number().int() })).max(20_000),
});
/**
 * The bot's application and the channels it can see, from `discord channels --instance <name> --json` run as a child
 * process. A failure is the child's own one-line message (it scrubs the token from everything it prints).
 */
export async function botView(instance, run) {
    const r = await run(['discord', 'channels', '--instance', instance, '--json']);
    if (r.status !== 0) {
        const line = r.stderr.trim().split('\n').at(-1)?.trim() ?? '';
        throw new DiscordSetupError((line || `the listing ended with status ${r.status ?? 'unknown'}`).slice(0, 400), 502);
    }
    let out;
    try {
        out = ChannelsOutput.parse(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? ''));
    }
    catch {
        throw new DiscordSetupError("the listing's output could not be read", 502);
    }
    return { application: out.application, invite: inviteUrl(out.application.id), channels: out.channels, at: new Date().toISOString() };
}
export function tokenState(credentialsFile) {
    let file;
    try {
        const r = CredentialsFile.safeParse(parse(readFileSync(credentialsFile, 'utf8')));
        if (!r.success)
            return { configured: false, file: null, present: false, error: `${credentialsFile} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
        file = r.data.intake?.discord_token;
    }
    catch (e) {
        return { configured: false, file: null, present: false, error: `can't read ${credentialsFile} (${e.code ?? 'error'})` };
    }
    // INVARIANT: existence only; the token file is never opened here.
    return { configured: !!file, file: file ?? null, present: !!file && existsSync(file), error: null };
}
/** The setup console's rule for a pasted bot token: its shape, then credentials.yaml pointed at the installed file. */
export function discordTokenRule(o) {
    return {
        shape: { re: DISCORD_TOKEN_SHAPE, what: "that doesn't look like a Discord bot token (the Bot page's Reset Token gives one); nothing stored" },
        stored: (ask, file) => {
            if (ask.instance !== o.instance)
                throw new Error(`the ask is for instance ${ask.instance}, not ${o.instance}`);
            setDiscordToken(o.credentialsFile, file);
            o.onStored?.();
            return 'credentials.yaml intake.discord_token now names it';
        },
    };
}
const openTokenAsk = (all, instance) => all.find((a) => a.kind === 'paste_secret' && a.credential === DISCORD_CREDENTIAL && a.instance === instance && a.status === 'open') ?? null;
/** The open paste box for this instance's bot token: the one already waiting, or a new ask. Nothing is stored yet. */
export function tokenAsk(log, instance, by) {
    const a = asks(log);
    const open = openTokenAsk(a.list({ instance }), instance);
    if (open)
        return { ask: open, created: false };
    const ask = a.create({
        kind: 'paste_secret',
        instance,
        title: 'Paste the Discord bot token',
        detail: "From Discord's developer portal: your application, Bot, Reset Token. It goes straight to a file only this instance's coordinator user can read (0400), and credentials.yaml intake.discord_token is pointed at it. It is never shown again.",
        credential: DISCORD_CREDENTIAL,
        where: 'credentials.yaml intake.discord_token',
    }, by);
    return { ask, created: true };
}
/** The intake.yaml keys this step writes, and nothing else in the file. */
export const INTAKE_FORM = [
    { key: 'discord.enabled', kind: 'boolean', what: 'the bot connects' },
    { key: 'discord.guild', kind: 'guild', what: 'the one server the bot reads' },
    { key: 'discord.channels', kind: 'ids', what: 'the channels reports and ideas are taken from' },
    { key: 'discord.asks_channel', kind: 'id', what: 'where decisions and setup asks are posted, one thread each' },
    { key: 'discord.ops_channel', kind: 'id', what: 'where incidents, merges and the weekly digest are posted (never read)' },
    { key: 'discord.chat_channels', kind: 'ids', what: 'where the bot answers questions about the code and the instance' },
    { key: 'discord.dashboard_url', kind: 'url', what: "the dashboard's https address, for the links a post carries (needed with the asks or ops channel)" },
    { key: 'superfan.enabled', kind: 'boolean', what: 'the superfan watches this instance' },
    { key: 'superfan.channel', kind: 'id', what: 'where the superfan posts about this instance (a channel of its own)' },
    { key: 'superfan.machine_channel', kind: 'id', what: 'where it posts about the engine and updater (a channel of its own)' },
];
export const INTAKE_FORM_KEYS = INTAKE_FORM.map((f) => f.key);
/** Channels the bot reads: each must be in the chosen server. */
const READ_KEYS = ['discord.channels', 'discord.asks_channel', 'discord.chat_channels'];
const at = (cfg, key) => {
    const [a, b] = key.split('.');
    const v = cfg[a][b];
    return v === undefined ? null : v;
};
/** The form's keys as the config has them (its defaults applied). */
export const intakeFormValues = (cfg) => Object.fromEntries(INTAKE_FORM_KEYS.map((k) => [k, at(cfg, k)]));
function normalize(key, kind, v) {
    const bad = (what) => new DiscordSetupError(`${key}: ${what}`);
    if (kind === 'boolean') {
        if (typeof v !== 'boolean')
            throw bad('must be true or false');
        return v;
    }
    if (kind === 'ids') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !/^\d{5,25}$/.test(x)))
            throw bad('must be a list of channel ids (digits)');
        return [...new Set(v)];
    }
    if (v === null || v === '')
        return null;
    if (typeof v !== 'string')
        throw bad('must be text');
    if (kind !== 'url' && !/^\d{5,25}$/.test(v))
        throw bad('must be an id (digits)');
    return v;
}
/**
 * The change these values make to intake.yaml, or why it is refused. Nothing is written.
 * - Only INTAKE_FORM's keys; every other key and comment of the file is kept.
 * - A newly picked server or channel must be one the bot can see (`channels`, the bot's own list).
 * - A channel the bot reads (discord.channels, asks_channel, chat_channels) must be in the chosen server.
 * - A superfan channel is never one the bot reads: the schema's rule, held here whether or not the superfan is on.
 * - The result must pass the intake schema (src/intake/report.ts).
 */
export function planIntake(o) {
    const unknown = Object.keys(o.values).filter((k) => !INTAKE_FORM_KEYS.includes(k));
    if (unknown.length)
        throw new DiscordSetupError(`not set here: ${unknown.join(', ')}; this step writes ${INTAKE_FORM_KEYS.join(', ')}`);
    const loaded = loadIntakeConfig(o.path);
    if (loaded && 'error' in loaded)
        throw new DiscordSetupError(`refused: ${loaded.error}`);
    const before = loaded ? readFileSync(o.path, 'utf8') : null;
    const doc = parseDocument(before ?? 'version: 1\n');
    const cfg = loaded?.config ?? IntakeConfig.parse({ version: 1 });
    const byId = new Map(o.channels.map((c) => [c.id, c]));
    const guilds = new Map(o.channels.map((c) => [c.guild_id, c.guild]));
    const changes = [];
    for (const f of INTAKE_FORM) {
        if (!Object.hasOwn(o.values, f.key))
            continue;
        const to = normalize(f.key, f.kind, o.values[f.key]);
        const from = at(cfg, f.key);
        if (JSON.stringify(from) === JSON.stringify(to))
            continue;
        // INVARIANT: an id comes from the bot's own list, never typed in; one already in the file stays as it is.
        const had = new Set(Array.isArray(from) ? from : typeof from === 'string' ? [from] : []);
        const added = (Array.isArray(to) ? to : typeof to === 'string' && f.kind !== 'url' ? [to] : []).filter((id) => !had.has(id));
        for (const id of added) {
            if (f.kind === 'guild' ? !guilds.has(id) : !byId.has(id))
                throw new DiscordSetupError(`refused: ${f.key}: ${id} is not a ${f.kind === 'guild' ? 'server' : 'channel'} the bot can see; pick one from its list (load it again if the bot was only just invited)`);
        }
        const path = f.key.split('.');
        if (to === null)
            doc.deleteIn(path);
        else
            doc.setIn(path, to);
        changes.push({ key: f.key, from, to });
    }
    if (!changes.length)
        throw new DiscordSetupError('nothing to change');
    const parsed = IntakeConfig.safeParse(doc.toJS());
    if (!parsed.success)
        throw new DiscordSetupError(`refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const next = parsed.data;
    const problems = [];
    const name = (id) => (byId.has(id) ? `#${byId.get(id).name}` : id);
    const read = [...next.discord.channels, ...next.discord.chat_channels, ...(next.discord.asks_channel ? [next.discord.asks_channel] : [])];
    if (read.length && !next.discord.guild)
        problems.push('discord.guild: pick the server first; the bot reads one server only');
    for (const key of READ_KEYS) {
        const v = at(next, key);
        for (const id of Array.isArray(v) ? v : typeof v === 'string' ? [v] : []) {
            const row = byId.get(id);
            if (row && next.discord.guild && row.guild_id !== next.discord.guild)
                problems.push(`${key}: ${name(id)} is in ${row.guild}, not the chosen server (${guilds.get(next.discord.guild) ?? next.discord.guild}); the bot reads one server only`);
        }
    }
    for (const [k, ch] of [['channel', next.superfan.channel], ['machine_channel', next.superfan.machine_channel]]) {
        if (ch && read.includes(ch))
            problems.push(`superfan.${k}: ${name(ch)} is a channel the bot reads (discord.channels, chat_channels or asks_channel); a superfan needs a channel of its own`);
    }
    if (problems.length)
        throw new DiscordSetupError(`refused: ${problems.join('; ')}`);
    // WHY: no re-wrapping of long lines; what YAML still normalizes (the spacing inside a [ ] or { }) is in the diff.
    const text = doc.toString({ lineWidth: 0 });
    return {
        file: o.path,
        creates: before === null,
        changes,
        diff: lineDiff(before, text, INTAKE_FILE),
        hash: createHash('sha256').update(JSON.stringify([before, text])).digest('hex'),
        warnings: intakeWarnings(next),
        text,
    };
}
/**
 * Write a confirmed change: planned again (the file or the bot's list may have changed since), and written only when
 * that is the very change the owner was shown (`expect`, the plan's hash). Renamed into place, 0600.
 */
export function applyIntake(o) {
    const plan = planIntake(o);
    if (plan.hash !== o.expect)
        throw new DiscordSetupError(`${INTAKE_FILE} or the bot's channels changed since the change was shown: nothing written; review it again`, 409);
    replaceFileAtomically(o.path, plan.text, 0o600, dirname(o.path));
    const check = loadIntakeConfig(o.path);
    if (!check || 'error' in check)
        throw new DiscordSetupError(`${INTAKE_FILE} was written, but it does not load: ${check ? check.error : 'it is missing'}`, 409);
    return plan;
}
/** A unified diff of two texts by line, three lines of context; `before` null is a file that doesn't exist yet. */
export function lineDiff(before, after, name) {
    const lines = (t) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
    const a = lines(before ?? '');
    const b = lines(after);
    // The longest common subsequence, by table (these files are a few hundred lines at most).
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const ops = [];
    for (let i = 0, j = 0; i < a.length || j < b.length;) {
        if (i < a.length && j < b.length && a[i] === b[j])
            ops.push({ op: ' ', line: a[i++] }), j++;
        else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1]))
            ops.push({ op: '-', line: a[i++] });
        else
            ops.push({ op: '+', line: b[j++] });
    }
    const keep = new Set();
    ops.forEach((o, n) => {
        if (o.op !== ' ')
            for (let k = Math.max(0, n - 3); k <= Math.min(ops.length - 1, n + 3); k++)
                keep.add(k);
    });
    const out = [before === null ? `--- (no ${name} yet)` : `--- ${name}`, `+++ ${name}`];
    let last = -1;
    for (const n of [...keep].sort((x, y) => x - y)) {
        if (last >= 0 && n > last + 1)
            out.push('@@');
        out.push(`${ops[n].op}${ops[n].line}`);
        last = n;
    }
    return out.join('\n');
}
/** The step as the page shows it: all from local files and the event log; no network, nothing written, no token. */
export function discordSetupView(o) {
    const file = join(o.home, INTAKE_FILE);
    const loaded = loadIntakeConfig(file);
    const cfg = loaded && !('error' in loaded) ? loaded.config : IntakeConfig.parse({ version: 1 });
    const ask = openTokenAsk(o.asks, o.instance);
    const user = o.user ?? currentUser();
    return {
        available: true,
        instance: o.instance,
        canAct: o.role === 'owner',
        portal: DISCORD_PORTAL,
        token: tokenState(join(o.home, 'credentials.yaml')),
        ask: ask ? { ...ask, canAnswer: o.role === 'owner' } : null,
        invite: { integer: INVITE_PERMISSION_INTEGER, permissions: INVITE_PERMISSIONS.map((p) => ({ ...p })) },
        intake: { file, exists: loaded !== null, error: loaded && 'error' in loaded ? loaded.error : null, values: intakeFormValues(cfg), warnings: loaded && !('error' in loaded) ? loaded.warnings : [] },
        form: INTAKE_FORM.map((f) => ({ ...f })),
        automation: {
            token: `sudo bash ${join(o.engineRoot, 'scripts', 'setup', 'credentials.sh')} ${o.instance} ${DISCORD_CREDENTIAL}`,
            channels: `sudo -H -u ${user} ${BRAND.cli} discord channels --instance ${o.instance}`,
            file,
            keys: [...INTAKE_FORM_KEYS],
            restart: `sudo systemctl restart ${instanceUnit(o.instance)}`,
        },
    };
}
//# sourceMappingURL=discord-setup.js.map