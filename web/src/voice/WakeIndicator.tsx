// INVARIANT: whenever the microphone is open for the wake word, the indicator is on screen (fixed, on every page,
// over everything but the Ask panel), with words saying so and a button that turns the wake word off. See wake.ts.
import { useEffect, useRef, useState } from 'react';
import { browserWakeEnv, emitWake, mayWake, onDictating, wakeEngine, wakePhrase, WakeListener, type WakeEnv, type WakeStatus } from './wake';
import { useVoicePrefs } from './prefs';

/**
 * The listening indicator: a ring that pulses outward (our own: one colour, one shape; under reduced motion it
 * holds still, styles.css) beside the words. Rendered whenever `micOpen`, nothing otherwise.
 */
export function WakeIndicator({ micOpen, phrase, onOff }: { micOpen: boolean; phrase: string; onOff: () => void }) {
  if (!micOpen) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 flex h-9 max-w-[calc(100vw-32px)] items-center gap-2 rounded-full bg-surface pr-1.5 pl-3 text-[12.5px] whitespace-nowrap text-ink shadow-overlay max-md:bottom-20 max-md:h-auto" role="status" aria-live="polite" data-testid="wake-indicator">
      <span className="wake-ring" aria-hidden="true" />
      <span>
        Mic on: listening for <q className="font-medium">{phrase}</q>
      </span>
      <button type="button" onClick={onOff} className="rounded-full px-2 py-0.5 text-[12px] text-ink-2 hover:bg-hover-2 hover:text-ink" data-testid="wake-off" title="Turn the wake word off (Settings, Voice)">
        Turn off
      </button>
    </div>
  );
}

/** The wake word for this tab: listening while everything allows it, the Ask panel told on a hit. */
export function useWakeWord(o: { role: string | null | undefined; brand: string | undefined; env?: WakeEnv }) {
  const [prefs, setPrefs] = useVoicePrefs();
  const [s, setS] = useState<{ status: WakeStatus; micOpen: boolean; why: string | null }>({ status: 'off', micOpen: false, why: null });
  const listener = useRef<WakeListener | null>(null);
  const enabled = !!o.brand && mayWake(o.role, prefs);
  const phrase = wakePhrase(o.brand ?? '');

  useEffect(() => {
    // INVARIANT: nothing is made, asked or opened until an owner turned it on.
    if (!enabled) return;
    const l = new WakeListener(wakeEngine(), o.env ?? browserWakeEnv(), phrase, {
      onWake: () => {
        // WHY: nothing took it (no Ask panel): listen again rather than stay closed.
        if (!emitWake()) l.dictating(false);
      },
      onChange: setS,
    });
    listener.current = l;
    const off = onDictating((on) => l.dictating(on));
    l.set({ enabled: true });
    return () => {
      off();
      l.dispose();
      listener.current = null;
      setS({ status: 'off', micOpen: false, why: null });
    };
  }, [enabled, phrase, o.env]);

  return { ...s, phrase, turnOff: () => setPrefs({ ...prefs, wakeWord: false }) };
}

/** The indicator for the whole dashboard (App). */
export function WakeWord({ role, brand }: { role: string | null | undefined; brand: string | undefined }) {
  const w = useWakeWord({ role, brand });
  return <WakeIndicator micOpen={w.micOpen} phrase={w.phrase} onOff={w.turnOff} />;
}
