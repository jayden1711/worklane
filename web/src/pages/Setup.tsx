import { useEffect, useRef, useState } from 'react';
import { addProject, addProjectInvalid, answerAsk, apiPath, getAddProject, getAsks, hubInstance, openSetupLink, pasteSecret, pendingSetupLink, runRootStep, liveStream, terminalProtocols, type AddProjectData, type AddProjectRun, type AddProjectStep, type Ask, type AsksView } from '../api';
import { ago, Badge, Button, Card, cx, Empty } from '../components/ui';
import { navigate } from '../App';
import { Header } from './Overview';

const KIND_LABEL: Record<Ask['kind'], string> = { paste_secret: 'Paste a secret', approve_link: 'Open and approve', question: 'Question', root_step: 'Machine step' };

function Status({ a }: { a: Ask }) {
  if (a.status === 'open') return <Badge tone="warn">waiting</Badge>;
  if (a.status === 'cancelled') return <Badge>withdrawn</Badge>;
  return <Badge tone={/declined|failed/.test(a.answer?.answer ?? '') ? 'danger' : 'ok'}>{a.answer?.answer}</Badge>;
}

/**
 * The secret's input is uncontrolled: its value lives only in the field, goes straight to the server, and the
 * field is cleared after sending. It is never put in state, shown, or logged.
 */
function SecretForm({ a, onDone }: { a: Ask & { kind: 'paste_secret' }; onDone: (err: string | null) => void }) {
  const field = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const el = field.current;
    if (!el || !el.value) return;
    setBusy(true);
    try {
      await pasteSecret(a.id, el.value);
      onDone(null);
    } catch (e) {
      onDone((e as Error).message);
    } finally {
      el.value = '';
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input ref={field} type="password" autoComplete="off" spellCheck={false} name={`secret-${a.credential}`} aria-label={`Value of ${a.credential}`} placeholder={`${a.credential} (not shown)`} className="min-w-64 flex-1 rounded-control border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px]" data-testid="ask-secret" />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? 'Storing…' : 'Store'}
      </Button>
    </form>
  );
}

/** One ask: what it needs, its status, and, when this person may answer it, how. */
export function AskCard({ a, onChanged }: { a: Ask; onChanged?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const can = a.status === 'open' && a.canAnswer;
  return (
    <Card className="p-4" data-testid="ask-card" data-ask={a.id} data-status={a.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
        <Badge tone="info">{KIND_LABEL[a.kind]}</Badge>
        <Status a={a} />
        <span>{a.instance}</span>
        <span>· asked {ago(a.createdAt)} by {a.createdBy}</span>
      </div>
      <div className="mt-2 text-[14px] font-medium text-ink">{a.title}</div>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">{a.detail}</p>
      {a.kind === 'paste_secret' && (
        <p className="mt-1.5 text-[12px] text-ink-3">
          Credential <code>{a.credential}</code>, for {a.where}. It goes to this instance's credential store (0400, its coordinator user only) and is never shown again.
        </p>
      )}
      {a.kind === 'approve_link' && (
        <p className="mt-1.5 text-[12px]">
          <a href={a.url} target="_blank" rel="noopener noreferrer" className="break-all text-blue-ink hover:underline" data-testid="ask-link">
            {a.url}
          </a>
        </p>
      )}
      {a.kind === 'root_step' && (
        <p className="mt-1.5 text-[12px] text-ink-3">
          Runs <code>{[a.command, ...a.args].join(' ')}</code> through the machine helper, as root: this instance's coordinator runs it on its next tick.
          {!a.allowed && <span className="mt-1 block text-red" data-testid="ask-refusal">Not on the helper's allowlist: {a.refusal}</span>}
          {a.request && a.status === 'open' && <span className="mt-1 block" data-testid="ask-request">Machine request: {a.request.status === 'pending' ? 'waiting for the coordinator' : a.request.status}{a.request.detail ? ` (${a.request.detail})` : ''}</span>}
        </p>
      )}
      {can && a.kind === 'paste_secret' && <SecretForm a={a} onDone={(e) => (e ? setErr(e) : onChanged?.())} />}
      {can && a.kind === 'approve_link' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={!!busy} onClick={() => void act('approved', () => answerAsk(a.id, 'approved'))}>
            I approved it
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('declined', () => answerAsk(a.id, 'declined'))}>
            Decline
          </Button>
        </div>
      )}
      {can && a.kind === 'question' && (
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Answer">
          {a.options.map((o) => (
            <Button key={o} size="sm" variant="outline" data-testid="ask-option" disabled={!!busy} onClick={() => void act(o, () => answerAsk(a.id, o))}>
              {busy === o ? `${o}…` : o}
            </Button>
          ))}
        </div>
      )}
      {can && a.kind === 'root_step' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={!!busy || !a.allowed || a.request?.status === 'pending' || a.request?.status === 'running'} data-testid="ask-run" onClick={() => void act('run', () => runRootStep(a.id))}>
            {busy === 'run' ? 'Running…' : 'Run it'}
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act('declined', () => answerAsk(a.id, 'declined'))}>
            Decline
          </Button>
        </div>
      )}
      {a.status === 'open' && !a.canAnswer && <p className="mt-2 text-[12px] text-ink-3">Waiting on the owner{a.kind === 'question' && a.writersMayAnswer ? ' or a writer' : ''}.</p>}
      {a.answer && (
        <p className="mt-2 text-[12px] text-ink-3" data-testid="ask-answered">
          {a.answer.answer} by @{a.answer.by} ({a.answer.role}) {ago(a.answer.at)}
          {a.answer.detail ? `: ${a.answer.detail}` : ''}
        </p>
      )}
      {err && <p className="mt-2 text-[12px] text-red">{err}</p>}
    </Card>
  );
}

