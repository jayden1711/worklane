// INVARIANT: the wake word ("hey <brand>") is spotted in the page, on this computer, by a WakeEngine handed the
// microphone's stream; no audio and nothing computed from it (features, scores, transcripts) leaves the page, and
// this module has no way to send anything. After a hit, dictation (speech.ts) keeps its own on-device default.
//
// INVARIANT: no engine ships. A wake-word model must be one whose licence was checked at its source (see
// docs/wake-word.md: no non-commercial, ShareAlike-NC, GPL or access-key models); until one is registered with
// registerWakeEngine the feature says "no wake-word model installed" and never opens the microphone.
//
// INVARIANT: the microphone is open for the wake word only while all of these hold: an owner turned it on in
// Settings (off by default), the tab is visible, the microphone permission isn't denied or revoked, a model is
// installed, and dictation isn't running. Whenever it is open, `micOpen` is true, from the moment it is asked
// for until its tracks are stopped, so the indicator (WakeIndicator.tsx) can't lag behind it.

/** One running detection: stop() ends it (the listener stops the microphone's tracks itself). */
export interface WakeSession {
  stop(): void;
}

/** A track of the microphone's stream, as far as the listener uses it. */
export interface MicTrack {
  stop(): void;
  addEventListener?(type: 'ended', cb: () => void): void;
}
export interface MicStream {
  getTracks(): MicTrack[];
}

/**
 * A wake-word detector that runs in the page: WebAudio and/or WASM with a small model loaded from this dashboard's
 * own files. It gets the stream; it must not fetch, post or open a socket, and calls onHit when it hears `phrase`.
 */
export interface WakeEngine {
  id: string;
  /** What Settings shows, e.g. the model's name and its licence. */
  label: string;
  start(o: { stream: MicStream; phrase: string; onHit: () => void; onError: (why: string) => void }): Promise<WakeSession>;
}

const engines: WakeEngine[] = [];

/** Install a detector (a model whose licence was checked; see docs/wake-word.md). None is bundled. */
export function registerWakeEngine(e: WakeEngine) {
  if (!engines.some((x) => x.id === e.id)) engines.push(e);
  return () => {
    const i = engines.indexOf(e);
    if (i >= 0) engines.splice(i, 1);
  };
}

/** The installed detector, or null: none ships. */
export const wakeEngine = (): WakeEngine | null => engines[0] ?? null;

export const NO_WAKE_MODEL = 'no wake-word model installed';

/** The phrase, from the product name the server serves (BRAND, src/brand.ts): never written here. */
export const wakePhrase = (brand: string) => `hey ${brand}`;

/** Whether this person gets the wake word: an owner who turned both the mic and the wake word on. */
export const mayWake = (role: string | null | undefined, prefs: { dictation: boolean; wakeWord: boolean }) => role === 'owner' && prefs.dictation && prefs.wakeWord;

// Talk-back (speechSynthesis) stops the moment the owner starts talking. The talk-back module registers its own
// stop here; the browser's speech queue is cancelled either way.
const stoppers = new Set<() => void>();

/** For the talk-back module: called whenever the owner starts talking (the wake word). */
export function onInterruptSpeech(fn: () => void) {
  stoppers.add(fn);
  return () => void stoppers.delete(fn);
}

/** Stop any talk-back now. */
export function interruptSpeech(synth: { cancel(): void } | null | undefined = typeof window === 'undefined' ? undefined : window.speechSynthesis) {
  try {
    synth?.cancel();
  } catch {
    // WHY: a browser without speech synthesis has nothing to stop.
  }
  for (const fn of [...stoppers]) {
    try {
      fn();
    } catch {
      // WHY: one broken stopper doesn't keep the others (or the dictation) from running.
    }
  }
}

// The hand-off between the listener (App) and the Ask panel's dictation (ChatPanel), in this tab only.
const wakeHandlers = new Set<() => void>();
const dictatingHandlers = new Set<(on: boolean) => void>();

