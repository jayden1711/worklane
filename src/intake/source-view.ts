// `slack view` and `linear view`: what an instance's Slack app or Linear key can see, so its owner can pick the
// workspace and channels (Slack) or the team and label (Linear), and copy the ids of the people who may send. With
// --json: one JSON line, which is what the dashboard's First run page reads from a child process run as the
// instance's user (src/intake/source-setup.ts): the dashboard's own process never reads a token.
// INVARIANT: requests go only to Slack's and Linear's own API bases (the constants SLACK_API, LINEAR_API): no option,
// argument, environment variable or file names another host. Read-only by construction: Slack's read methods and one
// GraphQL query, no mutation. Nothing is written: no file, event or log. Every message that leaves this module has the
// secret scrubbed out.
import { instanceFilesProblem, instancesDir, listInstances, loadInstanceCredentials } from '../instance.js';
import { linearQuery, scrubKey } from './linear.js';
import { SLACK_API } from './slack.js';
import { readIntakeSecret } from './wire.js';

export class SourceViewError extends Error {}

export interface SlackView {
  team: { id: string; name: string };
  bot: { user: string };
  /** Public channels in the workspace, and whether the bot is in each (it hears mentions only where it is). */
  channels: { id: string; name: string; member: boolean }[];
  /** People (no bots, no deactivated accounts), to copy ids into slack.allowed_senders. */
  members: { id: string; name: string }[];
}

