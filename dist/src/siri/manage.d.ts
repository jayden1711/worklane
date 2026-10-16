import type { Role } from '../dashboard-auth.js';
export declare const SIRI_DEVICES_PATH = "/api/siri-devices";
export interface SiriManager {
    login: string;
    role: Role;
    via: 'session' | 'break-glass';
    deviceOk: boolean;
}
export interface SiriManageOptions {
    stateDir: string;
    instance: string | null;
    intakeFile?: string;
    audit: (action: string, detail: Record<string, unknown>) => void;
    now?: () => Date;
}
type Answer = {
    status: number;
    body: unknown;
};
/** Why this person may not make a token (or unbind one) here, or null. */
export declare function createRefusal(who: SiriManager, instance: string | null): string | null;
/** GET and POST on /api/siri-devices[/<id>/(revoke|unbind)]; null when the path isn't one of these. */
export declare function siriDevicesRoute(who: SiriManager, method: string, path: string, body: Record<string, unknown>, o: SiriManageOptions): Answer | null;
export {};
