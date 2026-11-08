// The acceptance tests that need a booted systemd and passwordless sudo: each test under test/ whose options say
// `skip: !systemCi`. In the self-hosted tests runner's container they skip (no systemd as process 1, #1165), so
// ci.yml's `systemd-acceptance` job runs them on GitHub's VM on each push to main. This finds them by that gate,
// runs exactly them, and fails unless every one ran and passed: a skip here is a failure, so none of them can
// quietly run nowhere. Nothing is listed by hand, so a new test with that gate is run here too, in any directory
// under test/ (npm test runs dist/test/**/*.test.js). The gate has one spelling: any other mention of systemCi in a
// test file (`! systemCi`, `!(systemCi)`, a ternary, a check inside a test), a flag or function shaped like it or
// reading systemd's sign under another name, or any of that in src/ or a test helper, stops the job.
//
// Results come from node's own test events (systemd-acceptance-reporter.mjs, R1169f), never from TAP text a test
// could print: each gate is matched by its built file, the line and column its test() call is on, and its name, and
// the events arrive on a pipe (fd 3) no test process holds.
//
//   node scripts/ci/systemd-acceptance.mjs      (after the build: it runs dist/test/<file>.js)
//
// Exit 1: a test failed, skipped, didn't run, ran more than once or has a subtest that didn't pass, or a test here
// skipped naming systemd. Exit 2: no such test was found, a file couldn't be read, or a gate isn't one it reads.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
/** The suite's isolation preload, as every runner of it passes it (test/isolate.ts). */
const PRELOAD = ['--import', './dist/test/isolate.js'];
/** The reporter that writes node's own results as JSON lines (systemd-acceptance-reporter.mjs). */
const REPORTER = fileURLToPath(new URL('./systemd-acceptance-reporter.mjs', import.meta.url));

/** A JS string literal's body, unescaped (\\, \', \", \` and \n; the names here use no other escape). */
const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));

/**
 * Each `test(<name>, { skip: !systemCi ...` in `text`, as its name. The gate must be the options' first key, as every
 * such test writes it; `gateCount` counts every `skip: !systemCi` so a caller can see none was missed.
 */
export function systemdTests(text) {
  return gatesOf(text).map((g) => g.name);
}

