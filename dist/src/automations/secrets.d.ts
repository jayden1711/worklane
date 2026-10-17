/** Where an instance keeps its webhook secrets: its home, beside automations.yaml. */
export declare const SECRETS_DIR = "automation-secrets";
/** The instance's state file for bindings, seen deliveries and counts. */
export declare const HOOKS_STATE = "automation-hooks.json";
/** A new secret for `id` (256 bits), replacing any old one at once: 0400 in a 0700 folder. Returned once. */
export declare function makeSecret(home: string, id: string): string;
export declare function removeSecret(home: string, id: string): void;
export declare function readSecret(home: string, id: string): string | null;
export interface HooksState {
    bound: Record<string, {
        id: string;
        name: string;
        at: string;
    }>;
    seen: Record<string, Record<string, number>>;
    accepted: Record<string, number[]>;
    refused: Record<string, number[]>;
}
export declare function readHooksState(stateDir: string): HooksState;
export declare function writeHooksState(stateDir: string, s: HooksState): void;
/** Forget which node an automation is bound to (an owner's unbind; and a delete). Its next valid delivery binds it again. */
export declare function unbind(stateDir: string, id: string): boolean;
