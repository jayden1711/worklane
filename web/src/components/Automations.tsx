// WHY: Extend -> Automations (docs/automations.md). The server sends this view to owners and writers only, with the
// actions this person may use (`actions`): the page shows those buttons and no others. Every action is reviewed first
// (the server says exactly what changes; nothing is written) and confirmed against the file that review saw.
import { useState } from 'react';
import { changeAutomation, useView, type AutomationAction, type AutomationDef, type AutomationItem, type AutomationPlan, type AutomationsView, type State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Button, Card, cx, usd } from './ui';

const field = 'h-8 w-full rounded-control bg-field px-2.5 text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
const fieldAuto = field.replace('w-full', 'w-auto max-w-full');
const label = 'block space-y-1 text-[12px] text-ink-3';

const ACTION_LABEL: Record<AutomationAction, string> = { create: 'Create', edit: 'Edit', delete: 'Delete', pause: 'Pause', resume: 'Resume', run: 'Run now', rotate: 'Rotate secret', unbind: 'Unbind device' };

/** Three starting points inside the form (never in the empty state, which offers one action). */
const PRESETS: { name: string; def: AutomationDef }[] = [
  {
    name: 'Weekly dependency check',
    def: { id: 'weekly-deps', name: 'Weekly dependency check', trigger: { kind: 'schedule', cron: '0 9 * * 1' }, mode: 'task', template: { title: 'Dependency check, week of {week}', outcome: 'Patch and minor dependency bumps whose tests pass, and a list of the major ones.', done_when: [{ command: 'npm test' }] }, budget: { per_run_usd: 3, per_day_usd: 6 }, limits: { runs_per_day: 1, cooldown_minutes: 60 } },
  },
  {
    name: 'Triage issues with a label',
    def: { id: 'triage-label', name: 'Triage labelled issues', trigger: { kind: 'github', on: 'issue.labeled', label: 'triage-me' }, mode: 'report', template: { title: 'Triage this issue', outcome: 'Where in the code it likely is, how risky it looks, and what to ask the reporter.', done_when: [] }, budget: { per_run_usd: 1, per_day_usd: 4 }, limits: { runs_per_day: 4, cooldown_minutes: 10 } },
  },
  {
    name: 'A report on a Discord command',
    def: { id: 'status-report', name: 'Status report', trigger: { kind: 'discord', command: 'status' }, mode: 'report', template: { title: "Summarize this week's merged work", outcome: 'Five bullet points a person outside the team understands.', done_when: [] }, budget: { per_run_usd: 1, per_day_usd: 2 }, limits: { runs_per_day: 2, cooldown_minutes: 60 } },
  },
];

const BLANK: AutomationDef = { id: '', name: '', trigger: { kind: 'schedule', cron: '0 9 * * 1' }, mode: 'task', template: { title: '', outcome: '', done_when: [{ command: '' }] }, budget: { per_run_usd: 2, per_day_usd: 4 }, limits: { runs_per_day: 1, cooldown_minutes: 60 } };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);