/** The gate regex: `test(<name>, { skip: !systemCi`, `test` with a member's `.` before it (`t.test(`) or not. */
const GATE = /(?<![\w$])test\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\{\s*skip:\s*!systemCi\b/g;

/**
 * Each gate in `text`: its name, the line its `test(` is on (1-based, as node reports a test's location), and whether
 * it is a subtest's (`t.test(`), which the job refuses (R1169e): the run selects top-level tests by name.
 */
export function gatesOf(text) {
  return [...text.matchAll(GATE)].map((m) => {
    const before = text.slice(0, m.index);
    const lineStart = before.slice(before.lastIndexOf('\n') + 1);
    return {
      name: unescape(m[2]),
      line: before.split('\n').length,
      // Where node reports the test: the `test` token's column, 1-based (R1169h: a namesake on the same line is elsewhere).
      column: lineStart.length + 1,
      // A member call (`t.test(`, `sub.test (`): a `.` right before it on its line.
      member: /\.[ \t]*$/.test(lineStart),
      // The gate must be its line's first statement (only spaces, or `await`, before it), so no other call shares it.
      first: /^[ \t]*(?:await[ \t]+)?$/.test(lineStart),
      // A template name with `${...}` isn't the text the run selects by.
      computed: m[1] === '`' && m[2].includes('${'),
    };
  });
}

/** How many times `text` gates something on systemCi the way systemdTests reads it. */
export const gateCount = (text) => (text.match(/\bskip:\s*!systemCi\b/g) ?? []).length;

/**
 * How many times `text` mentions the identifier systemCi other than to declare it (`const systemCi =`). Each must
 * be a gate systemdTests reads: a gate spelled any other way (`! systemCi`, `!(systemCi)`, `systemCi ? ... : ...`)
 * or a check of it anywhere else is a mention that isn't one, and findAll refuses the file.
 */
export const mentionCount = (text) => (text.match(/\bsystemCi\b/g) ?? []).length - (text.match(/\bconst\s+systemCi\s*=/g) ?? []).length;

/**
 * Each `skip:` option's expression in `text`: from `skip:` to the first `,` or `}` outside brackets, across lines (a
 * value on the line after `skip:`, R1169e), at most 400 characters, comments left out.
 */
export function skipExprs(text) {
  const out = [];
  for (const m of text.matchAll(/\bskip\s*:/g)) {
    let depth = 0;
    let k = m.index + m[0].length;
    const end = Math.min(text.length, k + 400);
    let quote = null;
    for (; k < end; k++) {
      const c = text[k];
      if (quote) {
        if (c === '\\') k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    out.push(text.slice(m.index + m[0].length, k).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' '));
  }
  return out;
}
const unquoted = (e) => e.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''");

/**
 * How many `skip:` options in `text` look like a systemd gate: their expression names a flag like `system…Ci`
 * (`systemdCi`, `isSystemCi`, `SYSTEM_CI`; a string's words don't count, as "needs systemd" in a test that checks for
 * systemctl itself). Each must be a gate systemdTests reads, so a flag renamed (R1169d) stops the job.
 */
export const gateLikeCount = (text) => skipExprs(text).filter((e) => /(?<![\w$])[A-Za-z_$]*system[\w$]*ci(?![\w$])/i.test(unquoted(e))).length;

/**
 * systemd's sign, however a path to it is built (R1169h, R1169j): `/run/systemd`, a `'run'` part then a `'systemd'`
 * part (`join('/run', 'systemd', 'system')`, `['', 'run', 'systemd', ...].join('/')`), `is-system-running`, `sd_booted`,
 * `/proc/1/comm` (systemd as process 1). A bare `'systemd'` string (a program name, data) isn't one.
 * Not `systemctl`: a test that checks for that program is not a booted-systemd gate.
 */
/** The longest declaration read as a detector of systemd's sign (signNames). */
const MAX_DETECTOR = 600;
const SIGN = /\/run\/systemd|(['"`])\/?run\1[^;\n]{0,40}?(['"`])systemd\2|is-system-running|sd_booted|\/proc\/1\/comm/;

/** `text` without its comments (strings kept: a path is a string), one pass. */
function withoutComments(text) {
  let out = '';
  let quote = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      out += c;
      if (c === '\\') out += text[++k] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
    } else if (c === '/' && text[k + 1] === '/') {
      while (k < text.length && text[k] !== '\n') k++;
      out += '\n';
    } else if (c === '/' && text[k + 1] === '*') {
      const end = text.indexOf('*/', k + 2);
      k = end === -1 ? text.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

/** From `k` in `code`, to the end of a statement or block: brackets and strings balanced, ending at a `;` or line end at depth 0 (or the block's closing brace). */
function scanBody(code, k, block) {
  let depth = 0;
  let quote = null;
  const start = k;
  for (; k < code.length && k - start < 20_000; k++) {
    const c = code[k];
    if (quote) {
      if (c === '\\') k++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (block && depth === 0) return code.slice(start, k + 1);
      if (depth < 0) break;
    } else if (!block && depth === 0 && (c === ';' || (c === '\n' && !/[=+\-*/%&|^?:,(<>!~]\s*$/.test(code.slice(start, k)) && !/^\s*[.?:)\]&|+\-*/,]/.test(code.slice(k + 1, k + 40))))) break;
  }
  return code.slice(start, k);
}

/** Each name `code` declares (`const`/`let`/`var`, a function, an arrow), with its whole initializer or body (scanBody). */
function declarations(code) {
  const out = [];
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]*)?=(?![=>])/g)) out.push([m[1], scanBody(code, m.index + m[0].length, false)]);
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = scanBody(code, m.index + m[0].length - 1, true);
    const open = code.indexOf('{', m.index + m[0].length - 1 + params.length);
    out.push([m[1], params + (open === -1 ? '' : scanBody(code, open, true))]);
  }
  return out;
}

