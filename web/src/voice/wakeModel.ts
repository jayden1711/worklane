// INVARIANT: the bundled wake-word engine. It hears the microphone's stream in the page and nowhere else: it has no
// fetch, XMLHttpRequest, WebSocket, EventSource or sendBeacon, before, during or after a hit. Its model and the code
// that runs it (wakeRuntime.ts) are loaded with import() only when an owner has turned the wake word on and the
// listener starts it, from the dashboard's own files; the normal page bundle carries only this small module.
//
// The model: a Hey Buddy-style classifier (Apache-2.0) over Google's speech_embedding features (Apache-2.0), trained
// on CC BY 4.0 / CC0 data and Apache-2.0 synthetic voices (THIRD_PARTY_NOTICES.md, docs/wake-word.md). It knows one
// phrase: the one it was trained for, written in the model file. If the product is renamed, start() refuses and
// says so until the model is retrained (docs/wake-word.md).

import type { MicStream, WakeEngine, WakeSession } from './wake';

/** Feeds 16 kHz mono samples from the stream to `onSamples` until the returned stop() is called. */
export type AudioIn = (stream: MicStream, onSamples: (s: Float32Array) => void) => Promise<() => void>;

export const WAKE_MODEL_LABEL = 'hey-wake v1, trained with Hey Buddy (Apache-2.0 model; features: Google speech_embedding, Apache-2.0)';

/** The engine, with the audio input replaceable (a test stands in for WebAudio). */
export function modelWakeEngine(o: { audioIn?: AudioIn } = {}): WakeEngine {
  return {
    id: 'hey-wake-v1',
    label: WAKE_MODEL_LABEL,
    async start({ stream, phrase, onHit, onError }): Promise<WakeSession> {
      const rt = await import('./wakeRuntime');
      const det = await rt.loadDetector();
      if (det.phrase.trim().toLowerCase() !== phrase.trim().toLowerCase()) throw new Error(`the installed model was trained for “${det.phrase}”, not “${phrase}”: retrain it (docs/wake-word.md)`);
      let stopped = false;
      let fired = false;
      const stopAudio = await (o.audioIn ?? rt.webAudioIn)(stream, (s) => {
        if (stopped || fired) return;
        try {
          // INVARIANT: one onHit per detection: after a hit this session hears nothing more (the listener closes it).
          if (det.push(s)) {
            fired = true;
            onHit();
          }
        } catch (e) {
          stopped = true;
          onError(`the wake-word model failed: ${(e as Error).message}`);
        }
      });
      return {
        stop() {
          stopped = true;
          stopAudio();
          det.reset();
        },
      };
    },
  };
}
