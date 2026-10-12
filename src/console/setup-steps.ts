// The machine helper's setup commands, as root steps: what onboarding a project (`add`, the dashboard's Add
// project) needs done as root, each one existing setup script with arguments of one exact shape. The helper
// (scripts/machine/<cli>-machine.cjs) checks every argument again; these checks only refuse early, before sudo.
// sudoers gives them to the one setup user (machine-helper.sh --setup-user), never to a coordinator.
// A secret (an App key, an API key, a bot token) goes on stdin, never in the arguments.
import { BRAND } from '../brand.js';
import { runSetupCommand, type Exec, type MachineResult } from '../machine.js';

type Check = (s: string) => boolean;
export const SETUP_ARG = {
  name: ((s) => /^[a-z][a-z0-9-]{0,20}$/.test(s) && s !== 'dash' && !/-(agent|eval|work)$/.test(s)) as Check,
  repo: ((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(s) && !s.includes('..')) as Check,
  id: ((s) => /^[1-9][0-9]{0,11}$/.test(s)) as Check,
  ref: ((s) => /^[0-9a-f]{40}$/.test(s)) as Check,
  login: ((s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s)) as Check,
  usd: ((s) => /^[1-9][0-9]{0,3}$/.test(s) && Number(s) <= 1000) as Check,
  mode: ((s) => s === 'per-repo' || s === 'shared') as Check,
};

export interface SetupStepRule {
  command: string;
  what: string;
  usage: string;
  /** The script (or command) the helper runs for it, for the console and the review. */
  runs: string;
  /** It reads one secret on stdin: the credential's name. */
  secret?: string;
  allows: (args: string[]) => boolean;
  run: (args: string[], exec?: Exec, input?: string) => MachineResult;
}

const A = SETUP_ARG;
function exact(...checks: Check[]): (args: string[]) => boolean {
  return (a) => a.length === checks.length && a.every((x, i) => typeof x === 'string' && checks[i]!(x));
}
const rule = (command: string, what: string, usage: string, runs: string, allows: (a: string[]) => boolean, secret?: string): SetupStepRule => ({
  command,
  what,
  usage,
  runs,
  ...(secret ? { secret } : {}),
  allows,
  run: (args, exec, input) => runSetupCommand(command, args, input, ...((exec ? [exec] : []) as [Exec?])),
});

/** The helper's setup commands, one for one with SETUP_COMMANDS in scripts/setup/lib.sh and the helper's source (a test keeps them equal). */
export const SETUP_STEPS: readonly SetupStepRule[] = [
  rule('setup-machine', 'roots, agent slots and sandbox dependencies, once per machine', 'setup-machine', 'machine.sh', exact()),
  rule('add-instance', "the instance's coordinator and agent users, groups, checkout directory and sudoers rule", 'add-instance <name>', 'instance.sh <name>', exact(A.name)),
  rule('install-engine', `the engine at a pinned commit (/opt/${BRAND.cli}) and the instance's home`, 'install-engine <sha> <name> <owner/repo>', 'engine.sh <sha> <name> <owner/repo>', exact(A.ref, A.name, A.repo)),
  rule('install-app-key', "the GitHub App's private key for the coordinator only (0400), verified against the repo", 'install-app-key <name> <app-id> <installation-id> <owner/repo> per-repo|shared', 'credentials.sh <name> github-app <app-id> <installation-id> - <owner/repo> [--shared]', exact(A.name, A.id, A.id, A.repo, A.mode), 'github-app-key'),
  rule('checkout', "the coordinator's clone, its permissions, and the guardrail hooks for the instance's agent runs only", 'checkout <name> <owner/repo>', 'checkout.sh <name> <owner/repo>', exact(A.name, A.repo)),
  rule('install-service', 'the coordinator as a system service, with its resource limits', 'install-service <name>', 'service.sh <name>', exact(A.name)),
  rule(
    'install-dashboards',
    "each instance's dashboard service and the hub over them",
    'install-dashboards <login> <name> [<name>...]',
    'dashboards.sh <login> <name>...',
    (a) => a.length >= 2 && a.length <= 21 && A.login(a[0]!) && a.slice(1).every(A.name) && new Set(a.slice(1)).size === a.length - 1,
  ),
  rule('install-claude-key', "an Anthropic API key for the agent user's Claude Code", 'install-claude-key <name>', 'credentials.sh <name> claude-key', exact(A.name), 'claude-api-key'),
  rule('install-discord-token', "the chat bot's token, for the coordinator only (intake stays off)", 'install-discord-token <name>', 'credentials.sh <name> intake-discord', exact(A.name), 'intake-discord'),
  rule('set-budget', "the instance's daily budget (policy.yaml), as its coordinator user", 'set-budget <name> <1..1000>', `runuser -u wl-<name> -- ${BRAND.cli} instance set-budget <name> <usd>`, exact(A.name, A.usd)),
  rule('claude-status', "read-only: whether the agent user's Claude Code is signed in", 'claude-status <name>', 'runuser -u wl-<name>-agent -- claude auth status --json', exact(A.name)),
  rule('instance-doctor', "read-only: the instance's doctor, as its coordinator user", 'instance-doctor <name> <owner/repo>', `runuser -u wl-<name> -- ${BRAND.cli} doctor --json --instance <name> --root <checkout>`, exact(A.name, A.repo)),
  rule('tailscale-serve', 'tailscale cert for this node, then tailscale serve of the dashboard hub on the tailnet (HTTPS)', 'tailscale-serve', 'tailscale cert <node>; tailscale serve --bg --https=443 http://127.0.0.1:<hub port>', exact()),
];
