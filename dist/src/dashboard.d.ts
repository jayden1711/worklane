import { type Server } from 'node:http';
import type { Config } from './config/load.js';
export interface DashboardOptions {
    root: string;
    cfg: Config;
    eventsDb: string;
    stateDir: string;
    user: string;
    port?: number;
    webDir?: string;
    pollMs?: number;
}
export declare function dashboardToken(stateDir: string): string;
export declare function startDashboard(opts: DashboardOptions): Promise<{
    server: Server;
    url: string;
    token: string;
    close: () => Promise<void>;
}>;
