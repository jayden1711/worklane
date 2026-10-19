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
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { readRootFile } from './os/root-file.js';
import { etcPath } from './os/system-paths.js';

/** Root's record of the instances whose policy.yaml is root's: one file per instance, holding that policy.yaml's path. */
export const POLICY_ROOT_DIR = etcPath('policy-root');

/** The uid that owns a root policy: root. Tests stand another in (no test runs as root). */
let rootUid = 0;
export function setPolicyRootUid(uid: number): void {
  rootUid = uid;
}

/** The root shell command that makes an instance's policy.yaml root's again, keeping its content and showing its keys. */
export const ownCommand = (instance: string) => `sudo ${BRAND.cli} policy own ${instance}`;

/** Whether root's record says this policy.yaml is root's (its instance's record names exactly this file). */
export function policyRootRequired(file: string, dir = POLICY_ROOT_DIR): boolean {
  const path = resolve(file);
  try {
    return readFileSync(join(dir, basename(dirname(path))), 'utf8').trim() === path;
  } catch {
    return false;
  }
}

/**
 * A policy.yaml as the engine may read it: null when root's record doesn't cover it (read it as before); its text when
 * the record does and the file is root's alone (checked on the file opened: nothing swapped in after the check is
 * read); else why it is refused, and never read.
 */
export function readPolicyChecked(file: string, dir = POLICY_ROOT_DIR): { text: string } | { refused: string } | null {
  if (!policyRootRequired(file, dir)) return null;
  const r = readRootFile(resolve(file), rootUid);
  if ('text' in r) return r;
  return { refused: `refused: on this machine ${file} is root's and only root changes it, but ${r.problem.replace(`${resolve(file)} `, 'it ')}, so the coordinator user (or something running as it) wrote it. An admin checks it, then makes it root's again: ${ownCommand(basename(dirname(resolve(file))))}` };
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

/** The one value of each of these a coordinator may set (tightening); any other is an admin's, at a root shell (#698 decision 1). */
export const HELPER_ONLY: Readonly<Record<string, string>> = { land_mode: 'pr', main_watch: 'auto' };

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
 * Whether `set-policy <key> <arg>` is a change root's machine helper takes for a dashboard: a known key, its shape, and
 * never a loosening. The helper (scripts/machine/<cli>-machine.cjs) holds the same table, and checks it again.
 */
export function policySetOk(args: readonly string[]): boolean {
  if (args.length !== 2) return false;
  const [key, arg] = args as [string, string];
  if (!Object.hasOwn(POLICY_SET_KEYS, key) || decodePolicyValue(key, arg) === undefined) return false;
  return !Object.hasOwn(HELPER_ONLY, key) || HELPER_ONLY[key] === arg;
}
