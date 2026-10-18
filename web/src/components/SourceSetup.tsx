// The first-run page's Slack and Linear steps (src/intake/source-setup.ts), beside the Discord step in the "Intake
// sources" group, and built the same way: the secret(s) through the setup console's paste box, what the secret can
// see loaded from a child process on the instance (this page never sees a secret), the picks reviewed as the exact
// intake.yaml diff, and written only on an owner's Confirm. Closing the step without confirming changes nothing.
// Nothing set up yet: the empty state says what the source does and offers ONE first action; the later steps follow
// once it is taken (or once anything is stored). A writer reads where it stands and gets no button: there is
// nothing they may do here. Who may send stays in intake.yaml by hand, as for Discord.
import { useCallback, useEffect, useState } from 'react';
import { changeSourceIntake, getSourceSetup, getSourceView, isRefusal, openSourceTokenAsk, type SourceFormValue, type SourceIntakePlan, type SourceKind, type SourceSetup, type SourceView } from '../api';
import { AskCard } from '../pages/Setup';
import { afterLoad, NOTHING_YET, StaleNote, useRetry, type Loaded } from '../refresh';
import { ago, Badge, Button, cx } from './ui';

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';
const field = 'h-8 min-w-0 max-w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]';
const linkButton = 'inline-flex h-7 items-center rounded-full px-3 text-[12.5px] font-medium';

type Ready = Extract<SourceSetup, { available: true }>;
type Values = Record<string, SourceFormValue>;

const NAME: Record<SourceKind, string> = { slack: 'Slack', linear: 'Linear' };
const LABEL: Record<string, string> = {
  'slack.enabled': 'Connect the app',
  'slack.team': 'Workspace',
  'slack.channels': 'Channels',
  'linear.enabled': 'Read the issues',
  'linear.team': 'Team',
  'linear.label': 'Label',
};

/** What each source does, in a sentence, and how it connects: the empty state's words (the writer's too). */
const WHAT: Record<SourceKind, { does: string; connects: string; first: string; firstWhy: string }> = {
  slack: {
    does: 'When it is connected, a message that mentions the bot in a channel you pick, from someone you list, becomes a report here: redacted, triaged, and filed or sent to the Inbox, exactly like a Discord one. The bot replies in that message’s thread.',
    connects: 'The bot connects out from this machine (Slack’s Socket Mode), so nothing needs a public address. Until you list who may send, it takes nothing.',
    first: 'Create the Slack app from the manifest',
    firstWhy: 'The manifest asks for exactly what intake uses: Socket Mode, the app_mention event and four bot scopes. Nothing else: no message history, no direct messages, no files.',
  },
  linear: {
    does: 'When it is connected, an open issue with the label you pick, in the team you pick, opened by someone you list, becomes a report here: redacted, triaged, and filed on GitHub or sent to the Inbox. The bot comments once on the issue to say what happened.',
    connects: 'It is read every few minutes over Linear’s API, so nothing needs a public address. Until you list who may send, it takes nothing.',
    first: 'Create a Linear API key',
    firstWhy: 'Give the key only Read and Create comments, for the one team.',
  },
};

function Step({ n, title, children, testid }: { n: number; title: string; children: React.ReactNode; testid: string }) {
  return (
    <li className="space-y-2" data-testid={testid}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] text-ink-2 shadow-hairline" aria-hidden>
          {n}
        </span>
        {title}
      </div>
      <div className="space-y-2 sm:pl-7">{children}</div>
    </li>
  );
}