export interface LinearView {
  organization: { name: string };
  viewer: { id: string; name: string };
  teams: { id: string; name: string; key: string; labels: { id: string; name: string }[]; members: { id: string; name: string }[] }[];
  /** Workspace labels (no team): usable in every team. */
  labels: { id: string; name: string }[];
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

async function slackCall(token: string, method: string, params: Record<string, string>, f: typeof fetch): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    // INVARIANT: the token goes in the Authorization header only.
    r = await f(`${SLACK_API}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new SourceViewError(`could not reach Slack (${method}): ${(e as Error).name}`);
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || body.ok !== true) throw new SourceViewError(`Slack refused ${method}: ${str(body.error, 80) || `HTTP ${r.status}`}${body.error === 'missing_scope' ? ' (create the app from the manifest the First run page shows, or add the scope and reinstall)' : ''}`);
  return body;
}

/** The workspace, the bot, the public channels (and whether the bot is in each), and the people. */
export async function slackView(o: { botToken: string; fetch?: typeof fetch }): Promise<SlackView> {
  const f = o.fetch ?? fetch;
  const me = await slackCall(o.botToken, 'auth.test', {}, f);
  const channels: SlackView['channels'] = [];
  const members: SlackView['members'] = [];
  for (let page = 0, cursor = ''; page < 10; page++) {
    const r = await slackCall(o.botToken, 'conversations.list', { types: 'public_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) }, f);
    for (const c of (Array.isArray(r.channels) ? r.channels : []) as Record<string, unknown>[]) {
      if (/^[CG][A-Z0-9]{2,30}$/.test(str(c.id))) channels.push({ id: str(c.id), name: str(c.name), member: c.is_member === true });
    }
    cursor = str((r.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor, 500);
    if (!cursor) break;
  }
  for (let page = 0, cursor = ''; page < 10; page++) {
    const r = await slackCall(o.botToken, 'users.list', { limit: '200', ...(cursor ? { cursor } : {}) }, f);
    for (const u of (Array.isArray(r.members) ? r.members : []) as Record<string, unknown>[]) {
      const id = str(u.id);
      if (u.deleted === true || u.is_bot === true || id === 'USLACKBOT' || !/^[UW][A-Z0-9]{2,30}$/.test(id)) continue;
      const p = (u.profile ?? {}) as Record<string, unknown>;
      members.push({ id, name: str(p.display_name) || str(p.real_name) || str(u.name) });
    }
    cursor = str((r.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor, 500);
    if (!cursor) break;
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  members.sort((a, b) => a.name.localeCompare(b.name));
  return { team: { id: str(me.team_id), name: str(me.team) }, bot: { user: str(me.user_id) }, channels, members };
}

const VIEW = `query IntakeView {
  viewer { id name }
  organization { name }
  teams(first: 25) { nodes { id name key labels(first: 100) { nodes { id name } } members(first: 100) { nodes { id name displayName active app } } } }
  issueLabels(first: 100, filter: { team: { null: true } }) { nodes { id name } }
}`;

/** The key's workspace and user, and each team it can see with its labels and members. */
export async function linearView(o: { apiKey: string; fetch?: typeof fetch }): Promise<LinearView> {
  type N<T> = { nodes?: T[] };
  const d = await linearQuery<{
    viewer?: { id?: unknown; name?: unknown };
    organization?: { name?: unknown };
    teams?: N<{ id?: unknown; name?: unknown; key?: unknown; labels?: N<{ id?: unknown; name?: unknown }>; members?: N<{ id?: unknown; name?: unknown; displayName?: unknown; active?: unknown; app?: unknown }> }>;
    issueLabels?: N<{ id?: unknown; name?: unknown }>;
  }>({ apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch } : {}) }, VIEW);
  const labels = (n: N<{ id?: unknown; name?: unknown }> | undefined) => (n?.nodes ?? []).map((l) => ({ id: str(l.id), name: str(l.name) })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    organization: { name: str(d.organization?.name) },
    viewer: { id: str(d.viewer?.id), name: str(d.viewer?.name) },
    teams: (d.teams?.nodes ?? []).map((t) => ({
      id: str(t.id),
      name: str(t.name),
      key: str(t.key, 20),
      labels: labels(t.labels),
      members: (t.members?.nodes ?? []).filter((m) => m.active !== false && m.app !== true).map((m) => ({ id: str(m.id), name: str(m.displayName) || str(m.name) })),
    })),
    labels: labels(d.issueLabels),
  };
}

export interface ViewCommandOptions {
  kind: 'slack' | 'linear';
  instance?: string | undefined;
  json?: boolean;
  dir?: string;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The CLI command: pick the instance, read its secret, print what it sees. Exit 0, or 1 with one scrubbed line. */
export async function sourceViewCommand(o: ViewCommandOptions): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const err = o.err ?? ((l: string) => console.error(l));
  const dir = o.dir ?? instancesDir();
  let secret = '';
  try {
    let name = o.instance;
    if (!name) {
      const all = listInstances(dir);
      if (all.length !== 1) {
        err(all.length ? `more than one instance here (${all.join(', ')}); pass --instance <name>` : `no instance here (${dir}); run this as the instance's user, or pass --instance <name>`);
        return 1;
      }
      name = all[0]!;
    }
    let file: string | undefined;
    try {
      const c = loadInstanceCredentials(name, dir).credentials.intake;
      file = o.kind === 'slack' ? c?.slack_bot_token : c?.linear_api_key;
    } catch (e) {
      err(`instance ${name}: ${instanceFilesProblem(e)}`);
      return 1;
    }
    const key = o.kind === 'slack' ? 'intake.slack_bot_token' : 'intake.linear_api_key';
    if (!file) {
      err(`instance ${name} has no ${o.kind === 'slack' ? 'Slack bot token' : 'Linear API key'}: credentials.yaml names no ${key} (credentials.sh ${name} intake-${o.kind} installs it)`);
      return 1;
    }
    try {
      secret = readIntakeSecret(file);
    } catch (e) {
      err(`instance ${name}: can't read ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}); run this as the instance's user`);
      return 1;
    }
    if (!secret) {
      err(`instance ${name}: ${file} is empty`);
      return 1;
    }
    const f = o.fetch ? { fetch: o.fetch } : {};
    if (o.kind === 'slack') {
      const v = await slackView({ botToken: secret, ...f });
      if (o.json) out(scrubKey(JSON.stringify(v), secret));
      else {
        out(scrubKey(`workspace ${v.team.name} ${v.team.id}; the bot is ${v.bot.user}`, secret));
        for (const c of v.channels) out(scrubKey(`#${c.name} ${c.id}${c.member ? '' : ' (the bot is not in it: /invite it there)'}`, secret));
        for (const m of v.members) out(scrubKey(`person ${m.name} ${m.id}`, secret));
      }
      return 0;
    }
    const v = await linearView({ apiKey: secret, ...f });
    if (o.json) out(scrubKey(JSON.stringify(v), secret));
    else {
      out(scrubKey(`workspace ${v.organization.name}; the key is ${v.viewer.name}'s`, secret));
      for (const t of v.teams) {
        out(scrubKey(`team ${t.key} ${t.name} ${t.id}`, secret));
        for (const l of t.labels) out(scrubKey(`  label ${l.name} ${l.id}`, secret));
        for (const m of t.members) out(scrubKey(`  person ${m.name} ${m.id}`, secret));
      }
      for (const l of v.labels) out(scrubKey(`workspace label ${l.name} ${l.id}`, secret));
    }
    return 0;
  } catch (e) {
    // WHY: the last net: whatever was thrown, its message is scrubbed and its stack (which could hold it) is dropped.
    err(scrubKey(`${o.kind} view: ${(e as Error).message ?? String(e)}`, secret));
    return 1;
  }
}
