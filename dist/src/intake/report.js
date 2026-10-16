// Work intake: the shape of a report, whichever source it came from, and the
// instance's intake config (sources, trusted senders, caps). The config lives in
// the instance home (intake.yaml, the coordinator user's, 0600), never in the
// repo, so no agent can read who is trusted or change it. See docs/intake.md.
import { z } from 'zod';
export const SOURCES = ['discord', 'bug-store', 'alerts', 'github', 'voice', 'slack', 'linear'];
export const INTAKE_DEFAULT_CAPS = { reports_per_sender_per_day: 10, drafts_per_day: 20, max_usd_per_day: 2 };
/** The chat channels' defaults (intake.yaml discord.chat_model, discord.chat_max_usd_per_day). */
export const CHAT_DEFAULTS = { model: 'haiku', max_usd_per_day: 2 };
/** The superfan's defaults (intake.yaml superfan.every_minutes, superfan.daily_budget_usd). */
export const SUPERFAN_DEFAULTS = { every_minutes: 30, daily_budget_usd: 2 };
export const TRIAGE_KINDS = ['bug', 'feature', 'question', 'duplicate', 'not_actionable', 'needs_info'];
/** A GitHub login as GitHub allows them (letters, digits, dashes; at most 39), as the dashboard checks it. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const snowflake = (what) => z.string().regex(/^\d{5,25}$/, `a Discord ${what} id (digits)`);
/**
 * A Slack id (a workspace T..., a channel C... or G..., a user U... or W...). Slack calls ids opaque, so only their
 * shape is checked: capitals and digits. Enough to refuse a name or an @handle, which would silently never match.
 */
