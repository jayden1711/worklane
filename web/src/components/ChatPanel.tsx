// The chat panel, on every page: a question goes to an instance's own server as a
// request its coordinator answers (src/chat.ts); the panel polls for the answer.
// An answer cites events, runs, PRs and issues as links. For the owner it may carry
// an issue draft, shown as a preview that is filed (with `ready`, checked again by the
// server) only after a confirm, and proposals, each of which opens the flow that
// already confirms that change: nothing runs from the chat itself. Anyone else gets
// the answer read-only. On a hub, a question goes to the selected instance, or to
// each instance's own server.
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { MessageCircle, X } from 'lucide-react';
import { askChat, chatAnswer, fileChatDraft, hub, hubInstance, type ChatAction, type ChatAnswer, type ChatAnswerFile, type ChatCitation, type HubInfo } from '../api';
import { navigate } from '../App';
import { Badge, Button, cx } from './ui';

const MAX = 4000;
const POLL_MS = 2000;

/** Where a citation opens: events on Activity, runs on their page, PRs and issues on GitHub. */
export function citationHref(c: ChatCitation): string {
  if (c.kind === 'event') return `/activity?event=${encodeURIComponent(c.id)}`;
  return c.href;
}

/** The dashboard page that confirms a proposal; null when it is done on the machine (no dashboard control). */
export function actionHref(a: ChatAction): string | null {
  if (a.kind === 'settings') return `/settings?set=${encodeURIComponent(a.key)}&to=${encodeURIComponent(JSON.stringify(a.value))}`;
  if (a.kind === 'decision') return `/decisions?proposed=${encodeURIComponent(a.answer)}#${encodeURIComponent(a.id)}`;
  return null;
}

/**
 * Open a dashboard page on an instance: this page's own (or the hub's selected one) in place;
 * another instance on a hub by switching to it, so the page and its writes go to that instance's server.
 */
function openOn(instance: string | null, current: string | null, to: string) {
  if (instance && instance !== current) {
    try {
      sessionStorage.setItem('dash-instance', instance);
    } catch {
      // no storage: it opens on the selected instance
    }
    window.location.assign(to);
  } else if (window.location.pathname === to.split(/[?#]/)[0]) window.location.assign(to);
  else navigate(to);
}

function CitationLink({ c, onOpen }: { c: ChatCitation; onOpen: (to: string) => void }) {
  const href = citationHref(c);
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      onClick={(e) => {
        if (external) return;
        e.preventDefault();
        onOpen(href);
      }}
      className="inline-flex h-6 items-center rounded-full bg-inset px-2 text-[11.5px] font-medium text-blue-ink shadow-hairline hover:bg-hover-2"
      data-testid="chat-citation"
      data-kind={c.kind}
    >
      {c.label}
    </a>
  );
}

function DraftPreview({ draft, filed, onFile }: { draft: NonNullable<ChatAnswer['issueDraft']>; filed: { number: number } | null; onFile: () => Promise<number> }) {
  const [step, setStep] = useState<'preview' | 'confirm' | 'busy'>('preview');
  const [done, setDone] = useState<number | null>(filed?.number ?? null);
  const [err, setErr] = useState<string | null>(null);
  const file = async () => {
    setStep('busy');
    setErr(null);
    try {
      setDone(await onFile());
    } catch (e) {
      setErr((e as Error).message);
      setStep('preview');
    }
  };
  return (
    <div className="mt-3 rounded-control bg-inset p-2.5 shadow-hairline" data-testid="chat-draft">
      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
        Issue draft {draft.ok && <Badge tone="info">ready</Badge>}
      </div>
      <div className="mt-1 text-[13px] font-medium text-ink" data-testid="chat-draft-title">
        {draft.title || '(no title)'}
      </div>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-control bg-surface p-2 font-mono text-[11.5px] text-ink-2 shadow-hairline" data-testid="chat-draft-body">
        {draft.body}
      </pre>
      {!draft.ok ? (
        <div className="mt-2 text-[12px] text-red" data-testid="chat-draft-invalid">
          Can't be filed as it is: {draft.why}
        </div>
      ) : done !== null ? (
        <div className="mt-2 text-[12px] font-medium text-green" data-testid="chat-draft-filed">
          Filed as #{done} with ready
        </div>
      ) : step === 'preview' ? (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => setStep('confirm')} data-testid="chat-draft-review">
          File this issue…
        </Button>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="text-[12px] text-ink-2">Files this issue with the ready label, so the harness may pick it up. The server checks the contract again first.</div>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={step === 'busy'} onClick={() => void file()} data-testid="chat-draft-confirm">
              {step === 'busy' ? 'Filing…' : 'Confirm: file it'}
            </Button>
            <Button size="sm" variant="ghost" disabled={step === 'busy'} onClick={() => setStep('preview')} data-testid="chat-draft-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {err && (
        <div className="mt-1.5 text-[12px] text-red" data-testid="chat-draft-error">
          {err}
        </div>
      )}
    </div>
  );
}

function ActionRow({ a, cli, onOpen }: { a: ChatAction; cli: string; onOpen: (to: string) => void }) {
  const href = actionHref(a);
  const what =
    a.kind === 'settings' ? `Change ${a.key} to ${JSON.stringify(a.value)}` : a.kind === 'decision' ? `Answer decision ${a.id}: ${a.answer}` : a.kind === 'pause' ? 'Stop every agent on this machine' : 'Lift the emergency stop';
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 text-[12.5px]" data-testid="chat-action" data-kind={a.kind}>
      <div className="min-w-0 flex-1">
        <div className="text-ink">{what}</div>
        {a.why && <div className="text-[11.5px] text-ink-3">{a.why}</div>}
        {!href && (
          <div className="text-[11.5px] text-ink-3" data-testid="chat-action-machine">
            Done on the machine: <code className="rounded-chip bg-surface px-1 font-mono shadow-hairline">{cli} {a.kind === 'pause' ? 'stop-all' : 'resume-all'}</code>
          </div>
        )}
      </div>
      {href && (
        <Button size="sm" variant="outline" onClick={() => onOpen(href)} data-testid="chat-action-open">
          {a.kind === 'settings' ? 'Review in Settings' : 'Open the decision'}
        </Button>
      )}
    </li>
  );
}

