// The agents' Claude account profiles (src/claude-profiles.ts, issue #464), inside the Machine page's Claude account
// panel, for the machine's owners: an accounts × instances table (which profile each instance's runs use, and whether
// each agent user's last real call on each profile was answered), adding an account from a setup token, choosing one
// for every instance or one instance (each checked by a real call first: refused, nothing changes), and removing one.
import { useRef, useState } from 'react';
import { addClaudeProfile, claudeProfileAction, setClaudeFailover, type ProfileCell, type ProfileOp, type ProfilesTable } from '../api';
import { ago, Badge, Button, cx } from './ui';

const OP_LABEL: Record<ProfileOp['op'], string> = { 'profile-add': 'Add', use: 'Switch to', remove: 'Remove' };
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
      {!c.active && canAct && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUse} data-testid="claude-profile-use-here">
          Use here
        </Button>
      )}
    </td>
  );
}

/** The add form: the token field is uncontrolled, sent straight to the server and cleared; never in state or shown. */
function AddForm({ disabled, onDone }: { disabled: boolean; onDone: (err: string | null) => void }) {
  const name = useRef<HTMLInputElement>(null);
  const token = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const n = name.current?.value.trim() ?? '';
    const t = token.current;
    if (!n || !t || !t.value) return;
    setBusy(true);
    try {
      await addClaudeProfile(n, t.value);
      if (name.current) name.current.value = '';
      onDone(null);
    } catch (e) {
      onDone((e as Error).message);
    } finally {
      t.value = '';
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-testid="claude-profile-add"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input ref={name} name="claude-profile-name" aria-label="A name for the account" placeholder="name (e.g. work)" pattern="[a-z][a-z0-9-]{0,20}" className="w-36 rounded-control border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px]" data-testid="claude-profile-name" />
      <input ref={token} type="password" autoComplete="off" spellCheck={false} name="claude-profile-token" aria-label="The token claude setup-token printed for that account" placeholder="sk-ant-oat01-… (not shown)" className="min-w-0 flex-1 basis-56 rounded-control border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px]" data-testid="claude-profile-token" />
      <Button type="submit" size="sm" disabled={disabled || busy} data-testid="claude-profile-add-send">
        {busy ? 'Adding…' : 'Add account'}
      </Button>
    </form>
  );
}

/** Auto-failover: off by default; an order of accounts to move through on a usage limit, and whether to move back. */
function Failover({ table, disabled, onDone }: { table: ProfilesTable; disabled: boolean; onDone: (err: string | null) => void }) {
  const [scope, setScope] = useState('');
  const current = (scope ? table.failover?.instances[scope] : undefined) ?? table.failover?.machine ?? null;
  const on = !!current && current.order.length >= 2;
  const [order, setOrder] = useState((current?.order.length ? current.order : table.profiles.map((p) => p.name)).join(', '));
  const [back, setBack] = useState(current?.back ?? true);
  const [busy, setBusy] = useState(false);
  const send = async (enable: boolean) => {
    setBusy(true);
    try {
      const list = order.split(',').map((s) => s.trim()).filter(Boolean);
      await setClaudeFailover(enable ? list : null, back, scope || undefined);
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
        <span className="text-[13px] font-medium text-ink">Failover on a usage limit</span>
        <Badge tone={on ? 'info' : 'neutral'}>{on ? `on: ${current!.order.join(' → ')}${current!.back ? ', back after the reset' : ''}` : 'off'}</Badge>
      </div>
      <p className="text-[12px] text-ink-3">
        When the account in use hits its usage limit, move to the next one in this order, after a real call on it as each agent user; a notice says which and when the limit resets. Never on a sign-in failure: that pauses runs on that account until you act.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <label className="flex items-center gap-1">
          For
          <select
            value={scope}
            onChange={(e) => {
              // The form shows the chosen scope's setting (an instance without its own goes by the machine's).
              const next = e.target.value;
              const c = (next ? table.failover?.instances[next] : undefined) ?? table.failover?.machine ?? null;
              setScope(next);
              setOrder((c?.order.length ? c.order : table.profiles.map((p) => p.name)).join(', '));
              setBack(c?.back ?? true);
            }} className="rounded-control border border-line bg-surface px-1.5 py-1" data-testid="claude-failover-scope">
            <option value="">every instance</option>
            {table.instances.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
        <input value={order} onChange={(e) => setOrder(e.target.value)} aria-label="The accounts to move through, in order, comma-separated" className="min-w-0 flex-1 basis-48 rounded-control border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px]" data-testid="claude-failover-order" />
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
export function ClaudeProfiles({ table, ops, canAct, onChanged }: { table: ProfilesTable; ops: ProfileOp[]; canAct: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const running = ops.some((o) => o.status === 'running');
  const may = canAct && !running && !busy;
  const act = async (action: 'use' | 'remove', profile: string, instance?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await claudeProfileAction(action, profile, instance);
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
          Each account is signed in for every agent user side by side. Choosing one first makes one minimal real call as each agent user on it (the cheapest model, a one-word answer); if any is refused, nothing changes. Runs already going finish on the account they started on.
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
                    <div className="text-[11px] text-ink-3">{p.name === 'default' ? 'the login each agent user had' : p.addedAt ? `added ${ago(p.addedAt)}` : p.kind}</div>
                  </td>
                  {p.cells.map((c) => (
                    <Cell key={c.instance} c={c} profile={p.name} canAct={may} busy={busy} onUse={() => void act('use', p.name, c.instance)} />
                  ))}
                  <td className="px-2 py-1.5 align-top">
                    <div className="flex flex-wrap gap-1">
                      {!p.cells.every((c) => c.active) && (
                        <Button size="sm" variant="outline" disabled={!may} onClick={() => void act('use', p.name)} data-testid="claude-profile-use-all">
                          Use everywhere
                        </Button>
                      )}
                      {p.name !== 'default' &&
                        (removing === p.name ? (
                          <>
                            <Button size="sm" disabled={!may} onClick={() => void act('remove', p.name)} data-testid="claude-profile-remove-confirm">
                              Remove its login from every agent user
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
      <p className="text-[12px] text-ink-3">
        Add an account: on a machine signed in to it, run <code>claude setup-token</code>, then give it a name and paste what it prints. It is stored in each agent user's own profile and checked with a real call; if the API refuses it, nothing is kept.
      </p>
      <AddForm disabled={!may} onDone={(e) => (setErr(e), e ? undefined : onChanged?.())} />
      {table.profiles.length > 1 && <Failover table={table} disabled={!may} onDone={(e) => (setErr(e), e ? undefined : onChanged?.())} />}
      {err && (
        <p className="text-[12.5px] text-red" data-testid="claude-profile-error">
          {err}
        </p>
      )}
      {ops[0] && <LastOp op={ops[0]} />}
    </div>
  );
}
