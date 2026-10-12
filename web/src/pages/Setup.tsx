import { useEffect, useRef, useState } from 'react';
import { answerAsk, getAsks, hubInstance, pasteSecret, runRootStep, type Ask, type AsksView } from '../api';
import { ago, Badge, Button, Card, cx, Empty } from '../components/ui';
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
          Runs <code>{[a.command, ...a.args].join(' ')}</code> through the machine helper, as root.
          {!a.allowed && <span className="mt-1 block text-red" data-testid="ask-refusal">Not on the helper's allowlist: {a.refusal}</span>}
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
          <Button size="sm" disabled={!!busy || !a.allowed} data-testid="ask-run" onClick={() => void act('run', () => runRootStep(a.id))}>
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

export function SetupConsoleView({ data, onChanged }: { data: AsksView; onChanged?: () => void }) {
  const open = data.asks.filter((a) => a.status === 'open');
  const done = data.asks.filter((a) => a.status !== 'open').reverse();
  return (
    <div className="space-y-6">
      {!data.asks.length && <Empty title="Nothing to set up" hint="When the harness needs something it can't do itself (a secret, an approval, a machine step), it asks here." />}
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
  const open = () => {
    setOut('');
    setNote(null);
    setState('opening');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const s = new WebSocket(`${proto}://${location.host}/api/terminal?instance=${encodeURIComponent(instance)}&cols=120&rows=32`);
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
          <p className="text-[12px] text-ink-3">A login shell as this machine's admin user. Needs a GitHub sign-in in the last 5 minutes and one of your allowed Tailscale devices; sudo asks for your password; every command is recorded; it closes after 10 minutes idle.</p>
        </div>
        {state === 'closed' ? (
          <Button size="sm" variant="outline" onClick={open} data-testid="terminal-open">
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
  const [err, setErr] = useState<string | null>(null);
  const [inst, setInst] = useState<string | null>(null);
  const load = () =>
    void getAsks()
      .then((d) => (setData(d), setErr(null)))
      .catch((e: Error) => setErr(e.message));
  useEffect(() => {
    load();
    void hubInstance.then(setInst);
  }, []);
  return (
    <div data-testid="page-setup">
      <Header title="Setup console" sub="what the harness needs from you and can't do itself" />
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        {err && <p className="text-[13px] text-red">{err}</p>}
        {data && <SetupConsoleView data={data} onChanged={load} />}
        {inst && data?.role === 'owner' && <Terminal instance={inst} />}
      </div>
    </div>
  );
}
