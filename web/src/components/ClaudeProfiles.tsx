// The agents' Claude account profiles (src/claude-profiles.ts, issue #464), inside the Machine page's Claude account
// panel, for the machine's owners: an accounts × instances table (which profile each instance's runs use, and whether
// each agent user's last real call on each profile was answered), adding an account from a setup token, choosing one
// for every instance or one instance (each checked by a real call first: refused, nothing changes), and removing one.
import { useRef, useState } from 'react';
import { addClaudeProfile, claudeProfileAction, type ProfileCell, type ProfileOp, type ProfilesTable } from '../api';
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
 * that): another instance, or every one, is a root admin's on the machine, with `confirmScript`.
 */
export function ClaudeProfiles({ table, ops, self, confirmScript, canAct, onChanged }: { table: ProfilesTable; ops: ProfileOp[]; self: string; confirmScript: string; canAct: boolean; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const running = ops.some((o) => o.status === 'running');
  const may = canAct && !running && !busy;
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
          Accounts sit side by side for each agent user. From here, only {self}'s: choosing one first makes one minimal real call as its agent user on it (the cheapest model, a one-word answer); if it is refused, nothing changes. Runs already going finish on the account they started on. Another instance, or every one, is chosen at a root shell on the machine: <code>sudo bash {confirmScript} use &lt;name&gt; [&lt;instance&gt;]</code>.
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
      <p className="text-[12px] text-ink-3">
        Add an account for {self}: on a machine signed in to it, run <code>claude setup-token</code>, then give it a name and paste what it prints. It is stored in {self}'s agent user's own profile and checked with a real call (refused: nothing is kept), then staged: nothing uses it until an admin confirms it on the machine.
      </p>
      <AddForm disabled={!may} onDone={(e) => (setErr(e), e ? undefined : onChanged?.())} />
      {err && (
        <p className="text-[12.5px] text-red" data-testid="claude-profile-error">
          {err}
        </p>
      )}
      {ops[0] && <LastOp op={ops[0]} />}
    </div>
  );
}
