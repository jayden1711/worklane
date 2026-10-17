import type { IncomingMessage } from 'node:http';
import type { Role } from './console/asks.js';
export declare const PROFILE_ADD_PATH = "/api/claude-account/profile-add";
export declare const PROFILE_PATH = "/api/machine/claude-profile";
/** The one-time code for a relayed sign-in (claude-account.sh login), in a JSON body: {"value": "<code>"}. */
export declare const LOGIN_CODE_PATH = "/api/claude-account/login-code";
export declare const isProfileRoute: (path: string) => path is "/api/claude-account/profile-add" | "/api/machine/claude-profile" | "/api/claude-account/login-code";
/** A person the dashboard identified. */
export interface ProfileWho {
    login: string;
    role: Role;
    via: 'session' | 'break-glass';
    deviceOk: boolean;
}
export interface ProfileRouteDeps {
    eventsDb: string;
    instance: string;
    repo: string;
    accountDir: string;
    ownersFile?: string;
    secretsHome?: string;
    /** Records a write by a person (dashboard.audit). */
    audit: (who: ProfileWho, action: string, detail: Record<string, unknown>) => void;
    readBody: (req: IncomingMessage) => Promise<unknown>;
}
export type ProfileRouteResult = {
    status: number;
    body: Record<string, unknown>;
};
/**
 * A request with no person behind it (no session, or one with no role here): refused, and recorded as
 * claude_account.refused with what is known (the login the hub named, if any). Nothing is read from the body.
 */
export declare function refuseUnidentified(req: IncomingMessage, d: Pick<ProfileRouteDeps, 'eventsDb' | 'instance'>, path: string, id: {
    status: number;
    error: string;
    login?: string;
}): ProfileRouteResult;
export declare function handleProfileRoute(req: IncomingMessage, url: URL, who: ProfileWho, d: ProfileRouteDeps): Promise<ProfileRouteResult>;
