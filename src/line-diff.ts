// A unified line diff with no imports, so any module can show one without loading anything else (it was in
// src/intake/discord-setup.ts, which pulled the intake, credentials and service modules into whoever used it).

/** A unified diff of two texts by line, three lines of context; `before` null is a file that doesn't exist yet. */
export function lineDiff(before: string | null, after: string, name: string): string {
  const lines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  const a = lines(before ?? '');
  const b = lines(after);
  // The longest common subsequence, by table (these files are a few hundred lines at most).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ op: ' ', line: a[i++]! }), j++;
    else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: '-', line: a[i++]! });
    else ops.push({ op: '+', line: b[j++]! });
  }
  const keep = new Set<number>();
  ops.forEach((o, n) => {
    if (o.op !== ' ') for (let k = Math.max(0, n - 3); k <= Math.min(ops.length - 1, n + 3); k++) keep.add(k);
  });
  const out = [before === null ? `--- (no ${name} yet)` : `--- ${name}`, `+++ ${name}`];
  let last = -1;
  for (const n of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && n > last + 1) out.push('@@');
    out.push(`${ops[n]!.op}${ops[n]!.line}`);
    last = n;
  }
  return out.join('\n');
}
