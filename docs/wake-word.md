# The wake word

The dashboard can listen for "hey" plus the product's name (taken from `src/brand.ts`, as the server serves it) and,
on hearing it, stop any read-aloud answer and start dictating into the Ask box. Dictation then works exactly like the
mic button: on-device by default, into the box for review, never sent.

## What ships, and why no model does

The feature ships with a detector interface and **no wake-word model**. Until a model is installed, Settings, Voice
dictation says "No wake-word model installed" and the microphone is never opened for it.

We checked these options (2026-10-14) before deciding:

| Option | Licence, read at its source | Why not |
|---|---|---|
| openWakeWord's pretrained models | Code Apache-2.0, but "All of the included pre-trained models are licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International license" ([README](https://github.com/dscripka/openWakeWord#license)) | Non-commercial: not allowed here |
| openWakeWord's training recipe as published ([automatic_model_training.ipynb](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb)) | Its negative-data features are `cc-by-nc-sa-4.0` ([dataset card](https://huggingface.co/datasets/davidscripka/openwakeword_features)); its music is FMA, whose tracks are under "the license chosen by the artist" ([FMA](https://github.com/mdeff/fma)); its noise is AudioSet clips "drawn from YouTube videos" ([AudioSet](https://research.google.com/audioset/dataset/index.html)) | The recipe as published pulls in NC and unknown-licence data; a clean run needs a different data set (below) |
| Porcupine (Picovoice) | Needs an AccessKey from Picovoice Console for every use ([README](https://github.com/Picovoice/porcupine)); custom keywords are trained in their console | Proprietary, account-bound; ruled out |
| Vosk with a keyword grammar | Apache-2.0, `vosk-model-small-en-us-0.15` is 40 MB ([models](https://alphacephei.com/vosk/models)) | Licence fine, but a 40 MB general recognizer is far over a "small model" for the repo and the page |

## The detector interface

`web/src/voice/wake.ts`:

```ts
interface WakeEngine {
  id: string;
  label: string; // shown in Settings: the model's name and its licence
  start(o: { stream: MicStream; phrase: string; onHit: () => void; onError: (why: string) => void }): Promise<WakeSession>;
}
registerWakeEngine(engine);
```

The listener (`WakeListener`) owns the microphone: it opens it only while an owner turned the wake word on, the tab
is visible, the permission isn't denied or revoked, and dictation isn't running; it hands the stream to the engine and
closes it (stopping every track) the moment any of that changes, or on a hit. An engine:

- runs in the page (WebAudio, and WASM if it needs it), on 16 kHz mono frames from the stream;
- loads its model from the dashboard's own files (`web/public/`), never from another host;
- never calls `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`, before or after a hit: no audio,
  features or scores leave the page;
- calls `onHit` once per detection, and stops everything it started in `stop()`.

Register it from a module `web/src/main.tsx` imports, and add a test in `test/web-render.test.ts` that runs it on
recorded positive and negative clips with the network stubbed (the existing `noNetwork` helper).

## Training a "hey <product name>" model with permissive data

openWakeWord's training code is Apache-2.0, so its pipeline can be used with a different, permissive data set. Every
input below has to be checked at its source before use, and the result recorded in `THIRD_PARTY_NOTICES.md` with the
model:

1. **Positive clips (the phrase).** Synthetic speech from a TTS voice whose licence allows commercial use of its
   output, plus real recordings of the phrase by people who agreed to it. The openWakeWord notebook uses Piper's
   `en_US-libritts_r-medium` generator: the generator code is MIT
   ([piper-sample-generator](https://github.com/rhasspy/piper-sample-generator)) and LibriTTS-R is CC BY 4.0
   ([OpenSLR 141](https://www.openslr.org/141/)), but we could not read a licence for the trained voice checkpoint
   itself; confirm it with its publisher before using it.
2. **Negative speech.** LibriSpeech, CC BY 4.0 ([OpenSLR 12](https://www.openslr.org/12/)): compute openWakeWord's
   features from it yourself instead of downloading the precomputed (NC) ones.
3. **Noise and music.** MUSAN, CC BY 4.0 ([OpenSLR 17](https://www.openslr.org/17/)), instead of AudioSet and FMA.
4. **Room impulse responses.** Use a set whose licence you read at its source.
5. **Feature models.** openWakeWord's README says its shared embedding model is Google's speech embedding, Apache-2.0
   on TF Hub; check that at the source too.

Keep the exported model files small (measure them before committing; a general speech recognizer is too big) and run
them in the browser with an MIT or Apache-licensed runtime.

**Never** use a model, voice or data set that is non-commercial (NC), ShareAlike-NC, GPL/AGPL/SSPL/BUSL, Commons
Clause, needs an access key, or has no licence you could read.
