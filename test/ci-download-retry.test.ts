// lint-test
// Every pinned download in CI goes through scripts/ci/fetch-pinned.sh, which retries a transient failure and checks the
// pinned sha256 before the file exists (#1201); every download in the setup and CI scripts retries. WHY: on 2026-11-08
// GitHub release downloads answered 504 for a while, and a single-shot `curl` turned whole PRs red with no test
// failing. The first version of this lint matched text around each curl and failed open on 20 forms (R1228a, R1228b:
// a check that can't fail, a check of another file, the first --retry read instead of the last, flags in a comment, a
// URL in a variable or an env: value, wget). So the retry and the check now live once, in the helper, its behavior is
// tested below with a stub curl, and the lint only has to hold that no pinned URL appears anywhere but on a helper line.
// One exception, derived from the workflow, not a list: a job whose container can run a pull request's code runs its
// steps as root on the self-hosted runner until it switches to the runner user, and a root step there runs nothing
// from the checkout (desktop-removed.test.ts's RUNS_CHECKOUT). Its downloads stay inline, in one exact curl-and-check
// pair, and the helper is refused there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { BRAND } from '../src/brand.js';
import { repoRoot } from './helpers.js';

/** A pinned binary's URL: a GitHub release asset (download or API form), a raw file, or a vendor host CI fetches pinned binaries from. */
const DOWNLOAD = /releases\/download\/|\/releases\/assets\/|(?:objects|release-assets|raw)\.githubusercontent\.com|storage\.googleapis\.com\/chrome-for-testing-public\/|nodejs\.org\/dist\//;

const HELPER = 'scripts/ci/fetch-pinned.sh';
/** A shell variable reference, `$x` or `${x}`: no `$(…)`, no `${x:-…}`. */
const VAR = String.raw`\$\{?[A-Za-z_][A-Za-z0-9_]*\}?`;
/** A quoted path: plain characters and variables only. */
const PATH = String.raw`(?:[^"\s$\x60\\]|${VAR})+`;
/**
 * The one form a workflow line naming a pinned URL may take: the helper, run with bash, with a quoted https URL, a
 * 64-hex pin or a quoted variable holding one, and an out file, and nothing after it (no `|| true`, no `;`, no `#`).
 */
const HELPER_LINE = new RegExp(
  String.raw`^\s*bash "?(?:\$GITHUB_WORKSPACE/|\$ws/)?scripts/ci/fetch-pinned\.sh"? ` +
    String.raw`"https://${PATH}" ` +
    String.raw`(?:"${VAR}"|[0-9a-f]{64}) ` +
    String.raw`(?:"(?:[^"$\x60\\]|${VAR})+"|[A-Za-z0-9_./-]+)\s*$`,
);
/**
 * The inline download a root container step makes (it may run nothing from the checkout): the helper's own curl flags
 * (-sSfL first: self-hosted-guard.test.ts asks for it), to `<out>.part`, from an https URL.
 */
const INLINE_CURL = new RegExp(
  String.raw`^\s*curl -sSfL --proto '=https' --tlsv1\.2 --connect-timeout 20 --max-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120 ` +
    String.raw`-o "(${PATH})\.part" "https://${PATH}"\s*$`,
);
/**
 * Its check, the very next line, fail-safe whatever the shell does (#1228 review R1228d D1): the pin (a variable or
 * 64 hex) and `<out>.part`, checked --strict (a pin holding a second line fails), and only then moved to `<out>`.
 * A check that failed, swallowed by `|| true`, `set +e` or a shell without -e, leaves nothing at the name that's used.
 */
const INLINE_CHECK = new RegExp(String.raw`^\s*echo "(?:${VAR}|[0-9a-f]{64})  (${PATH})\.part" \| sha256sum -c - --strict && mv -f -- "(${PATH})\.part" "(${PATH})"\s*$`);

