// The environment variables that carry a GitHub or Anthropic credential a process would use in place of its own login
// (gh prefers GH_TOKEN/GITHUB_TOKEN over its config dir).

/**
 * INVARIANT (#838): one list, dropped from the coordinator's environment (src/service.ts instanceEnv) and from every
 * test process (test/isolate.ts), so neither can keep a name the other drops.
 */
export const INHERITED_CREDENTIAL_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
