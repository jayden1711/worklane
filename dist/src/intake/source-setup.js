// WHY: the first-run page's Slack and Linear steps, beside Discord's in its "Intake sources" group: store the
// source's secret(s) through the setup console's paste box, load what the secret can see (a child process), pick the
// workspace and channels (Slack) or the team and label (Linear) from that view, and write those picks into
// intake.yaml after an owner has seen the exact diff and confirmed it. The same pattern as the Discord step
// (src/intake/discord-setup.ts), whose child-process runner, diff and file writer it uses.
//
// INVARIANT: this module, and so the dashboard's process, never reads a Slack token or the Linear key. It knows each
// file's path (credentials.yaml intake.slack_app_token, slack_bot_token, linear_api_key) and whether a file is there,
// and nothing more. What needs a secret comes from `slack view --json` / `linear view --json` (src/intake/source-view.ts)
// run as a child process, which reads it itself, as the instance's user, and prints no secret.
//
// INVARIANT: who may send (slack.allowed_senders, linear.allowed_senders) and who is trusted are never written here:
// they stay in intake.yaml by hand, as for Discord. Opening a step, loading a view and reviewing a change write nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { asks } from '../console/asks.js';
import { CredentialsFile, setIntakeCredential } from '../instance.js';
import { currentUser, replaceFileAtomically } from '../os/index.js';
import { instanceUnit } from '../service.js';
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import { DiscordSetupError, lineDiff } from './discord-setup.js';
import { IntakeConfig, intakeWarnings, LINEAR_ID, SLACK_ID } from './report.js';
export const SOURCE_KINDS = ['slack', 'linear'];
/** What a Slack app-level token looks like (credentials.sh intake-slack checks the same). */
export const SLACK_APP_TOKEN_SHAPE = /^xapp-[0-9]+-[A-Za-z0-9-]{20,250}$/;
/** What a Slack bot token looks like. */
export const SLACK_BOT_TOKEN_SHAPE = /^xoxb-[A-Za-z0-9-]{20,250}$/;
/** What a Linear personal API key looks like. */
export const LINEAR_KEY_SHAPE = /^lin_api_[A-Za-z0-9]{20,100}$/;
/** The Slack app intake needs, exactly: Socket Mode, the app_mention event, and these bot scopes. Nothing else. */
export const SLACK_SCOPES = [
    { scope: 'app_mentions:read', why: 'be told about messages that mention the bot, in channels it is in (and only those)' },
    { scope: 'chat:write', why: "reply in the message's thread" },
    { scope: 'users:read', why: "a sender's display name, only to take it out of their text before anything else sees it; and the people's ids, for you to copy" },
    { scope: 'channels:read', why: 'list the public channels, so you can pick them here' },
];
/** The manifest to create the Slack app from: Socket Mode on, one event, the scopes above. */
export function slackManifest(name = `${BRAND.name} intake`) {
    return {
        display_information: { name: name.slice(0, 35), description: 'Takes reports from people you list, when they mention it.' },
        features: { bot_user: { display_name: name.slice(0, 80), always_online: false } },
        oauth_config: { scopes: { bot: SLACK_SCOPES.map((s) => s.scope) } },
        settings: { event_subscriptions: { bot_events: ['app_mention'] }, interactivity: { is_enabled: false }, org_deploy_enabled: false, socket_mode_enabled: true, token_rotation_enabled: false },
    };
}
/** The permissions to give the Linear key: the least intake uses. */
export const LINEAR_PERMISSIONS = [
    { name: 'Read', why: "list the team's labelled issues, and read the ones from people you list" },
    { name: 'Create comments', why: 'one status comment on each report' },
    { name: 'Team access: only the one team', why: 'it reads nothing else' },
];
/** Where each source's secret is made. */
export const PORTAL = { slack: 'https://api.slack.com/apps', linear: 'https://linear.app/settings/account/security' };
/** Each source's secrets, in the order they are pasted. */
export const SOURCE_CREDS = {
    slack: [
        {
            credential: 'intake-slack-app',
            key: 'slack_app_token',
            title: 'Paste the Slack app-level token',
            detail: "From your Slack app's page: Basic Information, App-Level Tokens, Generate (scope connections:write). It opens the bot's outbound connection. It goes straight to a file only this instance's coordinator user can read (0400), and credentials.yaml intake.slack_app_token is pointed at it. It is never shown again.",
            shape: { re: SLACK_APP_TOKEN_SHAPE, what: "that doesn't look like a Slack app-level token (xapp-...); nothing stored" },
        },
        {
            credential: 'intake-slack-bot',
            key: 'slack_bot_token',
            title: 'Paste the Slack bot token',
            detail: "From your Slack app's page: OAuth & Permissions, Install to Workspace, then the Bot User OAuth Token. It goes straight to a file only this instance's coordinator user can read (0400), and credentials.yaml intake.slack_bot_token is pointed at it. It is never shown again.",
            shape: { re: SLACK_BOT_TOKEN_SHAPE, what: "that doesn't look like a Slack bot token (xoxb-...); nothing stored" },
        },
    ],
    linear: [
        {
            credential: 'intake-linear',
            key: 'linear_api_key',
            title: 'Paste the Linear API key',
            detail: "From Linear: Settings, Account, Security & access, Personal API keys: New key with only Read and Create comments, for the one team. It goes straight to a file only this instance's coordinator user can read (0400), and credentials.yaml intake.linear_api_key is pointed at it. It is never shown again.",
            shape: { re: LINEAR_KEY_SHAPE, what: "that doesn't look like a Linear API key (lin_api_...); nothing stored" },
        },
    ],
};
export const credDef = (credential) => {
    for (const kind of SOURCE_KINDS)
        for (const c of SOURCE_CREDS[kind])
            if (c.credential === credential)
                return { ...c, kind };
    return null;
};
export function credStates(credentialsFile, kind) {
    let names = {};
    let error = null;
    try {
        const r = CredentialsFile.safeParse(parse(readFileSync(credentialsFile, 'utf8')));
        if (!r.success)
            error = `${credentialsFile} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        else
            names = r.data.intake ?? {};
    }
    catch (e) {
        error = `can't read ${credentialsFile} (${e.code ?? 'error'})`;
    }
    // INVARIANT: existence only; no secret file is ever opened here.
    return SOURCE_CREDS[kind].map((c) => {
        const file = names[c.key] ?? null;
        return { credential: c.credential, key: c.key, title: c.title, configured: !!file, file, present: !!file && existsSync(file), error };
    });
}
/** The setup console's rules for the pasted secrets: each one's shape, then credentials.yaml pointed at its file. */
export function sourceSecretRules(o) {
    const out = {};
    for (const kind of SOURCE_KINDS) {
        for (const c of SOURCE_CREDS[kind]) {
            out[c.credential] = {
                shape: c.shape,
                stored: (ask, file) => {
                    if (ask.instance !== o.instance)
                        throw new Error(`the ask is for instance ${ask.instance}, not ${o.instance}`);
                    setIntakeCredential(o.credentialsFile, c.key, file);
                    o.onStored?.(kind);
                    return `credentials.yaml intake.${c.key} now names it`;
                },
            };
        }
    }
    return out;
}
const openAsk = (all, instance, credential) => all.find((a) => a.kind === 'paste_secret' && a.credential === credential && a.instance === instance && a.status === 'open') ?? null;
/** The open paste box for one of a source's secrets: the one already waiting, or a new ask. Nothing is stored yet. */
export function sourceTokenAsk(log, instance, credential, by) {
    const c = credDef(credential);
    if (!c)
        throw new DiscordSetupError(`not an intake source's credential: ${credential.slice(0, 40)}`);
    const a = asks(log);
    const open = openAsk(a.list({ instance }), instance, credential);
    if (open)
        return { ask: open, created: false };
    const ask = a.create({ kind: 'paste_secret', instance, title: c.title, detail: c.detail, credential: c.credential, where: `credentials.yaml intake.${c.key}` }, by);
    return { ask, created: true };
}
// --- what the secret can see, through a child process ----------------------------------------------------------
const name = z.string().max(200);
const SlackViewOut = z.object({
    team: z.object({ id: z.string().regex(SLACK_ID), name }),
    bot: z.object({ user: z.string().regex(SLACK_ID) }),
    channels: z.array(z.object({ id: z.string().regex(/^[CG][A-Z0-9]{2,30}$/), name, member: z.boolean() })).max(20_000),
    members: z.array(z.object({ id: z.string().regex(SLACK_ID), name })).max(20_000),
});
const idName = z.object({ id: z.string().regex(LINEAR_ID), name });
const LinearViewOut = z.object({
    organization: z.object({ name }),
    viewer: z.object({ id: z.string().regex(LINEAR_ID), name }),
    teams: z.array(z.object({ id: z.string().regex(LINEAR_ID), name, key: z.string().max(20), labels: z.array(idName).max(1000), members: z.array(idName).max(1000) })).max(500),
    labels: z.array(idName).max(1000),
});
/**
 * What the source's secret can see, from `<kind> view --instance <name> --json` run as a child process (the Discord
 * step's runner: this engine's own cli.js, or a stand-in made in code). A failure is the child's own one line.
 */
