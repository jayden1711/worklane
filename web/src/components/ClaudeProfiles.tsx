// The agents' Claude account profiles (src/claude-profiles.ts, issue #464), inside the Machine page's Claude account
// panel, for the machine's owners: an accounts × instances table (which profile each instance's runs use, and whether
// each agent user's last real call on each profile was answered), choosing one for this instance (checked by a real
// call first: refused, nothing changes), and removing one. Adding an account, or signing one in, takes a Claude
// credential, which this page never takes (issue #711): it names the root command instead.
import { useState } from 'react';
import { claudeProfileAction, setClaudeFailover, type ProfileCell, type ProfileOp, type ProfilesTable } from '../api';
import { ago, Badge, Button, cx } from './ui';

const OP_LABEL: Record<ProfileOp['op'], string> = { 'profile-add': 'Add', use: 'Switch to', remove: 'Remove', login: 'Sign in' };
const OP_TONE: Record<ProfileOp['status'], 'info' | 'ok' | 'danger'> = { running: 'info', done: 'ok', failed: 'danger', stalled: 'danger' };
const OP_STATUS: Record<ProfileOp['status'], string> = { running: 'running', done: 'done', failed: 'refused', stalled: 'stopped without finishing' };

function Cell({ c, profile, canAct, busy, onUse }: { c: ProfileCell; profile: string; canAct: boolean; busy: boolean; onUse: () => void }) {
  const tone = c.apiOk === true ? 'ok' : c.apiOk === false ? 'danger' : 'neutral';
  const said = c.apiOk === true ? 'answered' : c.apiOk === false ? 'refused' : 'not checked';
  return (
    <td className="px-2 py-1.5 align-top" data-testid="claude-profile-cell" data-profile={profile} data-instance={c.instance} data-active={c.active ? 'yes' : 'no'} data-valid={c.apiOk === null ? 'unknown' : c.apiOk ? 'yes' : 'no'}>
      <div className="flex flex-wrap items-center gap-1">
        {c.active && <Badge tone="info">active</Badge>}
        <Badge tone={tone}>{said}</Badge>
      </div>
      {c.account && <div className="break-words text-[11.5px] text-ink-2">{c.account}{c.subscription ? ` · ${c.subscription}` : ''}</div>}
      {c.checkedAt && <div className="text-[11px] text-ink-3">checked {ago(c.checkedAt)}</div>}
      {c.apiOk === false && c.apiError && <div className="break-words text-[11px] text-red">{c.apiError}</div>}
      {c.limit && (
        <div className="mt-0.5 space-y-0.5" data-testid="claude-profile-limit" data-reset-at={c.limit.resetAt}>
          <Badge tone="warn">usage limit</Badge>
          <div className="break-words text-[11px] text-ink-2">resets {c.limit.resets}</div>
        </div>
      )}
      {!c.active && canAct && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUse} data-testid="claude-profile-use-here">
          Use here
        </Button>
      )}
    </td>
  );
}

