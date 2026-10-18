// INVARIANT: voice intake and approvals (commands.ts) act only on a confirm, spoken within 10 s or clicked on the
// banner, by an owner who turned it on, in a focused and visible tab; the server checks the same again (src/voice.ts).
// The words are heard on the device (speech.ts: on-device unless the owner allowed the cloud); what is sent on a
// confirm is the idea's text, or the decision's id, to this dashboard's own server only.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { decide, voiceIntake, type Decision, type State } from '../api';
import { checkSupport, Dictation, speechCtor, type RecognitionCtor, type Support } from './speech';
import { speechLang, type VoicePrefs } from './prefs';
import { bannerText, CONFIRM_WINDOW_MS, finder, mayUseVoice, tabState, voiceActive, VoiceCommands, type Pending, type Step } from './commands';
import { mayTalk, useTalkBack } from './TalkBack';
import { Button, cx, decisionWork } from '../components/ui';

/** What the banner shows: an item waiting for a confirm (with the seconds left), or what just happened. */
export type BannerView = { pending: Pending; left: number } | { done: string; ok: boolean };

/**
 * The 10-second banner shown for every spoken confirm, with the same confirm and cancel as buttons. `decisions`: the
 * open decisions (State.decisions); an approval's Approve says, while paused, what the work its decision's kind does
 * (decisionWork: a landing lands now, an intake or a plan waits for the resume).
 */
export function VoiceBanner({ view, decisions = [], onConfirm, onCancel }: { view: BannerView | null; decisions?: Pick<Decision, 'id' | 'kind'>[]; onConfirm: () => void; onCancel: () => void }) {
  if (!view) return null;
  const box = 'fixed top-3 left-1/2 z-[60] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 rounded-card bg-surface px-4 py-3 text-[13px] shadow-overlay';
  if ('done' in view)
    return (
      <div className={box} role="status" aria-live="polite" data-testid="voice-banner" data-kind="done">
        <span className={view.ok ? 'text-ink' : 'text-red'}>{view.done}</span>
      </div>
    );
  const p = view.pending;
  const work = p.kind === 'approve' ? decisionWork(decisions.find((d) => d.id === p.decision)?.kind) : null;
  const pct = Math.max(0, Math.min(100, (view.left / (CONFIRM_WINDOW_MS / 1000)) * 100));
  return (
    <div className={box} role="alertdialog" aria-live="assertive" aria-label="Spoken confirm" data-testid="voice-banner" data-kind={p.kind}>
      {p.kind === 'intake' && (
        <>
          <div className="text-[11.5px] font-medium text-ink-3">Heard, for intake (as yours):</div>
          <div className="mt-1 max-h-32 overflow-y-auto break-words text-ink" data-testid="voice-banner-text">
            {p.text}
          </div>
        </>
      )}
      {p.kind === 'approve' && (
        <>
          <div className="text-ink" data-testid="voice-banner-text">
            Approve <span className="font-medium">#{p.issue}</span>: {p.title}
          </div>
          <div className="mt-1 text-[12.5px] text-ink-2">Approving: {p.effect}.</div>
        </>
      )}
      {p.kind === 'refused' && (
        <div className="text-ink" data-testid="voice-banner-text">
          #{p.issue} can't be approved by voice: {p.why}.
        </div>
      )}
      {p.kind !== 'refused' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-3" data-testid="voice-banner-window">
            Say “confirm” within <span className="tabular-nums">{view.left}</span> s, or click; anything else said cancels.
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={onConfirm} work={work} data-testid="voice-banner-confirm">
              {p.kind === 'intake' ? 'Send to intake' : 'Approve'}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancel} data-testid="voice-banner-cancel">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[12px] text-ink-3">Anything voice can't approve takes a click on the Decisions page.</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={onCancel} data-testid="voice-banner-cancel">
            Dismiss
          </Button>
        </div>
      )}
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-inset" aria-hidden>
        <div className="h-full bg-blue transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The floating voice button: owners who turned it on only; pressed while listening. */
export function VoiceButton({ show, support, listening, onToggle }: { show: boolean; support: Support | null; listening: boolean; onToggle: () => void }) {
  if (!show || !support || support.kind === 'none') return null;
  const ready = support.kind === 'ready';
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={onToggle}
      title={ready ? (listening ? 'Stop listening for voice commands' : 'Voice: say an idea for intake, or "approve <number>"; nothing happens without a confirm') : support.why}
      aria-label={listening ? 'Stop listening for voice commands' : 'Listen for voice commands'}
      aria-pressed={ready ? listening : undefined}
      className={cx('fixed right-[92px] bottom-4 z-30 flex size-9 items-center justify-center rounded-full shadow-overlay', !ready ? 'cursor-not-allowed bg-surface text-ink-3 opacity-60' : listening ? 'bg-red-tint text-red' : 'bg-surface text-ink-2 hover:text-ink')}
      data-testid="voice-commands"
      data-state={!ready ? 'disabled' : listening ? 'listening' : 'idle'}
    >
      <AudioLines className="size-4" />
    </button>
  );
}

