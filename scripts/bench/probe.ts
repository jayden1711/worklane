// The sandbox probe (#748, owner's requirement and choice of 2026-10-18): before every bench run, from inside the
// agents' sandbox (benchLane's settings), try to reach what the sandbox must keep from them: connect to the Docker
// daemon's sockets, read ~/.claude.json, ~/.netrc, ~/.npmrc and ~/.pypirc. The run starts only if every attempt is
// refused.
//
// Which sandbox: Claude Code 2.1.303 has no model-free command that runs a command in its own sandbox, so the probe
// runs under sandbox-runtime's `srt` (the library Claude Code's sandbox is built on), at SRT_VERSION, installed for
// the bench user only (scripts/bench/README.md), and checked with `srt --version` before each run. That version is
// close to, not identical with, the build bundled in Claude Code 2.1.303: a static fingerprint of the binary's
// "[Sandbox Linux]" log lines against each published release puts the bundled build between 0.0.79 and 0.0.80, and
// 0.0.79 is the closest (the README has the method; re-run it on each new release and switch to an exact match).
// srt is run as `srt --settings <file> -- <argv...>`, `file` holding the lane's sandbox as sandbox-runtime's own
// configuration: the same denyRead, the same (no) allowed hosts. The bench's model-call confirmation in Claude Code's
// own sandbox is the driver's (driver.ts).
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dockerHostSocket, type LaneInput } from './agent.js';

export interface ProbeAttempt {
  kind: 'connect' | 'read';
  target: string;
}

export interface ProbeResult extends ProbeAttempt {
  /** The lane denies this path (or a folder holding it) to commands, and for a read to the Read tool as well. */
  deny_rule: boolean;
  /** The path exists on the host (lstat, outside the sandbox; nothing is read). */
  on_host: boolean;
  /** What the attempt inside the sandbox saw: an error code, `connected`, or `opened <kind>`. */
  seen: string;
  refused: boolean;
}

/** The sandbox-runtime release the probe runs on (owner's choice, 2026-10-18). */
export const SRT_VERSION = '0.0.79';
/** How the probe's sandbox is named in the summary and the PR. */
export const SRT_LABEL = `sandbox-runtime ${SRT_VERSION}: close to, not identical with, the build bundled in Claude Code 2.1.303`;

export interface ProbeReport {
  /** Which sandbox ran the probe (SRT_LABEL). */
  runner: string;
  results: ProbeResult[];
  ok: boolean;
}

/** What the probe tries: every daemon socket the lane denies, and the login and credential files. */
export function probeAttempts(o: LaneInput): ProbeAttempt[] {
  const sockets = [join(o.runtimeDir, 'docker.sock'), '/run/docker.sock', '/var/run/docker.sock', dockerHostSocket(o.dockerHost)];
  const files = ['.claude.json', '.netrc', '.npmrc', '.pypirc'].map((f) => join(o.home, f));
  const connects: ProbeAttempt[] = [...new Set(sockets.filter((s): s is string => Boolean(s)))].map((target) => ({ kind: 'connect', target }));
  return [...connects, ...files.map((target): ProbeAttempt => ({ kind: 'read', target }))];
}

/**
 * Runs inside the sandbox (node -e): each attempt, one JSON array out. A read opens the path and reports only what
 * it is (fstat), never a byte of it; a connect reports whether it connected.
 */
export const PROBE_JS = [
  "const fs = require('node:fs'), net = require('node:net');",
  'const one = (a) => new Promise((done) => {',
  "  if (a.kind === 'read') {",
  "    try { const fd = fs.openSync(a.target, 'r'); const st = fs.fstatSync(fd); fs.closeSync(fd);",
  "      done('opened ' + (st.isFile() ? 'file' : st.isCharacterDevice() ? 'char-device' : st.isDirectory() ? 'dir' : 'other')); }",
  "    catch (e) { done(String(e.code || 'error')); }",
  '    return;',
  '  }',
  '  const s = net.connect(a.target);',
  "  const t = setTimeout(() => { s.destroy(); done('ETIMEDOUT'); }, 5000);",
  "  s.on('connect', () => { clearTimeout(t); s.destroy(); done('connected'); });",
  "  s.on('error', (e) => { clearTimeout(t); done(String(e.code || 'error')); });",
  '});',
  '(async () => { const out = []; for (const a of JSON.parse(process.argv[1])) out.push(await one(a)); console.log(JSON.stringify(out)); })();',
].join('\n');