const STEP_LABEL: Record<string, string> = {
  instance: 'Instance users and folders',
  app: 'GitHub App (create, then install)',
  'claude-token': "The agent's Claude token",
  checkout: 'Checkout of the repo',
  policy: 'Default policy',
  service: 'Coordinator service',
  'test-user': 'Test-run user',
  'machine-helper': 'Machine helper',
  dashboards: 'Dashboards',
};
const STEP_TONE: Record<AddProjectStep['state'], 'neutral' | 'ok' | 'warn' | 'danger' | 'info'> = { pending: 'neutral', started: 'info', done: 'ok', failed: 'danger', ask: 'warn', waiting: 'warn' };
const STEP_STATE: Record<AddProjectStep['state'], string> = { pending: 'not yet', started: 'running', done: 'done', failed: 'failed', ask: 'waiting on you', waiting: 'waiting' };
const RUN_STATUS: Record<string, string> = { pending: 'waiting for the coordinator', running: 'running', done: 'done', failed: 'failed', refused: 'refused', interrupted: 'interrupted' };

/** One add-project run: its steps in the script's order, then what it's waiting on you for (in this same view). */
function AddProjectRunCard({ run, onChanged }: { run: AddProjectRun; onChanged?: () => void }) {
  return (
    <div className="space-y-3 rounded-control bg-inset p-3 shadow-hairline" data-testid="add-project-run" data-run={run.id} data-status={run.status}>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
        <span className="font-medium text-ink">
          {run.name} <span className="font-normal text-ink-3">({run.repo})</span>
        </span>
        <Badge tone={run.status === 'done' ? 'ok' : run.status === 'pending' || run.status === 'running' ? 'info' : 'danger'}>{RUN_STATUS[run.status] ?? run.status}</Badge>
        <span className="text-ink-3">
          asked {ago(run.at)} by @{run.by}
        </span>
      </div>
      <ol className="space-y-1" data-testid="add-project-steps">
        {run.steps.map((s, i) => (
          <li key={s.step} className="flex flex-wrap items-baseline gap-2 text-[12.5px]" data-testid="add-project-step" data-step={s.step} data-state={s.state}>
            <span className="w-5 text-right tabular-nums text-ink-3">{i + 1}.</span>
            <span className={cx('min-w-48', s.state === 'pending' ? 'text-ink-3' : 'text-ink')}>{STEP_LABEL[s.step] ?? s.step}</span>
            <Badge tone={STEP_TONE[s.state]}>{STEP_STATE[s.state]}</Badge>
            {s.detail && <span className="text-ink-3">{s.detail}</span>}
            {s.state === 'failed' && s.retry && (
              <span className="text-ink-2" data-testid="add-project-retry">
                To retry: <code>{s.retry}</code>
              </span>
            )}
          </li>
        ))}
      </ol>
      {run.failedStep && (
        <p className="text-[12.5px] text-red" data-testid="add-project-failed">
          Stopped at "{STEP_LABEL[run.failedStep] ?? run.failedStep}". Fix what it says, then add the same project again: the steps already done are skipped.
        </p>
      )}
      {(run.status === 'failed' || run.status === 'refused' || run.status === 'interrupted') && run.detail && !run.failedStep && <p className="text-[12.5px] text-red">{run.detail}</p>}
      {!!run.asks.length && (
        <div className="space-y-2" data-testid="add-project-asks">
          {run.asks.map((a) => (
            <AskCard key={a.id} a={a} {...(onChanged ? { onChanged } : {})} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Add project: a name and an owner/repo, checked here and again on the server, recorded as a machine request that
 * the coordinator runs as root through the machine helper. Enabled only when the server says this person may (a
 * machine owner, on an allowed device); otherwise it says why.
 */
export function AddProjectView({ data, onChanged }: { data: AddProjectData; onChanged?: () => void }) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const bad = addProjectInvalid(name.trim(), repo.trim());
    if (bad) return setErr(bad);
    setBusy(true);
    setErr(null);
    try {
      await addProject(name.trim(), repo.trim());
      setName('');
      setRepo('');
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = 'h-8 rounded-control bg-field px-2.5 font-mono text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
  return (
    <Card className="space-y-3 p-4" data-testid="add-project" data-enabled={data.allowed ? 'yes' : 'no'}>
      <div>
        <div className="text-[14px] font-medium text-ink">Add project</div>
        <p className="text-[12px] text-ink-3">
          A new instance for a GitHub repo on this machine: its users, its GitHub App (two clicks on GitHub), the agent's Claude token, the checkout, a default policy (auto-merge off, $20 a day, 2 workers) and its services. It runs as root through the machine helper, step by step below, and every step is recorded.
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input value={name} onChange={(e) => (setName(e.target.value), setErr(null))} disabled={!data.allowed || busy} aria-label="Project name" placeholder="name (e.g. shop)" spellCheck={false} autoComplete="off" className={cx(field, 'w-40')} data-testid="add-project-name" />
        <input value={repo} onChange={(e) => (setRepo(e.target.value), setErr(null))} disabled={!data.allowed || busy} aria-label="GitHub repo" placeholder="owner/repo" spellCheck={false} autoComplete="off" className={cx(field, 'min-w-56 flex-1')} data-testid="add-project-repo" />
        <Button type="submit" size="sm" disabled={!data.allowed || busy} data-testid="add-project-submit">
          {busy ? 'Adding…' : 'Add project'}
        </Button>
      </form>
      {!data.allowed && data.why && (
        <p className="text-[12.5px] text-ink-2" data-testid="add-project-disabled">
          Not available: {data.why}.
          {/* The machine owners, unless the reason already names them. */}
          {!/machine owners:/.test(data.why) && (
            <>
              {' '}
              <span className="text-ink-3" data-testid="add-project-owners">
                Machine owners: {data.machineOwners.length ? data.machineOwners.map((o) => `@${o}`).join(', ') : 'none set'}.
              </span>
            </>
          )}
        </p>
      )}
      {err && (
        <p className="text-[12.5px] text-red" data-testid="add-project-invalid">
          {err}
        </p>
      )}
      {data.runs.map((r) => (
        <AddProjectRunCard key={r.id} run={r} {...(onChanged ? { onChanged } : {})} />
      ))}
    </Card>
  );
}

export function SetupConsoleView({ data, onChanged, shown, focus }: { data: AsksView; onChanged?: () => void; shown?: ReadonlySet<string>; focus?: string | null }) {
  // An ask an add-project run raised is shown with that run, not twice.
  const asks = shown ? data.asks.filter((a) => !shown.has(a.id)) : data.asks;
  // Opened from a one-time Discord link: that step first.
  const open = asks.filter((a) => a.status === 'open').sort((a, b) => Number(b.id === focus) - Number(a.id === focus));
  const done = asks.filter((a) => a.status !== 'open').reverse();
  return (
    <div className="space-y-6">
      {!asks.length && <Empty title="Nothing to set up" hint="When the harness needs something it can't do itself (a secret, an approval, a machine step), it asks here." />}
      {!!open.length && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Waiting</h2>
          {open.map((a) => (
            <AskCard key={a.id} a={a} {...(onChanged ? { onChanged } : {})} />
          ))}
        </section>
      )}
      {!!done.length && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Done</h2>
          {done.map((a) => (
            <AskCard key={a.id} a={a} />
          ))}
        </section>
      )}
    </div>
  );
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const KEYS: Record<string, string> = { Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~' };

/** The keys a terminal gets for a key press, or null for one it doesn't take. */
export function keyData(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.metaKey) return null;
  if (e.ctrlKey && /^[a-z]$/i.test(e.key)) return String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
  if (KEYS[e.key]) return KEYS[e.key]!;
  return e.key.length === 1 ? e.key : null;
}

/** The owner terminal (hub only): opened on demand, the hub decides whether it may. */
function Terminal({ instance }: { instance: string }) {
  const [out, setOut] = useState('');
  const [state, setState] = useState<'closed' | 'opening' | 'open'>('closed');
  const [note, setNote] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const screen = useRef<HTMLPreElement>(null);
  useEffect(() => () => ws.current?.close(), []);
  useEffect(() => {
    if (screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [out]);
  const open = async () => {
    setOut('');
    setNote(null);
    setState('opening');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // The session's CSRF token goes as a subprotocol: a browser can't set headers on a WebSocket upgrade.
    const s = new WebSocket(`${proto}://${location.host}/api/terminal?instance=${encodeURIComponent(instance)}&cols=120&rows=32`, await terminalProtocols());
    ws.current = s;
    s.onopen = () => setState('open');
    s.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; data?: string; why?: string };
      if (msg.type === 'output') setOut((o) => (o + msg.data!.replace(ANSI, '').replace(/\r\n?/g, '\n')).slice(-200_000));
      else if (msg.type === 'refused' || msg.type === 'closed') setNote(`${msg.type === 'refused' ? 'Refused' : 'Closed'}: ${msg.why}`);
    };
    s.onclose = () => setState('closed');
  };
  return (
    <Card className="p-4" data-testid="owner-terminal">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="text-[14px] font-medium text-ink">Owner terminal</div>
          <p className="text-[12px] text-ink-3">A login shell as this machine's admin user. Needs one of your allowed Tailscale devices; sudo asks for your password; every command is recorded; it closes after 10 minutes idle.</p>
        </div>
        {state === 'closed' ? (
          <Button size="sm" variant="outline" onClick={() => void open()} data-testid="terminal-open">
            Open
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => ws.current?.close()}>
            Close
          </Button>
        )}
      </div>
      {note && <p className="mt-2 text-[12px] text-red">{note}</p>}
      {state !== 'closed' && (
        <pre
          ref={screen}
          tabIndex={0}
          className={cx('mt-3 h-96 overflow-auto rounded-control bg-inset p-2 font-mono text-[12px] leading-snug text-ink outline-none focus:ring-2 focus:ring-blue')}
          onKeyDown={(e) => {
            const d = keyData(e);
            if (d === null) return;
            e.preventDefault();
            ws.current?.send(JSON.stringify({ type: 'input', data: d }));
          }}
          onPaste={(e) => {
            e.preventDefault();
            ws.current?.send(JSON.stringify({ type: 'input', data: `\x1b[200~${e.clipboardData.getData('text')}\x1b[201~` }));
          }}
        >
          {out}
        </pre>
      )}
    </Card>
  );
}

export function SetupPage() {
  const [data, setData] = useState<AsksView | null>(null);
  const [adding, setAdding] = useState<AddProjectData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inst, setInst] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const load = () => {
    void getAsks()
      .then((d) => {
        setData(d);
        setErr(null);
        // Add project is for the instance's owners and writers to see (only a machine owner may start one).
        if (d.role === 'owner' || d.role === 'writer') void getAddProject().then(setAdding, () => setAdding(null));
      })
      .catch((e: Error) => setErr(e.message));
  };
  useEffect(() => {
    load();
    void hubInstance.then(setInst);
    // A one-time link from Discord (taken out of the address bar on load): exchanged once, by POST.
    const link = pendingSetupLink();
    if (link)
      void openSetupLink(link)
        .then((r) => setFocus(r.ask))
        .catch((e: Error) => setLinkErr(e.message));
    // Live: each new event (an add-project step, an ask) reloads the console, debounced.
    let timer: number | undefined;
    const es = liveStream(apiPath('/api/stream'), {
      change: (m) => {
        const types = (JSON.parse(m.data || '{}') as { types?: string[] }).types ?? [];
        if (types.length && !types.some((t) => /^(ask|machine|add_project)\./.test(t))) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(load, 150);
      },
    });
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, []);
  const shown = new Set((adding?.runs ?? []).flatMap((r) => r.asks.map((a) => a.id)));
  return (
    <div data-testid="page-setup">
      <Header title="Setup console" sub="what the harness needs from you and can't do itself" />
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {err && <p className="text-[13px] text-red">{err}</p>}
        {(data?.role === 'owner' || data?.role === 'writer') && (
          <button onClick={() => navigate('/first-run')} className="text-[12.5px] text-blue-ink hover:underline" data-testid="setup-first-run-link">
            The first-run checklist: tools, Claude login, GitHub, repo config, protection
          </button>
        )}
        {linkErr && (
          <p className="text-[13px] text-red" data-testid="setup-link-error">
            Your Discord link didn't open a step: {linkErr}
          </p>
        )}
        {focus && (
          <p className="text-[13px] text-ink-2" data-testid="setup-link-opened">
            Opened from your one-time Discord link: the step it is for is first below.
          </p>
        )}
        {adding && <AddProjectView data={adding} onChanged={load} />}
        {data && <SetupConsoleView data={data} onChanged={load} shown={shown} focus={focus} />}
        {inst && data?.role === 'owner' && <Terminal instance={inst} />}
      </div>
    </div>
  );
}
