// INVARIANT: dictation through the browser's Web Speech API (SpeechRecognition / webkitSpeechRecognition),
// for the Ask panel's mic button and whatever voice feature comes next, runs in the page only: no audio and
// no transcript goes to the dashboard's server. Only the person's own Ask sends the text.
//
// INVARIANT: in Chrome, plain recognition streams the audio to Google's speech service. On-device
// recognition is the `processLocally` option, checked with the static `available()` (and fetched with
// `install()`); a browser without them, or whose model isn't there, gets no recognition at all unless
// the owner allowed the cloud fallback in Settings (prefs.ts, off by default).

/** The parts of a SpeechRecognition this uses (the DOM lib has no types for it). */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
interface OnDeviceOptions {
  langs: string[];
  processLocally: true;
}
export interface RecognitionCtor {
  new (): Recognition;
  prototype: object;
  available?: (o: OnDeviceOptions) => Promise<Availability>;
  install?: (o: OnDeviceOptions) => Promise<boolean>;
}

/** The browser's recognizer, prefixed or not; null where there is none. */
export function speechCtor(w: unknown = typeof window === 'undefined' ? undefined : window): RecognitionCtor | null {
  const g = w as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor } | undefined;
  return g?.SpeechRecognition ?? g?.webkitSpeechRecognition ?? null;
}

export const NO_ON_DEVICE = "on-device speech recognition isn't available in this browser";

/**
 * What the mic can do here. `none`: no recognizer at all (no button). `disabled`: a button that says why.
 * `ready`: `local` says whether the audio stays on the device.
 */
export type Support = { kind: 'none' } | { kind: 'disabled'; why: string; availability: Availability | null } | { kind: 'ready'; local: boolean; title: string };

/** Whether this browser can recognize `lang` on the device, without ever throwing. */
export async function onDevice(ctor: RecognitionCtor, lang: string): Promise<Availability | null> {
  // WHY: without both the static check and the per-recognizer option, nothing proves the audio stays local.
  if (typeof ctor.available !== 'function' || !('processLocally' in ctor.prototype)) return null;
  try {
    return await ctor.available({ langs: [lang], processLocally: true });
  } catch {
    return 'unavailable';
  }
}

export async function checkSupport(ctor: RecognitionCtor | null, o: { lang: string; allowCloud: boolean }): Promise<Support> {
  if (!ctor) return { kind: 'none' };
  const availability = await onDevice(ctor, o.lang);
  if (availability === 'available') return { kind: 'ready', local: true, title: 'Dictate (on-device: the audio stays on this computer)' };
  if (o.allowCloud) return { kind: 'ready', local: false, title: "Dictate (the browser's cloud speech service: in Chrome, the audio goes to Google)" };
  if (availability === 'downloadable' || availability === 'downloading')
    return { kind: 'disabled', availability, why: `on-device speech recognition for ${o.lang} isn't downloaded yet: download it in Settings, Voice dictation` };
  return { kind: 'disabled', availability, why: NO_ON_DEVICE };
}

/**
 * Put dictated text where the caret is (replacing a selection), with a space between it and a word before it.
 * Returns the new text and where the caret goes: just after what was put in.
 */
export function insertAt(text: string, start: number, end: number, chunk: string): { text: string; caret: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const words = chunk.trim();
  if (!words) return { text, caret: e };
  const before = text.slice(0, s);
  const after = text.slice(e);
  const piece = (before && !/\s$/.test(before) ? ' ' : '') + words + (after && !/^\s/.test(after) ? ' ' : '');
  return { text: before + piece + after, caret: before.length + piece.length };
}

/** The parts of a text box (a textarea) dictation writes to. */
export interface TextBox {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
}

/**
 * A final transcript into the box at its caret, for review. `setText` is the box's own state (React's); this
 * has nothing that sends.
 */
export function intoBox(box: () => TextBox | null, setText: (t: string) => void) {
  return (words: string) => {
    const el = box();
    if (!el) return;
    const next = insertAt(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, words);
    // WHY: straight into the box as well, so a second final in the same event builds on the first
    // (React's state isn't there yet), and the caret sits just after the dictated words.
    el.value = next.text;
    el.setSelectionRange(next.caret, next.caret);
    setText(next.text);
  };
}

export interface DictationHooks {
  /** A final piece of transcript, for the text box (never sent from here). */
  onFinal: (text: string) => void;
  /** What is heard so far but not final yet; '' when there is none. */
  onInterim: (text: string) => void;
  onListening: (listening: boolean) => void;
  onError: (why: string) => void;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'the microphone is blocked for this page',
  'service-not-allowed': "the browser won't run speech recognition here",
  'audio-capture': 'no microphone found',
  'language-not-supported': "this language isn't supported",
  network: "the browser couldn't reach its speech service",
};

/**
 * One dictation at a time. It only hands text to its hooks: it has no way to send anything, and there is
 * no voice command. stop() keeps what was said (the browser's last final result still lands in the box);
 * abort() drops it, for the panel closing or losing focus, so nothing lands or listens after.
 */
export class Dictation {
  private rec: Recognition | null = null;
  constructor(
    private readonly ctor: RecognitionCtor,
    private readonly o: { lang: string; local: boolean },
    private readonly hooks: DictationHooks,
  ) {}

  get listening() {
    return this.rec !== null;
  }

  start() {
    if (this.rec) return;
    const rec = new this.ctor();
    if (this.o.local) {
      // INVARIANT: on-device only means the option is set on this recognizer, or it doesn't start.
      if (!('processLocally' in rec)) {
        this.hooks.onError(NO_ON_DEVICE);
        return;
      }
      rec.processLocally = true;
    }
    rec.lang = this.o.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      if (this.rec !== rec) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) this.hooks.onFinal(r[0].transcript);
        else interim += r[0].transcript;
      }
      this.hooks.onInterim(interim.trim());
    };
    rec.onerror = (e) => {
      if (this.rec !== rec) return;
      // WHY: 'aborted' and 'no-speech' are the person stopping or saying nothing, not a fault.
      if (e.error !== 'aborted' && e.error !== 'no-speech') this.hooks.onError(ERRORS[e.error] ?? `speech recognition stopped: ${e.error}`);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.done();
    };
    this.rec = rec;
    this.hooks.onListening(true);
    try {
      rec.start();
    } catch (e) {
      this.done();
      this.hooks.onError(`speech recognition didn't start: ${(e as Error).message}`);
    }
  }

  /** The person stopped: what the browser still has lands, then it ends. */
  stop() {
    this.rec?.stop();
  }

  /** Stop at once and drop anything still coming. */
  abort() {
    const rec = this.rec;
    if (!rec) return;
    this.done();
    rec.abort();
  }

  private done() {
    const rec = this.rec;
    this.rec = null;
    if (rec) rec.onresult = rec.onerror = rec.onend = null;
    this.hooks.onInterim('');
    this.hooks.onListening(false);
  }
}
