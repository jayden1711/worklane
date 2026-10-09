// A small POSIX-ish shell splitter for guardrail matching. It finds every
// simple command in a command line: across ; && || | & and newlines, inside
// $(...), backticks, ( ) subshells, `bash -c '...'`, `eval`, and behind
// wrappers like sudo/env/xargs/timeout. It is a best-effort matcher, not a
// security boundary: credentials that make the action impossible are the
// real guard (docs/design.md §12).

export interface SimpleCommand {
  /** argv with leading VAR=value assignments and wrappers removed. */
  argv: string[];
  /** VAR=value assignments that prefixed the command. */
  assignments: Record<string, string>;
  /** Files written by redirection (>, >>, &>) or tee. */
  writes: string[];
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'doas', 'builtin']);
const MAX_DEPTH = 8;

interface Token {
  text: string;
  op?: boolean;
}

/** Tokenize one level; $(...) and backtick bodies are returned for recursion. */
function tokenize(src: string, nested: string[]): Token[] {
  const out: Token[] = [];
  let cur = '';
  let has = false;
  const push = () => {
    if (has) out.push({ text: cur });
    cur = '';
    has = false;
  };
  let i = 0;
  const readUntilClose = (start: number, open: string, close: string): [string, number] => {
    let depth = 1;
    let j = start;
    let q: string | null = null;
    while (j < src.length) {
      const c = src[j]!;
      if (q) {
        if (c === '\\' && q === '"') j++;
        else if (c === q) q = null;
      } else if (c === "'" || c === '"') q = c;
      else if (c === '\\') j++;
      else if (src.startsWith(open, j)) depth++;
      else if (c === close && --depth === 0) return [src.slice(start, j), j + 1];
      j++;
    }
    return [src.slice(start), src.length];
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      cur += src[i + 1] ?? '';
      has = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      cur += src.slice(i + 1, end < 0 ? src.length : end);
      has = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          cur += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const [body, next] = readUntilClose(j + 2, '(', ')');
          nested.push(body);
          cur += `$(${body})`;
          j = next;
          continue;
        }
        if (src[j] === '`') {
          const end = src.indexOf('`', j + 1);
          const body = src.slice(j + 1, end < 0 ? src.length : end);
          nested.push(body);
          cur += '`' + body + '`';
          j = end < 0 ? src.length : end + 1;
          continue;
        }
        cur += src[j];
        j++;
      }
      has = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const [body, next] = readUntilClose(i + 2, '(', ')');
      nested.push(body);
      cur += `$(${body})`;
      has = true;
      i = next;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      const body = src.slice(i + 1, end < 0 ? src.length : end);
      nested.push(body);
      cur += '`' + body + '`';
      has = true;
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '#' && !has) {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === ' ' || c === '\t') {
      push();
      i++;
      continue;
    }
    // { and } are reserved words only as whole words: `{ a; }` groups, `{}` is a literal.
    const next = src[i + 1] ?? '';
    const groupBrace = !has && ((c === '{' && /\s/.test(next)) || (c === '}' && (next === '' || /[\s;)|&]/.test(next))));
    if (c === '\n' || c === ';' || c === '(' || c === ')' || groupBrace) {
      push();
      out.push({ text: c === '\n' ? ';' : c, op: true });
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      push();
      const two = src.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '|&') {
        out.push({ text: two, op: true });
        i += 2;
      } else if (c === '&' && src[i + 1] === '>') {
        out.push({ text: src[i + 2] === '>' ? '&>>' : '&>', op: true });
        i += src[i + 2] === '>' ? 3 : 2;
      } else {
        out.push({ text: c, op: true });
        i++;
      }
      continue;
    }
    if (c === '>' || c === '<') {
      // fd prefix like 2> stays attached to nothing: treat digits as part of op
      if (has && /^\d+$/.test(cur)) {
        cur = '';
        has = false;
      } else push();
      let op = c;
      if (src[i + 1] === c) op += c;
      else if (src[i + 1] === '&') op += '&';
      else if (src[i + 1] === '|') op += '|';
      out.push({ text: op, op: true });
      i += op.length;
      continue;
    }
    cur += c;
    has = true;
    i++;
  }
  push();
  return out;
}