/** Downloaders other than curl: none may run in a workflow or a script (a probe to /dev/null aside, below). */
const OTHER_FETCH = /\bwget\b|\bgh\s+release\s+download\b|\bInvoke-WebRequest\b|\biwr\b|\bInvoke-RestMethod\b|\birm\b|\bWebClient\b|\bDownloadFile\b|\bHttpClient\b|\bStart-BitsTransfer\b|\baria2c\b|\bcurl\.exe\b|=\s*["']?curl\b/i;

/** A run script's lines, with backslash-continued lines joined. */
const logicalLines = (run: string) => run.replace(/\\\n\s*/g, ' ').split('\n');

/** One shell command, and whether a pipe takes its output (`a | b`: a's). */
export interface Cmd {
  cmd: string;
  piped: boolean;
}

/** One shell line with its comment cut, split into commands at each unquoted `;`, `&` or `|` (so `&&`, `||`, pipes). */
export function shellCommands(line: string): Cmd[] {
  const out: Cmd[] = [];
  let cur = '';
  let q: string | null = null;
  const push = (piped: boolean) => {
    if (cur.trim()) out.push({ cmd: cur.trim(), piped });
    cur = '';
  };
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
    if (c === '|' && line[i + 1] === '|') { push(false); i++; continue; }
    if (c === '|') { push(true); continue; }
    if (c === '&' && line[i - 1] !== '>' && line[i + 1] !== '>') { if (line[i + 1] === '&') i++; push(false); continue; }
    if (c === ';') { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}
export const commands = (line: string): string[] => shellCommands(line).map((c) => c.cmd);

/** A command's words as the shell splits them: quotes kept together and taken off. */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      if (c === q) q = null;
      else cur = (cur ?? '') + c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur ??= ''; continue; }
    if (/\s/.test(c)) { if (cur !== null) out.push(cur); cur = null; continue; }
    cur = (cur ?? '') + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Whether a command runs curl (not a word in, say, an apt-get list): curl first, or after $( ` then do if ! exec env sudo nohup time timeout N or assignments. */
export const runsCurl = (cmd: string) => /(?:^|\$\(|`|\b(?:then|do|if|exec|command|sudo|env|nohup|time)\s+|[!{(]\s*|\btimeout\s+\S+\s+|^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+)curl(?:\s|$)/.test(cmd);

/**
 * Where one curl command's bodies go, one per transfer (`--next` or `-:` starts another): to a file (not /dev/null),
 * to stdout (a pipe, a redirect or a capture), or nowhere. The worst of them counts. Words are read as the shell
 * splits them, so an `-o /dev/null` inside a quoted header is no output (R1228d D3).
 */
export function curlOutput(cmd: string): 'file' | 'stdout' | 'none' {
  // From curl on: a capture's quotes ("$(curl … "$1")") would otherwise make one word of it.
  const t = words(cmd.slice(cmd.search(/\bcurl\b/))).slice(1);
  let file = false;
  let stdout = false;
  let named = false;
  const end = () => {
    if (!named) stdout = true;
    named = false;
  };
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    let target: string | undefined;
    if (tok === '--next' || tok === '-:') { end(); continue; }
    if (tok === '-o' || tok === '--output') target = t[++i];
    else if (tok.startsWith('--output=')) target = tok.slice('--output='.length);
    else if (tok === '--remote-name' || tok === '--remote-name-all') file = named = true;
    else if (/^-[a-zA-Z]+$/.test(tok)) {
      if (tok.includes('O')) file = named = true;
      if (tok.endsWith('o')) target = t[++i];
    } else if (/^-o\S/.test(tok)) target = tok.slice(2);
    if (target !== undefined) { named = true; if (target !== '/dev/null') file = true; }
  }
  end();
  return file ? 'file' : stdout ? 'stdout' : 'none';
}

/** Whether a curl command reads a config file (-K, --config): one can set its URL, its output, and reset --retry. */
const readsConfig = (cmd: string) => words(cmd.slice(cmd.search(/\bcurl\b/))).some((w) => w === '--config' || w.startsWith('--config=') || /^-[a-zA-Z]*K/.test(w));

/** The retry count curl uses: its last `--retry N` (curl takes the last), 0 when there is none. */
export function lastRetry(cmd: string): number {
  return Number([...cmd.matchAll(/(?:^|\s)--retry(?:=|\s+)(\d+)(?=\s|$)/g)].pop()?.[1] ?? 0);
}

/** What is wrong in one workflow file's text, line by line: a pinned URL anywhere but on a helper line, another downloader. */
export function workflowTextProblems(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (DOWNLOAD.test(l) && !HELPER_LINE.test(l) && !INLINE_CURL.test(l)) out.push(`a pinned URL not on a ${HELPER} line: ${l.trim()}`);
    if (!/^\s*#/.test(l) && OTHER_FETCH.test(l)) out.push(`a download that isn't the helper's curl: ${l.trim()}`);
  }
  return out;
}

/** A loopback URL: a local stand-in, never a download. */
const LOCAL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/]|$)/;