export const SLACK_ID = /^[A-Z][A-Z0-9]{2,30}$/;
const slackId = (what) => z.string().regex(SLACK_ID, `a Slack ${what} id (capitals and digits, e.g. U0123ABCD; not a name)`);
/** A Linear id (a user, team or label): a UUID. */
export const LINEAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const linearId = (what) => z.string().regex(LINEAR_ID, `a Linear ${what} id (a UUID; not a name)`);
export const IntakeConfig = z.strictObject({
    version: z.literal(1),
    /**
     * Trusted senders: their drafts are filed with `ready`. The owner is trusted by their Discord user id below. A
     * trusted Discord id must also be an allowed sender (discord.allowed_senders).
     */
    trusted: z
        .strictObject({
        discord: z.array(snowflake('user')).default([]),
        'bug-store': z.array(z.string().min(1)).default([]),
        /** Production alert kinds whose reports are filed `ready`; every other kind's draft is an Inbox decision. */
        alerts: z.array(z.string().min(1)).default([]),
        // WHY: GitHub logins compare case-insensitively; the github source lowercases the author too.
        github: z.array(z.string().regex(GITHUB_LOGIN, 'a GitHub login').transform((l) => l.toLowerCase())).default([]),
        /** Slack user ids whose drafts are filed `ready`; each must be in slack.allowed_senders. */
        slack: z.array(slackId('user')).default([]),
        /** Linear user ids whose drafts are filed `ready`; each must be in linear.allowed_senders. */
        linear: z.array(linearId('user')).default([]),
    })
        .prefault({}),
    /** One server only: messages from any other server, and every direct message, are dropped unstored. */
    discord: z
        .strictObject({
        enabled: z.boolean().default(false),
        /** The server (guild) id; required when enabled. */
        guild: snowflake('server').optional(),
        /** Only these channels of that server count. */
        channels: z.array(snowflake('channel')).default([]),
        /**
         * The only Discord users whose messages are taken (user ids). Anyone else's message is dropped before it is
         * stored, counted only, and gets no reply. Empty: nobody's message is accepted.
         */
        allowed_senders: z.array(snowflake('user')).default([]),
        /** In a channel, a message counts only if it mentions the bot or starts with one of these. */
        prefixes: z.array(z.string().min(1)).default(['bug:']),
        /**
         * Who each allowed sender is on GitHub: Discord user id -> GitHub login. Their role in a Discord thread is that
         * login's permission on the instance's repo (admin: owner, write: writer), read as the dashboard reads it. An
         * allowed sender not listed here is ignored in threads and conversations: nothing of theirs is stored.
         */
        people: z.record(snowflake('user'), z.string().regex(GITHUB_LOGIN, 'a GitHub login')).default({}),
        /**
         * The channel decisions and setup-console asks are posted in, one thread each, answered by a reply in the thread.
         * Absent: nothing is posted.
         */
        asks_channel: snowflake('channel').optional(),
        /**
         * The ops channel, posted to only (the bot never reads it, so several instances may share it):
         * - the machine's watchdog posts each incident here (a service down, an update rolled back, a login failing, a
         *   full disk...), once when it opens and once when it is resolved, each linking to its place on the
         *   dashboard's Health page (src/watchdog/); only one coordinator on the machine posts;
         * - the weekly trust digest (src/trust.ts), once a week, as a plain message.
         * It needs `dashboard_url` (the incident posts link to the Health page). Absent: neither is posted from here.
         */
        ops_channel: snowflake('channel').optional(),
        /**
         * Post every merge to the default branch in `ops_channel`, whoever made it (src/merge-posts.ts): the PR (linked),
         * the merger's GitHub login, the merge commit's short sha and the first line of the PR's intent, redacted. On by
         * default; nothing is posted without `ops_channel`.
         */
        post_merges: z.boolean().default(true),
        /**
         * Ideas in conversation: an addressed message in `channels` from a mapped admin or writer opens a thread where
         * the bot asks what it must, drafts the five-part issue, shows it, and files it `ready` only on an explicit
         * yes (src/coordinator/conversation.ts), instead of being triaged and filed at once. Off: intake as before.
         */
        conversation: z.boolean().default(false),
        /** The dashboard's address, for the links a post carries (a secret ask, a high-risk merge): https only. */
        dashboard_url: z.string().regex(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/, 'an https URL').optional(),
        /**
         * Chat channels (src/coordinator/channel-chat.ts): in these, the bot is a conversational assistant for mapped
         * admins and writers, replying to each of their messages (no mention needed), with read-only access to the
         * checkout's code and the instance's state. It can never file, answer, change or start anything. Each must be
         * none of `channels` or `asks_channel`. Empty (the default): no chat.
         */
        chat_channels: z.array(snowflake('channel')).default([]),
        /** The chat's model (capped by the instance's model_cap like every run). */
        chat_model: z.enum(['haiku', 'sonnet', 'opus']).default(CHAT_DEFAULTS.model),
        /** The chat's own daily spend cap, in dollars; its runs count against the instance's daily budget too. */
        chat_max_usd_per_day: z.number().positive().max(20).default(CHAT_DEFAULTS.max_usd_per_day),
        /**
         * The owners on Discord (user ids): the only people who may approve a high-risk (L3) merge from a thread
         * ("approve <number>"), or ask for a setup step's one-time dashboard link by DM. Each must be mapped in
         * `people`, and the login it maps to must be an admin on the instance's repo: checked at start-up, where one
         * that isn't refuses Discord. They are also the only users a post may ever mention (an approval pings the
         * others, in its thread). Empty (the default): no high-risk approval and no link comes from Discord.
         */
        owners: z.array(snowflake('user')).default([]),
    })
        .refine((d) => !d.enabled || d.guild, { message: 'discord.guild (the server id) is required when discord is enabled', path: ['guild'] })
        .refine((d) => !d.chat_channels.some((c) => d.channels.includes(c) || c === d.asks_channel), { message: 'a chat channel must not also be an ideas channel (discord.channels) or the asks channel', path: ['chat_channels'] })
        .refine((d) => !d.asks_channel || d.dashboard_url, { message: 'discord.dashboard_url is required with discord.asks_channel (posts link to it)', path: ['dashboard_url'] })
        .refine((d) => !d.ops_channel || d.dashboard_url, { message: 'discord.dashboard_url is required with discord.ops_channel (incident posts link to the Health page)', path: ['dashboard_url'] })
        .prefault({}),
    'bug-store': z
        .strictObject({
        enabled: z.boolean().default(false),
        /** A fixed read-only SELECT returning id, reporter, text, created_at, newer than :after. */
        query: z.string().min(1).optional(),
    })
        .prefault({}),
    /**
     * Production alerts (src/intake/alerts.ts): a second fixed read-only query on the production read path, through the
     * same read-only role and the owner's credential as the bug store. A kind never seen before, or more than
     * `spike.threshold` rows of one kind within `spike.window_minutes`, becomes a report. Off by default; it also needs
     * deploy.yaml prod_read, and the read-only role granted SELECT on the table.
     */
    alerts: z
        .strictObject({
        enabled: z.boolean().default(false),
        /** The table (or view), `name` or `schema.name`: plain identifiers only. */
        table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/, 'a table name (plain identifiers, optionally schema.table)').default('alerts'),
        /** Its columns: an increasing integer id, the alert's kind, its message and when it was raised. */
        columns: z
            .strictObject({
            id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).default('id'),
            kind: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).default('kind'),
            message: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).default('message'),
            created_at: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).default('created_at'),
        })
            .prefault({}),
        /** Rows per pull. */
        batch: z.number().int().min(1).max(10_000).default(500),
        spike: z
            .strictObject({
            threshold: z.number().int().min(1).max(100_000).default(20),
            window_minutes: z.number().int().min(1).max(10_080).default(60),
        })
            .prefault({}),
    })
        .prefault({}),
    /**
     * Slack (src/intake/slack.ts): a Slack app connected OUTBOUND over Socket Mode (no public address), told only about
     * messages that mention it. One workspace (`team`), the listed channels, the allowed senders: anyone else's mention
     * is dropped on their user id before its text is read, never stored, never answered. Replies go in the message's
     * thread. Off by default; it also needs the app's two tokens in credentials.yaml (credentials.sh intake-slack).
     */
    slack: z
        .strictObject({
        enabled: z.boolean().default(false),
        /** The workspace (team) id; required when enabled. Another workspace's event is dropped on its id. */
        team: slackId('workspace').optional(),
        /** Only mentions in these channels count (public C... or private G...); direct messages (D...) never. */
        channels: z.array(z.string().regex(/^[CG][A-Z0-9]{2,30}$/, 'a Slack channel id (C... or G...; never a direct message D...)')).default([]),
        /** The only Slack users whose mentions are taken (user ids, U... or W...). Empty: nobody's. */
        allowed_senders: z.array(slackId('user')).default([]),
    })
        .refine((d) => !d.enabled || d.team, { message: 'slack.team (the workspace id) is required when slack is enabled', path: ['team'] })
        .prefault({}),
    /**
     * Linear (src/intake/linear.ts): open issues in one team carrying one label, created by an allowed sender, read by
     * polling Linear's API (no webhook, no public address). A creator who isn't allowed has nothing of their issue
     * fetched but its id. Each report gets one comment back on its issue. Off by default; it also needs the API key in
     * credentials.yaml (credentials.sh intake-linear).
     */
    linear: z
        .strictObject({
        enabled: z.boolean().default(false),
        /** The one team (its id); required when enabled. */
        team: linearId('team').optional(),
        /** Only issues carrying this label (its id) are reports; required when enabled. */
        label: linearId('label').optional(),
        /** The only Linear users whose issues are taken (user ids). Empty: nobody's. */
        allowed_senders: z.array(linearId('user')).default([]),
        // INVARIANT: at least a minute between listings, as for GitHub issues.
        poll_minutes: z.number().int().min(1).max(1440).default(5),
    })
        .refine((d) => !d.enabled || (d.team && d.label), { message: 'linear.team and linear.label are required when linear is enabled', path: ['team'] })
        .prefault({}),
    // WHY: off by default; when on, outsiders' issues reach work only through triage and the trust policy (decide.ts).
    github: z
        .strictObject({
        enabled: z.boolean().default(false),
        // INVARIANT: at least a minute between listings, so the intake timer never polls GitHub on every pass.
        poll_minutes: z.number().int().min(1).max(1440).default(5),
    })
        .prefault({}),
    /**
     * Voice intake (src/intake/voice.ts): an idea an owner of the instance spoke on the dashboard and confirmed there,
     * within 10 s, from a focused and visible tab, taken through the same triage and approval as a Discord message.
     * Its sender is never trusted: what it drafts waits for an owner's approval. Off by default; each owner also turns
     * it on in their own browser (Settings, Voice).
     */
    voice: z
        .strictObject({
        enabled: z.boolean().default(false),
    })
        .prefault({}),
    /**
     * Siri (docs/siri.md, src/siri/): "tell" leaves a spoken idea in the same voice inbox (never trusted: an Inbox
     * approval, always), and "ask" answers aloud at a viewer's level, with no tools and no repository. Both need a
     * device token an owner made on the dashboard, through the hub's Siri gateway, from the tailnet. Off by default.
     */
    siri: z
        .strictObject({
        enabled: z.boolean().default(false),
        /** The model Siri answers with: fast enough to be heard within Siri's patience. */
        ask_model: z.string().min(1).max(100).default('haiku'),
        /** Siri answers' own daily cap, in USD; every answer also counts against the instance's daily budget. */
        ask_max_usd_per_day: z.number().positive().max(20).default(1),
    })
        .prefault({}),
    /**
     * Replies worded by the casual replier role from the redacted message and the engine's facts, each checked in
     * code before it is sent (src/intake/replier.ts). Off: the engine's fixed replies.
     */
    casual_replies: z.boolean().default(false),
    /** Days the raw (unredacted) text is kept in the coordinator's private state. */
    raw_retention_days: z.number().int().min(1).max(90).default(14),
    /** Extra redaction: names and labelled patterns specific to this project (e.g. account or bet ids). */
    redact: z
        .strictObject({
        names: z.array(z.string().min(2)).default([]),
        patterns: z
            .array(z.strictObject({
            label: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
            regex: z.string().min(1).refine((r) => {
                try {
                    new RegExp(r);
                    return true;
                }
                catch {
                    return false;
                }
            }, 'not a valid regular expression'),
        }))
            .default([]),
    })
        .prefault({}),
    /**
     * The superfan (src/superfan/): a watcher that reads this instance's event log, incidents, test runs, health and
     * service log every `every_minutes`, and posts in `channel` only when a cheap model finds something new or odd. It
     * may file an issue, or a `ready` fix task the normal pipeline builds; it never merges and never reads a secret.
     * `machine_channel`: this instance also competes to be the machine's engine-and-updater superfan (one on the
     * machine), posting there. `model`: the agents.yaml model_routing intake_summary model (the cheap tier) when unset.
     * Off by default; it needs discord on.
     */
    superfan: z
        .strictObject({
        enabled: z.boolean().default(false),
        channel: snowflake('channel').optional(),
        every_minutes: z.number().int().min(5).max(1440).default(SUPERFAN_DEFAULTS.every_minutes),
        daily_budget_usd: z.number().positive().max(20).default(SUPERFAN_DEFAULTS.daily_budget_usd),
        model: z.enum(['haiku', 'sonnet', 'opus']).optional(),
        machine_channel: snowflake('channel').optional(),
    })
        .refine((s) => !s.enabled || s.channel, { message: 'superfan.channel is required when superfan is enabled', path: ['channel'] })
        .prefault({}),
    /** Defaults for the caps; the instance settings (intake.*) win over these. */
    caps: z
        .strictObject({
        reports_per_sender_per_day: z.number().int().min(1).max(100).default(INTAKE_DEFAULT_CAPS.reports_per_sender_per_day),
        drafts_per_day: z.number().int().min(1).max(200).default(INTAKE_DEFAULT_CAPS.drafts_per_day),
        max_usd_per_day: z.number().positive().max(20).default(INTAKE_DEFAULT_CAPS.max_usd_per_day),
    })
        .prefault({}),
}).superRefine((c, ctx) => {
    for (const id of c.trusted.discord) {
        if (!c.discord.allowed_senders.includes(id))
            ctx.addIssue({ code: 'custom', path: ['trusted', 'discord'], message: `${id} is trusted but not in discord.allowed_senders; a trusted sender must be allowed` });
    }
    for (const src of ['slack', 'linear']) {
        for (const id of c.trusted[src]) {
            if (!c[src].allowed_senders.includes(id))
                ctx.addIssue({ code: 'custom', path: ['trusted', src], message: `${id} is trusted but not in ${src}.allowed_senders; a trusted sender must be allowed` });
        }
    }
    for (const id of Object.keys(c.discord.people)) {
        if (!c.discord.allowed_senders.includes(id))
            ctx.addIssue({ code: 'custom', path: ['discord', 'people'], message: `${id} is mapped to a GitHub login but not in discord.allowed_senders; a mapped person must be allowed` });
    }
    if (c.superfan.enabled) {
        if (!c.discord.enabled)
            ctx.addIssue({ code: 'custom', path: ['superfan', 'enabled'], message: 'the superfan posts through the Discord bot: discord.enabled must be true' });
        for (const [k, ch] of [['channel', c.superfan.channel], ['machine_channel', c.superfan.machine_channel]]) {
            if (ch && (c.discord.channels.includes(ch) || c.discord.chat_channels.includes(ch) || ch === c.discord.asks_channel))
                ctx.addIssue({ code: 'custom', path: ['superfan', k], message: `${ch} is a channel the bot reads (discord.channels, chat_channels or asks_channel); a superfan needs a channel of its own` });
        }
    }
    for (const id of c.discord.owners) {
        if (!Object.hasOwn(c.discord.people, id))
            ctx.addIssue({ code: 'custom', path: ['discord', 'owners'], message: `${id} is in discord.owners but not mapped to a GitHub login in discord.people; every Discord owner must be mapped (to a GitHub admin)` });
    }
});
/**
 * May this sender's message be taken at all? Checked on the sender id alone, before anything of the message is read
 * or stored.
 *
 * INVARIANT: one case per source and no default. A source added to SOURCES without its own case here doesn't compile
 * (this function would end without a return) and fails test/intake-allowed.test.ts (it would answer undefined): a new
 * source is never let in by omission.
 */
