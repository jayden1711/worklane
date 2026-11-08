// lint-test
// Every pinned download in CI goes through scripts/ci/fetch-pinned.sh, which retries a transient failure and checks the
// pinned sha256 before the file exists (#1201); every download in the setup and CI scripts retries. WHY: on 2026-11-08
// GitHub release downloads answered 504 for a while, and a single-shot `curl` turned whole PRs red with no test
// failing. The first version of this lint matched text around each curl and failed open on 20 forms (R1228a, R1228b:
// a check that can't fail, a check of another file, the first --retry read instead of the last, flags in a comment, a
// URL in a variable or an env: value, wget). So the retry and the check now live once, in the helper, its behavior is
// tested below with a stub curl, and the lint only has to hold that no pinned URL appears anywhere but on a helper line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './helpers.js';

/** A pinned binary's URL: a GitHub release asset (download or API form), or a vendor host CI fetches pinned binaries from. */
const DOWNLOAD = /releases\/download\/|\/releases\/assets\/|(?:objects|release-assets)\.githubusercontent\.com|storage\.googleapis\.com\/chrome-for-testing-public\/|nodejs\.org\/dist\//;

const HELPER = 'scripts/ci/fetch-pinned.sh';
/** A shell variable reference, `$x` or `${x}`: no `$(…)`, no `${x:-…}`. */
const VAR = String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?`;
/**
 * The one form a workflow line naming a pinned URL may take: the helper, run with bash, with a quoted https URL, a
 * 64-hex pin or a quoted variable holding one, and an out file, and nothing after it (no `|| true`, no `;`, no `#`).
 */
