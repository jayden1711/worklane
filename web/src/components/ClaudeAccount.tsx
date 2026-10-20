// The agents' Claude account, on the Machine page, for the machine's owners only (src/claude-account.ts): which
// account and expiry each agent user has. The engine manages no Claude account (#736): a person signs an agent user in
// themselves, as that user, on the machine, and the panel names that command; what the removed account profiles,
// failover and switch left on the machine is named with the root step that removes it. The page never takes a Claude
// credential (issue #711): no token box. Everyone else gets only whether an account is set (issue #567): the server
// refuses them the accounts, and sends that in the state.
import { useEffect, useId, useState } from 'react';
import { claudeAccountAction, getClaudeAccount, isRefusal, useScope, type ClaudeAccountData, type InstanceScope } from '../api';
import { afterLoad, NOTHING_YET, StaleNote, useRetry, type Loaded } from '../refresh';
import { ago, Badge, Button, Card, firstWhy } from './ui';

const expiry = (at: string | null, now: number) => {
  if (!at) return { text: 'no expiry known', tone: 'neutral' as const };
  const days = Math.floor((Date.parse(at) - now) / 86_400_000);
  if (days < 0) return { text: `expired ${at.slice(0, 10)}`, tone: 'danger' as const };
  return { text: `expires ${at.slice(0, 10)} (${days} day${days === 1 ? '' : 's'})`, tone: days < 14 ? ('warn' as const) : ('neutral' as const) };
};