export function AutomationsTab({ state, id }: { state: State; id: string | null }) {
  const [creating, setCreating] = useState(false);
  const { data, error } = useView<AutomationsView>('/api/automations', state.lastId);
  if (error) return <p className="text-[12.5px] text-red" data-testid="automations-error">{error}</p>;
  if (!data) return <p className="text-[12.5px] text-ink-3">Loading…</p>;
  if (data.unavailable) return <p className="text-[12.5px] text-ink-3" data-testid="automations-unavailable">{data.unavailable}</p>;
  const can = (a: AutomationAction) => data.actions.includes(a);
  const selected = id ? (data.automations.find((a) => a.id === id) ?? null) : null;
  const off = !data.limits.enabled && (
    <p className="rounded-lg bg-orange-tint p-3 text-[12.5px] text-ink" data-testid="automations-off">
      Automations are {data.limits.off}. {can('create') ? 'You can still set them up; none runs until they are on.' : 'An owner turns them on.'}
    </p>
  );
  if (creating) return <AutomationForm digest={data.digest} onDone={(newId) => (setCreating(false), newId && navigate(`/extend/automations/${newId}`))} />;
  if (!data.automations.length)
    return (
      <div className="space-y-3">
        {off}
        {data.error && <p className="text-[12.5px] text-red" data-testid="automations-file-error">{data.error}</p>}
        <div className="rounded-card bg-inset p-8 text-center shadow-hairline" data-testid="automations-empty">
          <div className="text-[14px] font-medium text-ink">No automations yet</div>
          <p className="mx-auto mt-1.5 max-w-md text-[12.5px] text-ink-2">An automation runs an agent task for you on a schedule or when something happens: a GitHub issue or pull request, a Discord message, or a webhook from your tailnet.</p>
          <ul className="mx-auto mt-3 max-w-sm space-y-0.5 text-left text-[12px] text-ink-2">
            <li>· Each one has its own budget and a daily run limit.</li>
            <li>· Its work goes through the same sandbox, review and merge rules as any other run.</li>
            <li>· Nothing it makes can start another automation unless you allow it.</li>
          </ul>
          {can('create') ? (
            <Button className="mt-4" onClick={() => setCreating(true)} data-testid="automations-new">
              New automation
            </Button>
          ) : (
            <p className="mt-4 text-[12.5px] text-ink-3" data-testid="automations-owner-only">
              An owner of this repo sets up automations.
            </p>
          )}
        </div>
      </div>
    );
  return (
    <div className="space-y-3" data-testid="automations">
      {off}
      {data.error && <p className="text-[12.5px] text-red" data-testid="automations-file-error">{data.error}</p>}
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span data-testid="automations-today">
          {data.automations.length} automation{data.automations.length === 1 ? '' : 's'} · {usd(data.today.spentUsd)} of {usd(data.limits.dailyUsd)} automation budget used today · {data.today.runs} of {data.limits.maxRunsPerDay} runs
        </span>
        {can('create') && (
          <Button size="sm" className="ml-auto" onClick={() => setCreating(true)} data-testid="automations-new">
            New automation
          </Button>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ul className={cx('space-y-1.5', selected && 'max-lg:hidden')} data-testid="automations-list">
          {data.automations.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => navigate(`/extend/automations/${a.id}`)}
                className={cx('w-full rounded-lg p-3 text-left shadow-hairline hover:bg-hover', selected?.id === a.id ? 'bg-hover' : 'bg-surface')}
                data-testid="automation-row"
                data-id={a.id}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                  <span className={cx('size-2 shrink-0 rounded-full', !a.enabled ? 'bg-ink-3' : a.runs[0]?.outcome.startsWith('failed') ? 'bg-red' : 'bg-green')} />
                  <span className="truncate">{a.name}</span>
                  <span className="ml-auto shrink-0 text-[12px] font-normal text-ink-3">
                    {usd(a.today.spentUsd)} / {usd(a.budget.per_day_usd)}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[12px] text-ink-3">
                  {a.mode === 'task' ? 'files a task' : 'report'} · {a.enabled ? a.when : 'paused'}
                </div>
              </button>
            </li>
          ))}
        </ul>
        {selected ? <AutomationDetail a={selected} actions={data.actions} digest={data.digest} timezone={data.timezone} /> : <p className="text-[12.5px] text-ink-3 max-lg:hidden">Pick an automation to see what it does and its last runs.</p>}
        {id && !selected && <p className="text-[12.5px] text-ink-3" data-testid="automation-missing">No automation {id} here.</p>}
      </div>
    </div>
  );
}