/**
 * What is wrong in one step's script. Anywhere: a curl that keeps (to a file or stdout) what an https URL, or an http
 * URL that isn't loopback, returns, the inline pair aside; a curl that reads a config file. In a root container step
 * (`rootStep`): the helper (checkout code, as root), and an inline curl not followed at once by its fail-safe check of
 * the same file. Elsewhere: the inline pair (the helper is the one way).
 */
export function runProblems(run: string, rootStep = false): string[] {
  const out: string[] = [];
  const lines = logicalLines(run);
  for (const [i, l] of lines.entries()) {
    if (HELPER_LINE.test(l) && rootStep) out.push(`${HELPER} from the checkout in a step that runs as root in the self-hosted container: ${l.trim()}`);
    const m = INLINE_CURL.exec(l);
    if (m) {
      if (!rootStep) out.push(`an inline download outside a root container step (use ${HELPER}): ${l.trim()}`);
      const next = lines.slice(i + 1).find((x) => x.trim() !== '' && !/^\s*#/.test(x)) ?? '';
      const c = INLINE_CHECK.exec(next);
      if (!c || c[1] !== m[1] || c[2] !== m[1] || c[3] !== m[1]) out.push(`an inline download not checked at once against its pin, then moved into place: ${l.trim()}`);
      continue;
    }
    for (const c of commands(l)) {
      if (!runsCurl(c)) continue;
      if (readsConfig(c)) out.push(`a curl that reads a config file (-K): ${c}`);
      const urls = words(c.slice(c.search(/\bcurl\b/))).filter((w) => /^https?:\/\//i.test(w));
      if (curlOutput(c) !== 'none' && urls.some((u) => /^https:/i.test(u) || !LOCAL.test(u))) out.push(`a curl that keeps what a URL returns (use ${HELPER}): ${c}`);
    }
  }
  return out;
}

/**
 * The runner-user switch a root container step may open with (as desktop-removed.test.ts's AS_RUNNER), exactly: after
 * it, the step runs as the runner user (R1228d D5: a looser match took a prelude that ran something else first).
 */
const AS_RUNNER = `# In the self-hosted runner's container, as the runner user (above), never root, with this same script.
if [ "\${${BRAND.envPrefix}_CI_CONTAINER:-}" = 1 ] && [ "$(id -u)" = 0 ]; then
  chown -R runner:runner "$GITHUB_WORKSPACE" "$RUNNER_TEMP"
  HOME=/home/runner exec runuser -p -u runner -- bash --noprofile --norc -eo pipefail "$0"
fi
`;
/** A step that switches to the runner user before anything else. */
const switchesToRunner = (run: string) => run.startsWith(AS_RUNNER);
/**
 * A job whose steps start as root: one with a container, unless it runs as another user (`options: --user`). R1228d
 * D5: matching the text `pull_request` missed a container expression that could run a pull request without it.
 */
const rootContainer = (job: { container?: unknown }) => {
  const c = job.container;
  if (c === undefined || c === null || c === '') return false;
  return !/--user\b|(^|\s)-u\s/.test(JSON.stringify(c));
};

/**
 * Commands in scripts/ that keep what they fetch with no retry and are allowed to: each reads a local server's answer
 * (the dashboard, a package index), which a retry would hide. Exact text, so an edit to one of them, or a new one, is
 * checked.
 */
const SCRIPT_PROBES: Record<string, string[]> = {
  'scripts/ci/wizard-url.sh': [
    `code="$(curl -s -o "$work/page.html" -w '%{http_code}' "$url")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' "$origin$api")"`,
    `code="$(curl -s -o "$work/api.json" -w '%{http_code}' -H @"$work/auth" "$origin$api")"`,
  ],
  'scripts/ci/testrun-pip-real-systemd.sh': [`curl -fsS "http://$PUB:$PORT/simple/standin/"`],
  // An egress probe that must fail: a container must not reach the URL.
  'scripts/ci/runner-stand-in/job.sh': [`if out="$(docker run --rm "$img" wget -q -T 5 -O- "$u" 2>&1)"`],
};

/** wget's outputs (-O, --output-document): all of them, since it writes the last. */
const wgetOutputs = (cmd: string) => {
  const w = words(cmd.slice(cmd.search(/\bwget\b/)));
  const outs: string[] = [];
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '-O' || w[i] === '--output-document') outs.push(w[++i] ?? '');
    else if (w[i]!.startsWith('--output-document=')) outs.push(w[i]!.slice('--output-document='.length));
    else if (/^-O./.test(w[i]!)) outs.push(w[i]!.slice(2));
  }
  return outs;
};

