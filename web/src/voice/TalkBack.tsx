// INVARIANT: talk-back (talk.ts) is the instance's owners' only, off until one turns it on in Settings, and it
// only ever hands an answer's text to the browser's own speech synthesis.
import { useEffect, useRef, useState } from 'react';
import { Square } from 'lucide-react';
import { TalkBack, type Synth, type UtteranceCtor } from './talk';
import { speechLang, type VoicePrefs } from './prefs';

/** Whether this person gets answers read aloud: the instance's owners, once one turned it on in Settings. */
export const mayTalk = (role: string | null | undefined, prefs: VoicePrefs) => role === 'owner' && prefs.talkBack;

/**
 * Talk-back for the Ask panel while `active` (the panel open, an owner who turned it on). It stops when `active`
 * goes false, the tab is hidden, the network-voice setting changes, or this unmounts.
 */
export function useTalkBack(o: { active: boolean; prefs: VoicePrefs; synth?: { synth: Synth; Utterance: UtteranceCtor } | null }) {
  const { active, prefs } = o;
  const talk = useRef<TalkBack | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const t = new TalkBack({ lang: speechLang(), allowNetwork: prefs.allowNetworkVoices, ...(o.synth !== undefined ? { synth: o.synth } : {}) });
    talk.current = t;
    const unsub = t.subscribe(() => setSpeaking(t.speaking));
    const unhide = t.stopWhenHidden(document);
    return () => {
      unsub();
      unhide();
      t.dispose();
      if (talk.current === t) talk.current = null;
      setSpeaking(false);
    };
  }, [prefs.allowNetworkVoices, o.synth]);

  useEffect(() => {
    talk.current?.setActive(active);
    if (!active) setNote(null);
  }, [active, prefs.allowNetworkVoices]);

  return {
    speaking,
    note,
    speak: (answer: string) => {
      setNote(null);
      void talk.current?.speak(answer).then((r) => !r.spoken && r.why && setNote(r.why));
    },
    stop: () => talk.current?.stop(),
    /** Esc: true when it was reading, so the key does nothing else. */
    escape: () => talk.current?.escape() ?? false,
  };
}

/** While an answer is read aloud: a line that says so, with Stop; or why it wasn't. Owners with it on only. */
export function TalkStatus({ role, prefs, speaking, note, onStop }: { role: string | null | undefined; prefs: VoicePrefs; speaking: boolean; note: string | null; onStop: () => void }) {
  if (!mayTalk(role, prefs)) return null;
  if (speaking)
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3" role="status" aria-live="polite" data-testid="chat-speaking">
        <span className="shrink-0 font-medium text-blue-ink">Reading the answer aloud</span>
        <span className="truncate">(Esc or talking stops it)</span>
        <button type="button" onClick={onStop} className="primitive-icon-button ml-auto size-6 shrink-0 text-ink-2 hover:bg-hover-2 hover:text-ink" aria-label="Stop reading aloud" title="Stop reading aloud (Esc)" data-testid="chat-speaking-stop">
          <Square className="size-3" />
        </button>
      </div>
    );
  if (note)
    return (
      <div className="text-[11.5px] text-ink-3" role="status" data-testid="chat-talk-note">
        Not read aloud: {note}
      </div>
    );
  return null;
}