export function AutomationDetail({ a, actions, digest, timezone }: { a: AutomationItem; actions: AutomationAction[]; digest: string; timezone: string }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <AutomationForm digest={digest} initial={a} onDone={() => setEditing(false)} />;
  const shown = actions.filter((x) => x !== 'create' && (x !== 'pause' || a.enabled) && (x !== 'resume' || !a.enabled) && (x !== 'run' || a.enabled) && ((x !== 'rotate' && x !== 'unbind') || !!a.webhook) && (x !== 'unbind' || !!a.webhook?.bound));
  return (
    <Card className="min-w-0 space-y-3 p-4" data-testid="automation-detail" data-id={a.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-[12px] text-ink-3 hover:text-ink lg:hidden" onClick={() => navigate('/extend/automations')} data-testid="automation-back">
          ← All automations
        </button>
        <h2 className="w-full text-[14px] font-semibold text-ink">{a.name}</h2>
        <Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'On' : 'Paused'}</Badge>
        <span className="text-[12px] text-ink-3">
          owner @{a.owner} · {a.id}
        </span>
      </div>
      {a.pausedBy && a.pausedBy.role === 'system' && <p className="rounded-lg bg-orange-tint p-2 text-[12.5px] text-ink">Paused by the engine: {a.pausedBy.why}. An owner resumes it.</p>}
      <ul className="space-y-1 text-[12.5px] text-ink" data-testid="automation-summary">
        {a.summary.map((l) => (
          <li key={l} className="break-words">
            {l}
          </li>
        ))}
        {a.next && (
          <li className="text-ink-2">
            Next: {new Date(a.next).toLocaleString()} ({timezone})
          </li>
        )}
      </ul>
      {a.webhook && (
        <div className="space-y-1 rounded-lg bg-inset p-3 text-[12.5px] text-ink shadow-hairline" data-testid="automation-webhook">
          <div>
            Address: <code className="break-all font-mono text-[12px]">https://&lt;this machine's tailnet name&gt;:8444{a.webhook.path}</code> (tailnet only)
          </div>
          <div className="text-ink-2">{a.webhook.bound ? `Bound to ${a.webhook.bound.name} since ${ago(a.webhook.bound.at)}: deliveries from any other device are refused.` : 'Not bound yet: the first valid delivery binds it to its device.'}</div>
          {!a.webhook.hasSecret && <div className="text-red">It has no secret, so every delivery is refused: Rotate secret makes one.</div>}
        </div>
      )}
      {a.waiting.length > 0 && (
        <p className="rounded-lg bg-blue-tint p-2 text-[12.5px] text-ink" data-testid="automation-waiting">
          {a.waiting.length} run{a.waiting.length === 1 ? '' : 's'} waiting for {a.owner ? `@${a.owner}` : 'its owner'}'s approval in the{' '}
          <a href="/inbox" onClick={(e) => (e.preventDefault(), navigate('/inbox'))} className="underline">
            Inbox
          </a>
          .
        </p>
      )}
      <div>
        <div className="text-[12px] font-medium text-ink-3">Last runs</div>
        {a.runs.length ? (
          <ul className="mt-1 divide-y divide-line text-[12px]" data-testid="automation-runs">
            {a.runs.map((r) => (
              <li key={r.run} className="flex flex-wrap gap-x-2 py-1">
                <span className={cx(r.outcome.startsWith('failed') ? 'text-red' : 'text-ink')}>{r.outcome}</span>
                {r.outputs.map((o) => (
                  <span key={`${o.kind}${o.number}`} className="text-ink-2">
                    #{o.number}
                  </span>
                ))}
                <span className="ml-auto text-ink-3">
                  {r.trigger.kind}
                  {r.trigger.by ? ` by @${r.trigger.by}` : ''} · {ago(r.at)}
                  {r.costUsd !== null ? ` · ${usd(r.costUsd)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[12px] text-ink-3">None yet.</p>
        )}
      </div>
      {a.refused.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-ink-3">Not started lately</div>
          <ul className="mt-1 space-y-0.5 text-[12px] text-ink-2" data-testid="automation-refused">
            {a.refused.map((r) => (
              <li key={r.at + r.why} className="break-words">
                {ago(r.at)} ({r.trigger}): {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ActionBar a={a} actions={shown} digest={digest} onEdit={() => setEditing(true)} />
    </Card>
  );
}

/** The detail's buttons; each opens its Review (what changes), then Confirm. */
function ActionBar({ a, actions, digest, onEdit }: { a: AutomationItem; actions: AutomationAction[]; digest: string; onEdit: () => void }) {
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<{ secret: string; path: string } | null>(null);
  if (!actions.length) return null;
  const review = async (action: AutomationAction) => {
    if (action === 'edit') return onEdit();
    setBusy(true);
    setMsg(null);
    try {
      setPlan(await changeAutomation({ action, id: a.id }));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await changeAutomation({ action: plan.action, id: a.id, ...(plan.digest ? { digest: plan.digest } : { digest }), confirm: true });
      setMsg({ ok: true, text: r.action === 'run' ? 'Asked: it starts on the next pass, if its caps allow.' : `Done: ${ACTION_LABEL[r.action].toLowerCase()}.` });
      if (r.secret && r.path) setSecret({ secret: r.secret, path: r.path });
      setPlan(null);
      if (r.action === 'delete') navigate('/extend/automations');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" data-testid="automation-actions">
        {actions.map((x) => (
          <Button key={x} size="sm" variant={x === 'delete' ? 'danger' : 'outline'} starts={x === 'run'} disabled={busy} onClick={() => void review(x)} data-testid={`automation-${x}`}>
            {ACTION_LABEL[x]}
          </Button>
        ))}
      </div>
      {plan && <Review plan={plan} busy={busy} onConfirm={() => void confirm()} onCancel={() => setPlan(null)} />}
      {secret && <SecretOnce secret={secret.secret} path={secret.path} onDone={() => setSecret(null)} />}
      {msg && <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="automation-result">{msg.text}</p>}
    </div>
  );
}

/** A webhook's secret, shown once (it is never shown again: Rotate secret makes a new one), with how to sign a delivery. */
function SecretOnce({ secret, path, onDone }: { secret: string; path: string; onDone: () => void }) {
  const example = [
    `SECRET='${secret}'`,
    "ts=$(date +%s); id=$(uuidgen); body='{\"text\":\"hello\"}'",
    `sig=$(printf '%s.%s.%s' "$ts" "$id" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')`,
    `curl -sS -X POST "https://<this machine's tailnet name>:8444${path}" -H "x-hook-timestamp: $ts" -H "x-hook-delivery: $id" -H "x-hook-signature: v1=$sig" --data "$body"`,
  ].join('\n');
  return (
    <div className="space-y-2 rounded-lg bg-orange-tint p-3" data-testid="automation-secret">
      <div className="text-[12.5px] font-medium text-ink">Its secret, shown this once: copy it now. It is never shown again (Rotate secret makes a new one).</div>
      <pre className="overflow-x-auto whitespace-pre rounded-md bg-surface p-2 font-mono text-[11.5px] text-ink shadow-hairline" data-testid="automation-secret-example">{example}</pre>
      <Button size="sm" variant="outline" onClick={onDone} data-testid="automation-secret-done">
        I've copied it
      </Button>
    </div>
  );
}

function Review({ plan, busy, onConfirm, onCancel }: { plan: AutomationPlan; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="automation-review">
      <div className="text-[12.5px] font-medium text-ink">
        Review: {ACTION_LABEL[plan.action].toLowerCase()} {plan.id}
      </div>
      {plan.changes.length > 0 && (
        <ul className="space-y-0.5 font-mono text-[11.5px]" data-testid="automation-review-changes">
          {plan.changes.map((c) => (
            <li key={c} className={cx('break-all', c.startsWith('-') ? 'text-red' : 'text-green')}>
              {c}
            </li>
          ))}
        </ul>
      )}
      <ul className="space-y-0.5 text-[12.5px] text-ink" data-testid="automation-review-summary">
        {plan.summary.map((l) => (
          <li key={l} className="break-words">
            {l}
          </li>
        ))}
        <li className="text-ink-2">Logged in the audit as you.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" starts={plan.action === 'run'} disabled={busy} onClick={onConfirm} data-testid="automation-confirm">
          {busy ? 'Working…' : 'Confirm'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} data-testid="automation-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** New or Edit: one form (When, What, Limits), then Review -> Confirm. An id never changes once made. */
function AutomationForm({ initial, digest, onDone }: { initial?: AutomationItem; digest: string; onDone: (id?: string) => void }) {
  const [d, setD] = useState<AutomationDef>(() => (initial ? { id: initial.id, name: initial.name, trigger: initial.trigger, mode: initial.mode, template: initial.template, budget: initial.budget, limits: initial.limits, ...(initial.gates ? { gates: initial.gates } : {}), ...(initial.chain ? { chain: initial.chain } : {}) } : BLANK));
  const [plan, setPlan] = useState<AutomationPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ secret: string; path: string } | null>(null);
  const set = (p: Partial<AutomationDef>) => (setD({ ...d, ...p }), setPlan(null), setMsg(null));
  const action = initial ? 'edit' : 'create';
  const send = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const body = { action, ...(initial ? { id: initial.id } : {}), automation: d } as const;
      if (!confirm) setPlan(await changeAutomation(body));
      else {
        const r = await changeAutomation({ ...body, digest: plan?.digest ?? digest, confirm: true });
        if (r.secret && r.path) setSecret({ secret: r.secret, path: r.path });
        else onDone(d.id);
      }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (secret) return <SecretOnce secret={secret.secret} path={secret.path} onDone={() => onDone(d.id)} />;
  const t = d.trigger;
  const commands = d.template.done_when.map((c) => ('command' in c ? c.command : c.test)).join('\n');
  return (
    <Card className="space-y-4 p-4" data-testid="automation-form">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold text-ink">{initial ? `Edit ${initial.name}` : 'New automation'}</h2>
        {!initial && (
          <select className={cx(fieldAuto, 'ml-auto')} value="" onChange={(e) => e.target.value && (setD(PRESETS[Number(e.target.value)]!.def), setPlan(null))} aria-label="Start from" data-testid="automation-preset">
            <option value="">Start from…</option>
            {PRESETS.map((p, i) => (
              <option key={p.name} value={i}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>
          Name
          <input className={field} value={d.name} onChange={(e) => set({ name: e.target.value, ...(initial ? {} : { id: slug(e.target.value) }) })} data-testid="automation-name" />
        </label>
        <label className={label}>
          Id (never changes)
          <input className={cx(field, 'font-mono')} value={d.id} disabled={!!initial} onChange={(e) => set({ id: e.target.value })} data-testid="automation-id" />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium text-ink">When</legend>
        <select className={fieldAuto} value={t.kind} onChange={(e) => set({ trigger: e.target.value === 'schedule' ? { kind: 'schedule', cron: '0 9 * * 1' } : e.target.value === 'github' ? { kind: 'github', on: 'issue.labeled', label: '' } : e.target.value === 'webhook' ? { kind: 'webhook' } : { kind: 'discord', command: '' }, ...(e.target.value === 'webhook' ? { gates: { start: 'approve' as const } } : {}) })} aria-label="Trigger" data-testid="automation-trigger">
          <option value="schedule">On a schedule (this machine's time)</option>
          <option value="github">On a GitHub event (by a writer or owner)</option>
          <option value="discord">On "run &lt;command&gt;" to the Discord bot</option>
          <option value="webhook">On a signed webhook from your tailnet (each run waits for your approval)</option>
        </select>
        {t.kind === 'schedule' && (
          <label className={label}>
            Cron: minute hour day month weekday (the minute is one number: at most once an hour)
            <input className={cx(field, 'font-mono')} value={t.cron} onChange={(e) => set({ trigger: { kind: 'schedule', cron: e.target.value } })} data-testid="automation-cron" />
          </label>
        )}
        {t.kind === 'github' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <select className={field} value={t.on} onChange={(e) => set({ trigger: { kind: 'github', on: e.target.value } })} aria-label="GitHub event" data-testid="automation-github-on">
              <option value="issue.opened">an issue is opened</option>
              <option value="issue.labeled">an issue gets a label</option>
              <option value="issue_comment.created">a comment starts with /command</option>
              <option value="pull_request.opened">a pull request is opened</option>
              <option value="pull_request.merged">a pull request is merged</option>
            </select>
            {t.on === 'issue.labeled' && <input className={field} placeholder="label" value={t.label ?? ''} onChange={(e) => set({ trigger: { ...t, label: e.target.value } })} aria-label="Label" data-testid="automation-github-label" />}
            {t.on === 'issue_comment.created' && <input className={cx(field, 'font-mono')} placeholder="command" value={t.command ?? ''} onChange={(e) => set({ trigger: { ...t, command: e.target.value } })} aria-label="Command" data-testid="automation-github-command" />}
          </div>
        )}
        {t.kind === 'webhook' && <p className="text-[12px] text-ink-3">After Confirm you get its secret once, and how to sign a delivery. Only devices on your tailnet reach it, and it binds to the first device that sends a valid delivery.</p>}
        <label className="flex items-center gap-2 text-[12.5px] text-ink">
          <input type="checkbox" checked={t.kind === 'webhook' || d.gates?.start === 'approve'} disabled={t.kind === 'webhook'} onChange={(e) => set({ gates: { start: e.target.checked ? 'approve' : 'auto' } })} data-testid="automation-approve" />
          Ask me before each run (always, for a webhook)
        </label>
        {t.kind === 'discord' && (
          <label className={label}>
            Command word
            <input className={cx(field, 'font-mono')} value={t.command} onChange={(e) => set({ trigger: { kind: 'discord', command: e.target.value } })} data-testid="automation-discord-command" />
          </label>
        )}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-[12px] font-medium text-ink">What</legend>
        <select className={fieldAuto} value={d.mode} onChange={(e) => set({ mode: e.target.value as 'task' | 'report' })} aria-label="Mode" data-testid="automation-mode">
          <option value="task">File a task (built, reviewed and merged like any other)</option>
          <option value="report">A read-only report (posted as a comment; nothing built)</option>
        </select>
        <label className={label}>
          Title ({'{date}'}, {'{week}'}, {'{trigger.ref}'} allowed)
          <input className={field} value={d.template.title} onChange={(e) => set({ template: { ...d.template, title: e.target.value } })} data-testid="automation-title" />
        </label>
        <label className={label}>
          Outcome (one sentence)
          <input className={field} value={d.template.outcome} onChange={(e) => set({ template: { ...d.template, outcome: e.target.value } })} data-testid="automation-outcome" />
        </label>
        {d.mode === 'task' && (
          <label className={label}>
            Done when: one command per line, each must exit 0
            <textarea className={cx(field, 'h-16 py-1.5 font-mono')} value={commands} onChange={(e) => set({ template: { ...d.template, done_when: e.target.value.split('\n').map((c) => ({ command: c })).filter((c) => c.command.trim()) } })} data-testid="automation-done-when" />
          </label>
        )}
      </fieldset>
      <fieldset className="grid gap-3 sm:grid-cols-4">
        <legend className="mb-2 text-[12px] font-medium text-ink">Limits</legend>
        {(
          [
            ['$ a run', d.budget.per_run_usd, (v: number) => set({ budget: { ...d.budget, per_run_usd: v } }), 'automation-per-run'],
            ['$ a day', d.budget.per_day_usd, (v: number) => set({ budget: { ...d.budget, per_day_usd: v } }), 'automation-per-day'],
            ['runs a day', d.limits?.runs_per_day ?? 1, (v: number) => set({ limits: { runs_per_day: v, cooldown_minutes: d.limits?.cooldown_minutes ?? 60 } }), 'automation-runs-per-day'],
            ['min between', d.limits?.cooldown_minutes ?? 60, (v: number) => set({ limits: { runs_per_day: d.limits?.runs_per_day ?? 1, cooldown_minutes: v } }), 'automation-cooldown'],
          ] as const
        ).map(([l, v, on, tid]) => (
          <label key={tid} className={label}>
            {l}
            <input type="number" min={0} className={cx(field, 'font-mono')} value={String(v)} onChange={(e) => on(Number(e.target.value))} data-testid={tid} />
          </label>
        ))}
      </fieldset>
      {msg && <p className="break-words text-[12.5px] text-red" data-testid="automation-form-error">{msg}</p>}
      {plan ? (
        <Review plan={plan} busy={busy} onConfirm={() => void send(true)} onCancel={() => setPlan(null)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void send(false)} data-testid="automation-form-review">
            Review
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone()} data-testid="automation-form-cancel">
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}