/** What the removed account profiles, failover and switch left on the machine (#736), and the root step that removes it. */
function Retired({ r }: { r: NonNullable<ClaudeAccountData['retired']> }) {
  return (
    <div className="space-y-1 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-account-retired">
      <p className="text-[12.5px] text-ink-2">
        Account profiles, failover and the account switch were removed. This machine still has what they left, which nothing uses: {r.files.join(', ')}.
        {r.refused.length > 0 && (
          <span className="text-red" data-testid="claude-account-retired-refused">
            {' '}
            Not started until it is removed, since their runs were on another profile: {r.refused.join(', ')}.
          </span>
        )}
        {r.unreadable && <span className="text-red"> Its profiles.json can't be read, so no instance starts until it is removed.</span>}
      </p>
      <p className="text-[12px] text-ink-3">A root admin removes it on the machine:</p>
      <pre className="overflow-x-auto font-mono text-[12px] text-ink" data-testid="claude-account-retired-command">
        {r.command}
      </pre>
    </div>
  );
}

/**
 * The panel from its data (also what the render checks render); nothing at all for anyone but a machine owner.
 * `scope`: on a hub, the instances the page shows. With "All instances" chosen the panel says it covers every one
 * (#562); with one instance picked, it names that one.
 */
export function ClaudeAccountView({ data, scope = null, onChanged, now = Date.now() }: { data: ClaudeAccountData; scope?: InstanceScope | null; onChanged?: () => void; now?: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refusedId = useId();
  if (!data.machineOwner) return null;
  const act = async (action: 'status') => {
    setBusy(action);
    setErr(null);
    try {
      await claudeAccountAction(action);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const users = data.status?.users ?? [];
  const open = data.requests.filter((r) => r.status === 'pending' || r.status === 'running');
  const all = scope?.all ? scope.instances.filter((i): i is string => !!i) : null;
  return (
    <Card className="space-y-3 p-4" data-testid="claude-account">
      <div>
        <div className="text-[14px] font-medium text-ink">Claude account</div>
        <p className="text-[12px] text-ink-3">The Claude login every agent on this machine uses: each instance's agent user (channel chat runs as it too) and eval user. For the machine's owners.</p>
        {scope?.current && (
          <p className="mt-1 text-[12px] text-ink-2" data-testid="claude-account-scope" data-scope={all ? 'all' : data.instance}>
            {all ? <>For every instance on this machine ({all.join(', ')}): Refresh covers them all.</> : <>For {data.instance}: Refresh covers every instance on this machine.</>}
          </p>
        )}
      </div>
      {data.status ? (
        <ul className="divide-y divide-line rounded-card bg-surface shadow-card" data-testid="claude-account-users">
          {users.map((u) => {
            const e = expiry(u.expiresAt, now);
            return (
              <li key={`${u.instance}/${u.user}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12.5px]" data-testid="claude-account-user" data-user={u.user} data-signed-in={u.loggedIn ? 'yes' : 'no'}>
                <span className="min-w-0 font-mono text-[12px] text-ink">
                  {u.user} <span className="text-ink-3">({u.instance}, {u.kind})</span>
                </span>
                <Badge tone={u.loggedIn ? 'ok' : 'danger'}>{u.loggedIn ? 'signed in' : 'not signed in'}</Badge>
                <span className="min-w-0 break-words text-ink-2">{u.account ? `${u.account}${u.org ? ` · ${u.org}` : ''}` : (u.authMethod ?? 'no account named')}</span>
                {u.tokenId && <span className="font-mono text-[11.5px] text-ink-3" title="the first 8 hex digits of the token's sha256: the same login shows the same id">token {u.tokenId}</span>}
                <Badge tone={e.tone}>{e.text}</Badge>
                {u.error && !u.loggedIn && <span className="basis-full text-[12px] text-red">{u.error}</span>}
              </li>
            );
          })}
          {!users.length && <li className="px-3 py-2 text-[12.5px] text-ink-3">No agent users found on this machine.</li>}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3" data-testid="claude-account-none">
          Not read yet: Refresh asks the machine for each agent user's account.
        </p>
      )}
      {data.status && <p className="text-[11.5px] text-ink-3">Read {ago(data.status.at)}.</p>}
      {/* A person no device would help (their role here) gets no buttons, only the read-only line below. */}
      {data.everAllowed !== false && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" why={firstWhy(!data.allowed && (data.why ?? 'not allowed'), !!busy && 'Asking…', open.some((r) => r.args[1] === 'status') && 'A refresh is waiting for the coordinator')} {...(!data.allowed && data.why ? { whyAt: refusedId } : {})} onClick={() => void act('status')} data-testid="claude-account-refresh">
            {busy === 'status' || open.some((r) => r.args[1] === 'status') ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      )}
      {/* #736: the engine signs no one in and switches no account; a person signs an agent user in themselves, on the machine. */}
      {data.signin && (
        <div className="space-y-1 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-account-signin-howto">
          <p className="text-[12.5px] text-ink-2">To sign an agent user in, or change its account, sign in as that user on the machine, through Anthropic's own sign-in. This page never takes a Claude credential.</p>
          <pre className="overflow-x-auto font-mono text-[12px] text-ink" data-testid="claude-account-signin-command">
            {data.signin}
          </pre>
        </div>
      )}
      {data.retired && <Retired r={data.retired} />}
      {!data.allowed && data.why && (
        <p id={refusedId} className="text-[12.5px] text-ink-2" data-testid="claude-account-disabled">
          Read-only: {data.why}.
        </p>
      )}
      {open.map((r) => (
        <p key={r.id} className="text-[12.5px] text-ink-3" data-testid="claude-account-request">
          {r.args.join(' ')}: {r.status === 'pending' ? 'waiting for the coordinator' : 'running'} (asked {ago(r.at)} by @{r.by})
        </p>
      ))}
      {err && (
        <p className="text-[12.5px] text-red" data-testid="claude-account-error">
          {err}
        </p>
      )}
    </Card>
  );
}

/** Whether the panel looks again every few seconds: a request waits for the coordinator or is running. */
export function accountBusy(d: Pick<ClaudeAccountData, 'requests'>): boolean {
  return d.requests.some((r) => r.status === 'pending' || r.status === 'running');
}

/**
 * For anyone the panel refuses (a viewer, a writer, an owner who isn't a machine owner): whether the agents' Claude
 * account is set, from the state, and nothing more. The server sends them no account or plan (#567).
 * Nothing when the state doesn't say (a checkout, an older server).
 */
export function ClaudeAccountSet({ set }: { set: boolean | null | undefined }) {
  if (set === undefined) return null;
  return (
    <Card className="space-y-1 p-4" data-testid="claude-account-set" data-set={set === null ? 'unknown' : String(set)}>
      <div className="text-[14px] font-medium text-ink">Claude account</div>
      <p className="text-[12.5px] text-ink-2">
        {set === null ? "Not known yet: the machine hasn't checked the agents' Claude login." : set ? 'An account is set for this instance\'s agents.' : "No account is signed in for this instance's agents."}
      </p>
      <p className="text-[12px] text-ink-3">Which account it is, and signing one in, are for the machine's owners.</p>
    </Card>
  );
}

/**
 * The panel: loaded, and looked at again every few seconds while a request is under way. On refusal, only whether an
 * account is set (`accountSet`, from the state); a look that fails otherwise keeps the last good data on screen
 * (web/src/refresh.tsx).
 */
export function ClaudeAccountPanel({ onLoaded, accountSet }: { onLoaded?: () => void; accountSet?: boolean | null | undefined }) {
  const scope = useScope();
  const [loaded, setLoaded] = useState<Loaded<ClaudeAccountData>>(NOTHING_YET);
  const [refused, setRefused] = useState(false);
  const data = loaded.data;
  const load = () =>
    getClaudeAccount()
      .then(
        (d) => {
          setRefused(false);
          setLoaded({ data: d, stale: null });
        },
        (error: unknown) => {
          if (isRefusal(error)) setRefused(true);
          setLoaded((p) => afterLoad(p, { error }));
        },
      )
      .finally(() => onLoaded?.());
  useEffect(() => void load(), []);
  useRetry(loaded, () => void load());
  const active = !!data && accountBusy(data);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [active]);
  if (!data) return refused ? <ClaudeAccountSet set={accountSet} /> : null;
  return (
    <div className="space-y-1">
      <StaleNote stale={loaded.stale} />
      <ClaudeAccountView data={data} scope={scope} onChanged={() => void load()} />
    </div>
  );
}
