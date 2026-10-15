import type { Config } from '../config/load.js';
import type { EventLog } from '../events/log.js';
import { type DeployGateSetup } from '../deploy-gate/wire.js';
import { type PreviewGitHub } from './github.js';
import { Previews } from './previews.js';
export interface PreviewSetup extends DeployGateSetup {
    previewGitHub?: PreviewGitHub;
    runFlow?: ConstructorParameters<typeof Previews>[0]['runFlow'];
    previewPassMs?: number;
    previewPollMs?: number;
    previewNow?: () => number;
}
export declare function setupPreviews(cfg: Config, s: PreviewSetup, d: {
    log: EventLog;
    actor: string;
    stateDir: string;
}): Previews | undefined;