/**
 * Voice intake and spoken approvals for the whole dashboard. Listens only after the owner presses the button, and
 * stops (dropping anything pending) the moment the tab loses focus or is hidden.
 */
export function VoiceControl({ state, prefs, ctor }: { state: State; prefs: VoicePrefs; ctor?: RecognitionCtor | null }) {
  const role = state.role;
  const on = mayUseVoice(role, prefs);
  const recCtor = ctor === undefined ? speechCtor() : ctor;
  const [support, setSupport] = useState<Support | null>(null);
  const [listening, setListening] = useState(false);
  const [view, setView] = useState<BannerView | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const machine = useMemo(() => new VoiceCommands({ find: (n) => finder(latest.current)(n) }), []);
  const talk = useTalkBack({ active: on && mayTalk(role, prefs), prefs });
  const speaking = useRef(false);
  speaking.current = talk.speaking;

  useEffect(() => {
    if (!on) return setSupport(null);
    let live = true;
    void checkSupport(recCtor, { lang: speechLang(), allowCloud: prefs.allowCloud }).then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [on, recCtor, prefs.allowCloud]);

  const stop = () => {
    dictation.current?.abort();
    machine.cancel();
    setView((v) => (v && 'pending' in v ? null : v));
  };

  // INVARIANT: nothing listens or waits once it is turned off, the tab loses focus or is hidden, or this unmounts.
  useEffect(() => {
    if (!on) stop();
    const hidden = () => document.visibilityState === 'hidden' && stop();
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', hidden);
      stop();
    };
  }, [on]); // eslint-disable-line react-hooks/exhaustive-deps

  // The banner's countdown, and its end: the window closed, so the item is dropped.
  useEffect(() => {
    if (!view) return;
    const t = window.setInterval(() => {
      if ('done' in view) return setView(null);
      const p = machine.live();
      if (!p) return setView(null);
      setView({ pending: p, left: Math.max(0, Math.ceil((p.until - Date.now()) / 1000)) });
    }, 'done' in view ? 4000 : 250);
    return () => window.clearInterval(t);
  }, [view, machine]);

  const run = async (step: Step) => {
    if (step.do === 'show') {
      setView({ pending: step.pending, left: CONFIRM_WINDOW_MS / 1000 });
      if (mayTalk(role, prefs)) talk.speak(bannerText(step.pending));
      return;
    }
    if (step.do === 'cancelled') return setView({ done: 'Cancelled: nothing was sent.', ok: true });
    if (step.do === 'nothing') return;
    // Checked again at the moment of sending, and sent with the request for the server to check too.
    const tab = tabState();
    if (!voiceActive(role, prefs, tab)) return setView(null);
    try {
      if (step.do === 'send-intake') {
        await voiceIntake(step.text, tab);
        setView({ done: 'Sent to intake by voice: it goes through triage and waits for an approval like any report.', ok: true });
      } else {
        await decide(step.decision, 'approve', tab);
        setView({ done: `Approved #${step.issue} by voice.`, ok: true });
      }
    } catch (e) {
      setView({ done: `Not done: ${(e as Error).message}`, ok: false });
    }
  };

  const heard = (text: string) => {
    // WHY: while the banner is read aloud, the mic hears the reading; that is not the owner speaking.
    if (speaking.current) return;
    void run(machine.hear(text, voiceActive(role, prefs, tabState())));
  };

  const toggle = () => {
    if (dictation.current?.listening) return stop();
    if (support?.kind !== 'ready' || !recCtor || !voiceActive(role, prefs, tabState())) return;
    dictation.current = new Dictation(recCtor, { lang: speechLang(), local: support.local }, { onFinal: heard, onInterim: () => {}, onListening: setListening, onError: (why) => setView({ done: `Voice stopped: ${why}`, ok: false }) });
    dictation.current.start();
  };

  if (!on) return null;
  return (
    <>
      <VoiceButton show={on} support={support} listening={listening} onToggle={toggle} />
      <VoiceBanner
        view={view}
        decisions={state.decisions}
        onConfirm={() => {
          talk.stop();
          void run(machine.click(voiceActive(role, prefs, tabState())));
        }}
        onCancel={() => {
          talk.stop();
          machine.cancel();
          setView(null);
        }}
      />
    </>
  );
}