/** Auto-failover: off by default; an order of accounts to move through on a usage limit, and whether to move back. */
function Failover({ table, self, confirmScript, disabled, onDone }: { table: ProfilesTable; self: string; confirmScript: string; disabled: boolean; onDone: (err: string | null) => void }) {
  // This instance's own setting, else the machine's (a root admin's, at a root shell).
  const own = table.failover?.instances[self] ?? null;
  const current = own ?? table.failover?.machine ?? null;
  const on = !!current && current.order.length >= 2;
  const usable = table.profiles.filter((p) => !p.staged).map((p) => p.name);
  const [order, setOrder] = useState((current?.order.length ? current.order : usable).join(', '));
  const [back, setBack] = useState(current?.back ?? true);
  const [busy, setBusy] = useState(false);
  const send = async (enable: boolean) => {
    setBusy(true);
    try {
      const list = order.split(',').map((s) => s.trim()).filter(Boolean);
      await setClaudeFailover(enable ? list : null, back);
      onDone(null);
    } catch (e) {
      onDone((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-failover" data-on={on ? 'yes' : 'no'}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Failover on a usage limit, for {self}</span>
        <Badge tone={on ? 'info' : 'neutral'}>{on ? `on: ${current!.order.join(' → ')}${current!.back ? ', back after the reset' : ''}${own ? '' : " (the machine's)"}` : 'off'}</Badge>
      </div>
      <p className="text-[12px] text-ink-3">
        When the account in use hits its usage limit, move {self} to the next one in this order, after a real call on it as its agent user; a notice says which and when the limit resets. Never on a sign-in failure, and never to a staged account. Every instance's setting is a root admin's: <code>sudo bash {confirmScript} failover a+b back</code>.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <input value={order} onChange={(e) => setOrder(e.target.value)} aria-label="The accounts to move through, in order, comma-separated" className="min-w-0 flex-1 basis-48 rounded-control border border-line-strong dark:border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px]" data-testid="claude-failover-order" />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} data-testid="claude-failover-back" />
          move back after the reset
        </label>
        <Button size="sm" disabled={disabled || busy} onClick={() => void send(true)} data-testid="claude-failover-on">
          {on ? 'Save' : 'Turn on'}
        </Button>
        {on && (
          <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void send(false)} data-testid="claude-failover-off">
            Turn off
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Adding an account, as a root admin does it on the machine: never through this page, which takes no Claude credential
 * (issue #711): a token from `claude setup-token`, at the hidden prompt of `claude-account.sh profile-add`.
 */
function AddHowTo({ self, confirmScript }: { self: string | null; confirmScript: string }) {
  return (
    <div className="space-y-1.5 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-profile-add-howto">
      <div className="text-[13px] font-medium text-ink">Add an account</div>
      <p className="text-[12px] text-ink-3">
        A root admin adds it on the machine; this page never takes a Claude credential. On a machine signed in to the account, run <code>claude setup-token</code>, then on this machine paste what it prints at the hidden prompt of:
      </p>
      <pre className="overflow-x-auto font-mono text-[12px] text-ink" data-testid="claude-profile-add-command">sudo bash {confirmScript} profile-add &lt;name&gt;</pre>
      {self !== null ? (
        <p className="text-[12px] text-ink-3">It is checked with a real call as each agent user ({self}'s included); then choose it here with Use here.</p>
      ) : (
        <p className="text-[12px] text-ink-3">It is added for every instance's agent user at once, each checked with a real call; then choose it for an instance by picking that instance in the sidebar, or for every one at a root shell.</p>
      )}
    </div>
  );
}

function LastOp({ op }: { op: ProfileOp }) {
  return (
    <div className="space-y-1 rounded-control bg-inset p-3 shadow-hairline" data-testid="claude-profile-op" data-op={op.op} data-status={op.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-medium text-ink">
          {OP_LABEL[op.op]} {op.profile}
        </span>
        <Badge tone={OP_TONE[op.status]}>{OP_STATUS[op.status]}</Badge>
        <span className="text-ink-3">started {ago(op.startedAt)}</span>
      </div>
      {op.steps.map((s, i) => (
        <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]" data-testid="claude-profile-op-step" data-state={s.state}>
          {s.user && <span className="font-mono text-[11.5px] text-ink-2">{s.user}</span>}
          <Badge tone={s.state === 'done' ? 'ok' : s.state === 'failed' ? 'danger' : 'info'}>{s.step}</Badge>
          <span className="min-w-0 break-words text-ink-3">{s.detail}</span>
        </div>
      ))}
      {op.status !== 'running' && <p className={cx('text-[12.5px]', op.status === 'done' ? 'text-ink-2' : 'text-red')}>{op.detail}</p>}
    </div>
  );
}

/** The profiles section; `canAct`: the person may change accounts now (a machine owner here, nothing else running). */
/**
 * `self`: this dashboard's instance. Every step from here is for it alone (the server and the machine helper hold to
 * that): another instance, or every one, is a root admin's on the machine, with `confirmScript`. null: "All instances"
 * is chosen on a hub, so the table is shown for every instance and no step for one instance is offered (#562).
 */
export function ClaudeProfiles({ table, ops, self, confirmScript, canAct, onChanged }: { table: ProfilesTable; ops: ProfileOp[]; self: string | null; confirmScript: string; canAct: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const running = ops.some((o) => o.status === 'running');
  const may = canAct && self !== null && !running && !busy;
  const act = async (action: 'use' | 'remove', profile: string) => {
    setBusy(true);
    setErr(null);
    try {
      await claudeProfileAction(action, profile);
      setRemoving(null);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="claude-profiles">
      <div>
        <div className="text-[13px] font-medium text-ink">Accounts</div>
        <p className="text-[12px] text-ink-3">
          {self === null ? (
            <>
              Accounts sit side by side for each agent user, every instance's here. To choose or remove one for an instance from here, pick that instance in the sidebar. Every instance at once is chosen at a root shell on the machine: <code>sudo bash {confirmScript} use &lt;name&gt;</code>.
            </>
          ) : (
            <>
              Accounts sit side by side for each agent user. From here, only {self}'s: choosing one first makes one minimal real call as its agent user on it (the cheapest model, a one-word answer); if it is refused, nothing changes. Runs already going finish on the account they started on. Another instance, or every one, is chosen at a root shell on the machine: <code>sudo bash {confirmScript} use &lt;name&gt; [&lt;instance&gt;]</code>.
            </>
          )}
        </p>
      </div>
      <div className="overflow-x-auto rounded-card bg-surface shadow-card">
        <table className="w-full text-left text-[12.5px]" data-testid="claude-profiles-table">
          <thead>
            <tr className="border-b border-line text-[11.5px] text-ink-3">
              <th className="px-2 py-1.5 font-medium">Account</th>
              {table.instances.map((i) => (
                <th key={i} className="px-2 py-1.5 font-medium">
                  {i}
                  {/* Usage limits come from each instance's own log: this server read only its own (#566). */}
                  {table.limitsOf && i !== table.limitsOf && (
                    <div className="text-[10.5px] font-normal text-ink-3" data-testid="claude-profile-limit-elsewhere" data-instance={i} title={`${i}'s usage limit is in its own log: its dashboard shows it`}>
                      usage limit: not shown here
                    </div>
                  )}
                </th>
              ))}
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {table.profiles.map((p) => {
              const inUse = p.cells.some((c) => c.active);
              return (
                <tr key={p.name} data-testid="claude-profile-row" data-profile={p.name}>
                  <td className="px-2 py-1.5 align-top">
                    <div className="font-mono text-[12px] text-ink">{p.name}</div>
                    <div className="text-[11px] text-ink-3">{p.name === 'default' ? 'the login each agent user had' : p.addedAt ? `added ${ago(p.addedAt)}${p.addedFor ? ` for ${p.addedFor}` : ''}` : p.kind}</div>
                    {p.staged && (
                      <div className="mt-1 space-y-0.5" data-testid="claude-profile-staged">
                        <Badge tone="warn">staged: not usable yet</Badge>
                        <div className="text-[11px] text-ink-3">
                          An admin confirms it on the machine, seeing the account first: <code>sudo bash {confirmScript} confirm-profile {p.name}</code>
                        </div>
                      </div>
                    )}
                  </td>
                  {p.cells.map((c) => (
                    <Cell key={c.instance} c={c} profile={p.name} canAct={may && c.instance === self && !p.staged} busy={busy} onUse={() => void act('use', p.name)} />
                  ))}
                  <td className="px-2 py-1.5 align-top">
                    <div className="flex flex-wrap gap-1">
                      {p.name !== 'default' && p.cells.some((c) => c.instance === self && c.apiOk !== null) &&
                        (removing === p.name ? (
                          <>
                            <Button size="sm" disabled={!may} onClick={() => void act('remove', p.name)} data-testid="claude-profile-remove-confirm">
                              Remove its login from {self}'s agent user
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="ghost" disabled={!may || inUse} title={inUse ? 'in use: choose another account for those instances first' : undefined} onClick={() => setRemoving(p.name)} data-testid="claude-profile-remove">
                            Remove…
                          </Button>
                        ))}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* profile-add covers every instance's agent user, so its how-to shows under All instances too. */}
      <AddHowTo self={self} confirmScript={confirmScript} />
      {self !== null && table.profiles.filter((p) => !p.staged).length > 1 && <Failover table={table} self={self} confirmScript={confirmScript} disabled={!may} onDone={(e) => (setErr(e), e ? undefined : onChanged?.())} />}
      {err && (
        <p className="text-[12.5px] text-red" data-testid="claude-profile-error">
          {err}
        </p>
      )}
      {ops[0] && <LastOp op={ops[0]} />}
    </div>
  );
}