/** The Ask panel: what to do on the wake word (open, then dictate). */
export function onWake(fn: () => void) {
  wakeHandlers.add(fn);
  return () => void wakeHandlers.delete(fn);
}
/** Whether anything takes the wake word; returns false when nothing did. */
export function emitWake() {
  for (const fn of [...wakeHandlers]) fn();
  return wakeHandlers.size > 0;
}
/** The Ask panel: dictation started or ended (or, after a wake, couldn't start). */
export function setDictating(on: boolean) {
  for (const fn of [...dictatingHandlers]) fn(on);
}
export function onDictating(fn: (on: boolean) => void) {
  dictatingHandlers.add(fn);
  return () => void dictatingHandlers.delete(fn);
}

/** What `startOnWake` did: started dictation, waits for the support check, or can't (it says why elsewhere). */
export type WakeStart = 'started' | 'pending' | 'unavailable';

/**
 * After the wake word, start dictation into the Ask box: the same dictation as the mic button, so the same
 * on-device rule. It starts listening only; nothing is sent.
 */
export function startOnWake(o: { support: { kind: string } | null; listening: boolean; start: () => void }): WakeStart {
  if (o.listening) return 'started';
  if (!o.support) return 'pending';
  if (o.support.kind !== 'ready') return 'unavailable';
  o.start();
  return 'started';
}

export type PermissionState = 'granted' | 'denied' | 'prompt';
export interface PermissionLike {
  state: PermissionState;
  addEventListener(type: 'change', cb: () => void): void;
  removeEventListener(type: 'change', cb: () => void): void;
}

/** What the listener needs from the browser, so a test can stand in for every part. */
export interface WakeEnv {
  getUserMedia: (c: { audio: Record<string, boolean> }) => Promise<MicStream>;
  visible: () => boolean;
  onVisibility: (cb: () => void) => () => void;
  /** The microphone permission, or null where the browser can't say. */
  permission: () => Promise<PermissionLike | null>;
  stopSpeaking?: () => void;
}

export function browserWakeEnv(): WakeEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) as unknown as Promise<MicStream>,
    visible: () => document.visibilityState === 'visible',
    onVisibility: (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    permission: async () => {
      try {
        return (await navigator.permissions.query({ name: 'microphone' as PermissionName })) as unknown as PermissionLike;
      } catch {
        return null;
      }
    },
  };
}

/** Where the listener is. Only `starting` and `listening` have the microphone open. */
export type WakeStatus = 'off' | 'no-model' | 'hidden' | 'blocked' | 'revoked' | 'held' | 'starting' | 'listening' | 'error';

export interface WakeHooks {
  /** The wake word was heard; the microphone is already closed. */
  onWake: () => void;
  onChange: (s: { status: WakeStatus; micOpen: boolean; why: string | null }) => void;
}

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

/**
 * Opens the microphone for the wake word only while everything allows it, and closes it the moment anything
 * doesn't. One per tab (App).
 */
export class WakeListener {
  private enabled = false;
  private held = false;
  /** A wake word was heard and dictation hasn't ended yet. */
  private handedOff = false;
  /** The permission went from granted to anything else, or a track ended: closed until it's granted again. */
  private revoked = false;
  private blocked = false;
  private perm: PermissionLike | null = null;
  private permReady: Promise<void> | null = null;
  private stream: MicStream | null = null;
  private session: WakeSession | null = null;
  /** Bumped on every open and close, so a late answer from an earlier open is dropped. */
  private gen = 0;
  private why: string | null = null;
  private offVisibility: (() => void) | null = null;
  status: WakeStatus = 'off';
  micOpen = false;

  constructor(
    private readonly engine: WakeEngine | null,
    private readonly env: WakeEnv,
    private readonly phrase: string,
    private readonly hooks: WakeHooks,
  ) {}

  /** `enabled`: mayWake for this person. `held`: dictation is running (it has the microphone). */
  set(o: { enabled: boolean; held?: boolean }) {
    const was = this.enabled;
    this.enabled = o.enabled;
    if (o.held !== undefined) {
      if (this.held && !o.held) this.handedOff = false;
      this.held = o.held;
    }
    if (o.enabled && !was) {
      // WHY: turning it on again is the owner asking again: a refusal or revocation from before is retried.
      this.blocked = false;
      this.why = null;
      this.offVisibility ??= this.env.onVisibility(() => this.sync());
    }
    if (!o.enabled) {
      this.offVisibility?.();
      this.offVisibility = null;
    }
    this.sync();
  }