const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')', '{', '}']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);

/** argv without wrappers; VAR=value given to `env` is recorded in `assignments` (it sets the command's environment). */
function stripWrappers(argv: string[], assignments: Record<string, string> = {}): string[] {
  let a = argv;
  for (let guard = 0; guard < 10 && a.length; guard++) {
    const base = basename(a[0]!);
    if (WRAPPERS.has(base)) {
      a = a.slice(1);
      // sudo/env options and env assignments
      while (a.length && (a[0]!.startsWith('-') || (base === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]!)))) {
        const opt = a[0]!;
        a = a.slice(1);
        if (base === 'env' && !opt.startsWith('-')) assignments[opt.slice(0, opt.indexOf('='))] = opt.slice(opt.indexOf('=') + 1);
        if (base === 'sudo' && ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'].includes(opt)) a = a.slice(1);
      }
      continue;
    }
    if (base === 'timeout') {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) a = a.slice(a[0] === '-s' || a[0] === '-k' ? 2 : 1);
      a = a.slice(1); // duration
      continue;
    }
    if (base === 'xargs') {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) {
        const opt = a[0]!;
        a = a.slice(1);
        if (['-I', '-n', '-P', '-L', '-s', '-d', '-E', '-a'].includes(opt)) a = a.slice(1);
      }
      continue;
    }
    if ((base === 'npx' || base === 'pnpx' || base === 'bunx') && a.length > 1) {
      a = a.slice(1);
      while (a.length && a[0]!.startsWith('-')) a = a.slice(1);
      continue;
    }
    break;
  }
  return a;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Every simple command in a shell command line, recursively. */
export function splitCommands(src: string, depth = 0): SimpleCommand[] {
  if (depth > MAX_DEPTH) return [];
  const nested: string[] = [];
  const tokens = tokenize(src, nested);
  const result: SimpleCommand[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let pendingRedirect: string | null = null;

  const flush = () => {
    const assignments: Record<string, string> = {};
    let k = 0;
    while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]!)) {
      const w = words[k]!;
      const eq = w.indexOf('=');
      assignments[w.slice(0, eq)] = w.slice(eq + 1);
      k++;
    }
    const argv = stripWrappers(words.slice(k), assignments);
    if (argv.length || Object.keys(assignments).length || writes.length) {
      const base = argv.length ? basename(argv[0]!) : '';
      if (base === 'tee') for (const f of argv.slice(1)) if (!f.startsWith('-')) writes.push(f);
      result.push({ argv, assignments, writes });
      // Re-parse the script given to a shell or eval.
      if (SHELLS.has(base)) {
        const ci = argv.findIndex((x, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(x));
        const script = ci > 0 ? argv[ci + 1] : undefined;
        if (script !== undefined) result.push(...splitCommands(script, depth + 1));
      } else if (base === 'eval' && argv.length > 1) {
        result.push(...splitCommands(argv.slice(1).join(' '), depth + 1));
      }
    }
    words = [];
    writes = [];
  };

  for (const t of tokens) {
    if (pendingRedirect !== null) {
      if (!t.op && WRITE_REDIRECTS.has(pendingRedirect) && !t.text.startsWith('/dev/')) writes.push(t.text);
      pendingRedirect = null;
      if (!t.op) continue;
    }
    if (t.op && SEPARATORS.has(t.text)) {
      flush();
      continue;
    }
    if (t.op) {
      pendingRedirect = t.text;
      continue;
    }
    words.push(t.text);
  }
  flush();
  for (const body of nested) result.push(...splitCommands(body, depth + 1));
  return result;
}