export async function sourceView(kind, instance, run) {
    const r = await run([kind, 'view', '--instance', instance, '--json']);
    if (r.status !== 0) {
        const line = r.stderr.trim().split('\n').at(-1)?.trim() ?? '';
        throw new DiscordSetupError((line || `the view ended with status ${r.status ?? 'unknown'}`).slice(0, 400), 502);
    }
    try {
        const raw = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '');
        const at = new Date().toISOString();
        return kind === 'slack' ? { kind, ...SlackViewOut.parse(raw), at } : { kind, ...LinearViewOut.parse(raw), at };
    }
    catch {
        throw new DiscordSetupError("the view's output could not be read", 502);
    }
}
/** The intake.yaml keys each step writes, and nothing else in the file. */
export const SOURCE_FORM = {
    slack: [
        { key: 'slack.enabled', kind: 'boolean', what: 'the app connects (outbound, Socket Mode)' },
        { key: 'slack.team', kind: 'team', what: 'the one workspace it reads' },
        { key: 'slack.channels', kind: 'ids', what: 'the channels mentions are taken from (invite the bot to each: /invite @bot)' },
    ],
    linear: [
        { key: 'linear.enabled', kind: 'boolean', what: "the team's labelled issues are read every few minutes" },
        { key: 'linear.team', kind: 'team', what: 'the one team it reads' },
        { key: 'linear.label', kind: 'label', what: 'only issues carrying this label are reports' },
    ],
};
export const sourceFormKeys = (kind) => SOURCE_FORM[kind].map((f) => f.key);
const at = (cfg, key) => {
    const [a, b] = key.split('.');
    const v = cfg[a][b];
    return v === undefined ? null : v;
};
export const sourceFormValues = (kind, cfg) => Object.fromEntries(sourceFormKeys(kind).map((k) => [k, at(cfg, k)]));
function normalize(kind, key, k, v) {
    const bad = (what) => new DiscordSetupError(`${key}: ${what}`);
    const id = kind === 'slack' ? SLACK_ID : LINEAR_ID;
    if (k === 'boolean') {
        if (typeof v !== 'boolean')
            throw bad('must be true or false');
        return v;
    }
    if (k === 'ids') {
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !id.test(x)))
            throw bad('must be a list of ids');
        return [...new Set(v)];
    }
    if (v === null || v === '')
        return null;
    if (typeof v !== 'string' || !id.test(v))
        throw bad('must be an id');
    return v;
}
/**
 * The change these values make to intake.yaml, or why it is refused. Nothing is written.
 * - Only the step's own keys; every other key and comment of the file is kept (allowed senders and trust included).
 * - A newly picked workspace, channel, team or label must be one the source's view shows: never typed in.
 * - Slack: the workspace must be the one the bot token belongs to. Linear: the label must be the team's, or a
 *   workspace label.
 * - The result must pass the intake schema.
 */
