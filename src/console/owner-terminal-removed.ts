// The owner terminal is gone (#742). It was a login shell as the machine's admin user, opened from the hub's Setup
// page, which the hub's viewer user started through a sudoers rule that let it run a root-installed console shell as
// that user. This engine has no terminal and never starts that shell. An install that had it keeps, until root runs
// dashboards.sh again (which removes them):
//   - the console shell, CONSOLE_SHELL (root:root 0755), and its sudoers rule (/etc/sudoers.d/<cli>-console, which
//     only root can see), so the hub's user could still start that shell as the admin user;
//   - a hub unit that names a console user (--console-user) and runs without NoNewPrivileges, ProtectSystem=strict
//     and ProtectHome=read-only.
// So the Setup page (an owner's) and doctor say so, and how to remove them, while any of it is there.
import { existsSync, readFileSync } from 'node:fs';
import { BRAND } from '../brand.js';
import { asRoot, libexecPath, unitPath } from '../os/system-paths.js';

/** The removed terminal's root-installed console shell (scripts/setup/lib.sh CONSOLE_SHELL): what dashboards.sh removes. */
export const CONSOLE_SHELL = libexecPath('console-shell');
/** The one root step that removes what is left: the same command as CHANGELOG's v0.5.3 "After install". */
export const OWNER_TERMINAL_RERUN = `sudo bash ${asRoot.opt('current/scripts/setup/dashboards.sh')} --machine-devices <the hub unit's --console-devices> --client-id <id> --public-url <url> <instance>...`;
/** The hub's unit, as dashboards.sh writes it (src/setup-steps.ts MACHINE_PATHS.hubUnitFile). */
const HUB_UNIT_FILE = unitPath(`${BRAND.cli}-dashboard-hub.service`);

export interface TerminalPaths {
  hubUnitFile?: string;
  consoleShell?: string;
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

/** The notice the Setup page and doctor show while anything of the owner terminal is left; null when nothing is. */
export function ownerTerminalNotice(o: TerminalPaths = {}): string | null {
  const left = ownerTerminalLeftovers(o);
  if (!left.length) return null;
  return `The owner terminal has been removed from the dashboard, but this machine still has it set up: ${left.join('; and ')}. As root, run dashboards.sh again with the hub's instances, and the devices its unit lists now (--console-devices) as --machine-devices (${OWNER_TERMINAL_RERUN}): it removes the console shell and its sudoers rule and gives the hub its sandbox back. For a shell on this machine, use ssh; the break-glass (port 4398, through ssh) still works.`;
}