/**
 * The names that stand for systemd's sign, per file (R1169j): in a file, a declaration whose initializer or body
 * reads the sign, or reads a name that stands for it there (a constant holding the path, a function returning the
 * check). Across files only through an import: a name a file exports that stands for it stands for it in a file
 * that imports that name (a helper's `export const canRun = existsSync('/run/systemd/system')`). Comments don't
 * count; strings do (a path is one). `texts`: path to text, every file of every build root.
 */
export function signNames(texts) {
  const files = [...texts].map(([p, t]) => {
    const code = withoutComments(t);
    const imported = new Set([...code.matchAll(/^\s*import\b[\s\S]*?\bfrom\b|\brequire\s*\(/gm)].length ? (code.match(/^\s*import\s*(?:type\s+)?\{[^}]*\}|^\s*import\s+[A-Za-z_$][\w$]*|\bconst\s*\{[^}]*\}\s*=\s*require\s*\(|\b(?:import|export)\s*\{[^}]*\}\s*from/gm) ?? []).flatMap((x) => x.match(/[A-Za-z_$][\w$]*/g) ?? []) : []);
    return { p, code, decls: declarations(code), imported, tainted: new Set() };
  });
  // A detector is short and near the sign: a declaration of at most MAX_DETECTOR characters that reads it (hop 0), or
  // reads a hop-0 name of its file or one it imports (hop 1). Further hops, or a long declaration (data, a fixture, a
  // helper that only mentions one), aren't followed: a long chain is not an accidental rename.
  const exportedBy = (f, name) => new RegExp(`\\bexport\\s+(?:const|let|var|function\\*?|async\\s+function)\\s+${name.replace(/\$/g, '\\$')}(?![\\w$])|\\bexport\\s*\\{[^}]*(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])|\\bexports\\.${name.replace(/\$/g, '\\$')}\\s*=`).test(f.code);
  const short = (body) => body.length <= MAX_DETECTOR;
  for (const f of files) for (const [name, body] of f.decls) if (short(body) && SIGN.test(body)) f.tainted.add(name);
  const exported = new Set();
  for (const f of files) {
    const hop0 = [...f.tainted];
    const re = hop0.length ? new RegExp(`(?<![\\w$])(?:${hop0.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`) : null;
    if (re) for (const [name, body] of f.decls) if (short(body) && re.test(body)) f.tainted.add(name);
    for (const n of f.tainted) if (exportedBy(f, n)) exported.add(n);
  }
  for (const f of files) {
    const fromImports = [...f.imported].filter((n) => exported.has(n));
    for (const n of fromImports) f.tainted.add(n);
    const re = fromImports.length ? new RegExp(`(?<![\\w$])(?:${fromImports.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`) : null;
    if (re) for (const [name, body] of f.decls) if (short(body) && re.test(body)) f.tainted.add(name);
  }
  return new Map(files.map((f) => [f.p, new Set([...f.tainted].filter((n) => n !== 'systemCi'))]));
}

/**
 * The names in `text`'s `skip:` options that stand for systemd's sign (`signs`, signNames over every build root, or
 * this file alone): each must be systemCi, so a check one step away (a constant, a helper, a function) stops the job.
 */
export const detectorNames = (text, signs = signNames([['', text]]).get('')) => {
  const used = new Set(skipExprs(withoutComments(text)).flatMap((e) => unquoted(e).match(/[A-Za-z_$][\w$]*/g) ?? []));
  return [...signs].filter((n) => used.has(n));
};

/** How many `skip:` options read systemd's sign inline (`skip: !existsSync('/run/systemd/system')`): each must be a read gate. */
export const inlineSignCount = (text) => skipExprs(text).filter((e) => SIGN.test(e)).length;

