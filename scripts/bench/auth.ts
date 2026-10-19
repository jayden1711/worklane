// Who the bench runs as, on what login, with which CLI (#748, owner's changes of 2026-10-18). No API key: the whole
// bench runs as a dedicated OS user (BENCH_USER_ENV, default DEFAULT_BENCH_USER) with its own clone, its own rootless
// Docker and its own claude, which the owner signed in once through Anthropic's own flow, on the owner's
// subscription. No sudo and no switching users. The bench never reads, copies, mounts or relays that login: it asks
// `claude auth status --json` and starts nothing unless the CLI reports a subscription login (the engine's runner asks
// again before every run, src/runner.ts), and only on the pinned CLI version, with updates off.
import { spawnSync } from 'node:child_process';
import { BRAND } from '../../src/brand.js';
import { currentUser } from '../../src/os/index.js';
import type { AgentRunner, RunRequest, RunResult } from '../../src/runner.js';

/** Names the bench's OS user (default DEFAULT_BENCH_USER). */
export const BENCH_USER_ENV = `${BRAND.envPrefix}_BENCH_USER`;
export const DEFAULT_BENCH_USER = 'wl-bench';
/** The claude CLI version the bench runs on (default DEFAULT_CLAUDE_PIN). */
export const CLAUDE_PIN_ENV = `${BRAND.envPrefix}_BENCH_CLAUDE_VERSION`;
export const DEFAULT_CLAUDE_PIN = '2.1.303';

/** The only auth methods a bench run starts on: a subscription login. Anything else (an API key, a helper) is refused. */
export const SUBSCRIPTION_AUTH: readonly string[] = ['claude.ai', 'oauth_token'];

/** Every claude the bench starts gets these: the pinned CLI never updates itself mid-run. */
export const CLAUDE_ENV: Readonly<Record<string, string>> = { DISABLE_UPDATES: '1' };

/** Variables that move claude off the subscription login: a key, a token, another endpoint or a cloud provider. */
export const OTHER_AUTH_VAR = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|AWS_BEARER_TOKEN_BEDROCK)$/;

/** Refuses (throws) unless this process runs as the bench user. */
export function requireBenchUser(env: NodeJS.ProcessEnv = process.env, me: string = currentUser()): string {
  const user = env[BENCH_USER_ENV] || DEFAULT_BENCH_USER;
  if (me !== user) throw new Error(`the bench runs as ${user} only, from its own clone (scripts/bench/README.md, one-time setup); this is ${me || 'an unknown user'}`);
  return user;
}

/** The environment the bench's own claude probes (auth status, --version) run with. */
export const cliEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, ...CLAUDE_ENV });

/** The bench's agents: every run gets CLAUDE_ENV on top of its own variables. */
export class BenchAgentRunner implements AgentRunner {
  constructor(private inner: AgentRunner) {}
  run(req: RunRequest): Promise<RunResult> {
    return this.inner.run({ ...req, env: { ...(req.env ?? {}), ...CLAUDE_ENV } });
  }
}

export interface Login {
  /** claude's authMethod: claude.ai or oauth_token. */
  method: string;
  /** claude's subscriptionType (pro, max, team, enterprise, ...) as it said it; recorded, never checked. */
  subscription_type: string | null;
}

/**
 * Refuses (throws) unless claude reports a subscription login: authMethod claude.ai or oauth_token, whatever the plan
 * (an enterprise or team plan as much as a personal one). An API key, a helper, Bedrock, Vertex, Foundry, a signed-out
 * or unreadable status: refused. Run before any task, any container and any model call. Reads only the CLI's answer
 * (`claude auth status --json`, which never prints the token), never the login's files.
 */
export function requireSubscription(env: NodeJS.ProcessEnv, bin = 'claude'): Login {
  const other = Object.keys(env).filter((k) => OTHER_AUTH_VAR.test(k) && env[k]);
  if (other.length) throw new Error(`${other.join(', ')} set in the bench's environment: claude would leave the subscription login (an API key, a token, another endpoint or a cloud provider); unset ${other.length > 1 ? 'them' : 'it'}`);
  const r = spawnSync(bin, ['auth', 'status', '--json'], { env: cliEnv(env), encoding: 'utf8', timeout: 30_000 });
  let j: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; apiProvider?: unknown } = {};
  try {
    j = JSON.parse(r.stdout ?? '') as typeof j;
  } catch {
    // unreadable: refused below
  }
  const method = j.loggedIn === true && typeof j.authMethod === 'string' ? j.authMethod : j.loggedIn === false ? 'none' : 'unknown';
  if (!SUBSCRIPTION_AUTH.includes(method)) {
    throw new Error(`claude reports auth "${method}", not a subscription login (${SUBSCRIPTION_AUTH.join(' or ')}): not starting. Sign the bench user in with claude's own /login; never an API key or a cloud provider`);
  }
  if (typeof j.apiProvider === 'string' && !/^(firstParty|anthropic)$/i.test(j.apiProvider)) throw new Error(`claude reports provider "${j.apiProvider}", not Anthropic's own: not starting`);
  return { method, subscription_type: typeof j.subscriptionType === 'string' ? j.subscriptionType.slice(0, 40) : null };
}

/** Refuses (throws) unless `claude --version` is the pin; returns the version (recorded with the results). */
export function requireClaudePin(env: NodeJS.ProcessEnv, bin = 'claude'): string {
  const pin = env[CLAUDE_PIN_ENV] || DEFAULT_CLAUDE_PIN;
  const r = spawnSync(bin, ['--version'], { env: cliEnv(env), encoding: 'utf8', timeout: 30_000 });
  const version = (r.stdout ?? '').trim().split(/\s+/)[0] ?? '';
  if (r.status !== 0 || version !== pin) throw new Error(`claude --version is ${version || `unreadable (${(r.stderr ?? '').trim().slice(0, 200)})`}, not the pinned ${pin}: not starting (install the pin, or set ${CLAUDE_PIN_ENV} after the owner approves another)`);
  return version;
}
