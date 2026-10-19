// Who the bench runs as, on what login, with which CLI (#748, owner's changes of 2026-10-18). No API key: the whole
// bench runs as a dedicated OS user (BENCH_USER_ENV, default DEFAULT_BENCH_USER) with its own clone, its own rootless
// Docker and its own claude, which the owner signed in once through Anthropic's own flow, on the owner's
// subscription. No sudo and no switching users. The bench never reads, copies, mounts or relays that login: it asks
// `claude auth status --json` and starts nothing unless the CLI reports a claude.ai login (the engine's runner asks
// again before every run, src/runner.ts), and only on the pinned CLI version, with updates off.
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { BRAND } from '../../src/brand.js';
import { currentUser } from '../../src/os/index.js';
import type { AgentRunner, RunRequest, RunResult } from '../../src/runner.js';
import { benchHome, inside, realPath } from './paths.js';

/** Names the bench's OS user (default DEFAULT_BENCH_USER). */
export const BENCH_USER_ENV = `${BRAND.envPrefix}_BENCH_USER`;
export const DEFAULT_BENCH_USER = 'wl-bench';
/** The claude CLI version the bench runs on (default DEFAULT_CLAUDE_PIN). */
export const CLAUDE_PIN_ENV = `${BRAND.envPrefix}_BENCH_CLAUDE_VERSION`;
export const DEFAULT_CLAUDE_PIN = '2.1.303';

/**
 * The only auth method a bench run starts on: claude.ai, the login /login makes (owner, 2026-10-18). Not oauth_token:
 * the CLI reports that for a CLAUDE_CODE_OAUTH_TOKEN, an ANTHROPIC_AUTH_TOKEN gateway bearer, Workload Identity
 * Federation and Console profiles alike, and gives no plan for it. An API key, a helper or a cloud provider: refused.
 */
export const SUBSCRIPTION_AUTH: readonly string[] = ['claude.ai'];

/** Every claude the bench starts gets these: the pinned CLI never updates itself mid-run. */
export const CLAUDE_ENV: Readonly<Record<string, string>> = { DISABLE_UPDATES: '1' };

/**
 * Variables that can move claude off the claude.ai login, by prefix so a variable a later CLI adds is refused too
 * (Claude Code's env-vars reference, checked 2026-10-18 for 2.1.303):
 * - every ANTHROPIC_*: keys and tokens, base URLs, federation (FEDERATION_RULE_ID with ORGANIZATION_ID), profiles,
 *   custom headers (an Authorization header) and model overrides. None is harmless to a benchmark, so none is exempt;
 * - CLAUDE_CODE_USE_* (a cloud provider), CLAUDE_CODE_OAUTH_* (a token or refresh token), CLAUDE_CODE_SKIP_*_AUTH,
 *   CLAUDE_CODE_API_KEY_* (a key, its helper or descriptor), CLAUDE_CODE_PROVIDER_* (a host-managed provider) and
 *   CLAUDE_CODE_CLIENT_* (a gateway's mTLS identity);
 * - any *_FILE_DESCRIPTOR (a token handed over on a descriptor) and any *_BASE_URL (another endpoint);
 * - AWS_*, AZURE_*, GOOGLE_APPLICATION_CREDENTIALS, CLOUD_ML_* and anything naming BEDROCK, VERTEX, FOUNDRY or MANTLE:
 *   a cloud provider's credentials or region.
 */
export const LOGIN_SWITCH_VAR = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY|CLAUDE_CODE_PROVIDER_|CLAUDE_CODE_CLIENT_|AWS_|AZURE_|CLOUD_ML_|GOOGLE_APPLICATION_CREDENTIALS$)|^CLAUDE_CODE_SKIP_.*_AUTH$|_FILE_DESCRIPTOR$|_BASE_URL$|BEDROCK|VERTEX|FOUNDRY|MANTLE/;

/** The login-switching variables `env` sets (any value, an empty one included). */
export const loginSwitchVars = (env: NodeJS.ProcessEnv): string[] => Object.keys(env).filter((k) => LOGIN_SWITCH_VAR.test(k.toUpperCase()) && env[k] !== undefined);

/** Refuses (throws) unless this process runs as the bench user. */
export function requireBenchUser(env: NodeJS.ProcessEnv = process.env, me: string = currentUser()): string {
  const user = env[BENCH_USER_ENV] || DEFAULT_BENCH_USER;
  if (me !== user) throw new Error(`the bench runs as ${user} only, from its own clone (scripts/bench/README.md, one-time setup); this is ${me || 'an unknown user'}`);
  return user;
}

/**
 * Variables that reach this user's Docker daemon or its user services. The bench user's daemon can mount anything
 * that user can read, its login included: never in an agent's or a probe's environment.
 */
export const DAEMON_VAR = /^(DOCKER_.*|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|CONTAINER_HOST)$/;