/** Code that can register a test under a location it makes up (R1169h: `vm.runInThisContext` with a filename). */
const FORGES = /\bfrom\s+['"](?:node:)?vm['"]|\brequire\s*\(\s*['"](?:node:)?vm['"]\s*\)|\bnew\s+Function\b|(?<![\w$.])eval\s*\(/;

/**
 * Every gated test under `dir` (test/), at any depth, by its path from `dir` ('/'-separated). Throws when a mention
 * of systemCi isn't a gate in a test() call this can read, when a skip that looks like a systemd gate isn't one, when
 * a flag read from systemd's sign isn't named systemCi, or when any of that is in a file under test/ that isn't a
 * `*.test.ts` (a helper module that registers tests, R1169d): the run is by file, so a gated test must be in one.
 */
export function findAll(dir, prefix = 'test/', signs = null) {
  const found = [];
  const files = readdirSync(dir, { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).sort();
  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const names = systemdTests(text);
    const mentions = mentionCount(text);
    const like = gateLikeCount(text);
    const odd = detectorNames(text, signs?.get(`${prefix}${f}`) ?? undefined).filter((n) => n !== 'systemCi');
    const inline = inlineSignCount(text);
    if (!f.endsWith('.test.ts')) {
      if (names.length || mentions || like || odd.length || inline) throw new Error(`${prefix}${f}: a systemd gate outside a *.test.ts file (a helper that registers tests): write the gated test in the test file itself, as \`test(<name>, { skip: !systemCi ...\``);
      continue;
    }
    if (names.length !== mentions) throw new Error(`${prefix}${f}: ${mentions} use(s) of systemCi, ${names.length} a gate in a test() call this reads (write it as \`test(<name>, { skip: !systemCi ...\`)`);
    if (like !== names.length) throw new Error(`${prefix}${f}: ${like} skip(s) that look like a systemd gate, ${names.length} a gate this reads (the flag must be named systemCi: \`test(<name>, { skip: !systemCi ...\`)`);
    if (odd.length) throw new Error(`${prefix}${f}: ${odd.join(', ')} read(s) systemd's sign under another name than systemCi`);
    if (inline) throw new Error(`${prefix}${f}: ${inline} skip(s) that read systemd's sign inline: gate the test on systemCi, as \`test(<name>, { skip: !systemCi ...\``);
    const member = gatesOf(text).filter((g) => g.member);
    if (member.length) throw new Error(`${prefix}${f}: a gate on a subtest (\`t.test(\`: ${JSON.stringify(member[0].name)}); gate a top-level test(), which the run selects by name`);
    const gates = gatesOf(text);
    const notFirst = gates.find((g) => !g.first && !g.member);
    if (notFirst) throw new Error(`${prefix}${f}: the gate ${JSON.stringify(notFirst.name)} isn't its line's first statement (line ${notFirst.line}): put it on a line of its own, so no other call shares its place`);
    const computed = gates.find((g) => g.computed);
    if (computed) throw new Error(`${prefix}${f}: the gate ${JSON.stringify(computed.name)} has a computed (template) name: name it with a literal`);
    if (gates.length && FORGES.test(text)) throw new Error(`${prefix}${f}: a gated file that uses node:vm, new Function or eval, which can register a test under a place it makes up`);
    if (names.length) found.push({ file: f, names });
  }
  return found;
}

/**
 * What's wrong with each gate in `runs`, one entry per file: { file, gates: [{ name, line }], events }, where `events`
 * are node's own results from running that file alone (systemd-acceptance-reporter.mjs: { type, name, nesting, file,
 * line, column, skip, todo }, in the order they finished). A gate's result is the event of its file
 * (`dist/test/<file>.js`), its line, its column (the `test` token's, R1169h) and its name, so a namesake elsewhere, a gate registered only sometimes (under an env var), or a line a
 * test prints can't stand in for it (R1169e, R1169f). Each problem is a gate with no result, more than one, a failure,
 * a skip or a todo, or a subtest (the deeper events just before it) that didn't pass. And a floor: any test in the
 * run that skipped with a reason naming systemd. [] when every gate ran once and passed, all of it.
 */
export function problems(runs) {
  return runs.flatMap(({ file, gates, events }) => {
    const built = `dist/test/${file.replace(/\.ts$/, '.js')}`;
    const inFile = (e) => typeof e.file === 'string' && (e.file.split(sep).join('/').endsWith(`/${built}`) || e.file === built);
    const out = [];
    const matched = new Set();
    for (const g of gates) {
      const at = `test/${file}: ${g.name}`;
      const ks = events.flatMap((e, k) => (inFile(e) && e.line === g.line && e.column === g.column && e.name === g.name ? [k] : []));
      ks.forEach((k) => matched.add(k));
      if (!ks.length) {
        out.push(`${at}: didn't run`);
        continue;
      }
      if (ks.length > 1) {
        out.push(`${at}: ran ${ks.length} times`);
        continue;
      }
      const r = events[ks[0]];
      if (r.type !== 'test:pass') out.push(`${at}: failed`);
      else if (r.skip !== null && r.skip !== false) out.push(`${at}: SKIP${typeof r.skip === 'string' ? ` ${r.skip}` : ''} (it must run here: this is the one place it does)`);
      else if (r.todo !== null && r.todo !== false) out.push(`${at}: TODO${typeof r.todo === 'string' ? ` ${r.todo}` : ''} (it must run here: this is the one place it does)`);
      else {
        // Its subtests: the events just before it, deeper than it, until one at its depth or shallower.
        for (let k = ks[0] - 1; k >= 0 && events[k].nesting > r.nesting; k--) {
          matched.add(k);
          const c = events[k];
          const bad = c.type !== 'test:pass' ? 'failed' : c.skip !== null && c.skip !== false ? `SKIP${typeof c.skip === 'string' ? ` ${c.skip}` : ''}` : c.todo !== null && c.todo !== false ? `TODO${typeof c.todo === 'string' ? ` ${c.todo}` : ''}` : null;
          if (bad) {
            out.push(`${at}: its subtest "${c.name}" ${bad} (all of it must run here)`);
            break;
          }
        }
      }
    }
    // The floor: any other test in this file's run (the run selects only gate names, so that is a gate's namesake or a
    // subtest) skipped with a reason naming systemd. It doesn't see a test the name filter left out: the static rules
    // above are what find a gate spelled another way (R1169j).
    events.forEach((e, k) => {
      if (!matched.has(k) && typeof e.skip === 'string' && /systemd/i.test(e.skip)) out.push(`test/${file}: ${e.name}: SKIP ${e.skip} (a test skipped for systemd here, where systemd is)`);
    });
    return out;
  });
}

/**
 * What node's TAP summary for one file's run says against a clean run (R1169g): its `# fail`, `# cancelled`,
 * `# skipped` and `# todo` all 0, and its `# tests` at least the file's gates. A second count of the same results, from
 * the runner's own reporter (stdout), beside the events. [] when it agrees; a summary it can't find is a problem.
 */
export function summaryProblems(tap, file, gates) {
  const n = (k) => {
    const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
  const out = [];
  for (const k of ['fail', 'cancelled', 'skipped', 'todo']) {
    const v = n(k);
    if (v === null) out.push(`test/${file}: its TAP summary has no "# ${k}" line`);
    else if (v !== 0) out.push(`test/${file}: its TAP summary says ${v} ${k}`);
  }
  const tests = n('tests');
  if (tests !== null && tests < gates) out.push(`test/${file}: its TAP summary counts ${tests} test(s), fewer than its ${gates} gate(s)`);
  return out;
}

/** The reporter's JSON lines, read; a line that isn't one is a problem (fail closed). */
export function eventsOf(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** The folders the build compiles: tsconfig.json's include, each glob's part before its first wildcard. */
export function buildRoots(dir) {
  // No tsconfig.json (a bare fixture): the roots this repo's names.
  if (!existsSync(join(dir, 'tsconfig.json'))) return ['src', 'test', 'scripts/bench'];
  const config = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  return [...new Set((config.include ?? []).map((g) => g.split('/').filter((x, k, a) => !a.slice(0, k + 1).some((y) => /[*?{[]/.test(y))).join('/')).filter(Boolean))];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let found;
  try {
    // systemd's sign, followed through every file the build compiles (R1169j): a helper's export, a constant holding
    // the path, a function returning the check.
    const roots = buildRoots(root).filter((r) => existsSync(join(root, r)));
    const texts = new Map(roots.flatMap((r) => readdirSync(join(root, r), { recursive: true }).map((x) => String(x).split(sep).join('/')).filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !x.endsWith('.d.ts')).map((x) => [`${r}/${x}`, readFileSync(join(root, r, x), 'utf8')])));
    const signs = signNames(texts);
    found = findAll(join(root, 'test'), 'test/', signs);
    // Every other root the build compiles (tsconfig.json's include, read from it so a new root is never missed:
    // src/, scripts/bench/, R1169g) holds no gate: one there, re-exported through a test helper, would run nowhere.
    for (const r of roots.filter((x) => x !== 'test')) findAll(join(root, r), `${r}/`, signs).forEach((f) => {
      throw new Error(`${r}/${f.file}: a systemd gate outside test/: write the gated test in test/`);
    });
    // The built files are what runs: each gate's line is read there, and its names must be the source's.
    for (const f of found) {
      const built = readFileSync(join(root, 'dist', 'test', f.file.replace(/\.ts$/, '.js')), 'utf8');
      f.gates = gatesOf(built).filter((g) => !g.member);
      const a = [...f.names].sort();
      const b = f.gates.map((g) => g.name).sort();
      if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`test/${f.file}: its gates ${JSON.stringify(a)} aren't the built file's ${JSON.stringify(b)} (build again)`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const names = found.flatMap((f) => f.names);
  if (!names.length) {
    console.error('no test in test/ is gated on systemCi: nothing to run');
    process.exit(2);
  }
  console.log(`${names.length} systemd acceptance test(s):\n${found.flatMap((f) => f.names.map((n) => `  test/${f.file}: ${n}`)).join('\n')}`);
  // One run per file; TAP to the log, node's own results on fd 3 (systemd-acceptance-reporter.mjs).
  const runs = [];
  const exits = [];
  {
    for (const f of found) {
      // node's own results arrive on fd 3, a pipe only this process and the runner's reporter hold (R1169g, R1169h).
      const args = [...PRELOAD, '--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...f.names.map((n) => `--test-name-pattern=^${escapeRe(n)}$`), `dist/test/${f.file.replace(/\.ts$/, '.js')}`];
      // Never a child of another test run (NODE_TEST_CONTEXT), and no NODE_OPTIONS (an --enable-source-maps there would
      // report TS lines, so every gate would read as not run).
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT' && k !== 'NODE_OPTIONS'));
      const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
      process.stdout.write(r.stdout ?? '');
      let events;
      try {
        events = eventsOf(r.output?.[3] ?? '');
      } catch (e) {
        console.error(`test/${f.file}: its results couldn't be read (${e.message})`);
        process.exit(1);
      }
      runs.push({ file: f.file, gates: f.gates, events });
      exits.push(...summaryProblems(r.stdout ?? '', f.file, f.gates.length));
      if (r.status !== 0) exits.push(`test/${f.file}: the test run exited ${r.status ?? r.signal}`);
    }
  }
  const bad = problems(runs);
  if (!bad.length) bad.push(...exits);
  if (bad.length) {
    console.error(`systemd acceptance tests that didn't pass here:\n${bad.map((b) => `  ${b}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`all ${names.length} ran and passed`);
}