const HELPER_LINE = new RegExp(
  String.raw`^\s*bash "?(?:\$GITHUB_WORKSPACE/|\$ws/)?scripts/ci/fetch-pinned\.sh"? ` +
    String.raw`"https://(?:[^"\s$\x60\\]|${VAR})+" ` +
    String.raw`(?:"${VAR}"|[0-9a-f]{64}) ` +
    String.raw`(?:"(?:[^"$\x60\\]|${VAR})+"|[A-Za-z0-9_./-]+)\s*$`,
);
/** Downloaders other than the helper's curl: none may run in a workflow or a script (a probe to /dev/null aside, below). */
const OTHER_FETCH = /\bwget\b|\bgh\s+release\s+download\b|\bInvoke-WebRequest\b|\biwr\b|\bStart-BitsTransfer\b|\baria2c\b|\bcurl\.exe\b|=\s*["']?curl\b/i;

/** A run script's lines, with backslash-continued lines joined. */
const logicalLines = (run: string) => run.replace(/\\\n\s*/g, ' ').split('\n');

/** One shell line with its comment cut, split into commands at each unquoted `;`, `&` or `|` (so `&&`, `||`, pipes). */
export function commands(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += line[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') { cur += c + (line[++i] ?? ''); continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) break;
    if (c === ';' || c === '&' || c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Where one curl command's body goes: to a file (not /dev/null), to stdout (a pipe or a capture), or nowhere. */
export function curlOutput(cmd: string): 'file' | 'stdout' | 'none' {
  const t = cmd.slice(cmd.search(/\bcurl\b/)).split(/\s+/);
  const unq = (s = '') => s.replace(/^["']|["']$/g, '');
  let file = false;
  let named = false;
  for (let i = 1; i < t.length; i++) {
    const tok = t[i]!;
    let target: string | undefined;
    if (tok === '-o' || tok === '--output') target = t[++i];
    else if (tok.startsWith('--output=')) target = tok.slice('--output='.length);
    else if (tok === '--remote-name' || tok === '--remote-name-all') file = named = true;
    else if (/^-[a-zA-Z]+$/.test(tok)) {
      if (tok.includes('O')) file = named = true;
      if (tok.endsWith('o')) target = t[++i];
    } else if (/^-o\S/.test(tok)) target = tok.slice(2);
    if (target !== undefined) { named = true; if (unq(target) !== '/dev/null') file = true; }
  }
  return file ? 'file' : named ? 'none' : 'stdout';
}

/** The retry count curl uses: its last `--retry N` (curl takes the last), 0 when there is none. */
export function lastRetry(cmd: string): number {
  return Number([...cmd.matchAll(/(?:^|\s)--retry(?:=|\s+)(\d+)(?=\s|$)/g)].pop()?.[1] ?? 0);
}

/** What is wrong in one workflow file's text, line by line: a pinned URL anywhere but on a helper line, another downloader. */
export function workflowTextProblems(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (DOWNLOAD.test(l) && !HELPER_LINE.test(l)) out.push(`a pinned URL not on a ${HELPER} line: ${l.trim()}`);
    if (!/^\s*#/.test(l) && OTHER_FETCH.test(l)) out.push(`a download that isn't the helper's curl: ${l.trim()}`);
  }
  return out;
}

/** What is wrong in one step's script: a curl to an https:// URL whose body goes anywhere but /dev/null. */
export function runProblems(run: string): string[] {
  return logicalLines(run)
    .flatMap(commands)
    .filter((c) => /\bcurl\b/.test(c) && /https:\/\//.test(c) && curlOutput(c) !== 'none')
    .map((c) => `a curl that keeps what an https URL returns (use ${HELPER}): ${c}`);
}

/**
 * Commands in scripts/ that keep what they fetch with no retry and are allowed to: each reads the local dashboard and
 * checks its answer code, which a retry would hide. Exact text, so an edit to one of them, or a new one, is checked.
 */
const SCRIPT_PROBES: Record<string, string[]> = {
  'scripts/ci/wizard-url.sh': [
    `code="$(curl -s -o "$work/page.html" -w '%{http_code}' "$url")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' "$origin$api")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' -H @"$work/auth" "$origin$api")"`,
  ],
  // An egress probe that must fail: a container must not reach the URL.
  'scripts/ci/runner-stand-in/job.sh': [`if out="$(docker run --rm "$img" wget -q -T 5 -O- "$u" 2>&1)"`],
};

/** One shell script's downloads (a curl that keeps a body, or names a pinned URL) and what is wrong with them. */
export function scriptProblems(text: string, probes: string[] = []): { downloads: number; problems: string[] } {
  let downloads = 0;
  const problems: string[] = [];
  for (const c of logicalLines(text).flatMap(commands)) {
    if (probes.includes(c)) continue;
    if (OTHER_FETCH.test(c) && !(/\bwget\b/.test(c) && /\s-O\s+\/dev\/null\b/.test(c) && !/-O-|-O\s+-\s/.test(c))) {
      problems.push(`a download that isn't curl: ${c}`);
      continue;
    }
    if (!/\bcurl\b/.test(c) || (curlOutput(c) !== 'file' && !DOWNLOAD.test(c))) continue;
    downloads++;
    if (lastRetry(c) < 1) problems.push(`a download with no retry (its last --retry must be 1 or more): ${c}`);
  }
  return { downloads, problems };
}

/** A shell script by name or shebang. */
const isShell = (name: string, text: string) => /\.(sh|bash)$/.test(name) || (!name.includes('.') && /^#!.*\b(ba|da|z)?sh\b/.test(text));

const walk = (d: string, keep: (p: string) => boolean): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p, keep)) : keep(p) ? [p] : [];
  });

const REL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
const PIN = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

test('the workflow lint refuses every form R1228a and R1228b found, and keeps the helper and local probes', () => {
  const refused = (s: string) => workflowTextProblems(s).length + runProblems(s).length > 0;
  const bad = {
    'the old curl and sha256sum pair': `curl -sSfL --retry 5 --retry-all-errors --retry-delay 5 -o f "${REL}"\necho "${PIN}  f" | sha256sum -c -`,
    'a check that cannot fail': `curl -sSfL -o f "${REL}"\necho "${PIN}  f" | sha256sum -c - || true`,
    'the helper with || true': `bash ${HELPER} "${REL}" ${PIN} f || true`,
    'the helper then more on its line': `bash ${HELPER} "${REL}" ${PIN} f; tar -xzf f`,
    'the helper in a comment of another command': `true # bash ${HELPER} "${REL}" ${PIN} f`,
    'the helper with a command substitution in its URL': `bash ${HELPER} "https://$(cat u)/releases/download/x" ${PIN} f`,
    'the helper with a short pin': `bash ${HELPER} "${REL}" ${PIN.slice(1)} f`,
    'the helper over http': `bash ${HELPER} "http://github.com/a/b/releases/download/x" ${PIN} f`,
    'a URL in a shell variable': `u="${REL}"\ncurl -sSfL -o f "$u"`,
    'a URL in a workflow env: value': `env:\n  GL_URL: ${REL}`,
    'a URL in a heredoc': `u="$(cat <<X\n${REL}\nX\n)"`,
    'the release API asset endpoint': `curl -sSfL -H 'Accept: application/octet-stream' -o f https://api.github.com/repos/a/b/releases/assets/123`,
    'wget': `wget -O f "$u"`,
    'gh release download': 'gh release download v1 -R a/b -p "*.tgz"',
    'Invoke-WebRequest': 'Invoke-WebRequest -Uri $u -OutFile f',
    'iwr': 'iwr $u -OutFile f',
    'curl through a variable': 'c=curl\n"$c" -sSfL -o f "$u"',
    'a split URL to a file': `curl -sSfL -o f "https://github.com/a/b/rel""eases/download/x"`,
    'an https body piped to tar': 'curl -sSfL "https://example.com/x.tgz" | tar -xz',
    'an https body to a file with -O': 'curl -sSfLO "https://example.com/x.tgz"',
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(refused(s), `refused: ${why}`);
  const good = {
    'the helper, relative': `bash ${HELPER} "https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${tarball}" "\${GITLEAKS_SHA256}" "$tarball"`,
    'the helper from the workspace, a literal pin': `bash "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`,
    'the helper inside WSL': `bash "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz`,
    'a probe to /dev/null': `[ "$(curl -s -o /dev/null -w '%{http_code}' https://hub.example.test/first-run)" = 200 ]`,
    'a local probe': 'curl -sf "$GH_FAKE/repos/example/alpha"',
  };
  for (const [why, s] of Object.entries(good)) assert.ok(!refused(s), `kept: ${why}: ${[...workflowTextProblems(s), ...runProblems(s)].join('; ')}`);
});

test('the scripts lint: the last --retry counts, comments and continuations are read as the shell reads them', () => {
  const bad = {
    'no retry': `curl -fsSL -o g "${REL}"`,
    'a later --retry 0': 'curl -fsSL --retry 5 --retry 0 -o g "$u"',
    'the retry only in a comment': 'curl -fsSL -o g "$u" # --retry 5',
    'a continued line': 'curl -fsSL \\\n  -o g "$u"',
    'a nodejs.org body piped': 'curl -fsSL "https://nodejs.org/dist/v1/x.tar.xz" | tar -xJ',
    'a helper function with no retry': 'fetch() { curl -fsSL -o "$work/$3" "$1"; echo "$2  $work/$3" | sha256sum -c -; }',
    'combined -O': 'curl -fsSLO "$u"',
    '--output=': 'curl -fsSL --output=g "$u"',
    'wget to a file': 'wget -O g "$u"',
    'wget to stdout': 'wget -O- "$u" | tar -xz',
    'gh release download': 'gh release download v1 -R a/b',
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(scriptProblems(s).problems.length > 0, `refused: ${why}`);
  const good = {
    'a retried download': 'curl -fsSL --retry 3 -o "$out" "$url"',
    'a retried download, continued': 'curl -fsSL --proto \'=https\' \\\n  --retry 3 -o "$work/$3" "$1"',
    'a status probe': `answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true)" = 200 ]; }`,
    'a wget egress probe to /dev/null': 'docker run --rm "$img" wget -T 10 -O /dev/null https://github.com/',
    'a mention in a comment': '# wget -O g "$u"',
  };
  for (const [why, s] of Object.entries(good)) assert.deepEqual(scriptProblems(s).problems, [], `kept: ${why}`);
  assert.equal(lastRetry('curl --retry 5 --retry-delay 9 -o f u'), 5, '--retry-delay is not --retry');
  assert.ok(isShell('x.bash', '') && isShell('stand-in', '#!/usr/bin/env bash\n') && !isShell('x.mjs', '#!/usr/bin/env bash\n'), '.bash files and shebang scripts are walked');
});

test(`every pinned download in .github goes through ${HELPER}, and nothing else there downloads (#1201)`, () => {
  const problems: string[] = [];
  let helperLines = 0;
  for (const f of walk(join(repoRoot, '.github'), (p) => /\.ya?ml$/.test(p)).sort()) {
    const name = relative(repoRoot, f);
    const text = readFileSync(f, 'utf8');
    helperLines += text.split('\n').filter((l) => HELPER_LINE.test(l)).length;
    for (const p of workflowTextProblems(text)) problems.push(`${name}: ${p}`);
    // Workflows' jobs, and a composite action's runs: every run script in the file.
    const doc = parse(text) as { jobs?: Record<string, { steps?: { run?: unknown }[] }>; runs?: { steps?: { run?: unknown }[] } } | null;
    const steps = [...Object.values(doc?.jobs ?? {}).flatMap((j) => j?.steps ?? []), ...(doc?.runs?.steps ?? [])];
    for (const s of steps) if (typeof s?.run === 'string') for (const p of runProblems(s.run)) problems.push(`${name}: ${p}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(helperLines >= 9, `found ${helperLines} helper lines: the lint must see the workflows' 9 pinned downloads`);
});

test("every download in the setup and CI scripts retries, the helpers in bootstrap.sh and ci-runner.sh among them", () => {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const f of walk(join(repoRoot, 'scripts'), (p) => isShell(p.split('/').pop()!, readFileSync(p, 'utf8').slice(0, 200))).sort()) {
    const name = relative(repoRoot, f);
    const probes = SCRIPT_PROBES[name] ?? [];
    const cmds = logicalLines(readFileSync(f, 'utf8')).flatMap(commands);
    for (const p of probes) assert.ok(cmds.includes(p), `${name}: the allowed probe is gone; remove it from SCRIPT_PROBES: ${p}`);
    const r = scriptProblems(readFileSync(f, 'utf8'), probes);
    seen.set(name, r.downloads);
    for (const p of r.problems) problems.push(`${name}: ${p}`);
  }
  assert.deepEqual(problems, []);
  for (const f of ['scripts/bootstrap.sh', 'scripts/setup/ci-runner.sh', 'scripts/setup/tools.sh', 'scripts/setup/test-user.sh', 'scripts/setup/node.sh', HELPER]) {
    assert.ok((seen.get(f) ?? 0) >= 1, `${f}: the lint must see its download`);
  }
});

/** Runs the helper with a stub curl first on PATH: it logs its argv and writes `body` to its -o target, or exits `rc`. */
function runHelper(args: (d: string) => string[], opts: { body?: string; rc?: number; stale?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  try {
    writeFileSync(
      join(d, 'curl'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\n' +
        '[ "$STUB_RC" = 0 ] || exit "$STUB_RC"\nprintf %s "$STUB_BODY" > "$out"\n',
      { mode: 0o755 },
    );
    if (opts.stale) writeFileSync(join(d, 'out.bin'), 'stale');
    const r = spawnSync('bash', [join(repoRoot, HELPER), ...args(d)], {
      cwd: d,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${d}:${process.env.PATH}`, STUB_LOG: join(d, 'log'), STUB_BODY: opts.body ?? '', STUB_RC: String(opts.rc ?? 0) },
    });
    return {
      status: r.status,
      stderr: r.stderr,
      out: existsSync(join(d, 'out.bin')) ? readFileSync(join(d, 'out.bin'), 'utf8') : null,
      parts: readdirSync(d).filter((n) => n.includes('.part')),
      curlArgs: existsSync(join(d, 'log')) ? readFileSync(join(d, 'log'), 'utf8').trim().split('\n') : null,
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('the helper: a matching download lands at its out file, fetched over https with the retry, and nothing else is left', () => {
  const r = runHelper((d) => [REL, sha('hello'), join(d, 'out.bin')], { body: 'hello' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out, 'hello');
  assert.deepEqual(r.parts, []);
  const a = r.curlArgs!;
  for (const flag of ['-fsSL', '--retry-all-errors', '--tlsv1.2']) assert.ok(a.includes(flag), `curl gets ${flag}`);
  assert.equal(a[a.indexOf('--proto') + 1], '=https');
  assert.ok(Number(a[a.lastIndexOf('--retry') + 1]) >= 3, 'curl retries at least 3 times');
  assert.equal(a.at(-1), REL, 'the URL is the last argument');
});

test('the helper: a sha256 mismatch exits 1 and leaves nothing at the out file, a stale file there included', () => {
  for (const stale of [false, true]) {
    const r = runHelper((d) => [REL, sha('expected'), join(d, 'out.bin')], { body: 'tampered', stale });
    assert.equal(r.status, 1, `stale=${stale}: ${r.stderr}`);
    assert.match(r.stderr, /sha256 mismatch/);
    assert.equal(r.out, null, `stale=${stale}: nothing is at the out file`);
    assert.deepEqual(r.parts, []);
  }
});

test('the helper: a failed download exits non-zero and leaves nothing; a bad argument exits 2 before any download', () => {
  const failed = runHelper((d) => [REL, sha('x'), join(d, 'out.bin')], { rc: 22, stale: true });
  assert.notEqual(failed.status, 0);
  assert.equal(failed.out, null);
  assert.deepEqual(failed.parts, []);
  const badArgs: Record<string, (d: string) => string[]> = {
    'an http URL': (d) => ['http://example.com/x', sha('x'), join(d, 'out.bin')],
    'an upper-case pin': (d) => [REL, sha('x').toUpperCase(), join(d, 'out.bin')],
    'a short pin': (d) => [REL, sha('x').slice(1), join(d, 'out.bin')],
    'an empty out file': () => [REL, sha('x'), ''],
    'two arguments': () => [REL, sha('x')],
    'four arguments': (d) => [REL, sha('x'), join(d, 'out.bin'), 'extra'],
  };
  for (const [why, args] of Object.entries(badArgs)) {
    const r = runHelper(args, { body: 'x' });
    assert.equal(r.status, 2, `${why}: ${r.stderr}`);
    assert.equal(r.curlArgs, null, `${why}: curl never ran`);
  }
});
