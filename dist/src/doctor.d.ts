export type Level = 'ok' | 'warn' | 'fail';
export interface DoctorCheck {
    name: string;
    level: Level;
    detail: string;
}
export declare function doctor(rootArg: string, opts?: {
    agentshield?: boolean;
}): DoctorCheck[];
/** AgentShield scan of hooks, MCP config and permissions (MIT, run via npx). */
export declare function agentShield(root: string): DoctorCheck;