/** Whether `p` is denied in `settings`: by the sandbox's denyRead (itself or a folder holding it), and for a read by a Read rule too. */
export function denied(settings: unknown, a: ProbeAttempt): boolean {
  const s = settings as { sandbox?: { filesystem?: { denyRead?: string[] } }; permissions?: { deny?: string[] } };
  const under = (p: string) => (s.sandbox?.filesystem?.denyRead ?? []).some((d) => p === d || p.startsWith(`${d.replace(/\/$/, '')}/`));
  if (!under(a.target)) return false;
  if (a.kind === 'connect') return true;
  const rules = s.permissions?.deny ?? [];
  for (let d = a.target; ; d = dirname(d)) {
    if (rules.includes(`Read(/${a.target})`) || (d !== a.target && rules.includes(`Read(/${d}/**)`))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * One attempt's verdict. Refused only with the deny rule in place (a missing file counts as refused then, never
 * without it), and only when the sandbox saw an error, or for a read, something other than a regular file: the
 * sandbox masks a denied file with /dev/null (a character device). Connected, or a regular file opened: reached.
 */
export const verdict = (rule: boolean, kind: ProbeAttempt['kind'], seen: string): boolean => rule && seen !== 'connected' && !(kind === 'read' && seen === 'opened file');

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Refuses (throws) unless `srt --version` is SRT_VERSION. */
export function requireSrt(srt = 'srt'): string {
  const r = spawnSync(srt, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  const version = (r.stdout ?? '').trim();
  if (r.status !== 0 || version !== SRT_VERSION) {
    throw new Error(`not run: srt --version is ${version || `unreadable (${(r.stderr ?? String(r.error ?? '')).trim().slice(0, 200)})`}, not ${SRT_VERSION}: install @anthropic-ai/sandbox-runtime@${SRT_VERSION} for the bench user (scripts/bench/README.md)`);
  }
  return version;
}

/**
 * The probe: refuses (throws) unless `srt` is SRT_VERSION and every attempt was refused from inside the lane's
 * sandbox, else returns the per-attempt report (the run records it). A refusal carries the report too (`report`).
 */
export function sandboxProbe(o: LaneInput & { settings: unknown; srt?: string; timeoutMs?: number }): ProbeReport {
  const srt = o.srt ?? 'srt';
  requireSrt(srt);
  const attempts = probeAttempts(o);
  const s = o.settings as { sandbox?: { filesystem?: { denyRead?: string[] }; network?: { allowedDomains?: string[] } } };
  // The lane's sandbox, as sandbox-runtime's configuration: the same reads denied, the same (no) hosts allowed.
  const config = { network: { allowedDomains: s.sandbox?.network?.allowedDomains ?? [], deniedDomains: [] }, filesystem: { denyRead: s.sandbox?.filesystem?.denyRead ?? [], allowRead: [], allowWrite: [], denyWrite: [] } };
  const file = join(mkdtempSync(join(tmpdir(), 'bench-probe-')), 'settings.json');
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const r = spawnSync(srt, ['--settings', file, '--', process.execPath, '-e', PROBE_JS, JSON.stringify(attempts)], { encoding: 'utf8', timeout: o.timeoutMs ?? 120_000 });
  let seen: unknown;
  try {
    seen = JSON.parse((r.stdout ?? '').trim().split('\n').at(-1) ?? '');
  } catch {
    // unreadable: refused below
  }
  if (r.status !== 0 || !Array.isArray(seen) || seen.length !== attempts.length || !seen.every((x) => typeof x === 'string')) {
    throw new Error(`not run: the sandbox probe did not report (exit ${r.status}): ${(r.stderr ?? '').trim().slice(0, 300)}`);
  }
  const results = attempts.map((a, i) => {
    const rule = denied(o.settings, a);
    const saw = String(seen[i]);
    return { ...a, deny_rule: rule, on_host: lexists(a.target), seen: saw, refused: verdict(rule, a.kind, saw) };
  });
  const report = { runner: SRT_LABEL, results, ok: results.every((x) => x.refused) };
  if (!report.ok) {
    const bad = results.filter((x) => !x.refused).map((x) => `${x.kind} ${x.target}: ${x.deny_rule ? x.seen : 'no deny rule'}`);
    throw Object.assign(new Error(`not run: from inside the agents' sandbox, ${bad.join('; ')}`), { report });
  }
  return report;
}
