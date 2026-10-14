// INVARIANT: talk-back reads an answer aloud with the browser's own speechSynthesis, in the page only: no text
// goes to the dashboard's server for speech, and nothing here fetches a speech service. What is read is the
// answer's text with code blocks left out ("code block omitted") and anything secret-shaped left out
// (src/events/redact.ts's patterns, plus long key-like runs).
//
// INVARIANT: some browsers' voices are network voices (in Chrome, the "Google ..." ones send the text to
// Google). Only a voice the browser marks `localService` is used, unless the owner allowed network voices in
// Settings (prefs.ts, off by default); with no local voice it stays silent and says why. It never falls back
// to the browser's default voice, which may be a network one.
//
// INVARIANT: it stops the moment the owner starts talking: stopSpeaking() is what any voice input calls first
// (Dictation.start does), and Esc, the panel closing, the tab being hidden and a new question stop it too.
import { redactString } from '../../../src/events/redact';

/** The parts of a SpeechSynthesisVoice this uses. */
export interface Voice {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}
/** The parts of a SpeechSynthesisUtterance this uses. */
export interface Utterance {
  text: string;
  lang: string;
  voice: Voice | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
export type UtteranceCtor = new (text: string) => Utterance;
/** The parts of window.speechSynthesis this uses. */
export interface Synth {
  speak(u: Utterance): void;
  cancel(): void;
  getVoices(): Voice[];
  addEventListener?(type: 'voiceschanged', fn: () => void): void;
  removeEventListener?(type: 'voiceschanged', fn: () => void): void;
}

/** The browser's speech synthesis and its utterance, or null where there is none. */
export function synthOf(w: unknown = typeof window === 'undefined' ? globalThis : window): { synth: Synth; Utterance: UtteranceCtor } | null {
  const g = w as { speechSynthesis?: Synth; SpeechSynthesisUtterance?: UtteranceCtor } | undefined;
  return g?.speechSynthesis && g.SpeechSynthesisUtterance ? { synth: g.speechSynthesis, Utterance: g.SpeechSynthesisUtterance } : null;
}

export const CODE_OMITTED = 'code block omitted';
export const SECRET_OMITTED = 'secret omitted';

/**
 * What is read aloud of an answer: fenced code blocks (closed or not) become "code block omitted", secret-shaped
 * strings "secret omitted", and markdown marks go, so it reads as prose.
 */
export function spokenText(answer: string): string {
  let s = answer.replace(/(^|\n)[ \t]*(```|~~~)[^\n`]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, `$1${CODE_OMITTED}.\n`);
  // WHY: the shared redaction first (keys, tokens, private keys, credentials in URLs), each replaced whole.
  s = redactString(s).replace(/\S*\[REDACTED[^\]]*\]\S*/g, SECRET_OMITTED);
  // WHY: a long unbroken run of letters and digits together (a key, a JWT, a hash) is noise at best and a secret
  // the patterns didn't know at worst; it isn't read out.
  s = s.replace(/[A-Za-z0-9_\-+/=.]{32,}/g, (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? SECRET_OMITTED : m));
  s = s
    .replace(/`+/g, '')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*(#{1,6}|>|[-*+])[ \t]+/gm, '')
    .replace(/(\*\*|__|\*|_)(\S[^\n]*?)\1/g, '$2');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** The voice to read with: a local one for the language unless network voices are allowed; null when none fits. */
export function pickVoice(voices: readonly Voice[], lang: string, allowNetwork: boolean): Voice | null {
  const usable = voices.filter((v) => allowNetwork || v.localService === true);
  const base = lang.split('-')[0]!.toLowerCase();
  const exact = (v: Voice) => v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase();
  const same = (v: Voice) => v.lang.toLowerCase().split(/[-_]/)[0] === base;
  // WHY: among the usable ones, a local voice first even when network ones are allowed, then the browser's default.
  const rank = (v: Voice) => (exact(v) ? 0 : 2) + (v.localService ? 0 : 4) + (v.default ? 0 : 1);
  return usable.filter(same).sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export const NO_LOCAL_VOICE = 'no on-device voice for this language in this browser (network voices are off in Settings)';
export const NO_SYNTH = "this browser can't read aloud";

export type Spoken = { spoken: true } | { spoken: false; why: string | null };

/** Every talk-back that is live, so stopSpeaking() reaches them all. */
const live = new Set<TalkBack>();

/** Stop any answer being read aloud, at once. Anything that starts listening to the owner calls this first. */
export function stopSpeaking() {
  for (const t of live) t.stop();
}

/**
 * One reader for the Ask panel. It reads only while `active` (an owner who turned it on, the panel open, the tab
 * visible); setActive(false) stops it. speak() never sends anything anywhere: it hands the text to the browser.
 */
export class TalkBack {
  private active = false;
  private pending = 0;
  private gen = 0;
  private listeners = new Set<() => void>();
  constructor(
    private readonly o: { lang: string; allowNetwork: boolean; synth?: { synth: Synth; Utterance: UtteranceCtor } | null; voicesWaitMs?: number },
  ) {
    live.add(this);
  }

  get speaking() {
    return this.pending > 0;
  }

  /** Called when speaking starts or stops. */
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.stop();
  }

  /** Esc: true when it was reading (and now isn't), so the key does nothing else. */
  escape(): boolean {
    const was = this.speaking;
    this.stop();
    return was;
  }

  stop() {
    this.gen++;
    const had = this.pending > 0;
    this.pending = 0;
    // WHY: cancel even with nothing counted, so a voice still waiting in the browser's queue goes too.
    this.synth()?.synth.cancel();
    if (had) this.emit();
  }

  /** The tab hidden: stop. Returns the unlisten. */
  stopWhenHidden(doc: { visibilityState: string; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void }) {
    const on = () => doc.visibilityState === 'hidden' && this.stop();
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  }

  dispose() {
    this.setActive(false);
    live.delete(this);
    this.listeners.clear();
  }

  /** Read an answer aloud (queued after one already being read). Nothing happens unless active. */
  async speak(answer: string): Promise<Spoken> {
    if (!this.active) return { spoken: false, why: null };
    const s = this.synth();
    if (!s) return { spoken: false, why: NO_SYNTH };
    const text = spokenText(answer);
    if (!text) return { spoken: false, why: null };
    const gen = this.gen;
    const voices = await this.voices(s.synth);
    // WHY: stopped (or turned off) while the voices loaded: nothing starts after a stop.
    if (gen !== this.gen || !this.active) return { spoken: false, why: null };
    const voice = pickVoice(voices, this.o.lang, this.o.allowNetwork);
    if (!voice) return { spoken: false, why: this.o.allowNetwork ? `no voice for ${this.o.lang} in this browser` : NO_LOCAL_VOICE };
    const u = new s.Utterance(text);
    // INVARIANT: the voice is always set: left null, the browser picks its default, which may be a network voice.
    u.voice = voice;
    u.lang = voice.lang;
    const done = () => {
      if (gen !== this.gen) return;
      this.pending = Math.max(0, this.pending - 1);
      this.emit();
    };
    u.onend = done;
    u.onerror = done;
    this.pending++;
    this.emit();
    s.synth.speak(u);
    return { spoken: true };
  }

  private synth() {
    return this.o.synth === undefined ? synthOf() : this.o.synth;
  }

  /** The browser's voices; Chrome lists them only after `voiceschanged`, so wait a moment for that once. */
  private voices(synth: Synth): Promise<Voice[]> {
    const now = synth.getVoices();
    if (now.length || !synth.addEventListener) return Promise.resolve(now);
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        synth.removeEventListener?.('voiceschanged', finish);
        done(synth.getVoices());
      };
      const timer = setTimeout(finish, this.o.voicesWaitMs ?? 1500);
      synth.addEventListener!('voiceschanged', finish);
    });
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
