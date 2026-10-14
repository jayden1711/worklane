#!/usr/bin/env node
// The pre-push hook's launcher: it runs the push gate (scripts/push-gate.mjs) and its rule files as they are on
// origin's default branch, fetched on this very push, never the copy in the checkout or on the branch being pushed.
//
//   pre-push hook:  node push-gate-hook.mjs <remote> [<url>]       (refs on stdin; installed by npm run setup:hooks)
//   by hand:        node scripts/push-gate-hook.mjs --range <base>..<tip>     (npm run check:push)
//   the file set:   node scripts/push-gate-hook.mjs --print-gate-files
//
// WHY: a hook that ran the checkout's gate enforced whatever rules that checkout happened to hold (a stale one
// refused a merge of main over an allowlist it didn't have yet), and one that ran the pushed branch's gate let
// the branch rewrite the rules that judge it.
//
// It fails closed: no origin, no default branch on it, a gate file missing there, or any error refuses the push.
// Only when the fetch itself fails (offline) does it fall back: to origin's default branch as last fetched, or
// with none to the checkout's own copy, each under a loud warning.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The gate and every file it imports (test/push-gate-hook.test.ts checks this against the real imports). */
export const GATE_CODE = ['scripts/push-gate.mjs', 'scripts/lib/denylist.mjs'];
/** The rule files the gate and gitleaks read from the directory they run in. */
export const GATE_RULES = { required: ['.denylist.json'], optional: ['.denylist-allow', '.gitleaks.toml', '.gitleaksignore'] };
const REMOTE = 'origin';
const SELF = 'scripts/push-gate-hook.mjs';

class Refusal extends Error {}
/** A refusal that first-time setup may answer with PUSH_GATE_BOOTSTRAP=1 (origin doesn't hold the gate yet). */
class NotOnOrigin extends Refusal {}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
}
const tryGit = (args, opts) => {
  try {
    return git(args, opts).trim();
  } catch {
    return null;
  }
};

function loud(lines) {
  const bar = '!'.repeat(78);
  console.error(['', bar, ...lines.map((l) => `!! ${l}`), bar, ''].join('\n'));
}

/** origin's default branch: what origin/HEAD names, else main. Read from this clone's refs, never from the pushed tree. */
function defaultBranch() {
  const head = tryGit(['symbolic-ref', '--quiet', '--short', `refs/remotes/${REMOTE}/HEAD`]);
  return head?.startsWith(`${REMOTE}/`) ? head.slice(REMOTE.length + 1) : 'main';
}

