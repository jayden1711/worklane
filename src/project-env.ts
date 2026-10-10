// A project's own environment variables (tests.yaml `env`), set for its agent
// sessions (and the hooks they run) and its commands (checks, worktree setup):
// e.g. a fixed test worker count. Committed config, so never secrets, and
// never a variable the harness sets or relies on for its boundaries.
import { BRAND } from './brand.js';

const RESERVED_NAMES = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'TERM', 'LANG', 'LC_.*', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'XDG_.*',
  // Code that runs before any project command: shell startup, loaders, Node.
  'ENV', 'BASH_ENV', 'BASH_FUNC_.*', 'PS4', 'PROMPT_COMMAND', 'LD_.*', 'DYLD_.*', 'NODE_OPTIONS', 'NODE_PATH',
  // Credentials and the agent's no-push setup, the agent runtime, sudo.
  'GIT_.*', 'GH_.*', 'GITHUB_.*', 'SSH_.*', 'CLAUDE_.*', 'ANTHROPIC_.*', 'SUDO_.*', `${BRAND.envPrefix}_.*`,
  // The sandbox's network proxy and trust store.
  '(HTTPS?|ALL|NO|FTP)_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_.*', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
];
const RESERVED = new RegExp(`^(?:${RESERVED_NAMES.join('|')})$`, 'i');
const SECRET_LIKE = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE/i;

/** Why `name` can't be a project variable, or null when it can. */
export function projectEnvProblem(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'not a variable name';
  if (RESERVED.test(name)) return 'set by the harness or the system; a project may not change it';
  if (SECRET_LIKE.test(name)) return 'looks like a secret; committed config never holds secrets';
  return null;
}

/** The variables that pass projectEnvProblem; anything else is dropped (the config check already refused it). */
export function safeProjectEnv(env: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([k, v]) => projectEnvProblem(k) === null && !/[\0\n]/.test(v)));
}