  /** Dictation started or ended (the Ask panel); an end, or a start that couldn't happen, resumes listening. */
  dictating(on: boolean) {
    if (!on) this.handedOff = false;
    this.held = on;
    this.sync();
  }

  dispose() {
    this.set({ enabled: false });
    this.perm?.removeEventListener('change', this.onPerm);
    this.perm = null;
  }

  private want() {
    return this.enabled && !!this.engine && this.env.visible() && !this.held && !this.handedOff && !this.revoked && !this.blocked && this.perm?.state !== 'denied';
  }

  private statusNow(): WakeStatus {
    if (!this.enabled) return 'off';
    if (!this.engine) return 'no-model';
    if (this.blocked) return this.why ? 'error' : 'blocked';
    if (this.revoked) return 'revoked';
    if (this.perm?.state === 'denied') return 'blocked';
    if (!this.env.visible()) return 'hidden';
    if (this.held || this.handedOff) return 'held';
    return this.session ? 'listening' : 'starting';
  }

  private emit() {
    const status = this.statusNow();
    this.status = status;
    this.hooks.onChange({ status, micOpen: this.micOpen, why: this.why });
  }

  private onPerm = () => {
    const s = this.perm?.state;
    if (s === 'granted') this.revoked = false;
    // INVARIANT: a permission that is no longer granted closes the microphone; it isn't asked for again.
    else if (this.micOpen || this.session) this.revoked = true;
    this.sync();
  };

  private watchPermission() {
    // WHY: asked once, only after an owner turned it on (no permission query before that either).
    this.permReady ??= this.env.permission().then((p) => {
      this.perm = p;
      p?.addEventListener('change', this.onPerm);
    });
    return this.permReady;
  }

  private sync() {
    if (!this.enabled || !this.engine) {
      this.close();
      return this.emit();
    }
    void this.watchPermission().then(() => {
      if (this.want()) void this.open();
      else this.close();
      this.emit();
    });
    // The parts that need no permission answer close at once.
    if (!this.enabled || !this.env.visible() || this.held || this.handedOff) this.close();
    this.emit();
  }

  private async open() {
    if (this.micOpen || !this.engine) return;
    const gen = ++this.gen;
    // INVARIANT: micOpen is true before the microphone is asked for, so the indicator shows from the first moment.
    this.micOpen = true;
    this.emit();
    let stream: MicStream;
    try {
      stream = await this.env.getUserMedia({ audio: MIC });
    } catch (e) {
      if (gen !== this.gen) return;
      this.micOpen = false;
      this.blocked = true;
      const name = (e as { name?: string }).name;
      this.why = name === 'NotAllowedError' ? null : `the microphone didn't open: ${(e as Error).message ?? name}`;
      return this.emit();
    }
    if (gen !== this.gen) return stopTracks(stream);
    this.stream = stream;
    for (const t of stream.getTracks())
      t.addEventListener?.('ended', () => {
        if (gen !== this.gen) return;
        // WHY: a track ends when the permission is revoked or the device goes; don't reopen on our own.
        this.revoked = true;
        this.close();
        this.emit();
      });
    let session: WakeSession;
    try {
      session = await this.engine.start({ stream, phrase: this.phrase, onHit: () => this.hit(gen), onError: (why) => this.fail(gen, why) });
    } catch (e) {
      return this.fail(gen, `the wake-word model didn't start: ${(e as Error).message}`);
    }
    if (gen !== this.gen) return session.stop();
    this.session = session;
    this.emit();
  }

  private fail(gen: number, why: string) {
    if (gen !== this.gen) return;
    this.close();
    this.blocked = true;
    this.why = why;
    this.emit();
  }

  private hit(gen: number) {
    if (gen !== this.gen || !this.micOpen) return;
    // The microphone is the dictation's now: close it first, stop any talk-back, then hand off.
    this.handedOff = true;
    this.close();
    (this.env.stopSpeaking ?? interruptSpeech)();
    this.emit();
    this.hooks.onWake();
  }

  private close() {
    if (!this.micOpen && !this.session && !this.stream) return;
    this.gen++;
    const { session, stream } = this;
    this.session = null;
    this.stream = null;
    this.micOpen = false;
    try {
      session?.stop();
    } finally {
      if (stream) stopTracks(stream);
    }
  }
}

function stopTracks(s: MicStream) {
  for (const t of s.getTracks()) t.stop();
}
