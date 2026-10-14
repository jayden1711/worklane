// docs/previews.md. INVARIANT: the host token is the deploy gate's (hostTokenFile, readHostToken), unchanged.
import type { Config } from '../config/load.js';
import { asks } from '../console/asks.js';
import { HOST_TOKEN_CREDENTIAL } from '../deploy-gate/config.js';
import { runFlowAt } from '../browser/run.js';
import type { EventLog } from '../events/log.js';
import { RAILWAY_API } from '../deploy-gate/railway.js';
import { hostTokenFile, readHostToken, type DeployGateSetup } from '../deploy-gate/wire.js';
import { githubPreviews, type PreviewGitHub } from './github.js';
import { Previews } from './previews.js';
import { railwayPreviewHost } from './railway.js';

export interface PreviewSetup extends DeployGateSetup {
  previewGitHub?: PreviewGitHub;
  runFlow?: ConstructorParameters<typeof Previews>[0]['runFlow'];
  previewPassMs?: number;
  previewPollMs?: number;
  previewNow?: () => number;
}

export function setupPreviews(cfg: Config, s: PreviewSetup, d: { log: EventLog; actor: string; stateDir: string }): Previews | undefined {
  const config = cfg.tests.preview;
  if (!config?.enabled) return undefined;
  const fail = (message: string) => {
    d.log.append('coordinator.error', { instance: d.actor, where: 'previews', kind: 'config', message }, d.actor);
    return undefined;
  };
  if (!s.instance) return fail("preview is on, but this isn't an instance: there is no stored host token to use");
  const missing = (config.flows ?? []).filter((f) => !cfg.app?.flows[f]);
  if (missing.length) return fail(`preview.flows names flows app.yaml doesn't have: ${missing.join(', ')}`);
  const file = hostTokenFile(s.instance, s.secretsHome);
  const token = () => readHostToken(file);
  if (!token()) {
    const a = asks(d.log);
    const open = a.list({ instance: s.instance, status: 'open' }).some((x) => x.kind === 'paste_secret' && x.credential === HOST_TOKEN_CREDENTIAL);
    if (!open)
      a.create({
        kind: 'paste_secret',
        instance: s.instance,
        title: "The host's API token, for PR previews",
        detail: `preview is on, but no ${config.host} token is stored, so no preview is created or deleted. Paste an account or workspace token (docs/previews.md, "What the owner does"). It is stored for the coordinator only (0400) and never shown, logged or posted.`,
        credential: HOST_TOKEN_CREDENTIAL,
        where: `the instance's secrets, ${HOST_TOKEN_CREDENTIAL} (the coordinator only)`,
      });
  }
  return new Previews({
    config,
    ...(cfg.app ? { app: cfg.app } : {}),
    host: railwayPreviewHost({ project: config.project!, template: config.template_environment! }, token, fetch, s.hostApi ?? RAILWAY_API),
    hasToken: () => token() !== null,
    github: s.previewGitHub ?? githubPreviews(s.repo, s.token, fetch, s.api),
    runFlow: s.runFlow ?? ((o) => runFlowAt(o)),
    log: d.log,
    actor: d.actor,
    stateDir: d.stateDir,
    ...(s.previewPassMs !== undefined ? { passMs: s.previewPassMs } : {}),
    ...(s.previewPollMs !== undefined ? { pollMs: s.previewPollMs } : {}),
    ...(s.previewNow ? { now: s.previewNow } : {}),
  });
}
