// The owner terminal is gone (#742). It was a login shell as the machine's admin user, opened from the hub's Setup
// page, which the hub's viewer user started through a sudoers rule that let it run a root-installed console shell as
// that user. This engine has no terminal and never starts that shell. An install that had it keeps, until root runs
// dashboards.sh again (which removes them):
//   - the console shell, CONSOLE_SHELL (root:root 0755), and its sudoers rule (/etc/sudoers.d/<cli>-console, which
//     only root can see), so the hub's user could still start that shell as the admin user;
//   - a hub unit that names a console user (--console-user) and runs without NoNewPrivileges, ProtectSystem=strict
//     and ProtectHome=read-only.
// So the Setup page (an owner's) and doctor say so, and how to remove them, while any of it is there. doctor gives the
// exact rerun, built from the hub unit's own ExecStart, so that it keeps every setting the hub has (its devices, its
// Siri and hooks gateways, its instances); everything else, and doctor when it can't read the unit, gives the one
// placeholder version, OWNER_TERMINAL_RERUN. The Tailscale screen's public-url step shows its by-hand command the same
// way (#767): exact from the unit with the new URL, or the placeholder.
import { existsSync, readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import { instanceNameOk } from '../instance-name.js';
import { readRegularFile } from '../os/index.js';
import { asRoot, libexecPath, SYSTEM_ROOTS, unitPath } from '../os/system-paths.js';

/** The removed terminal's root-installed console shell (scripts/setup/lib.sh CONSOLE_SHELL): what dashboards.sh removes. */
export const CONSOLE_SHELL = libexecPath('console-shell');
/** dashboards.sh as root runs it on an install (scripts/setup/engine.sh puts the engine at /opt/<cli>/current). */
const DASHBOARDS_SH = asRoot.opt('current/scripts/setup/dashboards.sh');
/** The hub's unit as root sees it, for text only (lib.sh HUB_UNIT). */
export const HUB_UNIT_AS_ROOT = `${SYSTEM_ROOTS.units}/${BRAND.cli}-dashboard-hub.service`;
/** The values a rerun sets anew instead of keeping the unit's: a new sign-in App's client id, a new URL. */
export interface HubRerunValues {
  clientId?: string | undefined;
  publicUrl?: string | undefined;
}
/**
 * dashboards.sh again with every setting the hub's unit has (its devices, its sign-in App, its Siri and hooks gateways,
 * its instances), each <...> and [...] filled in from the unit's ExecStart, and these values (text, or a <...> naming
 * them) in place of its own. The one placeholder form of every rerun the engine shows: leaving out --siri or --hooks
 * drops that gateway's port and its token's ACL (#752, #767). test/owner-terminal-rerun.test.ts scans src/, scripts/
 * and docs/ for any other dashboards.sh command with --client-id that leaves them out.
 */
export const hubRerunPlaceholder = (set: HubRerunValues = {}): string =>
  `sudo bash ${DASHBOARDS_SH} [--machine-devices <the hub unit's --console-devices or --machine-devices, if it has one>] --client-id ${set.clientId ?? '<its --client-id>'} --public-url ${set.publicUrl ?? '<its --public-url>'} [--siri if it has --siri-port] [--hooks if it has --hooks-port] <each instance name in its --hub>...`;
/**
 * The one placeholder version of the root step that removes what is left, each <...> and [...] filled in from the hub
 * unit's ExecStart. CHANGELOG v0.5.3 (Upgrading and After install), docs/dashboard.md, the Setup notice and the
 * console shell stub's refusal each hold this text verbatim (test/owner-terminal-removed.test.ts). doctor gives it
 * only when it can't build the exact command (ownerTerminalRerun).
 */
export const OWNER_TERMINAL_RERUN = hubRerunPlaceholder();
/** A new value that dashboards.sh wouldn't take, or none known, as the placeholder names it. */
const NEW_VALUE_PLACEHOLDER: Required<HubRerunValues> = { clientId: "<the sign-in App's client id>", publicUrl: 'https://<name>' };
/**
 * What `tailscale.sh public-url` does, by hand: the hub's own settings and its new URL. tailscale.sh's header and
 * docs/dashboard.md hold this text verbatim (test/owner-terminal-rerun.test.ts).
 */
export const TAILSCALE_PUBLIC_URL_RERUN = hubRerunPlaceholder({ publicUrl: NEW_VALUE_PLACEHOLDER.publicUrl });
/**
 * After a sign-in App's client secret is installed by hand on a machine whose hub is set up (credentials.sh
 * dashboard-signin): the hub's own settings and that App's client id. credentials.sh holds this text verbatim.
 */
export const SIGNIN_APP_RERUN = hubRerunPlaceholder({ clientId: NEW_VALUE_PLACEHOLDER.clientId });
/** The hub's unit, as dashboards.sh writes it (src/setup-steps.ts MACHINE_PATHS.hubUnitFile). */
const HUB_UNIT_FILE = unitPath(`${BRAND.cli}-dashboard-hub.service`);

export interface TerminalPaths {
  hubUnitFile?: string;
  consoleShell?: string;
  /** Who must own the hub unit for doctor to build the command from it: root (tests pass their own uid). */
  rootUid?: number;
}

/** What this machine still has of the removed owner terminal, one plain sentence each; empty when nothing. */
export function ownerTerminalLeftovers(o: TerminalPaths = {}): string[] {
  const out: string[] = [];
  let unit = '';
  try {
    unit = readFileSync(o.hubUnitFile ?? HUB_UNIT_FILE, 'utf8');
  } catch {
    // no hub on this machine (local mode), or not readable: nothing to say from it
  }
  if (/^ExecStart=.* --console-user \S/m.test(unit)) out.push("the dashboard hub's unit still names a console user and runs without its sandbox (NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only)");
  const shell = o.consoleShell ?? CONSOLE_SHELL;
  // An older engine updater replaces it with a stub that refuses everything (scripts/machine/<cli>-console-shell.sh);
  // the sudoers rule naming it stays until the rerun either way, so it is said the same.
  if (existsSync(shell)) out.push(`the console shell ${shell} is still installed, with the sudoers rule that lets the hub's user start it as the admin user`);
  return out;
}

/**
 * The notice the Setup page and doctor show while anything of the owner terminal is left; null when nothing is.
 * `exactAbove`: doctor printed the exact command on the line above, so the notice points at it and holds no second,
 * placeholder command.
 */
export function ownerTerminalNotice(o: TerminalPaths = {}, exactAbove = false): string | null {
  const left = ownerTerminalLeftovers(o);
  if (!left.length) return null;
  const run = exactAbove ? `with the exact command on the line above (built from its unit's ExecStart, ${HUB_UNIT_AS_ROOT})` : `with the hub's own settings filled in from its unit's ExecStart (${HUB_UNIT_AS_ROOT}): ${OWNER_TERMINAL_RERUN}`;
  return `The owner terminal has been removed from the dashboard, but this machine still has it set up: ${left.join('; and ')}. As root, run dashboards.sh again once, ${run}, which removes the console shell and its sudoers rule and gives the hub its sandbox back. For a shell on this machine, use ssh; the break-glass (port 4398, through ssh) still works.`;
}

/** What dashboards.sh needs to write the hub's unit again with every setting it has now. */
export interface HubSettings {
  /** --machine-devices; null: the unit lists none (every device refused, as now). */
  machineDevices: string | null;
  clientId: string;
  publicUrl: string;
  siri: boolean;
  hooks: boolean;
  /** The instances the hub serves; none: --no-instances. */
  instances: string[];
}

/** One shell word that is exactly `v`: single-quoted, each ' closed, escaped and reopened. Nothing in it expands. */
export const shellQuote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`;

/** The rerun, exactly, for these settings: every value one single-quoted word, so pasting it runs nothing else. */
export function rerunCommand(s: HubSettings): string {
  const w = ['sudo', 'bash', DASHBOARDS_SH];
  if (s.machineDevices !== null) w.push('--machine-devices', shellQuote(s.machineDevices));
  w.push('--client-id', shellQuote(s.clientId), '--public-url', shellQuote(s.publicUrl));
  if (s.siri) w.push('--siri');
  if (s.hooks) w.push('--hooks');
  // dashboards.sh reads every word after -- as an instance name.
  w.push(...(s.instances.length ? ['--', ...s.instances.map(shellQuote)] : ['--no-instances']));
  return w.join(' ');
}

/**
 * Every option a hub unit's ExecStart has ever had (dashboards.sh hub_unit, before and after #742), and the
 * dashboards.sh option that wrote it. lib.sh hub_keep_args, which add-project, instance removal and renames rerun
 * dashboards.sh with, keeps the same ones. --machine-owner never reaches the unit (its own root file, kept as it is).
 */
const UNIT_OPTIONS: Record<string, string> = {
  '--hub': 'the instance names (each <name>=<state>; "-": --no-instances)',
  '--client-id': '--client-id',
  '--public-url': '--public-url',
  '--signin-dir': 'none: dashboards.sh writes the viewer user\'s own',
  '--siri-port': '--siri (always port 4397)',
  '--hooks-port': '--hooks (always port 4396)',
  '--console-user': 'none: the removed terminal\'s, ignored',
  '--console-devices': '--machine-devices (its older name)',
  '--machine-devices': '--machine-devices',
};
/**
 * The patterns dashboards.sh itself holds each printed value to (it refuses anything else, exit 2), so doctor never
 * prints a value dashboards.sh would refuse, and none can hold a control character, a quote, a backtick or a glob.
 * test/owner-terminal-rerun.test.ts reads them back out of scripts/setup/dashboards.sh, so the two can't drift.
 * Instance names are held to dashboards.sh's need_instance_name (lib.sh instance_name_problem): instanceNameOk.
 */
export const HUB_VALUE_PATTERNS = {
  /** dashboards.sh: [[ "$client_id" =~ ... ]] */
  clientId: /^[A-Za-z0-9._-]{8,64}$/,
  /** dashboards.sh url_ok */
  publicUrl: /^https:\/\/[a-z0-9.-]+$/,
  /** dashboards.sh: [[ "$machine_devices" =~ ... ]] (and the older --console-devices, the same pattern) */
  machineDevices: /^[a-z0-9:.,-]+$/,
} as const;
/**
 * The characters any ExecStart word dashboards.sh writes is made of (paths, names, ids, URLs, ports, device lists).
 * Anything else (systemd's quotes, escapes and expansions, ';', a backtick, a control or non-ASCII character) means
 * root wrote it some other way: no exact reading, and never printed.
 */
const UNIT_WORD = /^[\w.,:=/@+~-]+$/;

/**
 * The hub's settings from its unit's text, or why they can't be read exactly. Never a guess, never a part. The why
 * names an option at most (one of UNIT_OPTIONS), never a word from the unit: those are root's file's bytes, and doctor
 * prints the why.
 */
export function parseHubUnit(text: string): HubSettings | { error: string } {
  const lines = text.split('\n').filter((l) => /^\s*ExecStart\s*=/.test(l));
  if (lines.length !== 1) return { error: `it has ${lines.length} ExecStart lines, not one` };
  // Split as systemd does, on spaces and tabs only: any other space stays in its word, which UNIT_WORD then refuses.
  const words = lines[0]!.replace(/^\s*ExecStart\s*=/, '').replace(/^[ \t]+|[ \t\r]+$/g, '').split(/[ \t]+/);
  if (!words.every((w) => UNIT_WORD.test(w))) return { error: 'its ExecStart has quotes, escapes, expansions, ";", a backtick, or a control or non-ASCII character, which dashboards.sh never writes' };
  const [exe, sub, ...rest] = words;
  if (!exe?.startsWith('/') || sub !== 'dashboard') return { error: "its ExecStart isn't the dashboard hub as dashboards.sh writes it" };
  const opts = new Map<string, string>();
  let service = false;
  for (let i = 0; i < rest.length; i++) {
    const o = rest[i]!;
    if (o === '--service') {
      service = true;
      continue;
    }
    if (!Object.hasOwn(UNIT_OPTIONS, o)) return { error: "its ExecStart has an option dashboards.sh doesn't write" };
    const v = rest[++i];
    if (v === undefined || v.startsWith('--')) return { error: `its ${o} has no value` };
    if (opts.has(o) && opts.get(o) !== v) return { error: `its ExecStart has ${o} twice, with different values` };
    opts.set(o, v);
  }
  const hub = opts.get('--hub');
  const clientId = opts.get('--client-id');
  const publicUrl = opts.get('--public-url');
  if (!service || !hub || !clientId || !publicUrl) return { error: 'its ExecStart lacks --hub, --service, --client-id or --public-url' };
  if (!HUB_VALUE_PATTERNS.clientId.test(clientId)) return { error: "its --client-id isn't one dashboards.sh takes (letters, digits, '.', '_' and '-', 8 to 64)" };
  if (!HUB_VALUE_PATTERNS.publicUrl.test(publicUrl)) return { error: "its --public-url isn't one dashboards.sh takes (https://, then lowercase letters, digits, '.' and '-')" };
  for (const o of ['--machine-devices', '--console-devices'] as const) {
    const v = opts.get(o);
    if (v !== undefined && !HUB_VALUE_PATTERNS.machineDevices.test(v)) return { error: `its ${o} isn't a list dashboards.sh takes (lowercase letters, digits, ':', '.', ',' and '-')` };
  }
  for (const [o, port] of [['--siri-port', '4397'], ['--hooks-port', '4396']] as const) {
    if (opts.has(o) && opts.get(o) !== port) return { error: `its ${o} isn't the ${port} dashboards.sh writes` };
  }
  const instances: string[] = [];
  if (hub !== '-') {
    for (const item of hub.split(',')) {
      const name = item.slice(0, item.indexOf('='));
      if (!item.includes('=') || !instanceNameOk(name)) return { error: "its --hub has an item that isn't <name>=<state> with an instance name dashboards.sh takes" };
      instances.push(name);
    }
  }
  // As the hub reads them (src/dashboard-hub.ts hubMachineDevices) and lib.sh hub_machine_devices: never merged.
  const machineDevices = opts.get('--machine-devices') ?? opts.get('--console-devices') ?? null;
  return { machineDevices, clientId, publicUrl, siri: opts.has('--siri-port'), hooks: opts.has('--hooks-port'), instances };
}

