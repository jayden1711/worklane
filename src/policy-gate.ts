// Single machine: an instance's policy.yaml is root's (issue #726). It holds the instance's isolation (sandbox,
// allow_same_user) and merge keys (land_mode, main_watch, auto_merge), so the coordinator user, and anything running
// as it, must not be able to loosen them. Setup makes the file root's (0644, the content kept: `<cli> policy own`, as
// root) and records that here, in root's directory. From then on:
//   - the engine reads that policy.yaml only while it is root's alone (readPolicyChecked), and refuses it otherwise:
//     a file the coordinator user wrote in its place is never read, so the instance stops instead (fail closed);
//   - the engine's own writers (the dashboard's Settings and Policy form) never write it; root changes one key of it
//     at a time (`<cli> policy set`, the keys below), which never takes a loosening of land_mode or main_watch from a
//     coordinator, nor sandbox or allow_same_user at all. A dashboard change goes to root's machine helper
//     (`<helper> set-policy <key> <value>`, through the coordinator), which runs it.
// An instance with no such record (a laptop, a cloud or VM install, a machine whose setup hasn't run again since)
// reads policy.yaml as before; doctor says when it is a machine install whose policy the coordinator can rewrite.
//
// INVARIANT (fail closed): the record is keyed on the instance's name, never on a path string, so how the engine
// spells the path (a home under a link) can't turn the check off. Any answer but "no record" (ENOENT) that isn't a
// record this engine reads refuses the policy. A recorded policy is read only when the file opened is the one the
// record names (the kernel's path for the opened file: a link in a directory on the way is refused) and its content
// hashes to what root last wrote, so an earlier root file the coordinator kept aside is refused too.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { HELPER_RULES, helperRules } from './machine.js';
import { readRootFile } from './os/root-file.js';
import { POLICY_ROOT_DIR } from './policy-kill.js';

/** Root's record of the instances whose policy.yaml is root's: one file per instance (policyRecord). */
export { POLICY_ROOT_DIR };

