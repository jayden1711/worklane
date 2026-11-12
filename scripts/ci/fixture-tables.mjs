// The systemd-acceptance fixtures, read from their round tables (test/fixtures/systemd-acceptance/r1169*.json and
// bases.json; README.md there says the format). One loader for the test that runs them and for the check that
// compares them with the folders they came from (the owner, 2026-11-12).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The keys a JSON text repeats inside one object, as `<path>: <key>` (R1169ax D1): JSON.parse keeps the last of two
 * equal keys, so a case copied under its own name would silently replace the original, and no line would be removed
 * for the hold to see. Throws on text that isn't JSON.
 */
export function duplicateKeys(text) {
  const out = [];
  const stack = []; // per open container: { keys: Set | null (array), path }
  let key = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (c === '"') {
      let e = k + 1;
      while (e < text.length && text[e] !== '"') e += text[e] === '\\' ? 2 : 1;
      const str = JSON.parse(text.slice(k, e + 1));
      let n = e + 1;
      while (/\s/.test(text[n] ?? '')) n++;
      const top = stack.at(-1);
      if (text[n] === ':' && top?.keys) {
        if (top.keys.has(str)) out.push(`${top.path || '(top)'}: ${str}`);
        top.keys.add(str);
        key = str;
      }
      k = e;
    } else if (c === '{' || c === '[') {
      const top = stack.at(-1);
      const path = top ? (top.keys ? `${top.path}${top.path ? '.' : ''}${key}` : `${top.path}[]`) : '';
      stack.push({ keys: c === '{' ? new Set() : null, path });
    } else if (c === '}' || c === ']') stack.pop();
  }
  return out;
}

/**
 * Every case, by name: { exit, reason, listed?, files } where files maps each folder-relative path (`x.test.ts.txt`,
 * `src/flags.ts.root`) to its exact text. Throws on a name in two tables or twice in one (any repeated key), a
 * missing base or a malformed entry.
 */
export function loadCases(dir) {
  const read = (f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const dup = duplicateKeys(text);
    if (dup.length) throw new Error(`${f}: a key repeated in one object (JSON keeps only the last): ${dup.join(', ')}`);
    return JSON.parse(text);
  };
  const bases = read('bases.json').bases;
  const cases = new Map();
  for (const t of readdirSync(dir).filter((f) => /^r1169[a-z]+\.json$/.test(f)).sort()) {
    for (const [name, c] of Object.entries(read(t).cases)) {
      if (cases.has(name)) throw new Error(`${t}: case ${name} is in another table too`);
      if (typeof c.exit !== 'number' || typeof c.reason !== 'string' || !c.files || (c.listed !== undefined && typeof c.listed !== 'string')) throw new Error(`${t}: case ${name} is malformed`);
      const files = new Map();
      for (const [p, v] of Object.entries(c.files)) {
        const lines = typeof v === 'string' ? bases[v.replace(/^@/, '')] : v;
        if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) throw new Error(`${t}: ${name}/${p} is neither lines nor a known base`);
        files.set(p, lines.join('\n'));
      }
      cases.set(name, { exit: c.exit, reason: c.reason, listed: c.listed, files });
    }
  }
  return cases;
}