export function isAllowed(sender, cfg) {
    switch (sender.source) {
        case 'discord':
            // Only the allowed senders (discord.allowed_senders); empty means nobody.
            return cfg.discord.allowed_senders.includes(sender.id);
        case 'bug-store':
            // WHY allowed: rows come only from the owner's own fixed read-only query on the production read path (deploy.yaml
            // prod_read); every reporter is untrusted unless trusted.bug-store names them, so a draft waits for an owner.
            return true;
        case 'alerts':
            // WHY allowed: the owner's own read-only alerts query; the "sender" is an alert kind, not a person.
            return true;
        case 'github':
            // WHY allowed: issues are public by design; each is triaged untrusted (an Inbox decision) unless trusted.github
            // names its author, and only the intake label brings it here.
            return true;
        case 'voice':
            // WHY allowed: an owner of the instance spoke and confirmed it on the dashboard (or a device token an owner made,
            // for Siri); never trusted, so it always waits for an owner's approval.
            return true;
        case 'slack':
            // Only the allowed senders (slack.allowed_senders); empty means nobody. The adapter drops the rest first.
            return cfg.slack.allowed_senders.includes(sender.id);
        case 'linear':
            // Only the allowed senders (linear.allowed_senders); empty means nobody. The adapter never fetches the rest.
            return cfg.linear.allowed_senders.includes(sender.id);
    }
}
/** What the config allows that is probably not meant, for the start-up check. */
export function intakeWarnings(cfg) {
    const out = [];
    if (cfg.discord.enabled && !cfg.discord.allowed_senders.length)
        out.push('discord is on but discord.allowed_senders is empty: no Discord message will be accepted');
    if (cfg.slack.enabled && !cfg.slack.allowed_senders.length)
        out.push('slack is on but slack.allowed_senders is empty: no Slack message will be accepted');
    if (cfg.slack.enabled && !cfg.slack.channels.length)
        out.push('slack is on but slack.channels is empty: no Slack channel is read');
    if (cfg.linear.enabled && !cfg.linear.allowed_senders.length)
        out.push('linear is on but linear.allowed_senders is empty: no Linear issue will be taken');
    return out;
}
/**
 * Is this sender trusted? Decided only from the adapter's sender id against the instance config: nothing in the
 * report's text can make a sender trusted.
 */
export function isTrusted(sender, cfg) {
    // A source no longer configured (a report stored before it was removed) is trusted for nobody.
    // WHY: voice has no trusted list: a spoken idea always waits for an owner's approval.
    return cfg.trusted[sender.source]?.includes(sender.id) ?? false;
}
//# sourceMappingURL=report.js.map