/** The empty state: what the source does, and the one first action (an owner's); a writer gets the words only. */
function EmptyState({ v, onStart }: { v: Ready; onStart: () => void }) {
  const w = WHAT[v.kind];
  return (
    <div className="space-y-2 rounded-lg bg-inset p-3 shadow-hairline" data-testid="source-empty" data-source={v.kind}>
      <div className="text-[13px] font-medium text-ink">{NAME[v.kind]} isn’t connected</div>
      <p className="text-[12.5px] text-ink-2">{w.does}</p>
      <p className="text-[12.5px] text-ink-2">{w.connects}</p>
      {v.canAct ? (
        <>
          <p className="text-[12.5px] text-ink-2">{w.firstWhy}</p>
          <a href={v.portal} target="_blank" rel="noreferrer" onClick={onStart} className={cx(linkButton, 'bg-ink text-surface hover:opacity-90')} data-testid="source-first-action">
            {w.first}
          </a>
          <p className="text-[12px] text-ink-3">
            Then, on this page: paste the {v.kind === 'slack' ? 'two tokens' : 'key'}, load what {v.kind === 'slack' ? 'the app' : 'the key'} can see, pick {v.kind === 'slack' ? 'the channels' : 'the team and label'}, review the exact change to <code>intake.yaml</code> and confirm it, then restart the instance. Who may send stays in <code>intake.yaml</code> by hand.
          </p>
        </>
      ) : (
        <p className="text-[12.5px] text-ink-3" data-testid="source-writer-note">
          An owner of this instance sets it up here.
        </p>
      )}
    </div>
  );
}

