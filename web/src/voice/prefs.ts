// WHY: the voice preferences are this browser's (whether this device can recognize on-device is too), so
// they live in its storage, and no setting about the microphone or the voice reaches the server. All start off.
import { useEffect, useState } from 'react';

export interface VoicePrefs {
  /** The Ask panel's mic button (owners only). Off until an owner turns it on. */
  dictation: boolean;
  /** Fall back to the browser's cloud speech service when on-device isn't available. Off: on-device only. */
  allowCloud: boolean;
  /** Read Ask answers aloud with the browser's speech synthesis (owners only). Off until an owner turns it on. */
  talkBack: boolean;
  /** Let talk-back use the browser's network voices (they send the text to the browser's vendor). Off: on-device voices only. */
  allowNetworkVoices: boolean;
  /** Listen for "hey <brand>" on this computer while a dashboard tab is visible (wake.ts). Off until an owner turns it on. */
  wakeWord: boolean;
}

export const VOICE_DEFAULTS: VoicePrefs = { dictation: false, allowCloud: false, talkBack: false, allowNetworkVoices: false, wakeWord: false };
const KEY = 'dash-voice';
const CHANGED = 'dash-voice-changed';

export function readVoicePrefs(): VoicePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof VoicePrefs, unknown>>;
    // INVARIANT: only a stored `true` turns any of them on; anything else (missing, unreadable, odd) is the default, off.
    return { dictation: raw.dictation === true, allowCloud: raw.allowCloud === true, talkBack: raw.talkBack === true, allowNetworkVoices: raw.allowNetworkVoices === true, wakeWord: raw.wakeWord === true };
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}

export function writeVoicePrefs(p: VoicePrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // WHY: no storage (a private window): the choice lasts until the page reloads.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: p }));
}

/** The preferences, kept current across this tab's components and other tabs. */
export function useVoicePrefs(): [VoicePrefs, (p: VoicePrefs) => void] {
  const [prefs, setPrefs] = useState(readVoicePrefs);
  useEffect(() => {
    const on = (e: Event) => setPrefs(e instanceof CustomEvent ? (e.detail as VoicePrefs) : readVoicePrefs());
    window.addEventListener(CHANGED, on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener(CHANGED, on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return [prefs, (p) => (setPrefs(p), writeVoicePrefs(p))];
}

/** The speech language: the browser's own. */
export const speechLang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