export function planSourceIntake(o) {
    const keys = sourceFormKeys(o.kind);
    const unknown = Object.keys(o.values).filter((k) => !keys.includes(k));
    if (unknown.length)
        throw new DiscordSetupError(`not set here: ${unknown.join(', ')}; this step writes ${keys.join(', ')}`);
    if (o.view.kind !== o.kind)
        throw new DiscordSetupError(`the view is ${o.view.kind}'s, not ${o.kind}'s`);
    const loaded = loadIntakeConfig(o.path);
    if (loaded && 'error' in loaded)
        throw new DiscordSetupError(`refused: ${loaded.error}`);
    const before = loaded ? readFileSync(o.path, 'utf8') : null;
    const doc = parseDocument(before ?? 'version: 1\n');
    const cfg = loaded?.config ?? IntakeConfig.parse({ version: 1 });
    const v = o.view;
    const known = (k, id) => {
        if (v.kind === 'slack')
            return k === 'team' ? id === v.team.id : v.channels.some((c) => c.id === id);
        if (k === 'team')
            return v.teams.some((t) => t.id === id);
        return v.labels.some((l) => l.id === id) || v.teams.some((t) => t.labels.some((l) => l.id === id));
    };
    const changes = [];
    for (const f of SOURCE_FORM[o.kind]) {
        if (!Object.hasOwn(o.values, f.key))
            continue;
        const to = normalize(o.kind, f.key, f.kind, o.values[f.key]);
        const from = at(cfg, f.key);
        if (JSON.stringify(from) === JSON.stringify(to))
            continue;
        // INVARIANT: an id comes from the source's own view, never typed in; one already in the file stays as it is.
        const had = new Set(Array.isArray(from) ? from : typeof from === 'string' ? [from] : []);
        const added = (Array.isArray(to) ? to : typeof to === 'string' ? [to] : []).filter((id) => !had.has(id));
        for (const id of added)
            if (!known(f.kind, id))
                throw new DiscordSetupError(`refused: ${f.key}: ${id} is not in what the ${o.kind === 'slack' ? 'Slack app' : 'Linear key'} can see; pick one from its view (load it again if it just changed)`);
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
    if (v.kind === 'slack' && next.slack.team && next.slack.team !== v.team.id)
        problems.push(`slack.team: the bot token belongs to workspace ${v.team.name} (${v.team.id}), not ${next.slack.team}`);
    if (v.kind === 'linear' && next.linear.label && next.linear.team) {
        const team = v.teams.find((t) => t.id === next.linear.team);
        const ok = v.labels.some((l) => l.id === next.linear.label) || !!team?.labels.some((l) => l.id === next.linear.label);
        if (!ok && changes.some((c) => c.key === 'linear.label' || c.key === 'linear.team'))
            problems.push('linear.label: that label is neither the chosen team\'s nor a workspace label');
    }
    if (problems.length)
        throw new DiscordSetupError(`refused: ${problems.join('; ')}`);
    const text = doc.toString({ lineWidth: 0 });
    return {
        file: o.path,
        creates: before === null,
        changes,
        diff: lineDiff(before, text, INTAKE_FILE),
        hash: createHash('sha256').update(JSON.stringify([before, text])).digest('hex'),
        warnings: intakeWarnings(next).filter((w) => w.startsWith(`${o.kind} `)),
        text,
    };
}
/** Write a confirmed change: planned again, and written only when it is the very change that was shown (`expect`). */
export function applySourceIntake(o) {
    const plan = planSourceIntake(o);
    if (plan.hash !== o.expect)
        throw new DiscordSetupError(`${INTAKE_FILE} or the ${o.kind} view changed since the change was shown: nothing written; review it again`, 409);
    replaceFileAtomically(o.path, plan.text, 0o600, dirname(o.path));
    const check = loadIntakeConfig(o.path);
    if (!check || 'error' in check)
        throw new DiscordSetupError(`${INTAKE_FILE} was written, but it does not load: ${check ? check.error : 'it is missing'}`, 409);
    return plan;
}
/** The step as the page shows it: all from local files and the event log; no network, nothing written, no secret. */
export function sourceSetupView(o) {
    const file = join(o.home, INTAKE_FILE);
    const loaded = loadIntakeConfig(file);
    const cfg = loaded && !('error' in loaded) ? loaded.config : IntakeConfig.parse({ version: 1 });
    const user = o.user ?? currentUser();
    const owner = o.role === 'owner';
    return {
        available: true,
        kind: o.kind,
        instance: o.instance,
        canAct: owner,
        portal: PORTAL[o.kind],
        creds: credStates(join(o.home, 'credentials.yaml'), o.kind).map((c) => {
            const ask = openAsk(o.asks, o.instance, c.credential);
            return { ...c, ask: ask ? { ...ask, canAnswer: owner } : null };
        }),
        intake: {
            file,
            exists: loaded !== null,
            error: loaded && 'error' in loaded ? loaded.error : null,
            values: sourceFormValues(o.kind, cfg),
            warnings: loaded && !('error' in loaded) ? loaded.warnings.filter((w) => w.startsWith(`${o.kind} `)) : [],
            // Counts only: who may send stays in the file.
            allowed: cfg[o.kind].allowed_senders.length,
            trusted: cfg.trusted[o.kind].length,
        },
        form: SOURCE_FORM[o.kind].map((f) => ({ ...f })),
        ...(o.kind === 'slack' ? { slack: { manifest: JSON.stringify(slackManifest(), null, 2), scopes: SLACK_SCOPES.map((s) => ({ ...s })) } } : { linear: { permissions: LINEAR_PERMISSIONS.map((p) => ({ ...p })) } }),
        automation: {
            token: `sudo bash ${join(o.engineRoot, 'scripts', 'setup', 'credentials.sh')} ${o.instance} intake-${o.kind}`,
            view: `sudo -H -u ${user} ${BRAND.cli} ${o.kind} view --instance ${o.instance}`,
            file,
            keys: sourceFormKeys(o.kind),
            restart: `sudo systemctl restart ${instanceUnit(o.instance)}`,
        },
    };
}
/** Each chat source's state for the Intake page, from local files only: never a secret, an id or a person. */
export function intakeSourcesSummary(home) {
    const loaded = loadIntakeConfig(join(home, INTAKE_FILE));
    const invalid = !!loaded && 'error' in loaded;
    const cfg = loaded && !('error' in loaded) ? loaded.config : IntakeConfig.parse({ version: 1 });
    let creds = {};
    try {
        const r = CredentialsFile.safeParse(parse(readFileSync(join(home, 'credentials.yaml'), 'utf8')));
        if (r.success)
            creds = r.data.intake ?? {};
    }
    catch {
        // no credentials: nothing stored
    }
    const stored = (...keys) => keys.every((k) => !!creds[k] && existsSync(creds[k]));
    const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    const state = (has, on) => (invalid ? 'invalid' : !has ? 'none' : on ? 'on' : 'off');
    return [
        { name: 'discord', state: state(stored('discord_token'), cfg.discord.enabled), detail: `${n(cfg.discord.channels.length, 'channel')} · ${cfg.discord.allowed_senders.length} may send` },
        { name: 'slack', state: state(stored('slack_app_token', 'slack_bot_token'), cfg.slack.enabled), detail: `${n(cfg.slack.channels.length, 'channel')} · ${cfg.slack.allowed_senders.length} may send` },
        { name: 'linear', state: state(stored('linear_api_key'), cfg.linear.enabled), detail: `${cfg.linear.label ? 'one label' : 'no label yet'} · ${cfg.linear.allowed_senders.length} may send` },
    ];
}
//# sourceMappingURL=source-setup.js.map