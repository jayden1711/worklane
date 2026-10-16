export declare const MACHINE_OWNERS_FILE: string;
/** A GitHub login: letters, digits and single dashes inside, at most 39 characters (dashboards.sh checks the same). */
export declare const GITHUB_LOGIN: RegExp;
/** The machine owners and, when the file can't be used, why (no file is no owners, not an error). */
export declare function readMachineOwners(file?: string): {
    owners: string[];
    error: string | null;
};
/** The machine owners' GitHub logins; none when the file is missing or can't be trusted. */
export declare const machineOwners: (file?: string) => string[];
/** Whether this GitHub login is a machine owner (case-insensitive, as GitHub logins are). */
export declare function isMachineOwner(login: string | null | undefined, file?: string): boolean;
/** Who asks for a machine change, as the dashboard resolved them. */
export interface MachineRequester {
    login: string;
    /** The owner's break-glass (the token, on this machine only): allowed without the checks below. */
    breakGlass: boolean;
    /** Whether the hub identified this request's Tailscale device as one allowed to open the console. */
    deviceOk: boolean;
}
/** The machine owners as the page names them: `@a, @b`, or that none are set and how to set them. */
export declare const ownersText: (owners: string[]) => string;
/**
 * Why this person may not ask for a machine change now; null when they may. The same device rule as the owner
 * terminal (src/console/terminal.ts): an allowed console device; on top, a machine owner. The break-glass is allowed.
 */
export declare function machineChangeRefusal(r: MachineRequester, o?: {
    file?: string;
}): string | null;
