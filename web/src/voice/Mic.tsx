// INVARIANT: the mic button and its hook only ever put text in the box they are given; sending stays the
// person's own Ask. See speech.ts for where the audio goes.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { checkSupport, Dictation, intoBox, speechCtor, type RecognitionCtor, type Support } from './speech';
import { speechLang, type VoicePrefs } from './prefs';
import { cx } from '../components/ui';

/** Whether this person gets the mic at all: the instance's owners, once one turned it on in Settings. */
export const mayDictate = (role: string | null | undefined, prefs: VoicePrefs) => role === 'owner' && prefs.dictation;

/** The mic button: nothing without a recognizer, disabled with why, or a toggle (pressed while listening). */
export function MicButton({ support, listening, onToggle }: { support: Support | null; listening: boolean; onToggle: () => void }) {
  if (!support || support.kind === 'none') return null;
  const ready = support.kind === 'ready';
  const title = ready ? (listening ? 'Stop dictating (Esc)' : support.title) : support.why;
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={onToggle}
      title={title}
      aria-label={listening ? 'Stop dictating' : 'Dictate'}
      aria-pressed={ready ? listening : undefined}
      className={cx('primitive-icon-button size-7 shrink-0', !ready ? 'cursor-not-allowed text-ink-3 opacity-50' : listening ? 'bg-red-tint text-red' : 'text-ink-2 hover:bg-hover-2 hover:text-ink')}
      data-testid="chat-mic"
      data-state={!ready ? 'disabled' : listening ? 'listening' : 'idle'}
      data-local={ready ? String(support.local) : undefined}
    >
      {ready ? <Mic className="size-4" /> : <MicOff className="size-4" />}
    </button>
  );
}

/** The mic as the Ask panel shows it: only for an owner who turned it on (mayDictate), else nothing at all. */
export function ComposerMic({ role, prefs, support, listening, onToggle }: { role: string | null | undefined; prefs: VoicePrefs; support: Support | null; listening: boolean; onToggle: () => void }) {
  return mayDictate(role, prefs) ? <MicButton support={support} listening={listening} onToggle={onToggle} /> : null;
}

/** What is heard but not final yet, shown apart from the text box and marked as such. */
export function MicInterim({ listening, interim, error }: { listening: boolean; interim: string; error: string | null }) {
  if (error)
    return (
      <div className="text-[11.5px] text-red" role="status" data-testid="chat-mic-error">
        Dictation stopped: {error}
      </div>
    );
  if (!listening) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[11.5px] text-ink-3" role="status" aria-live="polite" data-testid="chat-mic-interim">
      <span className="shrink-0 font-medium text-red">Listening</span>
      {interim ? <span className="truncate italic" data-testid="chat-mic-interim-text">{interim}…</span> : <span>(it goes in the box for you to review; Esc stops)</span>}
    </div>
  );
}

/**
 * Dictation into a text box while `active` (the panel open, an owner who turned it on). It stops for good when
 * `active` goes false, the window loses focus or is hidden, or focus leaves `container`.
 */
export function useDictation(o: { active: boolean; prefs: VoicePrefs; box: RefObject<HTMLTextAreaElement | null>; container: RefObject<HTMLElement | null>; setText: (t: string) => void; ctor?: RecognitionCtor | null }) {
  const { active, prefs, box, container, setText } = o;
  const [support, setSupport] = useState<Support | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const ctor = o.ctor === undefined ? speechCtor() : o.ctor;

  useEffect(() => {
    if (!active) return setSupport(null);
    let live = true;
    void checkSupport(ctor, { lang: speechLang(), allowCloud: prefs.allowCloud }).then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [active, ctor, prefs.allowCloud]);

  const abort = useCallback(() => dictation.current?.abort(), []);

  // INVARIANT: nothing listens once the panel closes, the setting changes, or this unmounts.
  useEffect(() => {
    if (!active) abort();
    return abort;
  }, [active, abort, prefs.allowCloud]);

  useEffect(() => {
    if (!listening) return;
    const hidden = () => document.visibilityState === 'hidden' && abort();
    const left = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!to || !container.current?.contains(to)) abort();
    };
    const el = container.current;
    window.addEventListener('blur', abort);
    document.addEventListener('visibilitychange', hidden);
    el?.addEventListener('focusout', left);
    return () => {
      window.removeEventListener('blur', abort);
      document.removeEventListener('visibilitychange', hidden);
      el?.removeEventListener('focusout', left);
    };
  }, [listening, abort, container]);

  const toggle = () => {
    if (dictation.current?.listening) return dictation.current.stop();
    if (support?.kind !== 'ready' || !ctor) return;
    setError(null);
    dictation.current = new Dictation(
      ctor,
      { lang: speechLang(), local: support.local },
      {
        onFinal: intoBox(() => box.current, setText),
        onInterim: setInterim,
        onListening: setListening,
        onError: setError,
      },
    );
    dictation.current.start();
    box.current?.focus();
  };

  return { support, listening, interim, error, toggle, stop: () => dictation.current?.stop(), abort };
}
