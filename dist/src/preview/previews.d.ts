import type { AppConfig } from '../config/schema.js';
import type { FlowRun } from '../browser/run.js';
import type { EventLog } from '../events/log.js';
import { type PreviewConfig } from './config.js';
import type { PreviewGitHub } from './github.js';
import type { PreviewHost } from './railway.js';
export declare const PREVIEW_COMMENT_MARKER = "<!-- pr-preview -->";
export interface PreviewsDeps {
    config: PreviewConfig;
    app?: AppConfig;
    host: PreviewHost;
    hasToken: () => boolean;
    github: PreviewGitHub;
    runFlow: (o: {
        app: AppConfig;
        flow: string;
        origin: string;
        outDir: string;
    }) => Promise<FlowRun>;
    log: EventLog;
    actor: string;
    stateDir: string;
    passMs?: number;
    pollMs?: number;
    now?: () => number;
}
export declare class Previews {
    private d;
    private lastPass;
    private running;
    private readonly inFlight;
    private readonly stopped;
    private tokenSaid;
    constructor(d: PreviewsDeps);
    private get file();
    private read;
    private update;
    private now;
    private emit;
    step(): void;
    idle(): Promise<void>;
    stop(): void;
    private pass;
    private remove;
    private launch;
    private sleep;
    private run;
    private flows;
}
