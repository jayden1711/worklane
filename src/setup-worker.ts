// The setup steps checked off the dashboard's main thread: the detectors run commands (`claude auth status`, `gh`, the
// service manager) synchronously, and some ask GitHub over the network, so in the dashboard they run here, in a worker,
// and its server keeps answering meanwhile. Started by checkSetupOffThread (src/setup-steps.ts).
import { parentPort, workerData } from 'node:worker_threads';
import { checkSetup, systemProbe, type DetectCache, type SetupContext } from './setup-steps.js';

const d = workerData as { ctx: SetupContext; cache: DetectCache; fresh: boolean; localMs: number; netMs: number };
const view = checkSetup(d.ctx, systemProbe(), { cache: d.cache, fresh: d.fresh, localMs: d.localMs, netMs: d.netMs });
parentPort!.postMessage({ view, cache: d.cache });