/** What root's record of an instance holds: its policy.yaml's real path, and the sha256 of what root last wrote there. */
export interface PolicyRecord {
  file: string;
  sha256: string;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The instance a policy.yaml belongs to: its directory's name (<instances>/<name>/policy.yaml). */
export const policyInstance = (file: string) => basename(dirname(resolve(file)));

/**
 * Root's record of `instance`: null only when there is none (ENOENT, or a name no file in the record directory can
 * have); else the record, or why it can't be used (unreadable, or not one this engine reads), which refuses the policy.
 */
export function policyRecord(instance: string, dir = POLICY_ROOT_DIR): PolicyRecord | { problem: string } | null {
  if (!instance || instance === '.' || instance === '..' || /[/\\\0]/.test(instance)) return null;
  const at = join(dir, instance);
  let text: string;
  try {
    text = readFileSync(at, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return { problem: `root's record of it (${at}) can't be read (${code ?? (e as Error).message})` };
  }
  try {
    const r = JSON.parse(text) as Partial<PolicyRecord>;
    if (typeof r.file === 'string' && r.file.startsWith('/') && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256)) return { file: r.file, sha256: r.sha256 };
  } catch {
    // below
  }
  return { problem: `root's record of it (${at}) isn't one this engine reads` };
}

/** The record's text, as root writes it. */
export const recordText = (r: PolicyRecord) => `${JSON.stringify({ file: r.file, sha256: r.sha256 })}\n`;

/** The uid that owns a root policy: root. Tests stand another in (no test runs as root). */
let rootUid = 0;
export function setPolicyRootUid(uid: number): void {
  rootUid = uid;
}
/** That uid, for a check that must read a file as root's helper will (src/settings.ts). */
export const policyRootUid = (): number => rootUid;

/**
 * The root shell command that makes an instance's policy.yaml root's, keeping its content and showing its keys. A
 * flag says what an admin checked first (policyCommand): `--retake`, a recorded file that changed since root wrote
 * it; `--accept-loose`, a policy looser than a coordinator could make it. Setup never passes either.
 */
export const ownCommand = (instance: string, ...flags: ('--retake' | '--accept-loose')[]) => `sudo ${BRAND.cli} policy own ${instance}${flags.map((f) => ` ${f}`).join('')}`;

/** Whether root's record covers this instance (any answer but "none" does: an unreadable record refuses, never skips). */
export function policyRootRequired(instance: string, dir = POLICY_ROOT_DIR): boolean {
  return policyRecord(instance, dir) !== null;
}

/**
 * Why `opened` (read from the file opened, with the kernel's path for it) isn't the file root's record names, with
 * the content root last wrote there; null when it is.
 */
export function recordMismatch(rec: PolicyRecord, opened: { text: string; at: string | null }): string | null {
  if (opened.at === null) return "where the opened file really is can't be checked on this system";
  if (opened.at !== rec.file) return `the file opened is ${opened.at}, not ${rec.file} as root's record says (a link on the way)`;
  if (sha256(opened.text) !== rec.sha256) return "its content isn't what root last wrote there (an earlier or other file put back in its place)";
  return null;
}

/**
 * A policy.yaml as the engine may read it: null when root's record doesn't cover its instance (read it as before);
 * its text when the record does, the file is root's alone (checked on the file opened: nothing swapped in after the
 * check is read), it is the file the record names, and its content is what root last wrote; else why it is refused,
 * and never read.
 */
export function readPolicyChecked(file: string, dir = POLICY_ROOT_DIR, instance = policyInstance(file), uid = rootUid): { text: string } | { refused: string } | null {
  const rec = policyRecord(instance, dir);
  if (rec === null) return null;
  const refused = (why: string) => ({ refused: `refused: on this machine ${file} is root's and only root changes it, but ${why}, so the coordinator user (or something running as it) may have changed it. An admin checks it, then makes it root's again: ${ownCommand(instance, '--retake')}` });
  if ('problem' in rec) return refused(rec.problem);
  const r = readRootFile(resolve(file), uid);
  if ('problem' in r) return refused(r.problem.replace(`${resolve(file)} `, 'it '));
  const why = recordMismatch(rec, r);
  return why ? refused(why) : { text: r.text };
}

/** How a value is written as one plain-word argument. */
type Kind = 'number' | 'bool' | 'word' | 'windows';

/**
 * Every key `<cli> policy set` changes (the Policy form's and the Settings page's), and how its value is written as one
 * plain word. Never sandbox, allow_same_user, lanes or the allowlists. test/policy-edit.test.ts holds this equal to
 * POLICY_KEYS plus settings.<SETTING_KEYS>, and to the machine helper's own copy.
 */
export const POLICY_SET_KEYS: Readonly<Record<string, Kind>> = {
  'budget.daily_usd': 'number',
  'agents.max_workers': 'number',
  land_mode: 'word',
  auto_merge: 'bool',
  main_watch: 'word',
  'automations.enabled': 'bool',
  'settings.workers': 'number',
  'settings.daily_budget_usd': 'number',
  'settings.ci_repair.enabled': 'bool',
  'settings.ci_repair.max_fixes_per_pr': 'number',
  'settings.run_windows': 'windows',
  'settings.research.max_searches_per_day': 'number',
  'settings.research.max_fetches_per_day': 'number',
  'settings.research.max_usd_per_day': 'number',
  'settings.research.repo_access': 'bool',
  'settings.intake.reports_per_sender_per_day': 'number',
  'settings.intake.drafts_per_day': 'number',
  'settings.intake.max_usd_per_day': 'number',
  'settings.stuck_guard': 'word',
  'settings.chat_attachments.max_file_mb': 'number',
  'settings.chat_attachments.max_message_mb': 'number',
  'settings.chat_attachments.retention_days': 'number',
};

/**
 * The one value of each of these a coordinator may set (tightening); any other is an admin's, at a root shell (#698
 * decision 1; auto_merge on is root's only, the owner's decision on #770). The machine helper holds the same table
 * (POLICY_ONLY), and test/policy-edit.test.ts holds them equal. `policy own` derives what is loose from it too.
 */
export const HELPER_ONLY: Readonly<Record<string, string>> = { land_mode: 'pr', main_watch: 'auto', auto_merge: 'off' };

/**
 * Keys whose HELPER_ONLY value is the only one a dashboard sets on EVERY install, whether its policy.yaml is root's or
 * the coordinator's (a laptop, cloud or VM install, or a machine not taken over yet): every HELPER_ONLY key. Turning
 * auto_merge on, land_mode to direct or main_watch off is an admin's alone (the owner's decisions on #770: auto_merge
 * 2026-10-18; land_mode and anything else that loosens, 2026-10-19, principle 6). test/policy-edit.test.ts holds it
 * equal to HELPER_ONLY's keys.
 */
export const DASHBOARD_TIGHTEN_ONLY: readonly string[] = ['land_mode', 'main_watch', 'auto_merge'];

/** The root shell command that sets one key of an instance's policy.yaml. */
export const policySetCommand = (instance: string, key: string, arg: string) => `sudo ${BRAND.cli} policy set ${instance} ${key} ${arg}`;

/**
 * Why root's machine helper can't take `set-policy <key> <arg>` on this machine, or null when it can (or nothing says
 * it can't). machine-helper.sh records the rules it left out in helper-rules.json's left_out: a sudo older than 1.9.10
 * reads a command's argument pattern as literal text, so every pattern rule is left out together (lib.sh
 * machine_sudoers), set-policy's among them. A record from before set-policy existed lists add-project instead, which
 * means the same sudo. The HELPER_ONLY tightenings (auto_merge off, land_mode pr, main_watch auto) are listed whole on
 * every sudo, so they are never missing: turning auto_merge off works on any sudo.
 */
export function policyHelperMissing(rulesFile = HELPER_RULES, change?: readonly [string, string]): string | null {
  if (change && Object.hasOwn(HELPER_ONLY, change[0]) && HELPER_ONLY[change[0]] === change[1]) return null;
  const r = helperRules(rulesFile);
  if (!r || !(r.leftOut.includes('set-policy') || r.leftOut.includes('add-project'))) return null;
  return `this machine's sudo (${r.sudo ?? 'version unknown'}) is older than 1.9.10, so root's helper has no set-policy rule here and a dashboard request would only fail`;
}

const NUMBER = /^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/;
const WINDOWS = /^(none|[0-2][0-9][0-5][0-9]-[0-2][0-9][0-5][0-9](\+[0-2][0-9][0-5][0-9]-[0-2][0-9][0-5][0-9]){0,7})$/;

/** A value as the helper's argument (the inverse of decodePolicyValue), or null when it can't be one. */
export function encodePolicyValue(key: string, value: unknown): string | null {
  const kind = POLICY_SET_KEYS[key];
  if (kind === 'bool') return typeof value === 'boolean' ? (value ? 'on' : 'off') : null;
  if (kind === 'number') return typeof value === 'number' && NUMBER.test(String(value)) ? String(value) : null;
  if (kind === 'word') return typeof value === 'string' && /^[a-z][a-z-]{0,15}$/.test(value) ? value : null;
  if (kind === 'windows') {
    if (!Array.isArray(value)) return null;
    const hm = (s: unknown) => (typeof s === 'string' && /^\d\d:\d\d$/.test(s) ? s.replace(':', '') : null);
    const parts = value.map((w: { from?: unknown; to?: unknown }) => (w && hm(w.from) && hm(w.to) ? `${hm(w.from)}-${hm(w.to)}` : null));
    const out = parts.length ? parts.join('+') : 'none';
    return parts.every((p) => p !== null) && WINDOWS.test(out) ? out : null;
  }
  return null;
}

/** The value a plain-word argument stands for (on|off, a number, a word, HHMM-HHMM+... or none), or undefined when it isn't one of its key's shape. */
export function decodePolicyValue(key: string, arg: string): unknown {
  const kind = POLICY_SET_KEYS[key];
  if (kind === 'bool') return arg === 'on' ? true : arg === 'off' ? false : undefined;
  if (kind === 'number') return NUMBER.test(arg) ? Number(arg) : undefined;
  if (kind === 'word') return /^[a-z][a-z-]{0,15}$/.test(arg) ? arg : undefined;
  if (kind === 'windows') return WINDOWS.test(arg) ? (arg === 'none' ? [] : arg.split('+').map((w) => ({ from: `${w.slice(0, 2)}:${w.slice(2, 4)}`, to: `${w.slice(5, 7)}:${w.slice(7, 9)}` }))) : undefined;
  return undefined;
}

/**
 * The keys the dashboard and the coordinator's route only ever tighten, on every install (the owner's decision of
 * 2026-10-19, principles 3 and 6): every key `policy set` takes but the HELPER_ONLY ones (tighten-only already). The
 * value in effect now is the ceiling; loosening past it is root's or the admin's. How each loosens: a number up
 * (budget, workers, every cap, attachment size and retention), a switch on (automations, ci_repair,
 * research.repo_access), `stuck_guard` toward off (on, dry-run, off), `run_windows` to any time the current windows
 * don't cover (none means any time).
 */
export const CEILING_KEYS: readonly string[] = Object.keys(POLICY_SET_KEYS).filter((k) => !Object.hasOwn(HELPER_ONLY, k));
const STUCK_RANK: Readonly<Record<string, number>> = { off: 0, 'dry-run': 1, on: 2 };
/** The minutes of a day a run_windows value allows ([] or none: all of them). */
function windowMinutes(v: unknown): Set<number> | null {
  if (!Array.isArray(v)) return null;
  const all = new Set<number>();
  if (!v.length) for (let m = 0; m < 1440; m++) all.add(m);
  for (const w of v as { from?: unknown; to?: unknown }[]) {
    const at = (s: unknown) => (typeof s === 'string' && /^\d\d:\d\d$/.test(s) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null);
    const [a, b] = [at(w?.from), at(w?.to)];
    if (a === null || b === null) return null;
    for (let m = a; m !== b; m = (m + 1) % 1440) all.add(m);
  }
  return all;
}
/** Whether `value` is looser than root's `ceiling` for `key` (anything this can't compare counts as looser). */
export function looserThan(key: string, value: unknown, ceiling: unknown): boolean {
  const kind = POLICY_SET_KEYS[key];
  if (kind === 'number') return typeof value !== 'number' || typeof ceiling !== 'number' || value > ceiling;
  if (kind === 'bool') return value === true && ceiling !== true;
  if (key === 'settings.stuck_guard') return !(String(value) in STUCK_RANK) || STUCK_RANK[String(value)]! < (STUCK_RANK[String(ceiling)] ?? 2);
  if (kind === 'windows') {
    const [v, c] = [windowMinutes(value), windowMinutes(ceiling)];
    return !v || !c || [...v].some((m) => !c.has(m));
  }
  return true;
}
/**
 * Why the dashboard or the coordinator's route may not set `key` to `value`: it loosens the value in effect now
 * (`current`), or null. `current` undefined means the caller can't tell it (root, for a setting the repo's config
 * decides; anyone, for an intake cap when intake.yaml doesn't load): then only turning a switch off is provably
 * tighter, and anything else is refused (fail closed). `route` is what the admin runs instead.
 */
export function tightenProblem(key: string, value: unknown, current: unknown, route: string): string | null {
  if (!CEILING_KEYS.includes(key)) return null;
  const shown = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
  const from = key.startsWith('settings.intake.') ? "intake.yaml beside it doesn't load" : "the repo's config sets it";
  if (current === undefined) return POLICY_SET_KEYS[key] === 'bool' && value === false ? null : `${key} ${shown(value)}: the value in effect isn't in policy.yaml (${from}), so this route can't tell it would only tighten; an admin sets it (${route})`;
  return looserThan(key, value, current) ? `${key} ${shown(value)} would loosen it (now ${shown(current)}): the dashboard only tightens; an admin does that (${route})` : null;
}

/** The admin's route for a value the dashboard may not set: root's command, or, before a takeover, own then set on a machine, or an edit of the file (or its Helm value) elsewhere. */
export function adminRoute(path: string, key: string, arg: string, root: boolean, machine: boolean): string {
  const instance = policyInstance(path);
  if (root) return policySetCommand(instance, key, arg);
  if (machine) return `${ownCommand(instance)}, then ${policySetCommand(instance, key, arg)}`;
  return `edit ${path} (${key}: ${String(decodePolicyValue(key, arg))}), or its Helm value`;
}

/**
 * Whether `set-policy <key> <arg>` is a change root's machine helper takes for a dashboard: a known key, its shape, and
 * never a loosening. The helper (scripts/machine/<cli>-machine.cjs) holds the same table, and checks it again.
 */
export function policySetOk(args: readonly string[]): boolean {
  if (args.length !== 2) return false;
  const [key, arg] = args as [string, string];
  if (!Object.hasOwn(POLICY_SET_KEYS, key) || decodePolicyValue(key, arg) === undefined) return false;
  return !Object.hasOwn(HELPER_ONLY, key) || HELPER_ONLY[key] === arg;
}