/** One instance's answer to a question: pending, refused, or answered (what the owner and others get differs). */
export function ChatAnswerView({ f, cli, onOpen = () => {}, onFile = () => Promise.reject(new Error('not here')), showInstance = false }: { f: ChatAnswerFile | { state: 'error'; why: string }; cli: string; onOpen?: (to: string) => void; onFile?: () => Promise<number>; showInstance?: boolean }) {
  if (f.state === 'pending') {
    return (
      <div className="py-1" role="status" data-testid="chat-pending">
        <span className="shimmer-text text-[13px] font-medium">Thinking…</span>
        <div className="text-[11.5px] text-ink-3">The coordinator answers on its next tick; nothing comes while it isn't running.</div>
      </div>
    );
  }
  if (f.state === 'refused' || f.state === 'error') {
    return (
      <div className="text-[12.5px] text-red" data-testid="chat-refused">
        {f.state === 'refused' ? 'Not answered' : "Couldn't ask"}: {f.why}
      </div>
    );
  }
  const a = f.answer;
  return (
    <div data-testid="chat-answer">
      {showInstance && <div className="mb-1 text-[11.5px] font-medium text-ink-3">{a.instance}</div>}
      <div className="whitespace-pre-wrap text-[13px] leading-5 text-ink" data-testid="chat-answer-text">
        {a.answer}
      </div>
      {!!a.citations.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {a.citations.map((c) => (
            <CitationLink key={`${c.kind}:${c.id}`} c={c} onOpen={onOpen} />
          ))}
        </div>
      )}
      {!!a.unknownCitations.length && (
        <div className="mt-1 text-[11.5px] text-ink-3" data-testid="chat-unknown-citations">
          Left out {a.unknownCitations.length} citation(s) that matched nothing it was given.
        </div>
      )}
      {a.issueDraft && <DraftPreview draft={a.issueDraft} filed={f.filed} onFile={onFile} />}
      {!!a.actions.length && (
        <div className="mt-3">
          <div className="text-[11.5px] text-ink-3">Proposed; each opens the page that confirms it</div>
          <ul className="divide-y divide-line">
            {a.actions.map((x, i) => (
              <ActionRow key={i} a={x} cli={cli} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}
      {!!a.refusedActions.length && (
        <ul className="mt-2 space-y-0.5 text-[11.5px] text-ink-3" data-testid="chat-refused-actions">
          {a.refusedActions.map((w, i) => (
            <li key={i}>Not proposed: {w}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-3">
        <span data-testid="chat-cost">~${a.costUsd.toFixed(2)} (estimated)</span>
        {(a.readOnly || !f.owner) && <span data-testid="chat-read-only">Read-only: only the owner gets drafts and proposals.</span>}
      </div>
    </div>
  );
}

interface Turn {
  question: string;
  asks: { instance: string | null; id: string | null; f: ChatAnswerFile | { state: 'error'; why: string } }[];
}

const pendingFile = (id: string): ChatAnswerFile => ({ v: 1, id, at: '', owner: false, filed: null, state: 'pending' });

/**
 * This tab's questions, kept across page loads (opening a proposal on another instance reloads the page);
 * each answer is fetched again. `?chat=<id>` opens the panel on that question's answer (the question
 * itself isn't kept once the coordinator takes it).
 */
function restoreTurns(): { turns: Turn[]; open: boolean } {
  let saved: { question: string; asks: { instance: string | null; id: string }[] }[] = [];
  try {
    saved = JSON.parse(sessionStorage.getItem('dash-chat') ?? '[]') as typeof saved;
  } catch {
    // no storage, or unreadable: a fresh thread
  }
  const turns: Turn[] = saved.map((t) => ({ question: t.question, asks: t.asks.map((a) => ({ ...a, f: pendingFile(a.id) })) }));
  const linked = new URLSearchParams(window.location.search).get('chat');
  if (linked && /^[0-9]+-[a-f0-9]+$/.test(linked) && !turns.some((t) => t.asks.some((a) => a.id === linked))) turns.push({ question: '', asks: [{ instance: null, id: linked, f: pendingFile(linked) }] });
  return { turns, open: !!linked };
}

function saveTurns(turns: Turn[]) {
  try {
    sessionStorage.setItem('dash-chat', JSON.stringify(turns.slice(-20).map((t) => ({ question: t.question, asks: t.asks.filter((a) => a.id).map((a) => ({ instance: a.instance, id: a.id })) }))));
  } catch {
    // no storage: the thread lasts as long as the page
  }
}

/** The floating Ask button and its panel. `cli` is the command the machine-only proposals name. */
export function ChatPanel({ cli }: { cli: string }) {
  const [restored] = useState(restoreTurns);
  const [open, setOpen] = useState(restored.open);
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>(restored.turns);
  useEffect(() => saveTurns(turns), [turns]);
  const [hubInfo, setHubInfo] = useState<{ hub: HubInfo; current: string } | null>(null);
  const [target, setTarget] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void Promise.all([hub, hubInstance]).then(([h, current]) => {
      if (h && current) {
        setHubInfo({ hub: h, current });
        setTarget(current);
      }
    });
  }, []);

  // Poll every pending answer until it is in.
  const pending = turns.some((t) => t.asks.some((a) => a.id && a.f.state === 'pending'));
  const polled = useRef(false);
  useEffect(() => {
    if (!pending) return;
    // At once for the answers restored on load; then every POLL_MS.
    const delay = polled.current ? POLL_MS : 0;
    polled.current = true;
    const timer = window.setTimeout(() => {
      const waiting = turns.flatMap((t) => t.asks).filter((a) => a.id && a.f.state === 'pending');
      void Promise.all(waiting.map(async (a) => [`${a.instance}/${a.id}`, await chatAnswer(a.instance, a.id!).catch((e: Error) => ({ state: 'error' as const, why: e.message }))] as const)).then((got) => {
        const by = new Map(got);
        // Merged into the turns as they are now: a question asked meanwhile stays.
        setTurns((prev) => prev.map((t) => ({ ...t, asks: t.asks.map((a) => ({ ...a, f: by.get(`${a.instance}/${a.id}`) ?? a.f })) })));
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [turns, pending]);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [turns.length]);

  const ask = async () => {
    const question = q.trim();
    if (!question || question.length > MAX) return;
    setBusy(true);
    // On a hub: the chosen instance, or each one that answers; elsewhere this page's own server.
    const targets: (string | null)[] = !hubInfo ? [null] : target === '*' ? hubInfo.hub.instances.filter((i) => i.up).map((i) => i.name) : [target];
    const asks = await Promise.all(
      targets.map(async (instance) => {
        try {
          const { id } = await askChat(instance, question);
          return { instance, id, f: pendingFile(id) };
        } catch (e) {
          return { instance, id: null, f: { state: 'error' as const, why: (e as Error).message } };
        }
      }),
    );
    setTurns((t) => [...t, { question, asks }]);
    setQ('');
    setBusy(false);
  };

  const current = hubInfo?.current ?? null;
  const opener = (instance: string | null) => (to: string) => {
    setOpen(false);
    openOn(instance, current, to);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="fixed right-4 bottom-4 z-30 flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-surface shadow-overlay hover:opacity-90" data-testid="chat-open" aria-label="Ask about this project">
          <MessageCircle className="size-4" /> Ask
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/10" />
        <Dialog.Content onOpenAutoFocus={(e) => (e.preventDefault(), input.current?.focus())} className="fixed top-0 right-0 bottom-0 z-50 flex w-[min(440px,100vw)] flex-col bg-surface shadow-overlay" style={{ animation: 'fade-up 200ms cubic-bezier(0.23,1,0.32,1) both' }} data-testid="chat-panel" aria-describedby={undefined}>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
            <Dialog.Title className="text-[13.5px] font-medium text-ink">Ask</Dialog.Title>
            <span className="text-[11.5px] text-ink-3">answers cite what they come from; nothing runs from here</span>
            <Dialog.Close className="primitive-icon-button ml-auto size-7 text-ink-3 hover:bg-hover-2 hover:text-ink" aria-label="Close" data-testid="chat-close">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3" data-testid="chat-thread">
            {!turns.length && <div className="text-[12.5px] text-ink-3">Ask why something is stuck, what ran, or what to do next. The owner gets drafts and proposals to confirm; everyone else gets answers.</div>}
            {turns.map((t, i) => (
              <div key={i} className="space-y-2" data-testid="chat-turn">
                {t.question && (
                  <div className="ml-8 rounded-card bg-inset px-3 py-2 text-[13px] text-ink shadow-hairline" data-testid="chat-question">
                    {t.question}
                  </div>
                )}
                {t.asks.map((a) => (
                  <ChatAnswerView key={a.instance ?? '.'} f={a.f} cli={cli} showInstance={t.asks.length > 1} onOpen={opener(a.instance)} onFile={async () => (await fileChatDraft(a.instance, a.id!)).number} />
                ))}
              </div>
            ))}
            <div ref={bottom} />
          </div>
          <form
            className="shrink-0 space-y-2 border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            {hubInfo && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ask which instance">
                {[...hubInfo.hub.instances.filter((i) => i.up).map((i) => i.name), '*'].map((n) => (
                  <button key={n} type="button" onClick={() => setTarget(n)} className={cx('h-6 rounded-full px-2.5 text-[11.5px]', target === n ? 'bg-ink font-medium text-surface' : 'text-ink-2 shadow-hairline hover:bg-hover-2')} data-testid="chat-target">
                    {n === '*' ? 'Every instance' : n}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void ask();
                }
              }}
              rows={3}
              placeholder="Why is issue 12 stuck?"
              aria-label="Question"
              className="w-full resize-none rounded-control bg-field px-2.5 py-2 text-[13px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--blue)]"
              data-testid="chat-input"
            />
            <div className="flex items-center gap-2">
              <span className={cx('text-[11.5px] tabular-nums', q.length > MAX ? 'text-red' : 'text-ink-3')}>
                {q.length > MAX ? `${q.length - MAX} over the ${MAX} limit` : '⌘↵ to ask'}
              </span>
              <Button size="sm" type="submit" className="ml-auto" disabled={busy || !q.trim() || q.length > MAX} data-testid="chat-ask">
                {busy ? 'Asking…' : 'Ask'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
