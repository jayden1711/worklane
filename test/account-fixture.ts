// A dashboard whose agents' Claude account is fully known (issue #567): a confirmed profile in use with its email,
// org and plan, the status record claude-account.sh keeps, a refused login with Claude's words and a check, the hold
// an older engine recorded (its reason named the account), a profile switch and a failover, the red incident, and a
// backlog with one ready issue (so the Board and the ignored-issues list have something to say about it). Each role's
// answers are read from it by test/account-visibility.test.ts and test/web-render.test.ts.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBacklog } from '../src/backlog/file.js';
import { DEVICE_VIEWS } from '../src/dashboard-auth.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { raiseIncident } from '../src/watchdog/incidents.js';
import { exampleProject, exampleRole, machineOwnersFile, repoRoot } from './helpers.js';

const tag = randomBytes(4).toString('hex');
/** What names the account, made up at each run: no viewer may see any of these (nor a writer on the accounts panel). */
export const ACCOUNT = { email: `agents-${tag}@example.com`, org: `org-${tag}`, plan: `plan-${tag}`, profile: `night-${tag}` };
export const ACCOUNT_TEXT = new RegExp([ACCOUNT.email, ACCOUNT.org, ACCOUNT.plan, ACCOUNT.profile].map((s) => s.replace(/[.]/g, '\\.')).join('|'));

/** A person with no role here at all (no read on the repo): the dashboard refuses them everything. */
export const STRANGER = 'no-role-person';

/**
 * Every literal /api/ path the engine's source names (src/**), for a GET: the dashboard's routes and the modules that
 * answer for it. Paths built at runtime and prefixes (ending in /) aren't literals; the live stream never ends.
 */
export function apiPaths(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/'(\/api\/[a-z0-9/_-]*[a-z0-9_-])'/g)) out.add(m[1]!);
    }
  };
  walk(join(repoRoot, 'src'));
  // The views a console device may be asked for are named once, in DEVICE_VIEWS, and served at /api/<view>.
  for (const v of Object.values(DEVICE_VIEWS)) out.add(`/api/${v}`);
  out.delete('/api/stream');
  return [...out].sort();
}

export async function accountDashboard() {
  const dir = mkdtempSync(join(tmpdir(), 'account-visibility-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const instance = cfg.project.project.name;
  const agent = `wl-${instance}-agent`;
  const acct = join(dir, 'claude-account');
  mkdirSync(acct);
  const check = { instance, user: agent, account: ACCOUNT.email, subscription: ACCOUNT.plan, api_ok: true, checked_at: '2026-10-18T09:00:00Z' };
  writeFileSync(join(acct, 'profiles.json'), JSON.stringify({ version: 1, profiles: { [ACCOUNT.profile]: { kind: 'setup-token', added_at: '2026-10-17T00:00:00Z', users: { [agent]: check } } }, active: { [instance]: { profile: ACCOUNT.profile, since: '2026-10-18T08:00:00Z' } }, switched_at: { [instance]: '2026-10-18T08:00:00Z' } }));
  writeFileSync(join(acct, 'status.json'), JSON.stringify({ at: '2026-10-18T09:00:00Z', users: [{ instance, kind: 'agent', user: agent, stored: true, logged_in: true, auth_method: 'oauth_token', account: ACCOUNT.email, org: ACCOUNT.org, subscription: ACCOUNT.plan, api_ok: true }] }));
  writeFileSync(join(acct, 'profile-ops.jsonl'), '');
  const backlog = new FileBacklog(join(dir, 'backlog.json'));
  const issue = await backlog.createIssue('Add price.js', 'Add price.js.\n\n```done_when\n- test: test/price.test.js\n```\n', ['ready']);
  const eventsDb = join(dir, 'events.db');
  const log = new EventLog(eventsDb);
  const key = `/home/${agent}/.claude-profiles/${ACCOUNT.profile}`;
  log.append('issue.seen', { issue, title: 'Add price.js', labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, 'coordinator');
  log.append('account.switched', { op: 'op-1', to: ACCOUNT.profile, from: { [instance]: 'default' }, instances: [instance], by: 'example-owner', ok: true, detail: `${instance}: on ${ACCOUNT.profile}` }, 'coordinator');
  log.append('account.failover', { stage: 'switched', from: 'default', to: ACCOUNT.profile, reset_at: null, detail: `moved to ${ACCOUNT.profile}` }, 'coordinator');
  log.append('claude_auth.failed', { key, login: ACCOUNT.email, lane: 'default', issue: null, role: 'worker', detail: `claude's login was refused (HTTP 401): OAuth token has expired for ${ACCOUNT.email} (${ACCOUNT.org})` }, 'coordinator');
  log.append('claude_auth.checked', { key, login: ACCOUNT.email, ok: false, by: 'timer', detail: `still refused for ${ACCOUNT.email}`, cost_usd: 0 }, 'coordinator');
  // The hold as an engine before #567 recorded it: its reason named the account.
  log.append('governor.hold', { reason: `Claude sign-in failed (${ACCOUNT.email}): no new runs until a call on that login succeeds`, load: null, free_disk_pct: null, kind: 'sign_in' }, 'coordinator');
  log.close();
  const slotsDir = join(dir, 'slots');
  mkdirSync(slotsDir);
  mkdirSync(join(dir, 'state'));
  raiseIncident('claude_auth', `${instance}:refused`, `Claude refused a login this instance's runs use: ${ACCOUNT.email} (${ACCOUNT.plan})`, `Sign ${ACCOUNT.profile} in again`, { dir: slotsDir });
  const d = await startDashboard({
    root,
    cfg,
    eventsDb,
    stateDir: join(dir, 'state'),
    user: 'example-owner',
    roleOf: async (login: string) => (login === STRANGER ? null : exampleRole(login)),
    machineOwnersFile: machineOwnersFile('example-owner'),
    claudeAccountDir: acct,
    secretsHome: join(dir, 'home'),
    slotsDir,
    backlog: () => backlog,
    machineStats: () => null,
  });
  const base = d.url.split('/?')[0]!;
  /** A GET as this person (null: with no key at all, signed out). */
  const get = async (path: string, headers: Record<string, string> | null) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000), ...(headers ? { headers: { authorization: `Bearer ${d.token}`, ...headers } } : {}) });
    return { status: res.status, text: await res.text() };
  };
  return { d, instance, issue, get };
}
