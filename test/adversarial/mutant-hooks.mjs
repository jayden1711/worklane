// The in-memory mutant for test/adversarial/run-mutants.mjs: a module load hook that rewrites one listed module's
// source as it loads, in the suite's process and in every node process it starts (NODE_OPTIONS). No file on disk
// changes. An anchor not found exactly once fails the load, so a stale mutant can't pass as killed.
import { readFileSync } from 'node:fs';

let edits = [];
let id = '';

export async function initialize(data) {
  id = data.id;
  const list = JSON.parse(readFileSync(new URL('./mutants.json', import.meta.url), 'utf8'));
  const m = list.mutants.find((x) => x.id === id);
  if (!m) throw new Error(`no mutant ${id} in test/adversarial/mutants.json`);
  edits = m.edits;
}

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  const mine = edits.filter((e) => url.endsWith(`/${e.file}`));
  if (!mine.length) return r;
  let src = typeof r.source === 'string' ? r.source : Buffer.from(r.source).toString('utf8');
  for (const e of mine) {
    const n = src.split(e.from).length - 1;
    if (n !== 1) throw new Error(`mutant ${id}: anchor found ${n} times in ${e.file}: ${e.from}`);
    src = src.replace(e.from, () => e.to);
    process.stderr.write(`MUTANT-APPLIED ${id} ${e.file}\n`);
  }
  return { ...r, source: src, shortCircuit: true };
}