/** The environment agents and probes are built on: this one without any way to the daemon or the user bus. */
export function agentBase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !DAEMON_VAR.test(k)));
}

/** The environment the bench's own claude probes (auth status, --version) run with. */
export const cliEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...agentBase(env), ...CLAUDE_ENV });

/**
 * The bench's agents: every run gets CLAUDE_ENV, and a request's own variables never name the daemon. The inner
 * runner is built on agentBase (agent.ts benchClaude; the engine's agentEnv keeps only its pass-through list).
 */
export class BenchAgentRunner implements AgentRunner {
  constructor(private inner: AgentRunner) {}
  run(req: RunRequest): Promise<RunResult> {
    const own = Object.fromEntries(Object.entries(req.env ?? {}).filter(([k]) => !DAEMON_VAR.test(k)));
    return this.inner.run({ ...req, env: { ...own, ...CLAUDE_ENV } });
  }
}

export interface Login {
  /** claude's authMethod: always claude.ai. */
  method: string;
  /** claude's subscriptionType (pro, max, team, enterprise, ...) as it said it; recorded, never checked. */
  subscription_type: string | null;
  /** The config dir claude reports the login in (its configDirectory): inside the bench user's home. */
  config_directory: string;
}

/**
 * Refuses (throws) unless claude reports a claude.ai login, whatever the plan (an enterprise or team plan as much as a
 * personal one), on Anthropic's own API (apiProvider firstParty), kept in a config dir inside the bench user's home.
 * Refused: any login-switching variable (LOGIN_SWITCH_VAR) before claude is even asked; an oauth_token, an API key, a
 * helper, a cloud provider (third_party), a signed-out or unreadable status; a config dir elsewhere (CLAUDE_CONFIG_DIR
 * pointed at another login); a $HOME that isn't the bench user's home. The home is the passwd entry's (benchHome),
 * never $HOME. Run before any task, any container and any model call. Reads only the CLI's answer
 * (`claude auth status --json`, which never prints the token), never the login's files.
 */
export function requireSubscription(env: NodeJS.ProcessEnv, bin = 'claude', home = benchHome(env)): Login {
  const other = loginSwitchVars(env);
  if (other.length) throw new Error(`${other.join(', ')} set in the bench's environment: claude could leave the claude.ai login (a key, a token, federation, another endpoint or a cloud provider); unset ${other.length > 1 ? 'them' : 'it'}`);
  // claude finds its login through $HOME: one moved off the bench user's own home is refused before claude is asked.
  benchHome(env, () => home);
  const r = spawnSync(bin, ['auth', 'status', '--json'], { env: cliEnv(env), encoding: 'utf8', timeout: 30_000 });
  let j: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown; apiProvider?: unknown; configDirectory?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(r.stdout ?? '');
    if (parsed && typeof parsed === 'object') j = parsed as typeof j;
  } catch {
    // unreadable: refused below
  }
  const method = j.loggedIn === true && typeof j.authMethod === 'string' ? j.authMethod : j.loggedIn === false ? 'none' : 'unknown';
  if (!SUBSCRIPTION_AUTH.includes(method)) {
    throw new Error(`claude reports auth "${method}", not a claude.ai login: not starting. Sign the bench user in with claude's own /login; never a token, an API key or a cloud provider`);
  }
  if (j.apiProvider !== 'firstParty') throw new Error(`claude reports provider "${String(j.apiProvider)}", not Anthropic's own (firstParty): not starting`);
  const dir = j.configDirectory;
  if (typeof dir !== 'string' || !isAbsolute(dir) || !inside(realPath(dir), realPath(home))) {
    throw new Error(`claude reports its login in ${typeof dir === 'string' ? dir : 'no config directory'}, not inside the bench user's home ${home}: not starting (unset CLAUDE_CONFIG_DIR)`);
  }
  return { method, subscription_type: typeof j.subscriptionType === 'string' ? j.subscriptionType.slice(0, 40) : null, config_directory: dir };
}

/** Refuses (throws) unless `claude --version` is the pin; returns the version (recorded with the results). */
export function requireClaudePin(env: NodeJS.ProcessEnv, bin = 'claude'): string {
  const pin = env[CLAUDE_PIN_ENV] || DEFAULT_CLAUDE_PIN;
  const r = spawnSync(bin, ['--version'], { env: cliEnv(env), encoding: 'utf8', timeout: 30_000 });
  const version = (r.stdout ?? '').trim().split(/\s+/)[0] ?? '';
  if (r.status !== 0 || version !== pin) throw new Error(`claude --version is ${version || `unreadable (${(r.stderr ?? '').trim().slice(0, 200)})`}, not the pinned ${pin}: not starting (install the pin, or set ${CLAUDE_PIN_ENV} after the owner approves another)`);
  return version;
}
