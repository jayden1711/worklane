// Vite plugin: `virtual:wake-model` is the wake-word model files in web/public/wake/, base64, in their own chunk.
// WHY: the wake-word engine must never call fetch or XHR (web/src/voice/wake.ts), so its model reaches the page
// through the module loader (a lazy import() of this chunk, from the dashboard's own files) instead. The chunk is
// only imported when an owner turns the wake word on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WAKE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public', 'wake');
export const WAKE_FILES = { embedding: 'speech-embedding.onnx', classifier: 'wake-classifier.onnx' };

const ID = 'virtual:wake-model';

export function wakeModel() {
  return {
    name: 'wake-model',
    resolveId: (id) => (id === ID ? `\0${ID}` : null),
    load(id) {
      if (id !== `\0${ID}`) return null;
      return Object.entries(WAKE_FILES)
        .map(([k, f]) => {
          const p = join(WAKE_DIR, f);
          this.addWatchFile(p);
          return `export const ${k} = ${JSON.stringify(readFileSync(p).toString('base64'))};`;
        })
        .join('\n');
    },
  };
}
