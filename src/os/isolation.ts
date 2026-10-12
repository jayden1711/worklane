// What isolation an instance's agents have on this machine, for doctor. The boundaries are the same on
// macOS and Linux: agents run as their own OS user, their commands run in Claude Code's sandbox (reads of
// credential stores denied, network only through its proxy to the lane's hosts), and the coordinator runs
// as a root-owned service. The mechanisms differ: Seatbelt and launchd on macOS, bubblewrap and systemd
// on Linux. What macOS can't do is limit a service's memory or CPU (it has no cgroups).
import { existsSync } from 'node:fs';
import { BRAND } from '../brand.js';
import type { OsKind } from './index.js';

export interface IsolationFacts {
  os: OsKind;
  instance: string;
  /** The user running this (the instance's coordinator user). */
  coordinatorUser: string;
  /** The instance's agent user (run_as.agent_user), or null when agents run as the coordinator's own user. */
  agentUser: string | null;
  agentUserExists: boolean;
  /** The sandbox Claude Code uses for agent commands here, when it's present. */
  sandbox: string | null;
  /** The root-owned service definition for the instance's coordinator, when it's installed. */
  service: string | null;
}

export type Level = 'ok' | 'warn' | 'fail';

/**
 * Credential stores in a home that only this OS has, relative to the home: on macOS the user's keychain files.
 * Denying the files doesn't block the `security` tool, which asks the keychain service over IPC instead of
 * reading them; agents get no secret in their keychain to find.
 */
export function osCredentialStores(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['Library/Keychains'] : [];
}

/** The mechanism Claude Code's sandbox uses on this OS, if it's there (it refuses to run agents without it). */
export function sandboxMechanism(os: OsKind, exists: (p: string) => boolean = existsSync): string | null {
  if (os === 'macos') return exists('/usr/bin/sandbox-exec') ? 'Seatbelt' : null;
  if (os === 'linux' || os === 'windows-wsl') return exists('/usr/bin/bwrap') ? 'bubblewrap' : null;
  return null;
}

/** Where the setup scripts install an instance's coordinator service. */
export function serviceDefinitionPath(os: OsKind, instance: string): string | null {
  if (os === 'macos') return `/Library/LaunchDaemons/com.${BRAND.cli}.coordinator.${instance}.plist`;
  if (os === 'linux' || os === 'windows-wsl') return `/etc/systemd/system/${BRAND.cli}-${instance}.service`;
  return null;
}

/** The service definition, if installed. */
export function serviceDefinition(os: OsKind, instance: string, exists: (p: string) => boolean = existsSync): string | null {
  const p = serviceDefinitionPath(os, instance);
  return p && exists(p) ? p : null;
}

/** Doctor's line for one instance: what keeps its agents apart, and what this OS can't limit. */
export function isolationCheck(f: IsolationFacts): { level: Level; detail: string } {
  if (f.os === 'windows') return { level: 'warn', detail: 'native Windows: agents don\'t run here' };
  const mac = f.os === 'macos';
  const setup = mac ? 'scripts/setup/macos/' : 'scripts/setup/';
  if (!f.agentUser) return { level: 'fail', detail: `not hardened: ${f.instance}'s agents run as ${f.coordinatorUser}, the user holding its credentials; give them their own user (${setup}instance.sh)` };
  if (f.agentUser === f.coordinatorUser) return { level: 'fail', detail: `not hardened: ${f.instance}'s agent user is ${f.coordinatorUser} itself, the user holding its credentials` };
  if (!f.agentUserExists) return { level: 'fail', detail: `${f.instance}'s agent user ${f.agentUser} doesn't exist on this machine (${setup}instance.sh ${f.instance})` };
  if (!f.sandbox) {
    const what = mac ? '/usr/bin/sandbox-exec (Seatbelt) is missing' : 'bubblewrap (/usr/bin/bwrap) is missing';
    return { level: 'fail', detail: `no sandbox for agent commands: ${what}, so agent runs refuse to start` };
  }
  const name = mac ? 'hardened macOS' : 'hardened Linux';
  const parts = [
    `agents run as ${f.agentUser}, a separate OS user from ${f.coordinatorUser}`,
    `their commands run in Claude Code's sandbox (${f.sandbox}): reads of the coordinator's home and credential stores denied, network only through its proxy to the lane's allowed hosts`,
  ];
  if (!f.service) {
    parts.push(`the coordinator isn't a root-owned ${mac ? 'launchd daemon' : 'systemd service'} (${setup}service.sh ${f.instance})`);
    return { level: 'warn', detail: `${name}: ${parts.join('; ')}` };
  }
  parts.push(
    mac
      ? `the coordinator is a root-owned launchd daemon (${f.service}) with open-file and process limits and background CPU and IO priority; macOS can't cap its memory or CPU (no cgroups)`
      : `the coordinator is a root-owned systemd service (${f.service}) with memory, CPU and task limits`,
  );
  return { level: 'ok', detail: `${name}: ${parts.join('; ')}` };
}