/**
 * The exact rerun from the installed hub unit, read as root's other files are (src/managed-apps.ts): a regular file,
 * not a symlink, root's, writable by nobody else. Or why it can't be built, and then no command at all.
 * `set`: values the hub gets instead of its unit's (a new URL for tailscale.sh public-url, a new sign-in App's client
 * id), each held to dashboards.sh's own pattern like every value.
 */
export function ownerTerminalRerun(o: TerminalPaths = {}, set: HubRerunValues = {}): { command: string } | { error: string } {
  if (set.publicUrl !== undefined && !HUB_VALUE_PATTERNS.publicUrl.test(set.publicUrl)) return { error: "the new URL isn't one dashboards.sh takes (https://, then lowercase letters, digits, '.' and '-')" };
  if (set.clientId !== undefined && !HUB_VALUE_PATTERNS.clientId.test(set.clientId)) return { error: "the new client id isn't one dashboards.sh takes (letters, digits, '.', '_' and '-', 8 to 64)" };
  const f = readRegularFile(o.hubUnitFile ?? HUB_UNIT_FILE, 64 * 1024);
  if (f.kind === 'missing') return { error: 'there is no hub unit' };
  if (f.kind === 'hidden') return { error: "it can't be read here (permission denied)" };
  if (f.kind === 'symlink') return { error: 'it is a symlink (refused, not followed)' };
  if (f.kind !== 'file') return { error: f.kind === 'too-big' ? 'it is too big' : f.kind === 'not-file' ? "it isn't a regular file" : "this OS can't read it as root's file" };
  if (f.uid !== (o.rootUid ?? 0) || Number.parseInt(f.mode, 8) & 0o022) return { error: `it isn't root's alone (owner uid ${f.uid}, mode ${f.mode})` };
  const s = parseHubUnit(f.text);
  return 'error' in s ? s : { command: rerunCommand({ ...s, clientId: set.clientId ?? s.clientId, publicUrl: set.publicUrl ?? s.publicUrl }) };
}

/**
 * The rerun to show an owner when the hub gets these new values: the exact command from the installed unit when it
 * reads exactly (ownerTerminalRerun), else the placeholder. A new value is written into the placeholder only when
 * dashboards.sh would take it (HUB_VALUE_PATTERNS: nothing in it can quote, expand or control a terminal); else the
 * placeholder names it (#767).
 */
export function hubRerunToShow(set: HubRerunValues, o: TerminalPaths = {}): { exact: boolean; command: string } {
  const r = ownerTerminalRerun(o, set);
  if ('command' in r) return { exact: true, command: r.command };
  const taken = (k: keyof HubRerunValues) => (set[k] === undefined ? undefined : HUB_VALUE_PATTERNS[k].test(set[k]) ? set[k] : NEW_VALUE_PLACEHOLDER[k]);
  return { exact: false, command: hubRerunPlaceholder({ clientId: taken('clientId'), publicUrl: taken('publicUrl') }) };
}