/** One shell script's downloads (a curl that keeps a body, or names a pinned URL) and what is wrong with them. */
export function scriptProblems(text: string, probes: string[] = []): { downloads: number; problems: string[] } {
  let downloads = 0;
  const problems: string[] = [];
  for (const { cmd: c, piped } of logicalLines(text).flatMap(shellCommands)) {
    if (probes.includes(c)) continue;
    if (OTHER_FETCH.test(c)) {
      // wget only as a probe whose every output is /dev/null (R1228d D6: it writes the last -O).
      const outs = /\bwget\b/.test(c) ? wgetOutputs(c) : [];
      if (!(outs.length && outs.every((o) => o === '/dev/null'))) problems.push(`a download that isn't curl: ${c}`);
      continue;
    }
    if (!runsCurl(c)) continue;
    if (readsConfig(c)) problems.push(`a curl that reads a config file (-K: it can reset --retry): ${c}`);
    const o = curlOutput(c);
    // A body to stdout is kept when a pipe, a redirect or a capture takes it (R1228d D6).
    const kept = o === 'file' || (o === 'stdout' && (piped || /\$\(\s*curl\b/.test(c) || words(c.slice(c.search(/\bcurl\b/))).some((w) => /^&?>>?/.test(w)))) || DOWNLOAD.test(c);
    if (!kept) continue;
    downloads++;
    if (lastRetry(c) < 1) problems.push(`a download with no retry (its last --retry must be 1 or more): ${c}`);
  }
  return { downloads, problems };
}

type Step = { run?: unknown; uses?: unknown };
type Doc = { jobs?: Record<string, { steps?: Step[]; container?: unknown }>; runs?: { steps?: Step[] } } | null;

/**
 * Every run script in `.github`'s YAML files, judged: a workflow job's steps as root when the job is a root container;
 * a local composite action's (`uses: ./…`) as root when any root job uses it (R1228d D5). Returns the inline pairs seen.
 */
function workflowFiles(files: readonly { name: string; text: string }[], report: (name: string, problem: string) => void): number {
  const docs = files.map((f) => ({ ...f, doc: parse(f.text) as Doc }));
  const rootActions = new Set<string>();
  for (const { doc } of docs) for (const j of Object.values(doc?.jobs ?? {})) if (rootContainer(j ?? {})) for (const s of j?.steps ?? []) if (typeof s?.uses === 'string' && s.uses.startsWith('./')) rootActions.add(s.uses.replace(/^\.\//, '').replace(/\/$/, ''));
  let inline = 0;
  for (const { name, doc } of docs) {
    const actionRoot = rootActions.has(name.replace(/\/action\.ya?ml$/, ''));
    const steps = [
      ...Object.values(doc?.jobs ?? {}).flatMap((j) => (j?.steps ?? []).map((s) => ({ s, root: rootContainer(j ?? {}) }))),
      ...(doc?.runs?.steps ?? []).map((s) => ({ s, root: actionRoot })),
    ];
    for (const { s, root } of steps) {
      if (typeof s?.run !== 'string') continue;
      inline += logicalLines(s.run).filter((l) => INLINE_CURL.test(l)).length;
      for (const p of runProblems(s.run, root && !switchesToRunner(s.run))) report(name, p);
    }
  }
  return inline;
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
    'R1228d W1 plain http to a file': 'curl -sSfL -o tool "http://example.com/tool"; ./tool',
    'R1228d W3 a raw.githubusercontent URL in env': 'env:\n  TOOL_URL: https://raw.githubusercontent.com/a/b/main/tool',
    'R1228d W4 -o /dev/null hidden in a quoted header': 'curl -sSfL -H "X-Pad: -o /dev/null" "https://example.com/tool.tgz" | tar -xz',
    'R1228d W4 the same, with a word after it in the header': 'curl -sSfL -H "X-Pad: -o /dev/null x" "https://example.com/tool.tgz" | tar -xz',
    'R1228d W5 a second transfer after --next': 'curl -sS -o /dev/null "https://example.com/ping" --next "https://example.com/tool.tgz" | tar -xz',
    'R1228d W6 Invoke-RestMethod': 'Invoke-RestMethod -Uri https://example.com/t -OutFile t',
    'R1228d W6 irm': 'irm https://example.com/t -OutFile t',
    'R1228d W6 WebClient': '(New-Object Net.WebClient).DownloadFile("https://example.com/t", "t")',
    'R1228d W7 a config file': 'printf "url = https://example.com/t\\noutput = t\\n" > c\ncurl -sSfL -K c',
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(refused(s), `refused: ${why}`);
  const good = {
    'the helper, relative': `bash ${HELPER} "https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${tarball}" "\${GITLEAKS_SHA256}" "$tarball"`,
    'the helper from the workspace, a literal pin': `bash "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`,
    'the helper inside WSL': `bash "$ws/${HELPER}" "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz" "$sum" /tmp/node.tar.xz`,
    'a probe to /dev/null': `[ "$(curl -s -o /dev/null -w '%{http_code}' https://hub.example.test/first-run)" = 200 ]`,
    'a local probe': 'curl -sf "$GH_FAKE/repos/example/alpha"',
    'a loopback page kept': `curl -sS -o "$F/seam.json" -w '%{http_code}' "http://127.0.0.1:$port/api/x"`,
    'a loopback probe in a loop': 'for _ in $(seq 40); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.5; done',
  };
  for (const [why, s] of Object.entries(good)) assert.ok(!refused(s), `kept: ${why}: ${[...workflowTextProblems(s), ...runProblems(s)].join('; ')}`);
});

test('a root container step: the helper is refused, the inline pair must be exact and fail-safe; outside one the pair is refused (R1228d D1, D5)', () => {
  const F = "curl -sSfL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120";
  const pair = (out: string, pin = '${CHROME_SHA256}') => `${F} -o "${out}.part" "${REL}"\necho "${pin}  ${out}.part" | sha256sum -c - --strict && mv -f -- "${out}.part" "${out}"`;
  assert.deepEqual(runProblems(pair('/tmp/$f'), true), [], 'the exact pair in a root step');
  assert.deepEqual(runProblems(`${F} -o "$f.part" "${REL}"\n# a comment\n\necho "${PIN}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$f"`, true), [], 'comments and blank lines between are skipped');
  assert.match(runProblems(pair('/tmp/$f'), false).join(), /outside a root container step/, 'elsewhere the helper is the one way');
  assert.match(runProblems(`bash "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"`, true).join(), /from the checkout in a step that runs as root/);
  const bad = {
    'the old pair (no .part, no move)': `${F.replace(' --connect-timeout 20 --max-time 60', '')} -o "$f" "${REL}"\necho "${PIN}  $f" | sha256sum -c -`,
    'a check that cannot fail': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - --strict || true`,
    'no --strict': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - && mv -f -- "$f.part" "$f"`,
    'moved before the check': `${F} -o "$f.part" "${REL}"\nmv -f -- "$f.part" "$f"\necho "${PIN}  $f" | sha256sum -c - --strict`,
    'a check of another file': `${F} -o "$f.part" "${REL}"\necho "${PIN}  other.part" | sha256sum -c - --strict && mv -f -- "other.part" "other"`,
    'moved to another name': `${F} -o "$f.part" "${REL}"\necho "${PIN}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$g"`,
    'no check': `${F} -o "$f.part" "${REL}"`,
    'two downloads, one check': `${F} -o "$f.part" "${REL}"\n${F} -o "$g.part" "${REL}"\necho "${PIN}  $g.part" | sha256sum -c - --strict && mv -f -- "$g.part" "$g"`,
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(runProblems(s, true).length > 0, why);
  assert.equal(INLINE_CURL.test(`${F.replace('--retry 5', '--retry 0')} -o "$f.part" "${REL}"`), false, 'the flags are exact');
  assert.equal(INLINE_CURL.test(`${F.replace(' --max-time 60', '')} -o "$f.part" "${REL}"`), false, 'the time bound is part of them (R1228d D2)');
  // D5: a container is root unless it runs as another user; the runner switch is matched exactly.
  assert.ok(rootContainer({ container: "${{ github.event_name != 'push' && fromJSON('{}') || '' }}" }), 'X1: a container expression without the text pull_request');
  assert.ok(!rootContainer({}) && !rootContainer({ container: { image: 'x', options: '--user 1001' } }));
  const prelude = AS_RUNNER;
  assert.ok(switchesToRunner(`${prelude}echo ok\n`));
  assert.ok(!switchesToRunner(prelude.replace('chown -R runner:runner "$GITHUB_WORKSPACE" "$RUNNER_TEMP"', `bash "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} f`)), 'X2: a prelude that runs something else');
  assert.ok(!switchesToRunner(prelude.replace('-u runner', '-u root')), 'X2: a switch to root');
});

test('the inline pair, run: a failed check leaves nothing at the name used, however the shell carries on (R1228d D1, measured with a stub curl and the real sha256sum)', { skip: process.platform === 'win32' }, () => {
  const d = mkdtempSync(join(tmpdir(), 'inline-pair-'));
  try {
    writeFileSync(join(d, 'curl'), '#!/usr/bin/env bash\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf evil > "$out"\n', { mode: 0o755 });
    const F = "curl -sSfL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120";
    const good = sha('good');
    const pairFor = (pin: string) => `${F} -o "$f.part" "${REL}"\necho "${pin}  $f.part" | sha256sum -c - --strict && mv -f -- "$f.part" "$f"`;
    const forms: Record<string, string> = {
      'R1 the pair in { … } || true': `{ ${pairFor(good).replace('\n', '; ')}; } || true`,
      'R2 set +e first': `set +e\n${pairFor(good)}`,
      'R3 a shell without -e': pairFor(good),
      'R4 a pin holding a second line': `SUM="$(printf 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /dev/null\\n')"\n${pairFor('${SUM}')}`,
    };
    for (const [why, script] of Object.entries(forms)) {
      rmSync(join(d, 'f'), { force: true });
      const r = spawnSync('bash', ['--noprofile', '--norc', '-c', `f=f\n${script}\n[ -e "$f" ] && echo USED || echo NOTHING`], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
      assert.match(r.stdout, /NOTHING\s*$/, `${why}: ${r.stdout} ${r.stderr}`);
    }
    // And the right bytes do land.
    writeFileSync(join(d, 'curl'), '#!/usr/bin/env bash\nout=\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf good > "$out"\n', { mode: 0o755 });
    const ok = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `f=f\n${pairFor(good)}\ncat "$f"`], { cwd: d, encoding: 'utf8', env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
    assert.equal(ok.stdout.trim().split('\n').at(-1), 'good', ok.stderr);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('a composite action used by a root job is judged as root (R1228d D5 X3)', () => {
  const problems: string[] = [];
  const files = [
    { name: '.github/workflows/zz.yml', text: `jobs:\n  t:\n    container: { image: x }\n    steps:\n      - uses: ./.github/actions/zz\n` },
    { name: '.github/actions/zz/action.yml', text: `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bash "$GITHUB_WORKSPACE/${HELPER}" "${REL}" ${PIN} "$f"\n` },
  ];
  workflowFiles(files, (n, p) => problems.push(`${n}: ${p}`));
  assert.match(problems.join(), /\.github\/actions\/zz\/action\.yml: .*from the checkout in a step that runs as root/);
  problems.length = 0;
  workflowFiles([{ ...files[0]!, text: files[0]!.text.replace('    container: { image: x }\n', '') }, files[1]!], (n, p) => problems.push(`${n}: ${p}`));
  assert.deepEqual(problems, [], 'used by no root job: the helper is the one way');
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
    'R1228d S1 a body redirected to a file': 'curl -fsSL "$url" > "$out"',
    'R1228d S2 a body piped from a variable URL': 'curl -fsSL "$url" | tar -xz -C "$dir"',
    'R1228d S2 a body captured': 'body="$(curl -fsSL "$url")"',
    'R1228d S3 wget with a later -O to a file': 'wget -q -O /dev/null "$u" -O "$out"',
    'R1228d S4 a config file that resets the retry': 'curl --retry 3 -K "$cfg" -o "$out" "$url"',
  };
  for (const [why, s] of Object.entries(bad)) assert.ok(scriptProblems(s).problems.length > 0, `refused: ${why}`);
  const good = {
    'a retried download': 'curl -fsSL --retry 3 -o "$out" "$url"',
    'a retried download, continued': 'curl -fsSL --proto \'=https\' \\\n  --retry 3 -o "$work/$3" "$1"',
    'a status probe': `answers() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || true)" = 200 ]; }`,
    'a wget egress probe to /dev/null': 'docker run --rm "$img" wget -T 10 -O /dev/null https://github.com/',
    'a mention in a comment': '# wget -O g "$u"',
    'curl as a word in an install list': 'apt-get install -y -q uidmap git curl ca-certificates tar',
    'a body piped, retried': 'curl -fsSL --retry 3 "$url" | tar -xz -C "$dir"',
  };
  for (const [why, s] of Object.entries(good)) assert.deepEqual(scriptProblems(s).problems, [], `kept: ${why}`);
  assert.equal(lastRetry('curl --retry 5 --retry-delay 9 -o f u'), 5, '--retry-delay is not --retry');
  assert.ok(isShell('x.bash', '') && isShell('stand-in', '#!/usr/bin/env bash\n') && !isShell('x.mjs', '#!/usr/bin/env bash\n'), '.bash files and shebang scripts are walked');
});

test(`every pinned download in .github goes through ${HELPER}, and nothing else there downloads (#1201)`, () => {
  const problems: string[] = [];
  let helperLines = 0;
  let inline = 0;
  const files = walk(join(repoRoot, '.github'), (p) => /\.ya?ml$/.test(p)).sort().map((f) => ({ name: relative(repoRoot, f), text: readFileSync(f, 'utf8') }));
  for (const { name, text } of files) {
    helperLines += text.split('\n').filter((l) => HELPER_LINE.test(l)).length;
    for (const p of workflowTextProblems(text)) problems.push(`${name}: ${p}`);
  }
  inline = workflowFiles(files, (name, p) => problems.push(`${name}: ${p}`));
  assert.deepEqual(problems, []);
  assert.ok(helperLines + inline >= 9, `found ${helperLines} helper lines and ${inline} inline pairs: the lint must see the workflows' 9 pinned downloads`);
  assert.ok(inline >= 2, `found ${inline} inline pairs: the test shards' Chrome and gitleaks downloads are root container steps`);
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
  assert.equal(a[0], '-q', 'curl reads no ~/.curlrc: -q comes first (R1228d D7)');
  for (const flag of ['-fsSL', '--retry-all-errors', '--tlsv1.2']) assert.ok(a.includes(flag), `curl gets ${flag}`);
  // Bounded in time (R1228d D2): a stalled try ends at --max-time, and no retry begins after --retry-max-time.
  assert.equal(a[a.indexOf('--max-time') + 1], '60');
  assert.equal(a[a.indexOf('--connect-timeout') + 1], '20');
  assert.equal(a[a.indexOf('--retry-max-time') + 1], '120');
  // An unpredictable part file beside the out file (mktemp), never a name a link could be planted at (R1228d D7).
  assert.match(a[a.indexOf('-o') + 1]!, /\/out\.bin\.part\.[A-Za-z0-9]{6}$/);
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