/** Fetch origin's default branch. Returns null when it worked, else why it didn't. */
function fetchDefault(branch) {
  const asked = Number(process.env.PUSH_GATE_FETCH_TIMEOUT ?? 20);
  const seconds = Number.isFinite(asked) && asked > 0 ? asked : 20;
  const start = Date.now();
  try {
    // WHY: no prompt and a C locale: a hook must not hang on a credential question, and the "no such branch" answer is matched below.
    git(['fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${REMOTE}/${branch}`], {
      timeout: seconds * 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    return null;
  } catch (e) {
    const err = String(e.stderr ?? '').trim();
    if (/couldn't find remote ref/i.test(err)) throw new NotOnOrigin(`${REMOTE} has no ${branch} branch, so there is no gate to load from it.`);
    // WHY: by the clock, not the error: a git cut off at the timeout can still exit with a transport message of its own.
    return Date.now() - start >= seconds * 1000 ? `no answer within ${seconds}s` : err.split('\n').slice(-2).join(' ') || e.message;
  }
}

/** Write the gate and its rules, as they are at `rev`, into `dir`. */
function extractFromRev(rev, label, dir) {
  const has = (path) => tryGit(['cat-file', '-e', `${rev}:${path}`]) !== null;
  for (const path of [...GATE_CODE, ...GATE_RULES.required, ...GATE_RULES.optional]) {
    if (!has(path)) {
      if (GATE_RULES.optional.includes(path)) continue;
      throw new NotOnOrigin(`${label} has no ${path}.`);
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), execFileSync('git', ['show', `${rev}:${path}`], { maxBuffer: 64 * 1024 * 1024 }));
  }
}

/** Copy the gate and its rules from the checkout's working files into `dir`. */
function extractFromCheckout(top, dir) {
  for (const path of [...GATE_CODE, ...GATE_RULES.required, ...GATE_RULES.optional]) {
    if (!existsSync(join(top, path))) {
      if (GATE_RULES.optional.includes(path)) continue;
      throw new Refusal(`no gate found at all: ${join(top, path)} is missing too.`);
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(top, path), join(dir, path));
  }
}

/** The checkout's commit and how far it is behind origin's default branch as last fetched, for the warning. */
function checkoutState(branch) {
  const head = tryGit(['log', '-1', '--format=%h (%cs) %s', 'HEAD']) ?? 'unknown commit';
  const behind = tryGit(['rev-list', '--count', `HEAD..refs/remotes/${REMOTE}/${branch}`]);
  return [`checkout at ${head}`, behind === null ? `how far behind ${REMOTE}/${branch}: unknown (never fetched here)` : `${behind} commit(s) behind ${REMOTE}/${branch} as last fetched`];
}

/** Fill `dir` with the gate to run. Returns the line that says where it came from. */
function loadGate(dir, top) {
  const branch = defaultBranch();
  const ref = `refs/remotes/${REMOTE}/${branch}`;
  try {
    if (tryGit(['remote', 'get-url', REMOTE]) === null) throw new NotOnOrigin(`this repo has no "${REMOTE}" remote, and the gate and its rules are loaded from ${REMOTE}'s ${branch} branch.`);
    const failed = fetchDefault(branch);
    const rev = tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (failed !== null && rev === null) {
      extractFromCheckout(top, dir);
      loud([
        `PUSH GATE: could not fetch ${REMOTE}/${branch} (${failed}),`,
        `and this clone has never fetched it. Falling back to THE CHECKOUT'S OWN COPY of the gate`,
        `and its rules, which the branch being pushed can change:`,
        ...checkoutState(branch).map((l) => `  ${l}`),
        `Fetch ${REMOTE} and push again when you are back online.`,
      ]);
      return `the checkout's own copy (${REMOTE}/${branch} unreachable)`;
    }
    if (rev === null) throw new Error(`${ref} is missing after a fetch that reported success`);
    extractFromRev(rev, `${REMOTE}/${branch}`, dir);
    const at = git(['log', '-1', '--format=%h (%cs)', rev]).trim();
    if (failed !== null) {
      loud([
        `PUSH GATE: could not fetch ${REMOTE}/${branch} (${failed}).`,
        `Using the gate and rules of ${REMOTE}/${branch} AS LAST FETCHED: ${at}.`,
        `They may be stale: rules added on ${REMOTE} since then are not applied.`,
      ]);
      return `${REMOTE}/${branch} as last fetched, ${at}`;
    }
    return `${REMOTE}/${branch} at ${at}`;
  } catch (e) {
    if (!(e instanceof NotOnOrigin)) throw e;
    if (process.env.PUSH_GATE_BOOTSTRAP !== '1') {
      throw new Refusal(`${e.message}\nFirst-time setup (the gate isn't on ${REMOTE}/${branch} yet): push once with PUSH_GATE_BOOTSTRAP=1 to use the checkout's own copy.`);
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { mode: 0o700 });
    extractFromCheckout(top, dir);
    loud([`PUSH GATE: PUSH_GATE_BOOTSTRAP=1. ${e.message}`, `Using THE CHECKOUT'S OWN COPY of the gate and its rules:`, ...checkoutState(branch).map((l) => `  ${l}`)]);
    return "the checkout's own copy (bootstrap)";
  }
}

/** Say so when the installed hook is no longer the one on origin's default branch. */
function noteIfHookIsOld() {
  const branch = defaultBranch();
  const current = tryGit(['show', `refs/remotes/${REMOTE}/${branch}:${SELF}`]);
  const norm = (s) => s.replace(/\r\n/g, '\n').trim();
  if (current !== null && norm(current) !== norm(readFileSync(fileURLToPath(import.meta.url), 'utf8'))) {
    console.error(`push gate: note: the installed hook differs from ${REMOTE}/${branch}'s ${SELF}. Reinstall it from an up-to-date checkout: npm run setup:hooks`);
  }
}

function main(argv) {
  if (argv[0] === '--print-gate-files') {
    console.log(JSON.stringify({ code: GATE_CODE, rules: GATE_RULES }));
    return 0;
  }
  const hookMode = argv[0] !== '--range';
  const top = git(['rev-parse', '--show-toplevel']).trim();
  const gitDir = git(['rev-parse', '--absolute-git-dir']).trim();
  // INVARIANT: the gate and its rules live in a directory only this user can read, and it is gone when the hook returns.
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-'));
  try {
    chmodSync(dir, 0o700);
    const from = loadGate(dir, top);
    console.error(`push gate: gate and rules from ${from}`);
    if (hookMode) noteIfHookIsOld();
    // WHY: the gate reads its rules (and gitleaks its config) from the directory it runs in, so it runs in the
    // private copy; GIT_DIR points its git commands at this repo, and nothing else of the checkout is in reach.
    const env = { ...process.env, GIT_DIR: gitDir };
    for (const k of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete env[k];
    const r = spawnSync(process.execPath, [join(dir, GATE_CODE[0]), ...argv], { cwd: dir, stdio: 'inherit', env });
    if (r.error) throw r.error;
    if (r.status !== 0) console.error(`push gate: judged by the rules of ${from}. An entry in .denylist-allow counts once it is on ${REMOTE}'s default branch, not on the branch being pushed.`);
    return r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`push gate: REFUSED. ${e instanceof Refusal ? e.message : `the hook itself failed, so nothing is pushed: ${e.message}`}`);
  process.exitCode = 1;
}
