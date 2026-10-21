// releaseBase (#895), the main channel's one step that takes a release tag's signature as proof, keeps the release
// channel's order: the signers-file hold refuses before anything is listed or verified. As test/updater-setup.test.ts
// checks it for the release channel, this checks it for releaseBase, by behaviour and by source order, so a hold check
// moved after the verify call (or dropped) fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

type Base = { ok: true; base: string; tag: string } | { ok: false; reason: string };
type ReleaseBase = (deps: object, cfg: object, current: string) => Base;

const CURRENT = 'a'.repeat(40);
const OBJECT = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const CFG = { repo_url: 'https://github.com/example-org/engine.git', branch: 'main', allowed_signers: '/etc/example/allowed_signers' };
const HOLD = { at: '2026-10-20T00:00:00Z', file: '/etc/example/allowed_signers', from: 'sha256:a', to: 'sha256:b', linesBefore: 1, linesAfter: 2, added: [], removed: [] };

/** Stand-in deps: a tag listing naming the installed commit and a verifier that proves it, each call recorded. */
function deps(hold: typeof HOLD | null) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      exec: (file: string, args: string[]) => (calls.push(`${file} ${args[0]}`), `${OBJECT}\trefs/tags/v1.0.0\n${CURRENT}\trefs/tags/v1.0.0^{}\n`),
      verifyRelease: (_url: string, tag: string) => (calls.push(`verify ${tag}`), { ok: true, base: BASE, object: OBJECT, commit: CURRENT }),
      signersHold: () => hold,
    },
  };
}

/** Why releaseBase's behaviour breaks the order (a held signers file must refuse with nothing listed or verified), or null. */
export function behaviourProblem(releaseBase: ReleaseBase): string | null {
  const open = deps(null);
  const proven = releaseBase(open.deps, CFG, CURRENT);
  if (!proven.ok || proven.base !== BASE || !open.calls.includes('verify v1.0.0')) return `the stand-in release isn't proven without a hold: ${JSON.stringify(proven)}`;
  const held = deps(HOLD);
  const r = releaseBase(held.deps, CFG, CURRENT);
  if (r.ok) return 'a held signers file is taken as proof';
  if (!/the signers file changed outside updates\.sh/.test(r.reason)) return `refused for another reason: ${r.reason}`;
  if (held.calls.length) return `with the signers file held, it still ran: ${held.calls.join(', ')}`;
  return null;
}

/** Why releaseBase's source breaks the order (its hold refusal must come before its one verify call), or null. */
export function sourceProblem(src: string): string | null {
  const start = src.indexOf('\nfunction releaseBase(');
  const end = start < 0 ? -1 : src.indexOf('\n}\n', start);
  if (start < 0 || end < 0) return 'releaseBase not found';
  const body = src.slice(start, end);
  const hold = body.indexOf('if (signersHeld) return { ok: false');
  const verify = body.indexOf('const proof = deps.verifyRelease(cfg.repo_url, tag.tag, cfg.allowed_signers || ALLOWED_SIGNERS);');
  if (body.split('deps.verifyRelease(').length - 1 !== 1) return 'releaseBase must call deps.verifyRelease exactly once';
  if (!(hold > 0 && verify > hold)) return 'the hold is checked before the release is verified, and the verify call is as it was';
  return null;
}

const updater = join(repoRoot, 'scripts', 'machine', 'worklane-update.cjs');

test('#895 releaseBase: a held signers file is refused, with no tag listed and the verifier never called', () => {
  const { releaseBase } = createRequire(import.meta.url)(updater) as { releaseBase: ReleaseBase };
  assert.equal(behaviourProblem(releaseBase), null);
});

test('#895 releaseBase: its signers-hold refusal comes before its one verify call in the source', () => {
  const src = readFileSync(updater, 'utf8');
  assert.equal(sourceProblem(src), null);
  // The updater calls the verifier in two places only: the release channel and releaseBase, each after its hold.
  assert.equal(src.split('deps.verifyRelease(').length - 1, 2, 'no third verify call, unguarded');
});
