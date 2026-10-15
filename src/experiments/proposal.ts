// What one experimenter session hands back, and the checks the coordinator runs on it before any job exists
// (docs/experiments.md "The session"). The session's only output is one object in PROPOSAL_SCHEMA: there is no tool
// to start, watch or wait for a job. The change is the worktree's diff, which must stay inside the study's editable
// paths: anything else (the eval, the harness's config, a symlink, a mode change) is refused and logged, never run.
import { redactString } from '../events/redact.js';
import { globToRegExp } from '../guardrails/glob.js';
import { configRefusal, type Study } from './study.js';

export const TEXT_CAPS = { hypothesis: 200, motivation: 600, expected_effect: 200 } as const;

/** The session's structured output (the runner's jsonSchema): one hypothesis, one config, and nothing else. */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hypothesis', 'motivation', 'expected_effect', 'config'],
  properties: {
    hypothesis: { type: 'string', maxLength: TEXT_CAPS.hypothesis },
    motivation: { type: 'string', maxLength: TEXT_CAPS.motivation },
    expected_effect: { type: 'string', maxLength: TEXT_CAPS.expected_effect },
    config: { type: 'object' },
  },
} as const;

export interface Proposal {
  hypothesis: string;
  motivation: string;
  expected_effect: string;
  config: Record<string, string | number>;
}

/** Text from a session as the log keeps it: one paragraph, secrets redacted, cut to its cap. */
export const logText = (s: string, cap: number) => redactString(s.replace(/\s+/g, ' ').trim()).slice(0, cap);

/** The session's output as a proposal, or why it is refused. */
export function readProposal(raw: unknown, study: Study): Proposal | { refused: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { refused: 'the session returned no proposal' };
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(k in PROPOSAL_SCHEMA.properties));
  if (extra.length) return { refused: `unexpected fields: ${extra.join(', ')}` };
  for (const k of ['hypothesis', 'motivation', 'expected_effect'] as const) if (typeof o[k] !== 'string' || !(o[k] as string).trim()) return { refused: `no ${k}` };
  const why = configRefusal(o.config, study.config_schema);
  if (why) return { refused: `config: ${why}` };
  return {
    hypothesis: logText(o.hypothesis as string, TEXT_CAPS.hypothesis),
    motivation: logText(o.motivation as string, TEXT_CAPS.motivation),
    expected_effect: logText(o.expected_effect as string, TEXT_CAPS.expected_effect),
    config: o.config as Record<string, string | number>,
  };
}

/** One changed path as `git diff --raw -z --no-renames` reports it. */
export interface Change {
  path: string;
  oldMode: string;
  newMode: string;
  status: string;
}

/** `git diff --raw -z --no-renames <parent>` (with or without --cached) as changes. */
export function parseRawDiff(z: string): Change[] {
  const parts = z.split('\0');
  const out: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]!);
    if (!m) throw new Error(`not a raw diff line: ${parts[i]!.slice(0, 80)}`);
    out.push({ oldMode: m[1]!, newMode: m[2]!, status: m[3]!, path: parts[i + 1]! });
  }
  return out;
}

const FILE = new Set(['100644', '100755']);
/** A regular file's content change (its mode kept), a new plain file, or a removal: never a symlink, a submodule or a mode change. */
const plainChange = (o: string, n: string) => (o === '000000' ? n === '100644' : n === '000000' ? FILE.has(o) : FILE.has(o) && o === n);

/**
 * Whether a session's change may run: non-empty, only plain files (no symlink, no submodule, no mode change, no new
 * executable), every path inside the study's editable globs and none of its eval files. `lockfile`: it changes the
 * environment, which an owner approves first.
 */
export function checkChange(changes: readonly Change[], study: Study): { ok: true; files: string[]; lockfile: boolean } | { ok: false; why: string } {
  if (!changes.length) return { ok: false, why: 'no change' };
  const editable = study.editable.map(globToRegExp);
  for (const c of changes) {
    if (study.eval.files.includes(c.path)) return { ok: false, why: `changed the eval file ${c.path}` };
    if (!editable.some((r) => r.test(c.path))) return { ok: false, why: `changed ${c.path}, outside the study's editable paths` };
    if (!plainChange(c.oldMode, c.newMode)) return { ok: false, why: `${c.path}: only plain files may change, never a symlink, a submodule or a mode (${c.oldMode} -> ${c.newMode})` };
  }
  return { ok: true, files: changes.map((c) => c.path).sort(), lockfile: changes.some((c) => c.path === study.train.env.lockfile) };
}
