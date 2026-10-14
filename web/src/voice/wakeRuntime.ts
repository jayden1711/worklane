// The wake-word detector, loaded lazily by wakeModel.ts: the model (from the dashboard's own files, through the
// module loader; see web/wake-model-plugin.mjs), the interpreter that runs it, and the WebAudio input.
// INVARIANT: no fetch, XHR, WebSocket, EventSource or sendBeacon here; samples go in, a yes/no comes out.

import { classifier, embedding } from 'virtual:wake-model';
import { parseOnnx, run, type OnnxGraph } from './onnx';
import type { AudioIn } from './wakeModel';

/** Google speech_embedding: one 96-d vector per 775 ms window, a new one every 80 ms. */
export const WINDOW = 12400;
export const HOP = 1280;
export const RATE = 16000;

export interface Detector {
  phrase: string;
  threshold: number;
  /** Add samples; true when the phrase was just heard. */
  push(s: Float32Array): boolean;
  /** The last score (0..1), for tests. */
  score: number;
  reset(): void;
}

function decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

let graphs: { emb: OnnxGraph; cls: OnnxGraph } | null = null;

export async function loadDetector(): Promise<Detector> {
  graphs ??= { emb: parseOnnx(decode(embedding)), cls: parseOnnx(decode(classifier)) };
  return detector(graphs.emb, graphs.cls);
}

export function detector(emb: OnnxGraph, cls: OnnxGraph): Detector {
  const phrase = cls.meta.get('phrase') ?? '';
  const threshold = Number(cls.meta.get('threshold') ?? 'NaN');
  const frames = Number(cls.meta.get('frames') ?? '16');
  if (!phrase || !(threshold > 0 && threshold < 1)) throw new Error('the wake-word model has no phrase or threshold');
  // The newest WINDOW samples (filled from the end), the samples of the hop being collected, and the last
  // `frames` embeddings. Windows step by HOP from the first sample, as in training.
  const win = new Float32Array(WINDOW);
  const hop = new Float32Array(HOP);
  let filled = 0;
  let inHop = 0;
  let embs: Float32Array[] = [];
  const d: Detector = {
    phrase,
    threshold,
    score: 0,
    push(s) {
      let hit = false;
      for (let i = 0; i < s.length; ) {
        const n = Math.min(HOP - inHop, s.length - i);
        hop.set(s.subarray(i, i + n), inHop);
        inHop += n;
        i += n;
        if (inHop < HOP) break;
        inHop = 0;
        win.copyWithin(0, HOP);
        win.set(hop, WINDOW - HOP);
        filled = Math.min(WINDOW, filled + HOP);
        if (filled < WINDOW) continue;
        const e = run(emb, { audio: { dims: [1, WINDOW], data: win } })[0]!;
        embs.push(e.data);
        if (embs.length > frames) embs.shift();
        if (embs.length < frames) continue;
        const x = new Float32Array(frames * e.data.length);
        embs.forEach((v, j) => x.set(v, j * v.length));
        d.score = run(cls, { embeddings: { dims: [1, frames, e.data.length], data: x } })[0]!.data[0]!;
        if (d.score >= threshold) {
          hit = true;
          embs = [];
        }
      }
      return hit;
    },
    reset() {
      win.fill(0);
      filled = 0;
      inHop = 0;
      embs = [];
    },
  };
  return d;
}

/** The microphone's stream into 16 kHz mono samples, with WebAudio. stop() disconnects and closes everything. */
export const webAudioIn: AudioIn = async (stream, onSamples) => {
  const Ctx = (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
  const ctx = new Ctx({ sampleRate: RATE });
  const src = ctx.createMediaStreamSource(stream as unknown as MediaStream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const ratio = ctx.sampleRate / RATE;
  proc.onaudioprocess = (ev) => {
    const x = ev.inputBuffer.getChannelData(0);
    if (ratio === 1) return onSamples(new Float32Array(x));
    // A browser that won't run at 16 kHz: linear resampling is enough for these features.
    const n = Math.floor(x.length / ratio);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const j = Math.floor(p);
      y[i] = x[j]! + (x[Math.min(j + 1, x.length - 1)]! - x[j]!) * (p - j);
    }
    onSamples(y);
  };
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  return () => {
    proc.onaudioprocess = null;
    src.disconnect();
    proc.disconnect();
    mute.disconnect();
    void ctx.close();
  };
};