function Field({ f, value, view, values, disabled, onChange }: { f: Ready['form'][number]; value: SourceFormValue; view: SourceView; values: Values; disabled: boolean; onChange: (v: SourceFormValue) => void }) {
  const label = LABEL[f.key] ?? f.key;
  let control: React.ReactNode;
  if (f.kind === 'boolean') {
    control = <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="h-4 w-4" data-testid="source-field-input" />;
  } else if (f.kind === 'ids' && view.kind === 'slack') {
    const picked = Array.isArray(value) ? value : [];
    const unseen = picked.filter((id) => !view.channels.some((c) => c.id === id));
    control = (
      <div className="flex flex-wrap gap-x-3 gap-y-1.5" role="group" aria-label={label} data-testid="source-field-input">
        {!view.channels.length && !unseen.length && <span className="text-[12px] text-ink-3">the app sees no public channel</span>}
        {[...view.channels.map((c) => ({ id: c.id, text: `#${c.name}${c.member ? '' : ' (invite the bot)'}` })), ...unseen.map((id) => ({ id, text: `${id} (not in the app's view)` }))].map((c) => (
          <label key={c.id} className="inline-flex min-h-6 items-center gap-1.5 text-[12.5px] text-ink">
            <input type="checkbox" checked={picked.includes(c.id)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} className="h-4 w-4" />
            {c.text}
          </label>
        ))}
      </div>
    );
  } else {
    const current = typeof value === 'string' ? value : '';
    let options: { id: string; text: string }[] = [];
    if (view.kind === 'slack') options = [{ id: view.team.id, text: view.team.name || view.team.id }];
    else if (f.kind === 'team') options = view.teams.map((t) => ({ id: t.id, text: `${t.key} · ${t.name}` }));
    else {
      const team = view.teams.find((t) => t.id === values['linear.team']);
      options = [...(team?.labels ?? []).map((l) => ({ id: l.id, text: l.name })), ...view.labels.map((l) => ({ id: l.id, text: `${l.name} (workspace)` }))];
    }
    control = (
      <select value={current} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label={label} className={cx(field, 'w-72')} data-testid="source-field-input">
        <option value="">none</option>
        {current && !options.some((o) => o.id === current) && <option value={current}>{current} (not in the view)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.text}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-3" data-testid="source-field" data-key={f.key}>
      <div className="text-[12.5px] font-medium text-ink">
        {label}
        <div className="font-mono text-[11px] font-normal text-ink-3">{f.key}</div>
      </div>
      <div className="min-w-0 space-y-1">
        {control}
        <p className="text-[12px] text-ink-3">{f.what}</p>
      </div>
    </div>
  );
}

export interface SourceSetupViewProps {
  v: SourceSetup;
  view?: SourceView | null;
  viewError?: string | null;
  loadingView?: boolean;
  onLoadView?: (fresh: boolean) => void;
  onChanged?: () => void;
  /** For the render checks: the state a click would have reached. */
  initialStarted?: boolean;
  initialConfirming?: string | null;
  initialPlan?: SourceIntakePlan | null;
  initialValues?: Values;
}

/** The step from its data (also what the render checks render). */
export function SourceSetupView({ v, view = null, viewError = null, loadingView = false, onLoadView, onChanged, initialStarted = false, initialConfirming = null, initialPlan = null, initialValues }: SourceSetupViewProps) {
  const [started, setStarted] = useState(initialStarted);
  const [confirming, setConfirming] = useState<string | null>(initialConfirming);
  const [values, setValues] = useState<Values>(initialValues ?? (v.available ? v.intake.values : {}));
  const [plan, setPlan] = useState<SourceIntakePlan | null>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!v.available)
    return (
      <p className="text-[12.5px] text-ink-2" data-testid="source-setup-unavailable">
        {v.why}.
      </p>
    );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const set = (key: string, value: SourceFormValue) => {
    // A reviewed change is for the picks as they were: any new pick needs a new review.
    setPlan(null);
    setMsg(null);
    setValues((old) => ({ ...old, [key]: value }));
  };
  const name = NAME[v.kind];
  const anyStored = v.creds.some((c) => c.configured) || v.intake.values[`${v.kind}.enabled`] === true || v.creds.some((c) => c.ask);
  const allStored = v.creds.every((c) => c.configured && c.present);
  // WHY: nothing set up yet shows only the empty state and its one first action; the steps follow once it is taken.
  if (!anyStored && !started)
    return (
      <div className="space-y-2" data-testid="source-setup" data-source={v.kind} data-instance={v.instance}>
        <EmptyState v={v} onStart={() => setStarted(true)} />
      </div>
    );
  return (
    <div className="space-y-4" data-testid="source-setup" data-source={v.kind} data-instance={v.instance}>
      <p className="text-[12.5px] text-ink-2">
        Optional. Nothing here changes until you confirm it: closing this step leaves the {v.kind === 'slack' ? 'tokens' : 'key'} and <code>intake.yaml</code> as they are, and {name} stays off until <code>intake.yaml</code> turns it on.
      </p>
      {!v.canAct && (
        <p className="text-[12.5px] text-ink-3" data-testid="source-setup-refused">
          Only the instance's owners can set up its {name} intake. You can read where it stands.
        </p>
      )}
      <ol className="space-y-4">
        <Step n={1} title={v.kind === 'slack' ? 'Create the Slack app, from the manifest' : 'Create the Linear API key'} testid="source-step-create">
          {v.slack && (
            <>
              <p className="text-[12.5px] text-ink-2">On Slack's apps page: Create New App, From a manifest, pick the workspace, paste this. Then Install to Workspace, and under Basic Information make an App-Level Token with the scope connections:write.</p>
              <ul className="space-y-0.5 text-[12.5px] text-ink-2" data-testid="source-scopes">
                {v.slack.scopes.map((s) => (
                  <li key={s.scope}>
                    <code className="text-ink">{s.scope}</code>: {s.why}
                  </li>
                ))}
              </ul>
              <code className={cx(code, 'max-h-56')} data-testid="source-manifest">
                {v.slack.manifest}
              </code>
            </>
          )}
          {v.linear && (
            <>
              <p className="text-[12.5px] text-ink-2">In Linear: Settings, Account, Security & access, Personal API keys, New key. Use an account made for this if you can: its comments appear under its name.</p>
              <ul className="space-y-0.5 text-[12.5px] text-ink-2" data-testid="source-permissions">
                {v.linear.permissions.map((p) => (
                  <li key={p.name}>
                    <span className="font-medium text-ink">{p.name}</span>: {p.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          {v.canAct && (
            <a href={v.portal} target="_blank" rel="noreferrer" className={cx(linkButton, 'bg-surface text-ink shadow-btn hover:bg-hover')} data-testid="source-portal-link">
              {v.kind === 'slack' ? "Open Slack's apps page" : "Open Linear's API settings"}
            </a>
          )}
        </Step>
        <Step n={2} title={v.kind === 'slack' ? 'Store the two tokens' : 'Store the key'} testid="source-step-token">
          {v.creds.map((c) => {
            const stored = c.configured && c.present;
            return (
              <div key={c.credential} className="space-y-1.5" data-testid="source-cred" data-credential={c.credential} data-stored={stored}>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  <span className="font-medium text-ink">{c.title.replace(/^Paste the /, '')}</span>
                  <Badge tone={stored ? 'ok' : 'neutral'}>{stored ? 'stored' : 'not stored'}</Badge>
                  {c.error ? <span className="text-red">{c.error}</span> : c.file ? <code className="break-all">{c.file}</code> : null}
                </div>
                {c.ask ? (
                  <AskCard a={c.ask} {...(onChanged ? { onChanged } : {})} />
                ) : !v.canAct ? null : confirming !== c.credential ? (
                  <Button size="sm" variant={stored ? 'outline' : 'default'} onClick={() => setConfirming(c.credential)} data-testid="source-token-button">
                    {stored ? 'Replace it…' : `${c.title}…`}
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="source-token-confirming">
                    <span className="text-[12.5px] text-ink">Open a paste box for it? It records an ask in this instance's log (never the secret).</span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await openSourceTokenAsk(v.kind, c.credential);
                          setConfirming(null);
                          onChanged?.();
                        })
                      }
                      data-testid="source-token-confirm"
                    >
                      {busy ? 'Opening…' : 'Confirm'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)} data-testid="source-token-cancel">
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[12px] text-ink-3">Each is pasted once, goes straight to a file only this instance's coordinator user can read (0400) and is never shown again: not on this page, in a log, an event or an agent's environment.</p>
        </Step>
        <Step n={3} title={v.kind === 'slack' ? 'Pick the channels, from what the app sees' : 'Pick the team and label, from what the key sees'} testid="source-step-pick">
          <div className="flex flex-wrap items-center gap-2">
            {v.canAct && allStored && (
              <Button size="sm" variant={view ? 'outline' : 'default'} disabled={loadingView} onClick={() => onLoadView?.(!!view)} data-testid="source-load">
                {loadingView ? `Asking ${name}…` : view ? 'Load it again' : `Load what ${v.kind === 'slack' ? 'the app' : 'the key'} sees`}
              </Button>
            )}
            {view && (
              <span className="text-[12px] text-ink-3" data-testid="source-loaded">
                read {ago(view.at)}
              </span>
            )}
          </div>
          {!allStored && <p className="text-[12px] text-ink-3">After step 2.</p>}
          {viewError && (
            <p className="break-words text-[12.5px] text-red" data-testid="source-load-error">
              {viewError}
            </p>
          )}
          {v.intake.error && (
            <p className="break-words text-[12.5px] text-red" data-testid="source-intake-error">
              {v.intake.error}
            </p>
          )}
          {view && !v.intake.error && (
            <div className="space-y-3 rounded-lg bg-surface p-3 shadow-hairline" data-testid="source-form">
              {v.form.map((f) => (
                <Field key={f.key} f={f} value={values[f.key] ?? null} view={view} values={values} disabled={!v.canAct || busy} onChange={(x) => set(f.key, x)} />
              ))}
              <p className="text-[12px] text-ink-3" data-testid="source-senders-note">
                Who may send (<code>{v.kind}.allowed_senders</code>, {v.intake.allowed} now) and who is trusted (<code>trusted.{v.kind}</code>, {v.intake.trusted} now) stay in <code>{v.intake.file}</code> by hand: this step writes only the keys above and keeps every other key and comment.
              </p>
              <details className="text-[12px] text-ink-2" data-testid="source-people">
                <summary className="cursor-pointer text-ink-3">People and their ids, to copy into {v.kind}.allowed_senders</summary>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11.5px]">
                  {(view.kind === 'slack' ? view.members : [...new Map(view.teams.flatMap((t) => t.members).map((m) => [m.id, m])).values()]).map((m) => (
                    <li key={m.id}>
                      {m.id} <span className="font-sans text-ink-3">{m.name}</span>
                    </li>
                  ))}
                </ul>
              </details>
              {v.canAct && !plan && (
                <Button size="sm" disabled={busy} onClick={() => void run(async () => setPlan(await changeSourceIntake(v.kind, values)))} data-testid="source-review">
                  {busy ? 'Checking…' : 'Review the change'}
                </Button>
              )}
              {plan && !plan.confirmed && (
                <div className="space-y-2" data-testid="source-plan">
                  <p className="text-[12.5px] text-ink">{plan.creates ? `This creates ${plan.file} (0600):` : `This changes ${plan.file}:`}</p>
                  <pre className={cx(code, 'max-h-96')} data-testid="source-diff">
                    {plan.diff}
                  </pre>
                  {plan.warnings.map((w) => (
                    <p key={w} className="text-[12.5px] text-orange" data-testid="source-warning">
                      {w}
                    </p>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="source-confirming">
                    <span className="text-[12.5px] text-ink">Write exactly this change?</span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const done = await changeSourceIntake(v.kind, values, plan.hash);
                          setPlan(null);
                          setMsg({ ok: true, text: `Wrote ${done.file}. ${name} picks it up when the instance restarts.` });
                          onChanged?.();
                        })
                      }
                      data-testid="source-confirm"
                    >
                      {busy ? 'Writing…' : 'Confirm and write'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)} data-testid="source-cancel">
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {v.intake.warnings.map((w) => (
            <p key={w} className="text-[12.5px] text-orange" data-testid="source-warning">
              {w}
            </p>
          ))}
        </Step>
        <Step n={4} title="Restart the instance" testid="source-step-restart">
          <code className={code}>{v.automation.restart}</code>
        </Step>
      </ol>
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="source-result">
          {msg.text}
        </p>
      )}
      <div className="space-y-1.5" data-testid="source-automation">
        <div className="text-[12.5px] font-medium text-ink">The same without this page</div>
        <p className="text-[12px] text-ink-3">The {v.kind === 'slack' ? 'tokens' : 'key'}, as root (a hidden prompt, or stdin); what it sees, as the instance's user; then these keys in {v.automation.file} (0600); then restart.</p>
        <code className={code}>{[v.automation.token, v.automation.view, `# intake.yaml: ${v.automation.keys.join(', ')}, ${v.kind}.allowed_senders`, v.automation.restart].join('\n')}</code>
      </div>
    </div>
  );
}

/** The step, live: its state from the instance, and the source's view when an owner asks for it. */
export function SourceSetupPanel({ kind, onChanged }: { kind: SourceKind; onChanged?: () => void }) {
  const [loaded, setLoaded] = useState<Loaded<SourceSetup>>(NOTHING_YET);
  const [refused, setRefused] = useState<string | null>(null);
  const [view, setView] = useState<SourceView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const load = useCallback(() => {
    getSourceSetup(kind).then(
      (d) => (setRefused(null), setLoaded({ data: d, stale: null })),
      (error: unknown) => (setRefused(isRefusal(error) ? (error as Error).message : null), setLoaded((p) => afterLoad(p, { error }))),
    );
  }, [kind]);
  useEffect(load, [load]);
  useRetry(loaded, load);
  const v = loaded.data;
  const loadView = (fresh: boolean) => {
    setLoadingView(true);
    setViewError(null);
    getSourceView(kind, fresh)
      .then(setView)
      .catch((e: Error) => setViewError(e.message))
      .finally(() => setLoadingView(false));
  };
  if (refused !== null) return <p className="text-[12.5px] text-red">Can't load the {NAME[kind]} step: {refused}</p>;
  if (!v) return loaded.stale === null ? <p className="text-[12.5px] text-ink-3">Loading…</p> : <p className="text-[12.5px] text-red">Can't load the {NAME[kind]} step: {loaded.stale}, retrying</p>;
  return (
    <div className="space-y-1">
      <StaleNote stale={loaded.stale} />
      <SourceSetupView
        v={v}
        view={view}
        viewError={viewError}
        loadingView={loadingView}
        onLoadView={loadView}
        onChanged={() => {
          load();
          onChanged?.();
        }}
      />
    </div>
  );
}
